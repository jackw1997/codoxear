import { z } from "zod";
import { Id } from "../contracts/model.js";
export const CHUNK_BYTES = 64 * 1024,
  STREAM_WINDOW = 1024 * 1024,
  COMPUTER_WINDOW = 16 * 1024 * 1024,
  MAX_STREAMS = 16;
export const Headers = z
  .record(z.string().max(80), z.string().max(8192))
  .refine((h) => JSON.stringify(h).length <= 16384);
export const RequestHead = z.object({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"]),
  path: z.string().min(1).max(8192),
  headers: Headers,
  actorId: Id.optional(),
  workspace: z.object({ id: z.literal("default"), access: z.enum(["read", "write"]) }).optional(),
  queuePermit: z.string().max(200).optional(),
});
export const ResponseHead = z.object({
  status: z.number().int().min(100).max(599),
  headers: Headers,
});
const scope = { id: Id, epoch: Id };
export const HttpFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("http.request"), ...scope, head: RequestHead }),
  z.object({ type: z.literal("http.response"), ...scope, head: ResponseHead }),
  z.object({
    type: z.literal("http.chunk"),
    ...scope,
    direction: z.enum(["request", "response"]),
    sequence: z.number().int().nonnegative(),
    data: z.string().max(Math.ceil(CHUNK_BYTES / 3) * 4),
  }),
  z.object({
    type: z.literal("http.end"),
    ...scope,
    direction: z.enum(["request", "response"]),
    sequence: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("http.credit"),
    ...scope,
    direction: z.enum(["request", "response"]),
    bytes: z.number().int().positive().max(STREAM_WINDOW),
  }),
  z.object({
    type: z.literal("http.cancel"),
    ...scope,
    reason: z.string().max(200),
  }),
]);
export type HttpFrame = z.infer<typeof HttpFrame>;
export type RequestHead = z.infer<typeof RequestHead>;
export type ResponseHead = z.infer<typeof ResponseHead>;
export type Bytes = AsyncIterable<Uint8Array>;
export interface HttpRequest extends RequestHead {
  body: Bytes;
  signal: AbortSignal;
}
export interface HttpResponse extends ResponseHead {
  body: Bytes;
}
export const emptyBody: Bytes = { async *[Symbol.asyncIterator]() {} };
