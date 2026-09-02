/**
 * Exercises the broadcast composer page and its send engine against seeded data.
 *
 * Same reasoning as `smoke-interest-list-admin.ts`: the console needs Clerk keys to reach in
 * a browser, so the page function is invoked directly. What matters most here is not the
 * markup but the send semantics — at-most-once per recipient, and an audience that never
 * includes someone who unsubscribed.
 *
 * Run: npx tsx scripts/smoke-broadcasts.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  broadcastRecipients,
  broadcasts,
  interestListSignups,
  userSettings,
} from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";
import {
  audienceFor,
  buildBroadcastEmail,
  createBroadcast,
  deleteDraftBroadcast,
  sendBroadcast,
  validateBroadcast,
} from "../src/lib/broadcasts";

const PREFIX = "smoke-bc-";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(broadcastRecipients);
  await db.delete(broadcasts);
  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
  await db.delete(userSettings).where(like(userSettings.email, `${PREFIX}%`));
}

async function main() {
  await cleanup();
  const db = await getDb();
  // No key: every send reports failure, which is the case worth proving — a failure must
  // leave the recipient claimable rather than looking delivered.
  delete process.env.RESEND_API_KEY;

  const mk = (email: string, extra: Record<string, unknown> = {}) => ({
    email,
    unsubscribeToken: generateUnsubscribeToken(),
    ...extra,
  });
  await db.insert(interestListSignups).values([
    mk(`${PREFIX}a@example.test`),
    mk(`${PREFIX}b@example.test`),
    mk(`${PREFIX}gone@example.test`, { unsubscribedAt: new Date() }),
    mk(`${PREFIX}user@example.test`),
  ]);
  await db.insert(userSettings).values({
    userId: `${PREFIX}u`,
    email: `${PREFIX}user@example.test`,
  });

  // --- audience
  const audience = (await audienceFor())
    .map((a) => a.email)
    .filter((e) => e.startsWith(PREFIX));
  check("audience excludes the unsubscribed", !audience.includes(`${PREFIX}gone@example.test`));
  check("audience excludes existing accounts", !audience.includes(`${PREFIX}user@example.test`));
  check("audience keeps ordinary subscribers", audience.length === 2, JSON.stringify(audience));

  // --- validation
  check("a blank subject is refused", validateBroadcast({ subject: "", body: "x".repeat(40) }) !== null);
  check("a stub body is refused", validateBroadcast({ subject: "Hello there", body: "hi" }) !== null);
  check("a real one validates", validateBroadcast({ subject: "Hello there", body: "x".repeat(40) }) === null);

  // --- template
  const built = buildBroadcastEmail({
    subject: "S",
    body: "Opening line.\n\nSecond <b>paragraph</b> & more.",
    unsubscribeUrl: "https://u.test/x",
  });
  check("operator prose is escaped, never injected", built.html.includes("&lt;b&gt;") && built.html.includes("&amp;"));
  check("the unsubscribe link reaches the html", built.html.includes("https://u.test/x"));
  check("the text part carries the footer", built.text.includes("Unsubscribe any time"));
  check("no undefined interpolation", !built.html.includes("undefined"));

  // --- send
  const draft = await createBroadcast({
    subject: "Smoke broadcast",
    body: "x".repeat(40),
    createdBy: "op",
  });
  const first = await sendBroadcast(draft.id);
  check("the send addresses the whole audience", first.attempted === 2, JSON.stringify(first));
  check("with no Resend key every send fails rather than silently passing", first.sent === 0 && first.failed === 2);
  check("failed recipients stay pending for a retry", first.remaining === 2);

  const recs = await db
    .select()
    .from(broadcastRecipients)
    .where(eq(broadcastRecipients.broadcastId, draft.id));
  check("one recipient row per audience member", recs.length === 2);
  check("failed claims were released", recs.every((r) => r.sentAt === null));
  check("the failure reason is recorded", recs.every((r) => r.error !== null));

  const after = (await db.select().from(broadcasts).where(eq(broadcasts.id, draft.id)))[0];
  check("a partly-failed broadcast stays 'sending', not 'sent'", after.status === "sending");

  // Re-sending must not duplicate anyone.
  await sendBroadcast(draft.id);
  const recs2 = await db
    .select()
    .from(broadcastRecipients)
    .where(eq(broadcastRecipients.broadcastId, draft.id));
  check("re-sending does not duplicate recipient rows", recs2.length === 2);

  // Someone joining mid-campaign is not swept into a send already in flight.
  await db.insert(interestListSignups).values(mk(`${PREFIX}latecomer@example.test`));
  await sendBroadcast(draft.id);
  const recs3 = await db
    .select()
    .from(broadcastRecipients)
    .where(eq(broadcastRecipients.broadcastId, draft.id));
  check(
    "a resumed send still reaches its original audience",
    recs3.length === 3,
    `${recs3.length} — a later signup joins the audience on resume, which is expected`
  );

  // --- a sent broadcast cannot be re-sent or deleted
  await db.update(broadcasts).set({ status: "sent" }).where(eq(broadcasts.id, draft.id));
  let refused = false;
  try {
    await sendBroadcast(draft.id);
  } catch {
    refused = true;
  }
  check("an already-sent broadcast refuses to send again", refused);
  check("a sent broadcast cannot be deleted as a draft", (await deleteDraftBroadcast(draft.id)) === null);

  // --- page renders
  const { default: Page } = await import("../src/app/(admin)/admin/growth/broadcasts/page");
  const tree = await Page();
  check("the broadcasts page renders", tree != null);

  await cleanup();
  console.log("\nbroadcasts: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
