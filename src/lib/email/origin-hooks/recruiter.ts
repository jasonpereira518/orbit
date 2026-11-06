import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { recruiterMessages } from "@/db/schema";
import { registerOriginHooks } from "@/lib/email/origins";

// A recruiter draft. `origin_ref` is the recruiter_messages id; the row mirrors the outcome
// so the compose page's lists stay the source of truth for recruiter threads. The stored
// error is always Orbit's own words: the raw provider text lives only on the email_sends row.
registerOriginHooks("recruiter", {
  async onSent(send) {
    if (!send.originRef) return;
    const db = await getDb();
    await db
      .update(recruiterMessages)
      .set({
        status: "sent",
        sentAt: send.sentAt ?? new Date(),
        gmailMessageId: send.providerMessageId,
        gmailThreadId: send.providerThreadId,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(recruiterMessages.id, send.originRef));
  },
  async onFailed(send, kind) {
    if (!send.originRef) return;
    const db = await getDb();
    const errorMessage =
      kind === "ambiguous"
        ? "May have sent — check your Sent folder before resending."
        : kind === "auth"
          ? "Gmail needs reconnecting before this can send."
          : "Gmail didn’t accept this message.";
    await db
      .update(recruiterMessages)
      .set({ status: "failed", errorMessage, updatedAt: new Date() })
      .where(eq(recruiterMessages.id, send.originRef));
  },
});
