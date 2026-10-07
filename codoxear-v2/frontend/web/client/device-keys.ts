import { canonicalOrigin } from "../../shared/context.js";

export interface DeviceIdentity {
  id: string;
  origin: string;
  accountId: string;
  accountName: string;
  installationId: string;
  privateKey: CryptoKey;
  createdAt: number;
}
let opening: Promise<IDBDatabase> | undefined;
function database() {
  return (opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("codoxear-device-identities", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
async function op<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("keys", mode);
    const request = work(tx.objectStore("keys"));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export const deviceKeys = {
  list: () => op<DeviceIdentity[]>("readonly", (store) => store.getAll()),
  get: (origin: string, id: string) =>
    op<DeviceIdentity | undefined>("readonly", (store) =>
      store.get(JSON.stringify([canonicalOrigin(origin), id])),
    ),
  put: (key: DeviceIdentity) =>
    op("readwrite", (store) =>
      store.put(key, JSON.stringify([canonicalOrigin(key.origin), key.id])),
    ),
  remove: (origin: string, id: string) =>
    op("readwrite", (store) =>
      store.delete(JSON.stringify([canonicalOrigin(origin), id])),
    ),
};
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export class DeviceSignInError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: unknown) {
    super(
      [401, 403].includes(status)
        ? "Device sign-in rejected. Continue with Google or Feishu again."
        : "Device sign-in is temporarily unavailable. Retry when the Hub is reachable.",
    );
    this.name = "DeviceSignInError";
    this.status = status;
    this.code =
      typeof code === "string" && /^[a-z0-9_]{1,100}$/.test(code)
        ? code
        : undefined;
  }
}
export async function keyRequest(
  origin: string,
  path: string,
  body: unknown,
  accessToken?: string,
) {
  canonicalOrigin(origin);
  const response = await fetch(origin + path, {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: "Bearer " + accessToken } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    throw new DeviceSignInError(response.status, failure?.code);
  }
  return response.json();
}
async function signChallenge(
  privateKey: CryptoKey,
  challenge: { challengeId: string; payload: string; expiresAt: number },
  expected: {
    origin: string;
    purpose: string;
    keyId: string;
    installationId: string;
  },
) {
  if (
    typeof challenge.payload !== "string" ||
    !Number.isFinite(challenge.expiresAt) ||
    challenge.expiresAt <= Date.now()
  )
    throw new Error("Device sign-in challenge expired");
  const payload = JSON.parse(challenge.payload);
  if (
    payload.protocol !== "codoxear-client-key-v1" ||
    payload.issuer !== expected.origin ||
    payload.purpose !== expected.purpose ||
    payload.keyId !== expected.keyId ||
    payload.installationId !== expected.installationId ||
    payload.challengeId !== challenge.challengeId ||
    payload.expiresAt !== challenge.expiresAt ||
    typeof payload.nonce !== "string"
  )
    throw new Error(
      "Device sign-in challenge does not match this account and hub",
    );
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        new TextEncoder().encode(challenge.payload),
      ),
    ),
  );
}
export async function enrollDevice(
  origin: string,
  account: { id: string; name: string },
  accessToken: string,
): Promise<DeviceIdentity> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const installationId = crypto.randomUUID();
  const keyId = base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify({
            crv: publicKey.crv,
            kty: publicKey.kty,
            x: publicKey.x,
            y: publicKey.y,
          }),
        ),
      ),
    ),
  );
  const challenge = await keyRequest(
    origin,
    "/api/v1/auth/keys/enroll/challenge",
    {
      publicKey: {
        kty: publicKey.kty,
        crv: publicKey.crv,
        x: publicKey.x,
        y: publicKey.y,
      },
      name: "Browser device",
      installationId,
    },
    accessToken,
  );
  const verified = await keyRequest(
    origin,
    "/api/v1/auth/keys/enroll/verify",
    {
      challengeId: challenge.challengeId,
      signature: await signChallenge(pair.privateKey, challenge, {
        origin,
        purpose: "enroll",
        keyId,
        installationId,
      }),
    },
    accessToken,
  );
  if (verified.keyId !== keyId)
    throw new Error("Hub returned a different device key");
  const key: DeviceIdentity = {
    id: keyId,
    origin,
    accountId: account.id,
    accountName: account.name,
    installationId,
    privateKey: pair.privateKey,
    createdAt: Date.now(),
  };
  await deviceKeys.put(key);
  return key;
}
export async function proveDevice(key: DeviceIdentity) {
  const challenge = await keyRequest(
    key.origin,
    "/api/v1/auth/keys/challenge",
    { keyId: key.id, installationId: key.installationId },
  );
  return keyRequest(key.origin, "/api/v1/auth/keys/verify", {
    challengeId: challenge.challengeId,
    signature: await signChallenge(key.privateKey, challenge, {
      origin: key.origin,
      purpose: "login",
      keyId: key.id,
      installationId: key.installationId,
    }),
  });
}
