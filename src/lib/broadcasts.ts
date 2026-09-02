import { and, desc, eq, isNull, notExists, sql } from "drizzle-orm";
import { Resend } from "resend";
import { getDb } from "@/db";
import {
  broadcastRecipients,
  broadcasts,
  interestListSignups,
  userSettings,
} from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import { BODY_MAX, BODY_MIN, SUBJECT_MAX, SUBJECT_MIN } from "@/lib/broadcast-limits";
import {
  ACCENT,
  BG,
  FAINT,
  FONT_STACK,
  MUTED,
  TEXT,
  buildUnsubscribeUrl,
  escapeHtml,
} from "@/lib/interest-list-email";

/**
 * Operator-composed notes to the interest list.
 *
 * The landing page promises "the occasional note on what's new in Orbit", and until this
 * existed the list was write-only: two automated emails and no way to send the thing that
 * was actually promised.
 */

/** Ceiling on one send request, so a run cannot outlive its invocation. */
export const BROADCAST_BATCH_LIMIT = 200;


export type BroadcastSendStats = {
  attempted: number;
  sent: number;
  failed: number;
  /** Recipients still unsent after this run — a second send drains them. */
  remaining: number;
};

/**
 * Wraps operator prose in the same shell the welcome note uses.
 *
 * The operator writes plain text and this builds the markup, which is what stops a broadcast
 * from drifting off the product's look or shipping broken HTML to an entire list at once.
 * Every line is escaped: the author is trusted, but a stray `<` in prose should render as a
 * `<`, not silently eat the rest of the paragraph.
 */
export function buildBroadcastEmail(input: {
  subject: string;
  body: string;
  unsubscribeUrl: string;
}) {
  const appUrl = getAppBaseUrl();
  const logoUrl = `${appUrl}/orbit-logo.png`;

  // Blank lines separate paragraphs; single newlines stay inside one.
  const paragraphs = input.body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const text = [
    input.body.trim(),
    "",
    "—",
    "You're getting this because you joined Orbit's interest list.",
    `Unsubscribe any time: ${input.unsubscribeUrl}`,
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:${BG};font-family:${FONT_STACK};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG};">
      <tr>
        <td align="center" style="padding:40px 20px;">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
            <tr>
              <td style="padding-bottom:30px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding-right:11px;" valign="middle">
                      <img src="${logoUrl}" alt="" width="40" height="40"
                           style="display:block;border:0;outline:none;text-decoration:none;width:40px;height:40px;border-radius:50%;" />
                    </td>
                    <td valign="middle">
                      <span style="font-size:20px;font-weight:600;color:${TEXT};letter-spacing:-0.01em;">Orbit</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
${paragraphs
  .map(
    (block, i) =>
      `            <tr><td style="font-size:${i === 0 ? "17px" : "15px"};line-height:1.65;color:${
        i === 0 ? TEXT : MUTED
      };${i === 0 ? "font-weight:600;" : ""}padding-bottom:18px;">${escapeHtml(block).replace(
        /\n/g,
        "<br />"
      )}</td></tr>`
  )
  .join("\n")}
            <tr>
              <td style="font-size:15px;line-height:1.65;color:${MUTED};padding-top:8px;padding-bottom:28px;">
                — Jason
              </td>
            </tr>
            <tr>
              <td style="font-size:12px;line-height:1.6;color:${FAINT};border-top:1px solid rgba(232,243,241,0.14);padding-top:22px;">
                You're getting this because you joined Orbit's interest list.
                <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${FAINT};text-decoration:underline;">Unsubscribe any time</a>.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject: input.subject, html, text, accent: ACCENT };
}

export function validateBroadcast(input: { subject: string; body: string }): string | null {
  if (input.subject.trim().length < SUBJECT_MIN) return "Give it a subject.";
  if (input.subject.length > SUBJECT_MAX) return `Subject must be under ${SUBJECT_MAX} characters.`;
  if (input.body.trim().length < BODY_MIN) return "The body is too short to be worth sending.";
  if (input.body.length > BODY_MAX) return `Body must be under ${BODY_MAX} characters.`;
  return null;
}

export async function createBroadcast(input: {
  subject: string;
  body: string;
  createdBy: string;
}) {
  const db = await getDb();
  const rows = await db
    .insert(broadcasts)
    .values({
      subject: input.subject.trim(),
      body: input.body.trim(),
      createdBy: input.createdBy,
    })
    .returning();
  return rows[0];
}

export async function loadBroadcast(id: string) {
  const db = await getDb();
  const rows = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listBroadcasts(limit = 25) {
  const db = await getDb();
  return db.select().from(broadcasts).orderBy(desc(broadcasts.createdAt)).limit(limit);
}

export async function deleteDraftBroadcast(id: string) {
  const db = await getDb();
  // Guarded on status rather than checked first: a draft that started sending between the
  // read and the delete must not be removed out from under its own send.
  const rows = await db
    .delete(broadcasts)
    .where(and(eq(broadcasts.id, id), eq(broadcasts.status, "draft")))
    .returning();
  return rows[0] ?? null;
}

/**
 * Who a broadcast goes to.
 *
 * Exactly the audience the console calls "active": subscribed, and not already an account.
 * The same two exclusions the day-3 sweep uses, and for the same reasons — mailing someone
 * who unsubscribed is the one unforgivable bug here, and mailing "what's new" to an existing
 * user reads as a product that does not know its own customers.
 */
export async function audienceFor(): Promise<
  Array<{ id: string; email: string; unsubscribeToken: string }>
> {
  const db = await getDb();
  return db
    .select({
      id: interestListSignups.id,
      email: interestListSignups.email,
      unsubscribeToken: interestListSignups.unsubscribeToken,
    })
    .from(interestListSignups)
    .where(
      and(
        isNull(interestListSignups.unsubscribedAt),
        // Drizzle's `notExists` with a query-builder subquery, NOT a raw `sql` template:
        // interpolating the two columns by hand renders both as an unqualified `"email"`,
        // which inside the subquery both bind to `user_settings.email`. That collapses the
        // correlation to `lower(u.email) = u.email` — true for any lowercase address — so
        // the NOT EXISTS excludes everyone and a broadcast silently reaches nobody.
        notExists(
          db
            .select({ one: sql`1` })
            .from(userSettings)
            .where(eq(sql`lower(${userSettings.email})`, interestListSignups.email))
        )
      )
    );
}

function fromAddress() {
  const configured = process.env.RESEND_FROM_EMAIL?.trim();
  if (!configured) return null;
  return configured.includes("<") ? configured : `Jason from Orbit <${configured}>`;
}

/** A single send, used by both the test-send and the real one. */
async function deliver(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl: string;
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = fromAddress();
  if (!apiKey || !from) return { ok: false, error: "Resend is not configured." };

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo: process.env.CONTACT_INBOX_EMAIL?.trim() || undefined,
      headers: {
        "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Send failed." };
  }
}

/**
 * Send one copy to a chosen address, without touching the broadcast's own state.
 *
 * Deliberately does not mark the broadcast as sent or create recipient rows: seeing it in a
 * real inbox before it reaches the list is the entire point, and a test that consumed the
 * send would defeat it.
 */
export async function sendBroadcastTest(input: {
  subject: string;
  body: string;
  to: string;
}): Promise<{ ok: boolean; error?: string }> {
  // A real token so the unsubscribe link in the test is the live one, not a placeholder
  // that only fails when a subscriber clicks it.
  const [sample] = await audienceFor();
  const unsubscribeUrl = buildUnsubscribeUrl(
    sample?.unsubscribeToken ?? "test-token-not-a-real-subscriber"
  );
  const message = buildBroadcastEmail({ ...input, unsubscribeUrl });
  return deliver({ to: input.to, ...message, unsubscribeUrl });
}

/**
 * Send a broadcast, or resume one that stopped partway.
 *
 * AT MOST ONCE PER RECIPIENT, which is the whole reason `broadcast_recipients` exists. The
 * audience is materialised into rows on the first run (a unique index on the pair makes a
 * second attempt a no-op), then each unsent row is claimed with a conditional UPDATE before
 * its message is built. Two overlapping runs cannot take the same person, and a run that
 * dies loses a send rather than repeating one — double-sending a whole list being the worst
 * failure this feature has.
 *
 * Capped per run. A list longer than the cap finishes on the next send, which the console
 * surfaces rather than hiding.
 */
export async function sendBroadcast(id: string): Promise<BroadcastSendStats> {
  const db = await getDb();
  const broadcast = await loadBroadcast(id);
  if (!broadcast) throw new Error("That broadcast no longer exists.");
  if (broadcast.status === "sent") throw new Error("That broadcast has already been sent.");

  // Materialise the audience once. `onConflictDoNothing` on the (broadcast, signup) pair
  // means a resumed send re-uses the original list rather than picking up people who joined
  // after it started — a broadcast should reach the audience it was aimed at.
  const audience = await audienceFor();
  if (audience.length > 0) {
    await db
      .insert(broadcastRecipients)
      .values(
        audience.map((person) => ({
          broadcastId: id,
          signupId: person.id,
          email: person.email,
        }))
      )
      .onConflictDoNothing();
  }

  await db
    .update(broadcasts)
    .set({ status: "sending", recipientCount: audience.length })
    .where(eq(broadcasts.id, id));

  const pending = await db
    .select()
    .from(broadcastRecipients)
    .where(and(eq(broadcastRecipients.broadcastId, id), isNull(broadcastRecipients.sentAt)))
    .limit(BROADCAST_BATCH_LIMIT);

  const tokens = new Map(audience.map((p) => [p.id, p.unsubscribeToken]));
  const stats: BroadcastSendStats = {
    attempted: pending.length,
    sent: 0,
    failed: 0,
    remaining: 0,
  };

  for (const recipient of pending) {
    // Claim first; the IS NULL guard is what makes concurrent runs safe.
    const claimed = await db
      .update(broadcastRecipients)
      .set({ sentAt: new Date(), error: null })
      .where(
        and(eq(broadcastRecipients.id, recipient.id), isNull(broadcastRecipients.sentAt))
      )
      .returning();
    if (!claimed[0]) continue;

    const token = tokens.get(recipient.signupId);
    // No token means the signup row vanished mid-send (an operator delete). Skip rather
    // than mail a broken unsubscribe link.
    if (!token) {
      await db
        .update(broadcastRecipients)
        .set({ sentAt: null, error: "signup no longer exists" })
        .where(eq(broadcastRecipients.id, recipient.id));
      stats.failed += 1;
      continue;
    }

    const unsubscribeUrl = buildUnsubscribeUrl(token);
    const message = buildBroadcastEmail({
      subject: broadcast.subject,
      body: broadcast.body,
      unsubscribeUrl,
    });
    const result = await deliver({ to: recipient.email, ...message, unsubscribeUrl });

    if (result.ok) {
      stats.sent += 1;
    } else {
      stats.failed += 1;
      // Release the claim so a later send retries this person.
      await db
        .update(broadcastRecipients)
        .set({ sentAt: null, error: result.error?.slice(0, 300) ?? "send failed" })
        .where(eq(broadcastRecipients.id, recipient.id));
    }
  }

  const [left] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(broadcastRecipients)
    .where(and(eq(broadcastRecipients.broadcastId, id), isNull(broadcastRecipients.sentAt)));
  stats.remaining = left?.n ?? 0;

  const [delivered] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(broadcastRecipients)
    .where(
      and(eq(broadcastRecipients.broadcastId, id), sql`${broadcastRecipients.sentAt} is not null`)
    );

  await db
    .update(broadcasts)
    .set({
      // Only "sent" once nobody is left, so a capped or partly-failed run stays resumable
      // and visibly unfinished rather than reporting success it did not achieve.
      status: stats.remaining === 0 ? "sent" : "sending",
      sentAt: stats.remaining === 0 ? new Date() : null,
      sentCount: delivered?.n ?? 0,
      failedCount: stats.failed,
    })
    .where(eq(broadcasts.id, id));

  return stats;
}
