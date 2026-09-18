/**
 * The Resend payload for one outreach email.
 *
 * Hosted sending goes out FROM Orbit's verified `RESEND_FROM_EMAIL` — the only address it
 * can send from — so `replyTo` is what routes a recipient's reply to the person who wrote
 * the message. Pure, so the routing is pinned without a network
 * (`scripts/smoke-outreach-email.ts`).
 */
export function outreachEmailPayload(input: {
  from: string;
  to: string;
  subject: string | null | undefined;
  text: string;
  replyTo: string | null | undefined;
}) {
  const replyTo = input.replyTo?.trim();
  return {
    from: input.from,
    to: input.to,
    subject: input.subject?.trim() || "Hello",
    text: input.text,
    ...(replyTo ? { replyTo } : {}),
  };
}
