import { checkRecipient } from "@/lib/chat-send";
import { MAX_RECIPIENTS } from "@/lib/email/config";

export type RecipientsResult =
  | { ok: true; to: string[]; cc: string[]; bcc: string[]; all: string[] }
  | {
      ok: false;
      reason: "no_recipient" | "too_many" | "invalid_recipient" | "placeholder";
      address?: string;
    };

/**
 * Validates and normalizes To/CC/BCC. Each entry must be exactly one mailbox
 * (`checkRecipient` refuses commas, angle brackets, whitespace and control characters, which
 * is also what keeps CR/LF out of the headers). Addresses are lowercased and deduped across
 * all three fields; the first field an address appears in keeps it.
 */
export function normalizeRecipients(input: {
  to: string[];
  cc?: string[];
  bcc?: string[];
}): RecipientsResult {
  const seen = new Set<string>();
  const out = { to: [] as string[], cc: [] as string[], bcc: [] as string[] };
  for (const field of ["to", "cc", "bcc"] as const) {
    for (const raw of input[field] ?? []) {
      const check = checkRecipient(raw);
      if (!check.ok) {
        if (check.reason === "no_email") continue; // a blank chip, not an address
        return { ok: false, reason: check.reason, address: raw.trim() };
      }
      const email = check.email.toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      out[field].push(email);
    }
  }
  if (out.to.length === 0) return { ok: false, reason: "no_recipient" };
  if (seen.size > MAX_RECIPIENTS) return { ok: false, reason: "too_many" };
  return { ok: true, ...out, all: [...seen] };
}
