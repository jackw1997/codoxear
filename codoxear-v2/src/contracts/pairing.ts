export const PAIRING_LIFETIME_SECONDS = 15 * 60;
export const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Accept typed short codes without changing previously issued long tokens. */
export function normalizePairingCode(value: string): string {
  const trimmed = value.trim();
  return /^[A-HJ-NP-Z2-9]{4}[- ]?[A-HJ-NP-Z2-9]{4}$/i.test(trimmed)
    ? trimmed.replace(/[- ]/g, "").toUpperCase()
    : trimmed;
}
