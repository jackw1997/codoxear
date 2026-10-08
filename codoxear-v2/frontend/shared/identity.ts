import { z } from "zod";
import {
  canonicalOrigin,
  credentialKey,
  refreshKey,
  type CredentialVault,
  type RelayProfile,
  ConnectionContext,
} from "./context.js";
import { ClientFailure } from "./transport.js";
const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(32),
  expires_in: z.number().positive(),
});
const Login = z.object({
  accountId: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
});
const Flow = z.object({
  state: z.string(),
  verifier: z.string(),
  expiresAt: z.number(),
});
const Hub = z.object({
  id: z.string(),
  name: z.string(),
  origin: z.string().nullable(),
  access: z.string(),
});
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** Shared native login lifecycle. Presenters open authorizeUrl in the system
 * browser and hand its registered callback back here. Every secret, including
 * the pending PKCE transaction, belongs in the platform's secure vault. */
export class IdentityClient {
  private login: z.infer<typeof Login> | null = null;
  private rotation: Promise<void> | undefined;
  private epoch = 0;
  private accountWork: Promise<unknown> = Promise.resolve();
  private usedHubKeys = new Set<string>();
  constructor(
    readonly issuer: string,
    readonly registration: {
      clientId: string;
      installationId: string;
      redirectUri: string;
    },
    private vault: CredentialVault,
    readonly context: ConnectionContext,
    private transport: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {
    canonicalOrigin(issuer);
    if (
      ![registration.clientId, registration.installationId].every((id) =>
        /^[A-Za-z0-9_-]{1,80}$/.test(id),
      )
    )
      throw new Error("Invalid installation/client ID");
    new URL(registration.redirectUri); // Server separately enforces exact registered callback.
  }
  private get installationId() {
    return this.registration.installationId;
  }
  private get clientId() {
    return this.registration.clientId;
  }
  private get redirectUri() {
    return this.registration.redirectUri;
  }
  private flowKey() {
    return JSON.stringify(["v2", "pkce", this.issuer, this.installationId]);
  }
  private key(accountId: string) {
    return refreshKey(this.issuer, accountId, this.installationId);
  }
  private async request(
    path: string,
    body?: unknown,
    accessToken?: string,
    origin = this.issuer,
  ) {
    const response = await this.transport(new URL(path, origin), {
      method: body === undefined ? "GET" : "POST",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(accessToken ? { Authorization: "Bearer " + accessToken } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok)
      throw new ClientFailure(
        response.status,
        value.code ?? "identity_rejected",
        value.error ?? "Sign-in request rejected",
      );
    return value;
  }
  async authorizeUrl() {
    const flow = {
      state: random(),
      verifier: random(),
      expiresAt: this.now() + 600000,
    };
    await this.vault.write(this.flowKey(), JSON.stringify(flow));
    const challenge = base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(flow.verifier),
        ),
      ),
    );
    return (
      this.issuer +
      "/oauth/authorize?" +
      new URLSearchParams({
        response_type: "code",
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
        code_challenge_method: "S256",
        code_challenge: challenge,
        state: flow.state,
      })
    );
  }
  private changeAccount<T>(
    operation: (current: () => void) => Promise<T>,
  ): Promise<T> {
    const epoch = ++this.epoch;
    this.context.select(null);
    const current = () => {
      if (epoch !== this.epoch) throw new Error("Account operation superseded");
    };
    const work = this.accountWork
      .catch(() => {})
      .then(async () => {
        current();
        await this.rotation?.catch(() => {});
        current();
        for (const key of this.usedHubKeys) await this.vault.remove(key);
        this.usedHubKeys.clear();
        current();
        return operation(current);
      });
    this.accountWork = work;
    return work;
  }
  finish(callback: string) {
    return this.changeAccount((current) =>
      this.finishCurrent(callback, current),
    );
  }
  private async finishCurrent(callback: string, current: () => void) {
    const url = new URL(callback),
      expected = new URL(this.redirectUri);
    if (
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      url.hash ||
      expected.search
    )
      throw new ClientFailure(
        400,
        "invalid_callback",
        "Callback does not match this installation",
      );
    const stored = await this.vault.read(this.flowKey());
    const flow = stored ? Flow.parse(JSON.parse(stored)) : null;
    if (
      !flow ||
      flow.state !== url.searchParams.get("state") ||
      flow.expiresAt <= this.now()
    )
      throw new ClientFailure(
        401,
        "invalid_state",
        "Sign-in transaction expired or belongs to another installation",
      );
    await this.vault.remove(this.flowKey()); // Consume before exchange; lost responses never reuse a code.
    if (!url.searchParams.get("code") || url.searchParams.has("error"))
      throw new ClientFailure(401, "login_cancelled", "Sign-in was cancelled");
    const tokens = TokenResponse.parse(
      await this.request("/oauth/token", {
        grant_type: "authorization_code",
        code: url.searchParams.get("code"),
        client_id: this.clientId,
        installation_id: this.installationId,
        redirect_uri: this.redirectUri,
        code_verifier: flow.verifier,
      }),
    );
    const me = z
      .object({ id: z.string() })
      .parse(await this.request("/api/v1/me", undefined, tokens.access_token));
    current();
    const login = {
      accountId: me.id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: this.now() + tokens.expires_in * 1000,
    };
    await this.vault.write(this.key(me.id), JSON.stringify(login));
    try {
      current();
    } catch (e) {
      await this.vault.remove(this.key(me.id));
      throw e;
    }
    this.login = login;
    return me.id;
  }
  restore(accountId: string) {
    return this.changeAccount((current) =>
      this.restoreCurrent(accountId, current),
    );
  }
  private async restoreCurrent(accountId: string, current: () => void) {
    this.login = null;
    const stored = await this.vault.read(this.key(accountId));
    const login = stored ? Login.parse(JSON.parse(stored)) : null;
    if (login?.accountId !== accountId)
      throw new ClientFailure(401, "login_required", "Sign in to this account");
    current();
    this.login = login;
    await this.fresh();
    current();
  }
  private async fresh() {
    if (!this.login)
      throw new ClientFailure(401, "login_required", "Sign in first");
    if (this.login.expiresAt > this.now() + 30000) return;
    this.rotation ??= (async () => {
      const before = this.login!,
        epoch = this.epoch;
      try {
        const tokens = TokenResponse.parse(
          await this.request("/oauth/token", {
            grant_type: "refresh_token",
            refresh_token: before.refreshToken,
          }),
        );
        if (epoch !== this.epoch)
          throw new Error("Account changed during refresh");
        const next = {
          ...before,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: this.now() + tokens.expires_in * 1000,
        };
        await this.vault.write(this.key(next.accountId), JSON.stringify(next));
        if (epoch === this.epoch) this.login = next;
      } catch (e) {
        await this.vault.remove(this.key(before.accountId));
        if (epoch === this.epoch) {
          this.login = null;
          await this.clearSelected();
        }
        throw e; // Rotation may have committed: require login, never replay the old token.
      }
    })().finally(() => {
      this.rotation = undefined;
    });
    await this.rotation;
  }
  async hubs() {
    const epoch = this.epoch;
    await this.fresh();
    const result = z
      .array(Hub)
      .parse(
        await this.request(
          "/api/v1/me/hubs",
          undefined,
          this.login!.accessToken,
        ),
      );
    if (epoch !== this.epoch)
      throw new Error("Account changed while loading hubs");
    return result;
  }
  async computers(hubId: string) {
    const epoch = this.epoch;
    const hub = (await this.hubs()).find((h) => h.id === hubId);
    if (!hub?.origin || hub.access !== "allowed")
      throw new ClientFailure(
        403,
        "hub_unavailable",
        "Sign in with this hub's required method",
      );
    canonicalOrigin(hub.origin);
    const token = z
      .object({
        accessToken: z.string(),
        hubId: z.string(),
        origin: z.string(),
      })
      .parse(
        await this.request(
          "/api/v1/hub-token",
          { hubId },
          this.login!.accessToken,
        ),
      );
    if (token.hubId !== hubId || token.origin !== hub.origin)
      throw new Error("Hub directory changed; choose again");
    const computers = z
      .array(z.object({ id: z.string(), name: z.string() }).passthrough())
      .parse(
        await this.request(
          "/api/v1/computers",
          undefined,
          token.accessToken,
          hub.origin,
        ),
      );
    if (epoch !== this.epoch)
      throw new Error("Account changed while loading computers");
    return { hub, token: token.accessToken, computers };
  }
  async selectComputer(
    hubId: string,
    computerId: string,
  ): Promise<RelayProfile> {
    const epoch = this.epoch,
      result = await this.computers(hubId);
    if (epoch !== this.epoch || !this.login)
      throw new Error("Account changed while choosing computer");
    if (!result.computers.some((c) => c.id === computerId))
      throw new ClientFailure(
        403,
        "computer_unavailable",
        "Computer access is no longer available",
      );
    const profile: RelayProfile = {
      mode: "relay",
      id: JSON.stringify([hubId, computerId]),
      origin: result.hub.origin!,
      issuer: this.issuer,
      accountId: this.login.accountId,
      hubId,
      computerId,
    };
    const key = credentialKey(profile);
    await this.vault.write(key, result.token);
    this.usedHubKeys.add(key);
    if (epoch !== this.epoch) {
      await this.vault.remove(key);
      throw new Error("Account changed while choosing computer");
    }
    this.context.select(profile);
    return profile;
  }
  private async clearSelected() {
    this.epoch++;
    this.context.select(null);
    for (const key of this.usedHubKeys) await this.vault.remove(key);
    this.usedHubKeys.clear();
  }
  logout() {
    return this.changeAccount(async (current) => {
      const login = this.login;
      this.login = null;
      if (!login) return;
      await this.vault.remove(this.key(login.accountId));
      current();
      await this.request("/oauth/revoke", { token: login.refreshToken });
    });
  }
}
