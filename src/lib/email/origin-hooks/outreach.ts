import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { outreachMessages } from "@/db/schema";
import { registerOriginHooks } from "@/lib/email/origins";

// A campaign email. `origin_ref` is the outreach_messages id, claimed and ownership-checked by
// `sendCampaignMessagesForUser` before it was enqueued. The row mirrors the outcome; the stored
// error is always Orbit's own words, the raw provider text lives only on the email_sends row.
registerOriginHooks("outreach", {
  async onSent(send) {
    if (!send.originRef) return;
    const db = await getDb();
    await db
      .update(outreachMessages)
      .set({
        status: "sent",
        sentAt: send.sentAt ?? new Date(),
        deliveryId: send.id,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(outreachMessages.id, send.originRef));
  },
  async onFailed(send, kind) {
    if (!send.originRef) return;
    const db = await getDb();
    // "May have sent" is never claimed again: its idempotency key is still held by the outbox's
    // unique index, and a blind resend is exactly the duplicate this state exists to prevent.
    const set =
      kind === "ambiguous"
        ? { status: "unsure", errorMessage: "May have sent — check your Sent folder before resending" }
        : {
            status: "failed",
            errorMessage:
              kind === "auth"
                ? "Your email needs reconnecting before this can send"
                : "Your email provider didn’t accept this message",
          };
    await db
      .update(outreachMessages)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(outreachMessages.id, send.originRef));
  },
});
