import { and, eq, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { interestListSignups, outreachMessages } from "@/db/schema";
import {
  engagementOf,
  eventTimeOf,
  recipientsOf,
  resendWebhookSecret,
  shouldSuppress,
  verifyResendSignature,
  type ResendEvent,
} from "@/lib/resend-webhook";
import {
  WEBHOOK_REASONS,
  recordWebhookDelivery,
  type WebhookOutcome,
} from "@/lib/webhook-deliveries";
import { shouldRecordThrottled } from "@/lib/error-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Delivery feedback from Resend: hard bounces and spam complaints take the address off the
 * interest list automatically; `email.delivered`, `email.opened` and `email.clicked` stamp
 * `delivered_at` / `opened_at` / `clicked_at` on the send they belong to.
 *
 * ENGAGEMENT MATCHES ON RESEND'S EMAIL ID, not the address: an address receives many emails,
 * and only the id says which one was opened. The one table that keeps that id is
 * `outreach_messages.delivery_id` (outreach email sent through Resend). `email_sends` never
 * holds one — every row there goes out through the person's own Gmail or Outlook — and the
 * waitlist and broadcast mail does not store it, so their events match nothing and are
 * recorded as `no_matching_send`. Each column keeps the EARLIEST time seen (`least`), so a
 * redelivered or out-of-order event cannot move it.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Without it a dead address is mailed forever and a
 * spam complaint changes nothing — and those two signals are exactly what mailbox providers
 * score a sending domain on. A domain that keeps hitting non-existent addresses stops
 * reaching the live ones, so this is what protects every other email in the product,
 * including the ones that are not marketing at all.
 *
 * It suppresses by writing the SAME `unsubscribed_at` that the recipient's one-click link
 * and the operator console both write, so there stays exactly one condition deciding who is
 * mailable rather than three sources of truth to reconcile.
 *
 * NOTE: the event types below must also be enabled on this endpoint in the Resend
 * dashboard — handling them in code alone is not enough.
 */
export async function POST(req: NextRequest) {
  const started = Date.now();
  // Readable before verification, and stable across retries, which is what makes the
  // rejection path recordable at all. Same reasoning as the Clerk route.
  const eventId = req.headers.get("svix-id") ?? req.headers.get("webhook-id");

  const secret = resendWebhookSecret();
  if (!secret) {
    // Deliberately 500 rather than 200: an unconfigured endpoint is a deployment fault, and
    // answering 2xx would make Resend drop feedback that cannot be recovered later.
    await recordWebhookDelivery({
      source: "resend",
      eventId,
      outcome: "error",
      reason: "not_configured",
      durationMs: Date.now() - started,
    });
    return new NextResponse("Webhook secret not configured", { status: 500 });
  }

  // The signature covers the raw bytes, so the body is read as text and only parsed after
  // it verifies. Parsing first and re-serialising would change the payload and fail every
  // signature.
  const payload = await req.text();
  const verified = verifyResendSignature({
    secret,
    payload,
    id: eventId,
    timestamp: req.headers.get("svix-timestamp") ?? req.headers.get("webhook-timestamp"),
    signature: req.headers.get("svix-signature") ?? req.headers.get("webhook-signature"),
  });

  if (!verified.ok) {
    // Stores nothing from the body: an unverified payload is untrusted input. Latched to
    // once per hour — this write precedes authentication, so it must not scale with the
    // number of garbage POSTs. Same reasoning as the Clerk route.
    if (shouldRecordThrottled("webhook.resend.invalid")) {
      await recordWebhookDelivery({
        source: "resend",
        eventId,
        outcome: "invalid",
        reason: WEBHOOK_REASONS.signatureInvalid,
        detail: { failure: verified.reason },
        durationMs: Date.now() - started,
      });
    }
    return new NextResponse("Verification failed", { status: 400 });
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(payload) as ResendEvent;
  } catch (err) {
    await recordWebhookDelivery({
      source: "resend",
      eventId,
      outcome: "invalid",
      reason: "unparseable_body",
      error: err,
      durationMs: Date.now() - started,
    });
    return new NextResponse("Unparseable body", { status: 400 });
  }

  let outcome: WebhookOutcome = "ignored";
  let reason: string | null = WEBHOOK_REASONS.unhandledType;
  let suppressed = 0;
  let engaged = 0;
  const recipients = recipientsOf(event);
  const engagement = engagementOf(event);

  try {
    if (shouldSuppress(event)) {
      if (recipients.length === 0) {
        reason = "no_recipient";
      } else {
        const db = await getDb();
        for (const email of recipients) {
          // COALESCE for the same reason as everywhere else this column is written: a
          // redelivered event must not move a timestamp the person set themselves.
          const rows = await db
            .update(interestListSignups)
            .set({
              unsubscribedAt: sql`coalesce(${interestListSignups.unsubscribedAt}, now())`,
            })
            .where(eq(interestListSignups.email, email))
            .returning();
          suppressed += rows.length;
        }
        outcome = "handled";
        // An address Resend bounced that is not on the list is normal, not a fault: the
        // same sending domain carries the contact form and outreach mail.
        reason = suppressed > 0 ? null : "not_on_list";
      }
    } else if (engagement) {
      const emailId = event.data?.email_id;
      if (!emailId) {
        reason = "no_email_id";
      } else {
        const at = eventTimeOf(event);
        const column = outreachMessages[engagement];
        const db = await getDb();
        const rows = await db
          .update(outreachMessages)
          .set({ [engagement]: sql`least(coalesce(${column}, ${at.toISOString()}::timestamptz), ${at.toISOString()}::timestamptz)` })
          .where(and(eq(outreachMessages.deliveryId, emailId), eq(outreachMessages.channel, "email")))
          .returning();
        engaged = rows.length;
        outcome = "handled";
        reason = engaged > 0 ? null : "no_matching_send";
      }
    }
  } catch (err) {
    await recordWebhookDelivery({
      source: "resend",
      eventId,
      eventType: event.type ?? null,
      outcome: "error",
      reason: WEBHOOK_REASONS.handlerThrew,
      error: err,
      durationMs: Date.now() - started,
    });
    // Rethrow so the 500 makes Resend retry — losing a suppression is worse than a retry.
    throw err;
  }

  await recordWebhookDelivery({
    source: "resend",
    eventId,
    eventType: event.type ?? null,
    outcome,
    reason,
    resourceId: event.data?.email_id ?? null,
    detail: {
      // The address is the point of the record; without it a suppression cannot be audited.
      recipients,
      suppressed,
      engaged,
      bounceType: event.data?.bounce?.type ?? null,
    },
    durationMs: Date.now() - started,
  });

  return new NextResponse("OK", { status: 200 });
}
