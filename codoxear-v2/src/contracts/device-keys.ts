import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
// Only public P-256 coordinates cross the client/Hub boundary. Reject private
// material and extra JWK parameters instead of silently storing them.
export const DevicePublicKey = z.object({
  kty: z.literal("EC"), crv: z.literal("P-256"), x: coordinate, y: coordinate,
}).strict();
export type DevicePublicKey = z.infer<typeof DevicePublicKey>;
export const DeviceKeyEnrollmentRequest = z.object({
  publicKey: DevicePublicKey,
  name: z.string().trim().min(1).max(120),
  installationId: identifier,
}).strict();
export const DeviceKeyLoginRequest = z.object({
  keyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  installationId: identifier,
}).strict();
export const DeviceKeyProof = z.object({
  challengeId: identifier,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();
export const DeviceKeyChallengeResponse = z.object({
  challengeId: identifier, payload: z.string(), expiresAt: z.number(),
}).strict();
export const DeviceKeyMetadata = z.object({
  id: z.string(), name: z.string(), installationId: identifier,
  createdAt: z.number(), lastUsedAt: z.number().nullable(),
}).strict();
