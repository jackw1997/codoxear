/** Platform-neutral profile contract. Native presenters supply a secure vault and transport. */
export type DirectProfile = {
  mode: "direct";
  id: string;
  origin: string;
  accountId: string;
};
export type RelayProfile = {
  mode: "relay";
  id: string;
  origin: string;
  issuer: string;
  accountId: string;
  hubId: string;
  computerId: string;
};
export type ConnectionProfile = DirectProfile | RelayProfile;
export interface CredentialVault {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export function canonicalOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Use an exact HTTPS origin; HTTP is allowed only for loopback development",
    );
  return value;
}
export function profileKey(profile: ConnectionProfile): string {
  return JSON.stringify(
    profile.mode === "relay"
      ? [
          "v2",
          "relay",
          profile.issuer,
          profile.accountId,
          profile.hubId,
          profile.computerId,
        ]
      : ["v2", "direct", profile.id, profile.origin, profile.accountId],
  );
}
export function credentialKey(profile: ConnectionProfile): string {
  return JSON.stringify(
    profile.mode === "relay"
      ? ["v2", "hub-access", profile.issuer, profile.accountId, profile.hubId]
      : ["v2", "direct-cookie", profile.id, profile.origin, profile.accountId],
  );
}
export function directPasswordKey(profile: DirectProfile): string {
  return JSON.stringify([
    "v2",
    "direct-password",
    profile.id,
    profile.origin,
    profile.accountId,
  ]);
}
export function refreshKey(
  issuer: string,
  accountId: string,
  installationId: string,
): string {
  return JSON.stringify([
    "v2",
    "identity-refresh",
    canonicalOrigin(issuer),
    accountId,
    installationId,
  ]);
}
export function recoveryKey(
  profile: ConnectionProfile,
  sessionId: string,
  kind = "draft",
): string {
  return JSON.stringify([profileKey(profile), sessionId, kind]);
}
export function apiAddress(profile: ConnectionProfile, path: string): string {
  canonicalOrigin(profile.origin);
  if (!path.startsWith("/api/") || /[\\\r\n\0]/.test(path))
    throw new Error("An API-relative path is required");
  const raw = path.split("?")[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error("Invalid path encoding");
  }
  if (
    decoded.includes("%") ||
    decoded.includes("\\") ||
    decoded.split("/").some((p) => p === "." || p === "..")
  )
    throw new Error("Non-canonical API path");
  const prefix =
    profile.mode === "relay"
      ? "/api/v1/computers/" + encodeURIComponent(profile.computerId)
      : "";
  return profile.origin + prefix + path;
}
export class SupersededConnection extends Error {
  constructor() {
    super("Request belongs to a previous connection");
  }
}
/** All selected-context work captures a generation. Switching aborts every old request. */
export class ConnectionContext {
  private generation = 0;
  private current: ConnectionProfile | null = null;
  private pending = new Set<AbortController>();
  select(profile: ConnectionProfile | null) {
    if (profile) {
      canonicalOrigin(profile.origin);
      if (profile.mode === "relay") canonicalOrigin(profile.issuer);
    }
    this.generation++;
    for (const c of this.pending) c.abort(new SupersededConnection());
    this.pending.clear();
    this.current = profile ? Object.freeze({ ...profile }) : null;
  }
  get profile() {
    return this.current;
  }
  capture() {
    const profile = this.current;
    if (!profile) throw new Error("Choose a connection");
    const generation = this.generation,
      controller = new AbortController();
    this.pending.add(controller);
    return {
      profile,
      generation,
      signal: controller.signal,
      assertCurrent: () => {
        if (generation !== this.generation || controller.signal.aborted)
          throw new SupersededConnection();
      },
      release: () => this.pending.delete(controller),
    };
  }
}
