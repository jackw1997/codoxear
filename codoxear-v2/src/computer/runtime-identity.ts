import { DomainError } from "../contracts/model.js";
/** Updated brokers allocate a fresh 128-bit session identity, independent of PID. */
export function relaySessionId(value: unknown): value is string {
  return typeof value === "string" && /^(?:broker|managed)-[a-f0-9]{32}$/.test(value);
}
export function requireRelaySessionId(value: string): void {
  if (!relaySessionId(value)) throw new DomainError(409, "runtime_upgrade_required",
    "This session uses an older runtime identity. Continue it in direct mode, or resume it with an updated broker before publishing it to a hub.");
}
