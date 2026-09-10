/**
 * Signing and verifying outbound webhook deliveries.
 *
 * Pure: no database, no `next/server`, no environment. That is what lets a smoke test pin
 * every branch against known vectors, which matters more here than almost anywhere else —
 * a signature scheme that is subtly wrong still *looks* like it works, because every
 * signature it produces verifies against itself.
 *
 * ## The scheme, and why this one
 *
 *   Orbit-Signature: t=1757001600,v1=<hex hmac_sha256(secret, `${t}.${rawBody}`)>
 *
 * Deliberately Stripe-compatible in shape. Not for interoperability — nobody will feed
 * Orbit's signature to Stripe's verifier — but because the people writing receivers have
 * already written this exact check once, and a scheme they recognise is one they are far more
 * likely to implement correctly than a novel one.
 *
 * The timestamp is inside the signed string, not merely a header alongside it. This is the
 * whole replay defence: a header-only timestamp can be rewritten by anyone replaying the
 * request, because it is not covered by the MAC. Signing `${t}.${body}` means changing `t`
 * invalidates the signature, so a receiver rejecting old timestamps actually rejects replays.
 *
 * `v1=` is versioned so a future scheme can be added alongside rather than replacing it, and
 * receivers are expected to ignore versions they do not understand.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** How far out of step a receiver should tolerate. Five minutes is the conventional value. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function generateWebhookSecret(): string {
  return `whsec_orbit_${randomBytes(32).toString("base64url")}`;
}

export function signPayload(secret: string, body: string, timestampSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

export type ParsedSignature = { timestamp: number; signatures: string[] };

/**
 * Parse a signature header.
 *
 * Tolerates unknown `vN=` schemes and extra fields rather than rejecting them, so adding a v2
 * later does not break receivers written against v1 — and so a receiver written against this
 * parser does not break when Orbit adds one.
 */
export function parseSignatureHeader(header: string | null | undefined): ParsedSignature | null {
  if (!header) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s?.trim());
    if (!key || !value) continue;
    if (key === "t") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * The check a receiver performs. Exported so the smoke test verifies the real thing rather
 * than a re-implementation, and so it can be quoted verbatim in the API docs.
 */
export function verifySignature(opts: {
  secret: string;
  body: string;
  header: string | null | undefined;
  nowSeconds: number;
  toleranceSeconds?: number;
}): boolean {
  const parsed = parseSignatureHeader(opts.header);
  if (!parsed) return false;

  const tolerance = opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(opts.nowSeconds - parsed.timestamp) > tolerance) return false;

  const expected = createHmac("sha256", opts.secret)
    .update(`${parsed.timestamp}.${opts.body}`)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");

  return parsed.signatures.some((candidate) => {
    const candidateBuf = Buffer.from(candidate, "utf8");
    if (candidateBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(candidateBuf, expectedBuf);
  });
}

export type WebhookEventType =
  | "contact.created"
  | "contact.updated"
  | "interaction.created"
  | "followup.due"
  | "endpoint.verified";

/**
 * The envelope every delivery carries.
 *
 * `id` is stable across retries because Zapier and most receivers dedupe on the top-level id —
 * a retry that changed it would be processed twice. `apiVersion` is here so the payload shape
 * can evolve without breaking receivers pinned to an older one.
 */
export function buildEnvelope(input: {
  id: string;
  type: WebhookEventType;
  createdAt: Date;
  object: unknown;
}) {
  return {
    id: input.id,
    type: input.type,
    createdAt: input.createdAt.toISOString(),
    apiVersion: "2026-09-01",
    data: { object: input.object },
  };
}
