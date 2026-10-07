import { createHash, createPublicKey, verify } from "node:crypto";
import { DevicePublicKey, type DeviceKeyEnrollmentRequest, type DeviceKeyLoginRequest } from "../contracts/device-keys.js";
import { DomainError, type State } from "../contracts/model.js";
import { audit, id, secret } from "../domain/commands.js";
import type { IdentitySession } from "./model.js";
import type { Accounts } from "./accounts.js";
import { checkHubOrganization } from "./hub-organization.js";

type Enrollment = import("zod").infer<typeof DeviceKeyEnrollmentRequest>;
type Login = import("zod").infer<typeof DeviceKeyLoginRequest>;
type Challenge = State["identity"]["deviceKeyChallenges"][number];
const rejected = () => new DomainError(401, "invalid_key_proof", "Client key proof expired, invalid or already used");

export function deviceKeyId(input: DevicePublicKey): string {
  const key = DevicePublicKey.parse(input);
  for (const coordinate of [key.x, key.y])
    if (Buffer.from(coordinate, "base64url").toString("base64url") !== coordinate)
      throw new DomainError(400, "invalid_public_key", "Invalid public key coordinate");
  try { createPublicKey({ key, format: "jwk" }); }
  catch { throw new DomainError(400, "invalid_public_key", "Invalid P-256 public key"); }
  return createHash("sha256").update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })).digest("base64url");
}

/** The Hub stores public keys and short-lived proof challenges. Private keys
 * remain in the client's vault; provider credentials never become local keys. */
export class DeviceKeys {
  constructor(readonly accounts: Accounts, readonly issuer: string, private now = Date.now) {}
  private enrollmentSession(source: IdentitySession) {
    const current = this.accounts.sessionById(source.id);
    const identity = this.accounts.store.read().identity.identities.find((i) =>
      i.id === current.context.identityId && i.userId === current.userId && i.verifiedAt > 0);
    if (current.deviceKeyId || !identity || !["google", "feishu"].includes(identity.method) ||
      current.context.method !== identity.method || current.context.tenant !== identity.tenant ||
      this.now() - current.context.authenticatedAt > 300000)
      throw new DomainError(401, "reauthentication_required", "Sign in with Google or Feishu before registering this client");
    return current;
  }
  enrollChallenge(source: IdentitySession, input: Enrollment) {
    const current = this.enrollmentSession(source), keyId = deviceKeyId(input.publicKey);
    const existing = this.accounts.store.read().identity.deviceKeys;
    if (existing.some((key) => key.id === keyId))
      throw new DomainError(409, "key_in_use", "This client key is already registered");
    if (existing.filter((key) => key.userId === current.userId && !key.revoked).length >= 50)
      throw new DomainError(409, "key_limit", "Remove an unused client key before registering another");
    return this.challenge({
      purpose: "enroll", keyId, publicKey: input.publicKey, installationId: input.installationId,
      name: input.name, enrollmentSessionId: current.id,
    });
  }
  loginChallenge(input: Login) {
    const state = this.accounts.store.read(), key = state.identity.deviceKeys.find((key) => key.id === input.keyId && !key.revoked);
    if (!key || !state.users.some((user) => user.id === key.userId && !user.disabled) || key.installationId !== input.installationId)
      throw rejected();
    if (state.hubs.length === 1)
      checkHubOrganization(state, state.hubs[0]!.id, key.context.method, key.context.tenant);
    return this.challenge({ purpose: "login", keyId: key.id, publicKey: key.publicKey,
      installationId: key.installationId, name: key.name, enrollmentSessionId: null });
  }
  private challenge(input: Omit<Challenge, "id" | "issuer" | "payload" | "expiresAt" | "used">) {
    const challengeId = id(), expiresAt = this.now() + 120000;
    const payload = JSON.stringify({ protocol: "codoxear-client-key-v1", issuer: this.issuer,
      purpose: input.purpose, challengeId, nonce: secret(), keyId: input.keyId,
      installationId: input.installationId, expiresAt });
    this.accounts.store.change((state) => {
      state.identity.deviceKeyChallenges = state.identity.deviceKeyChallenges.filter((row) => row.expiresAt > this.now() && !row.used);
      state.identity.deviceKeyChallenges.push({ ...input, id: challengeId, issuer: this.issuer, payload, expiresAt, used: false });
    });
    return { challengeId, payload, expiresAt };
  }
  private consume(challengeId: string, purpose: Challenge["purpose"], signature: string, enrollmentSessionId: string | null) {
    // Consume before inspecting the signature. Failed proofs cannot be retried,
    // and transaction rollback never makes an attempted challenge reusable.
    const row = this.accounts.store.change((state) => {
      const challenge = state.identity.deviceKeyChallenges.find((row) => row.id === challengeId && !row.used);
      if (!challenge) return null;
      challenge.used = true;
      return { ...challenge };
    });
    if (!row || row.purpose !== purpose || row.issuer !== this.issuer || row.expiresAt <= this.now() ||
      row.enrollmentSessionId !== enrollmentSessionId) throw rejected();
    const bytes = Buffer.from(signature, "base64url");
    if (bytes.length !== 64 || bytes.toString("base64url") !== signature) throw rejected();
    const valid = verify("sha256", Buffer.from(row.payload, "utf8"), {
      key: createPublicKey({ key: row.publicKey, format: "jwk" }), dsaEncoding: "ieee-p1363",
    }, bytes);
    if (!valid) throw rejected();
    return row;
  }
  enrollVerify(source: IdentitySession, challengeId: string, signature: string) {
    const current = this.enrollmentSession(source), row = this.consume(challengeId, "enroll", signature, current.id);
    return this.enrollVerifiedPublicKey(current, { publicKey: row.publicKey, name: row.name, installationId: row.installationId });
  }
  /** Internal enrollment boundary. The caller must already have verified a
   * signature proving possession of this exact public key. Never expose this
   * method as an HTTP operation without that proof. */
  enrollVerifiedPublicKey(source: IdentitySession, input: Enrollment, allowExisting = false) {
    const current = this.enrollmentSession(source), keyId = deviceKeyId(input.publicKey);
    this.accounts.store.change((state) => {
      const existing = state.identity.deviceKeys.find((key) => key.id === keyId);
      if (existing && allowExisting && existing.userId === current.userId && !existing.revoked && existing.installationId === input.installationId) {
        existing.context = current.context;
        return;
      }
      if (existing)
        throw new DomainError(409, "key_in_use", "This client key is already registered");
      if (state.identity.deviceKeys.filter((key) => key.userId === current.userId && !key.revoked).length >= 50)
        throw new DomainError(409, "key_limit", "Remove an unused client key before registering another");
      state.identity.deviceKeys.push({ id: keyId, userId: current.userId, publicKey: input.publicKey,
        name: input.name, installationId: input.installationId, context: current.context,
        createdAt: this.now(), lastUsedAt: null, revoked: false });
      audit(state, current.userId, "identity.client-key.enroll", keyId);
    });
    return { keyId };
  }
  loginVerify(challengeId: string, signature: string) {
    const row = this.consume(challengeId, "login", signature, null);
    return this.accounts.deviceKey(row.keyId, row.installationId);
  }
  list(source: IdentitySession) {
    const current = this.accounts.sessionById(source.id);
    return this.accounts.store.read().identity.deviceKeys.filter((key) => key.userId === current.userId && !key.revoked)
      .map(({ id, name, installationId, createdAt, lastUsedAt }) => ({ id, name, installationId, createdAt, lastUsedAt }));
  }
  revoke(source: IdentitySession, keyId: string) {
    const current = this.accounts.sessionById(source.id);
    this.accounts.store.change((state) => {
      const key = state.identity.deviceKeys.find((key) => key.id === keyId && key.userId === current.userId);
      if (!key) throw new DomainError(404, "not_found", "Client key not found");
      key.revoked = true;
      // Revocation also invalidates forked credentials and delegated permits.
      // Retain the public-key tombstone so the same key cannot be registered
      // again, but discard its unusable session tree and transient references.
      const removed = new Set(state.identity.sessions.filter((row) => row.deviceKeyId === keyId).map((row) => row.id));
      const descendants = new Map<string, string[]>();
      for (const row of state.identity.sessions) if (row.parentId) {
        const children = descendants.get(row.parentId) ?? [];
        children.push(row.id); descendants.set(row.parentId, children);
      }
      const queue = [...removed];
      for (let index = 0; index < queue.length; index++)
        for (const child of descendants.get(queue[index]!) ?? []) if (!removed.has(child)) {
          removed.add(child); queue.push(child);
        }
      state.identity.sessions = state.identity.sessions.filter((row) => !removed.has(row.id));
      state.identity.refresh = state.identity.refresh.filter((row) => !removed.has(row.sessionId));
      state.identity.codes = state.identity.codes.filter((row) => !removed.has(row.sessionId));
      state.identity.queuePermits = state.identity.queuePermits.filter((row) => !removed.has(row.sessionId));
      state.identity.challenges = state.identity.challenges.filter((row) => !row.linkSessionId || !removed.has(row.linkSessionId));
      state.identity.flows = state.identity.flows.filter((row) => !row.linkSessionId || !removed.has(row.linkSessionId));
      state.identity.deviceKeyChallenges = state.identity.deviceKeyChallenges.filter((row) =>
        row.keyId !== keyId && (!row.enrollmentSessionId || !removed.has(row.enrollmentSessionId)));
      audit(state, current.userId, "identity.client-key.revoke", keyId);
    });
  }
}
