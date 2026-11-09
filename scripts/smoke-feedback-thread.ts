/**
 * Feedback conversation smoke tests.
 *
 * The rules that make a reply safe to send and worth getting: only the reporter sees their
 * thread, they can only write once the operator has, a reply shows on the bell until it is
 * opened, a credit thank-you lands once per report, and the emailed copy is escaped.
 *
 * Run: npx tsx scripts/smoke-feedback-thread.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { creditGrants, feedback, feedbackMessages } from "../src/db/schema";
import { createFeedbackSubmission } from "../src/lib/feedback-submission";
import {
  buildFeedbackReplyEmail,
  grantFeedbackThanks,
  listMyFeedback,
  loadThread,
  markThreadRead,
  postThreadMessage,
  unreadRepliesFor,
} from "../src/lib/feedback-thread";

const A = "smoke-thread-a";
const B = "smoke-thread-b";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  for (const user of [A, B]) {
    await db.delete(feedbackMessages).where(eq(feedbackMessages.userId, user));
    await db.delete(feedback).where(eq(feedback.userId, user));
    await db.delete(creditGrants).where(eq(creditGrants.userId, user));
  }
}

async function main() {
  await cleanup();
  const db = await getDb();
  const { id } = await createFeedbackSubmission({
    userId: A,
    text: "Search ignores accents",
    area: "contacts",
    category: null,
    context: {},
    screenshots: [],
  });

  console.log("Who can see it");
  {
    const mine = await loadThread(id, { userId: A });
    check("the reporter sees their own report", mine !== null && mine.report.text === "Search ignores accents");
    check("...and it isn't open before a reply", mine?.open === false && mine.messages.length === 0);
    check("someone else gets nothing", (await loadThread(id, { userId: B })) === null);
    check("a malformed id gets nothing", (await loadThread("../etc", "operator")) === null);
  }

  console.log("\nWho can write");
  {
    check("the reporter can't write before the operator has", (await postThreadMessage({ feedbackId: id, author: "user", body: "hello?", userId: A })) === null);
    const posted = await postThreadMessage({ feedbackId: id, author: "operator", body: "Fixed now — try again?" });
    check("the operator's reply opens it", posted?.reporterId === A && (await loadThread(id, { userId: A }))?.open === true);
    check("someone else still can't write", (await postThreadMessage({ feedbackId: id, author: "user", body: "me too", userId: B })) === null);
    check("the reporter can answer now", (await postThreadMessage({ feedbackId: id, author: "user", body: "Works, thanks!", userId: A })) !== null);
    const thread = await loadThread(id, "operator");
    check("messages come back in order", thread?.messages.map((m) => m.author).join(",") === "operator,user");
  }

  console.log("\nUnread");
  {
    // The reporter's own message stamped them read; a second operator reply is new again.
    await new Promise((r) => setTimeout(r, 5));
    await postThreadMessage({ feedbackId: id, author: "operator", body: "Great!\nSecond line" });
    const unread = await unreadRepliesFor(A);
    check("an unopened reply is unread", unread.length === 1 && unread[0].latest === "Great!\nSecond line");
    check("it shows on the list", (await listMyFeedback(A))[0]?.unread === true);
    check("...with the operator's reply count", (await listMyFeedback(A))[0]?.replies === 2);
    await markThreadRead(id, "user", B);
    check("someone else can't mark it read", (await unreadRepliesFor(A)).length === 1);
    await markThreadRead(id, "user", A);
    check("opening it clears it", (await unreadRepliesFor(A)).length === 0 && (await listMyFeedback(A))[0]?.unread === false);
  }

  console.log("\nCredits");
  {
    check("the first thank-you grants", (await grantFeedbackThanks({ feedbackId: id, userId: A, credits: 50 })) === true);
    check("a second is a no-op", (await grantFeedbackThanks({ feedbackId: id, userId: A, credits: 100 })) === false);
    const grants = await db.select().from(creditGrants).where(and(eq(creditGrants.userId, A), eq(creditGrants.kind, "adjustment")));
    check("exactly one adjustment grant", grants.length === 1 && grants[0].grantKey === `adj:feedback:${id}`);
    check("...worth 50 credits, and not cash", grants[0].microsGranted === 500_000 && grants[0].amountCents === null && grants[0].stripeRef === null);
    check("the report remembers the first amount", (await loadThread(id, { userId: A }))?.thanksCredits === 50);
  }

  console.log("\nEmail");
  {
    const mail = buildFeedbackReplyEmail({
      reply: "Fixed <b>now</b> & live",
      report: "It <script>broke</script>",
      credits: 50,
      threadUrl: "https://orbit.test/feedback/x",
    });
    check("the reply is escaped in HTML", mail.html.includes("Fixed &lt;b&gt;now&lt;/b&gt; &amp; live") && !mail.html.includes("<script>"));
    check("credits are mentioned", mail.text.includes("50 bonus AI credits"));
    check("the way back into Orbit is there", mail.text.includes("https://orbit.test/feedback/x"));
  }

  await cleanup();
  const leftover = await db.select({ id: feedbackMessages.id }).from(feedbackMessages).where(eq(feedbackMessages.userId, A));
  check("cleanup left nothing behind", leftover.length === 0);
  console.log("\nAll feedback thread checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
