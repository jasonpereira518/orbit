/**
 * E.164 for a phone-looking sender label, or null. Browser-safe twin of normalizePhone in
 * src/lib/duplicates.ts (which cannot be imported here) — scripts/smoke-chat-parsers.ts
 * asserts the two agree. If they ever differ, duplicates.ts is right.
 */
export function normalizePhoneLoose(value: string): string | null {
  const trimmed = value.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (hasPlus) return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}
