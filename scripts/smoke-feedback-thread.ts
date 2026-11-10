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
import { creditGrants, feedback, feedbackMessages, userSettings } from "../src/db/schema";
import { createFeedbackSubmission, logDirectFeedback } from "../src/lib/feedback-submission";
import {
  buildFeedbackReplyEmail,
  grantFeedbackThanks,
  listMyFeedback,
  loadThread,
  markThreadRead,
  postThreadMessage,
  unreadRepliesFor,
  unwrapThanks,
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
    await db.delete(userSettings).where(eq(userSettings.userId, user));
  }
}

async function main() {
  await cleanup();
  const db = await getDb();
  const { id } = await createFeedbackSubmission({
    userId: A,
    text: "Search ignores accents",
    subject: "Search and accents",
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

  console.log("\nThe gift");
  {
    await new Promise((r) => setTimeout(r, 5));
    await postThreadMessage({ feedbackId: id, author: "operator", body: "Thank you!", credits: 50 });
    const thread = await loadThread(id, { userId: A });
    const gifted = thread?.messages.filter((m) => m.credits != null) ?? [];
    check("the reply that carried it holds the credits", gifted.length === 1 && gifted[0].credits === 50 && gifted[0].body === "Thank you!");
    check("...and it starts wrapped", thread?.thanksSeen === false);
    check("the list says a gift is waiting", (await listMyFeedback(A))[0]?.giftWaiting === true);
    check("the bell knows it's a gift", (await unreadRepliesFor(A))[0]?.giftWaiting === true);
    check("a reporter's message never carries credits", (await postThreadMessage({ feedbackId: id, author: "user", body: "wow", userId: A, credits: 999 })) !== null
      && (await loadThread(id, "operator"))?.messages.at(-1)?.credits === null);
    check("someone else can't unwrap it", (await unwrapThanks(id, B)) === null && (await loadThread(id, { userId: A }))?.thanksSeen === false);
    check("the reporter unwraps it and learns the amount", (await unwrapThanks(id, A)) === 50);
    check("...it's now opened", (await loadThread(id, { userId: A }))?.thanksSeen === true && (await listMyFeedback(A))[0]?.giftWaiting === false);
    check("unwrapping again is harmless", (await unwrapThanks(id, A)) === 50);
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

  console.log("\nLogging feedback given outside the app");
  {
    await db.insert(userSettings).values({ userId: B, email: "Smoke.Thread@Example.com" });
    const unknown = await logDirectFeedback({ email: "nobody@example.com", text: "hi", source: "text", area: null, loggedBy: "op" });
    check("an email with no account is refused", !unknown.ok && unknown.message.includes("No Orbit account"));
    const blank = await logDirectFeedback({ email: "smoke.thread@example.com", text: "  ", source: "text", area: null, loggedBy: "op" });
    check("an empty message is refused", !blank.ok);
    const logged = await logDirectFeedback({ email: "  smoke.thread@EXAMPLE.com ", text: "Texted me: the export is slow", source: "call", area: "import", loggedBy: "op" });
    check("the email matches case-insensitively", logged.ok);
    if (logged.ok) {
      const [row] = await db.select().from(feedback).where(eq(feedback.id, logged.id));
      check("it is filed under their account as a normal report", row.userId === B && row.kind === "freeform" && row.area === "import");
      check("...remembering where it came from and who logged it", row.context.source === "call" && row.context.loggedBy === "op");
      check("...and can be replied to like any other", (await postThreadMessage({ feedbackId: logged.id, author: "operator", body: "On it" })) !== null);
    }
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
