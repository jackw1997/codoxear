import { createHash } from "node:crypto";

/** OAR requires UUID input identity; durable tunnel receipts remain opaque.
 * Stable UUIDv8 mapping preserves retry correlation without storing credentials
 * or rewriting the Computer's original receipt/message keys. */
export function oarInputId(receiptId: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(receiptId))
    return receiptId;
  const bytes = createHash("sha256")
    .update("codoxear-oar-input-id:v1\0")
    .update(receiptId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
