import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { Store } from "../persistence/store.js";
import { checkHubOrganization } from "./hub-organization.js";
import {
  id,
  secret,
  digest,
  audit,
  passwordMatches,
} from "../domain/commands.js";
import {
  DomainError,
  forbid,
  requireValue,
  type State,
} from "../contracts/model.js";
import {
  type ExternalIdentity,
  type LoginContext,
  type IdentitySession,
} from "./model.js";

export interface OtpDelivery {
  send(method: "email" | "phone", target: string, code: string): Promise<void>;
}
export interface VerifiedIdentity {
  connection: string;
  method: ExternalIdentity["method"];
  subject: string;
  tenant: string | null;
  email: string | null;
  name: string;
}
const fail = (message = "Authentication failed") =>
  new DomainError(401, "invalid_authentication", message);
export class Accounts {
  constructor(
    readonly store: Store,
    private otpKey: string,
    private delivery: OtpDelivery,
    private now = () => Date.now(),
  ) {
    if (otpKey.length < 32)
      throw new Error("OTP key must contain at least 32 characters");
  }
  session(credential: string): IdentitySession {
    const s = this.store.read(),
      session = s.identity.sessions.find(
        (x) =>
          x.credentialHash === digest(credential) &&
          !x.revoked &&
          x.expiresAt > this.now(),
      );
    if (
      !session ||
      !s.users.some((u) => u.id === session.userId && !u.disabled)
    )
      throw fail("Session expired");
    return this.sessionById(session.id);
  }
  sessionById(sessionId: string): IdentitySession {
    const s = this.store.read(),
      session = s.identity.sessions.find(
        (x) => x.id === sessionId && !x.revoked && x.expiresAt > this.now(),
      );
    if (
      !session ||
      !s.users.some((u) => u.id === session.userId && !u.disabled)
    )
      throw fail("Session revoked");
    if (session.parentId) this.sessionById(session.parentId);
    if (s.hubs.length === 1)
      checkHubOrganization(s, s.hubs[0]!.id, session.context.method, session.context.tenant);
    return session;
  }
  forkSession(sessionId: string, installationId: string) {
    const source = this.sessionById(sessionId);
    return this.store.change((s) => {
      const created = this.issue(
        s,
        source.userId,
        source.context,
        installationId,
      );
      created.session.parentId = source.id;
      return created.session;
    });
  }
  private fresh(credential: string) {
    const session = this.session(credential);
    if (this.now() - session.context.authenticatedAt > 300_000)
      throw new DomainError(
        401,
        "reauthentication_required",
        "Sign in again before changing login methods",
      );
    return session;
  }
  private issue(
    s: State,
    userId: string,
    context: LoginContext,
    installationId: string,
  ) {
    const credential = secret(),
      session: IdentitySession = {
        id: id(),
        userId,
        credentialHash: digest(credential),
        context,
        expiresAt: this.now() + 30 * 86400000,
        revoked: false,
        installationId,
      };
    s.identity.sessions.push(session);
    audit(s, userId, "identity.login", session.id);
    return { credential, session };
  }
  password(email: string, password: string, installationId: string) {
    const s = this.store.read(),
      user = s.users.find(
        (u) => u.email === email.toLowerCase() && !u.disabled,
      );
    if (!user || !passwordMatches(password, user.passwordHash)) throw fail();
    return this.store.change((state) =>
      this.issue(
        state,
        user.id,
        {
          method: "password",
          identityId: null,
          tenant: null,
          authenticatedAt: this.now(),
        },
        installationId,
      ),
    );
  }
  rateLimit(key: string, max: number, window: number) {
    const limited = this.store.change((s) => {
      s.identity.limits = s.identity.limits.filter((x) => x.until > this.now());
      let l = s.identity.limits.find((x) => x.key === key);
      if (!l) {
        l = { key, count: 0, until: this.now() + window };
        s.identity.limits.push(l);
      }
      l.count++;
      return l.count > max;
    });
    if (limited) throw new DomainError(429, "rate_limited", "Try again later");
  }
  private otpHash(challengeId: string, code: string) {
    return createHmac("sha256", this.otpKey)
      .update(challengeId + ":" + code)
      .digest("hex");
  }
  async challenge(
    method: "email" | "phone",
    target: string,
    linkCredential?: string,
  ) {
    const normalized =
      method === "email" ? target.trim().toLowerCase() : target.trim();
    if (
      method === "email"
        ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
        : !/^\+[1-9][0-9]{7,14}$/.test(normalized)
    )
      throw new DomainError(
        400,
        "invalid_target",
        "Use a valid email or an international +country-code phone number",
      );
    const link = linkCredential ? this.fresh(linkCredential) : null;
    this.rateLimit(`otp:${method}:${normalized}`, 5, 900000);
    const challengeId = id(),
      transaction = secret(),
      code = String(randomInt(0, 1000000)).padStart(6, "0"),
      expiresAt = this.now() + 300000;
    this.store.change((s) => {
      s.identity.challenges = s.identity.challenges.filter(
        (x) => x.expiresAt > this.now(),
      );
      s.identity.challenges.push({
        id: challengeId,
        transactionHash: digest(transaction),
        method,
        target: normalized,
        codeHash: this.otpHash(challengeId, code),
        expiresAt,
        attempts: 0,
        used: false,
        linkUserId: link?.userId ?? null,
        linkSessionId: link?.id ?? null,
      });
    });
    try {
      await this.delivery.send(method, normalized, code);
    } catch {
      this.store.change((s) => {
        const c = s.identity.challenges.find((x) => x.id === challengeId);
        if (c) c.used = true;
      });
      throw new DomainError(
        503,
        "delivery_unavailable",
        "Code delivery is unavailable",
      );
    }
    return { challengeId, transaction, expiresAt };
  }
  verifyChallenge(
    challengeId: string,
    transaction: string,
    code: string,
    installationId: string,
  ) {
    const result = this.store.change((s) => {
      const c = s.identity.challenges.find((x) => x.id === challengeId);
      if (
        !c ||
        c.used ||
        c.expiresAt <= this.now() ||
        c.attempts >= 5 ||
        c.transactionHash !== digest(transaction)
      )
        return null;
      c.attempts++;
      const actual = Buffer.from(this.otpHash(c.id, code), "hex"),
        expected = Buffer.from(c.codeHash, "hex");
      if (!timingSafeEqual(actual, expected)) return null;
      c.used = true;
      return { ...c };
    });
    if (!result) throw fail("Code expired, incorrect or already used");
    return this.finish(
      {
        connection: result.method,
        method: result.method,
        subject: result.target,
        tenant: null,
        email: result.method === "email" ? result.target : null,
        name: result.target,
      },
      installationId,
      result.linkSessionId ?? undefined,
    );
  }
  finish(
    identity: VerifiedIdentity,
    installationId: string,
    linkSessionId?: string,
    finalize?: (state: State, session: IdentitySession) => void,
  ) {
    const link = linkSessionId ? this.sessionById(linkSessionId) : null;
    if (link && this.now() - link.context.authenticatedAt > 300000)
      throw fail("Linking authentication expired");
    return this.store.change((s) => {
      if (s.hubs.length === 1)
        checkHubOrganization(s, s.hubs[0]!.id, identity.method, identity.tenant);
      let existing = s.identity.identities.find(
        (x) =>
          x.connection === identity.connection &&
          x.method === identity.method &&
          x.tenant === identity.tenant &&
          x.subject === identity.subject,
      );
      if (link && existing && existing.userId !== link.userId)
        throw new DomainError(
          409,
          "identity_in_use",
          "Identity belongs to another account; accounts are never automatically merged",
        );
      let userId = existing?.userId ?? link?.userId;
      if (!userId) {
        userId = id();
        s.users.push({
          id: userId,
          email: `${userId}@accounts.invalid`,
          name: identity.name.slice(0, 120) || "Member",
          passwordHash: "",
          disabled: false,
        });
      }
      forbid(
        s.users.some((u) => u.id === userId && !u.disabled),
        "Account disabled",
      );
      if (!existing) {
        existing = {
          id: id(),
          userId,
          connection: identity.connection,
          method: identity.method,
          subject: identity.subject,
          tenant: identity.tenant,
          email: identity.email,
          verifiedAt: this.now(),
        };
        s.identity.identities.push(existing);
        audit(
          s,
          userId,
          link ? "identity.link" : "identity.create",
          existing.id,
        );
      } else {
        // Email is current proof metadata. Connection, method, tenant and
        // subject are immutable identity coordinates, never account merge keys.
        existing.email = identity.email;
        existing.verifiedAt = this.now();
      }
      // Verified provider email is identity metadata, never an automatic account merge key.
      const context: LoginContext = {
        method: identity.method,
        identityId: existing.id,
        tenant: identity.tenant,
        authenticatedAt: this.now(),
      };
      const issued = this.issue(s, userId, context, installationId);
      finalize?.(s, issued.session);
      return issued;
    });
  }
  unlink(credential: string, identityId: string) {
    const session = this.fresh(credential);
    this.store.change((s) => {
      const identity = requireValue(
        s.identity.identities.find(
          (x) => x.id === identityId && x.userId === session.userId,
        ),
      );
      const user = requireValue(s.users.find((u) => u.id === session.userId));
      forbid(
        !!user.passwordHash ||
          s.identity.identities.some(
            (x) => x.userId === session.userId && x.id !== identity.id,
          ),
        "Keep at least one sign-in method",
      );
      s.identity.identities = s.identity.identities.filter(
        (x) => x.id !== identity.id,
      );
      for (const active of s.identity.sessions)
        if (active.context.identityId === identity.id) active.revoked = true;
      audit(s, session.userId, "identity.unlink", identity.id);
    });
  }
  issueRefresh(sessionId: string, familyId = id()) {
    const session = this.sessionById(sessionId),
      token = secret();
    this.store.change((s) =>
      s.identity.refresh.push({
        tokenHash: digest(token),
        familyId,
        sessionId: session.id,
        used: false,
        expiresAt: this.now() + 30 * 86400000,
      }),
    );
    return token;
  }
  rotateRefresh(token: string) {
    const found = this.store
      .read()
      .identity.refresh.find((x) => x.tokenHash === digest(token));
    if (!found) throw fail();
    const session = this.sessionById(found.sessionId);
    const next = secret();
    const ok = this.store.change((s) => {
      const current = requireValue(
        s.identity.refresh.find((x) => x.tokenHash === digest(token)),
      );
      if (current.used || current.expiresAt <= this.now()) {
        for (const r of s.identity.refresh.filter(
          (x) => x.familyId === current.familyId,
        )) {
          r.used = true;
          const ss = s.identity.sessions.find((x) => x.id === r.sessionId);
          if (ss) ss.revoked = true;
        }
        return false;
      }
      current.used = true;
      s.identity.refresh.push({
        tokenHash: digest(next),
        familyId: current.familyId,
        sessionId: current.sessionId,
        used: false,
        expiresAt: current.expiresAt,
      });
      return true;
    });
    if (!ok) throw fail("Refresh token reuse revoked this installation");
    return { refreshToken: next, session };
  }
  revoke(credential: string) {
    const session = this.session(credential);
    this.store.change((s) => {
      requireValue(
        s.identity.sessions.find((x) => x.id === session.id),
      ).revoked = true;
      audit(s, session.userId, "identity.logout", session.id);
    });
  }
  revokeRefresh(token: string) {
    this.store.change((s) => {
      const credential = s.identity.refresh.find(
        (r) => r.tokenHash === digest(token),
      );
      if (!credential) return;
      const session = s.identity.sessions.find(
        (x) => x.id === credential.sessionId,
      );
      if (session) {
        session.revoked = true;
        audit(s, session.userId, "identity.installation.revoke", session.id);
      }
    });
  }
}
