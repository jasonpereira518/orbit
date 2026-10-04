import { sanitizeDraft } from "@/lib/chat-draft";

export const SIGNATURE_MAX = 600;
const DELIMITER = "\n\n-- \n";

/**
 * A signature as stored and sent: plain text only (markup stays literal text — nothing renders
 * it), invisible and control characters stripped by the same cleaner drafts use, capped at
 * SIGNATURE_MAX. Null means no signature. Pure: safe for client code.
 */
export function cleanSignature(raw: unknown): string | null {
  const cleaned = sanitizeDraft(raw);
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, SIGNATURE_MAX).join("").trim() || null;
}

/** Appends with the standard `-- ` delimiter, once. */
export function appendSignature(body: string, signature: string | null): string {
  if (!signature) return body;
  if (body.endsWith(`${DELIMITER}${signature}`)) return body;
  return `${body}${DELIMITER}${signature}`;
}
