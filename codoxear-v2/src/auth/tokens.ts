import {
  generateKeyPair,
  exportJWK,
  importJWK,
  SignJWT,
  jwtVerify,
  createLocalJWKSet,
  type JWK,
} from "jose";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { atomicJson } from "../persistence/files.js";
import { DomainError } from "../contracts/model.js";
import { type IdentitySession } from "./model.js";
export async function signingKey(path?: string): Promise<JWK> {
  if (path) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const { privateKey } = await generateKeyPair("EdDSA", { extractable: true }),
    jwk = await exportJWK(privateKey);
  jwk.kid = createHash("sha256")
    .update(jwk.x!)
    .digest("base64url")
    .slice(0, 24);
  jwk.alg = "EdDSA";
  jwk.use = "sig";
  if (path) await atomicJson(path, jwk);
  return jwk;
}
export class Tokens {
  readonly jwks: { keys: JWK[] };
  constructor(
    readonly issuer: string,
    private key: JWK,
  ) {
    const { d, ...publicKey } = key;
    this.jwks = { keys: [publicKey] };
  }
  async issue(
    session: IdentitySession,
    audience: string,
    kind: "hub_access" | "identity_access" = "hub_access",
  ) {
    const key = await importJWK(this.key, "EdDSA");
    return new SignJWT({ sid: session.id, kind, auth: session.context })
      .setProtectedHeader({ alg: "EdDSA", kid: this.key.kid!, typ: "at+jwt" })
      .setIssuer(this.issuer)
      .setAudience(audience)
      .setSubject(session.userId)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
  }
  async verify(
    token: string,
    audience: string,
    kind: "hub_access" | "identity_access" = "hub_access",
  ) {
    try {
      const { payload, protectedHeader } = await jwtVerify(
        token,
        createLocalJWKSet(this.jwks),
        {
          issuer: this.issuer,
          audience,
          algorithms: ["EdDSA"],
          typ: "at+jwt",
          requiredClaims: ["exp", "iat", "sub", "sid"],
        },
      );
      if (
        payload.kind !== kind ||
        payload.aud !== audience ||
        typeof payload.sid !== "string" ||
        protectedHeader.typ !== "at+jwt"
      )
        throw new Error("Token scope mismatch");
      return { userId: payload.sub!, sessionId: payload.sid };
    } catch {
      throw new DomainError(
        401,
        "invalid_token",
        "Token expired, invalid, or addressed to another service",
      );
    }
  }
}
