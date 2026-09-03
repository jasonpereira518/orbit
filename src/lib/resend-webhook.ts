import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Standard Webhooks signature verification, as used by Resend (and by Svix, which is where
 * Clerk's `verifyWebhook` gets it).
 *
 * IMPLEMENTED RATHER THAN INSTALLED. The scheme is a documented twenty lines — an HMAC over
 * `id.timestamp.body` — and `svix` is not already a dependency here. Clerk brings its own
 * verifier and Stripe brings its own; adding a third party's SDK to parse three headers
 * would be the larger commitment.
 *
 * The parts that are easy to get wrong, and are therefore deliberate:
 *   - The signature covers the RAW body. Parsing to JSON first and re-serialising changes
 *     the bytes and every signature fails, so the caller must pass `await req.text()`.
 *   - Timestamp tolerance is enforced. Without it a captured request replays forever.
 *   - Comparison is timing-safe, and the header may carry several space-separated
 *     signatures (Svix sends both during a secret rotation), so every one is checked.
 */

/** How far out of step a delivery's timestamp may be before it is treated as a replay. */
export const TIMESTAMP_TOLERANCE_S = 5 * 60;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "bad_timestamp" | "bad_signature" };

export function resendWebhookSecret(): string | null {
  return process.env.RESEND_WEBHOOK_SECRET?.trim() || null;
}

/** `whsec_<base64>` — the prefix is not part of the key material. */
function secretKey(secret: string): Buffer {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(raw, "base64");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself leak length — so the
  // lengths are compared first and the result folded in.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyResendSignature(input: {
  secret: string;
  /** The raw request body, byte-for-byte as received. */
  payload: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  /** Seconds since epoch; injectable so the tolerance window is testable. */
  nowSeconds?: number;
}): VerifyResult {
  const { secret, payload, id, timestamp, signature } = input;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const sent = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sent)) return { ok: false, reason: "bad_timestamp" };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  // Both directions: a future timestamp is as suspicious as an old one.
  if (Math.abs(now - sent) > TIMESTAMP_TOLERANCE_S) {
    return { ok: false, reason: "bad_timestamp" };
  }

  const expected = createHmac("sha256", secretKey(secret))
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");

  // `v1,<sig>` entries, space separated. Versions other than v1 are ignored rather than
  // guessed at.
  const candidates = signature
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const comma = part.indexOf(",");
      return comma === -1
        ? { version: "v1", value: part }
        : { version: part.slice(0, comma), value: part.slice(comma + 1) };
    })
    .filter((part) => part.version === "v1")
    .map((part) => part.value);

  const matched = candidates.some((candidate) => safeEqual(candidate, expected));
  return matched ? { ok: true } : { ok: false, reason: "bad_signature" };
}

/**
 * The Resend event types this app acts on.
 *
 * A hard bounce means the address does not exist; a complaint means the recipient pressed
 * "spam". Both must stop mail immediately — continuing to send to either is precisely what
 * gets a sending domain throttled, and a complaint is also an unambiguous request to stop.
 *
 * `email.bounced` covers soft bounces too (a full mailbox, a temporary defer), which must
 * NOT suppress: the payload's bounce type is what separates them, and only `hard` counts.
 */
export const SUPPRESSING_EVENTS = new Set(["email.bounced", "email.complained"]);

export type ResendEvent = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { type?: string; subType?: string };
  };
};

/** Recipients of the event, lowercased — Resend sends `to` as an array or a bare string. */
export function recipientsOf(event: ResendEvent): string[] {
  const to = event.data?.to;
  const list = Array.isArray(to) ? to : to ? [to] : [];
  return list
    .map((address) => address?.trim().toLowerCase())
    .filter((address): address is string => Boolean(address));
}

/**
 * Whether this event should take the address off the list.
 *
 * Soft bounces are deliberately excluded. A full mailbox clears; suppressing on one would
 * silently lose a real subscriber to a temporary condition.
 */
export function shouldSuppress(event: ResendEvent): boolean {
  if (event.type === "email.complained") return true;
  if (event.type !== "email.bounced") return false;
  const kind = event.data?.bounce?.type?.toLowerCase();
  // Absent bounce metadata is treated as hard: Resend does not always populate it, and a
  // bounce we cannot classify is safer suppressed than retried forever.
  return kind === undefined || kind === "hard" || kind === "permanent";
}
