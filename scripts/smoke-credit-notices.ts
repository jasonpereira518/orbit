/**
 * The credit emails at 80% and 100% of the monthly AI credits (`src/lib/credits/notices.ts`),
 * on PGlite with a stub mailer:
 *
 *  - 80% sends once; the next run sends nothing; 100% then sends once more.
 *  - Crossing both levels between runs sends only the 100% email.
 *  - At 100%, an account with pack credits hears it is on packs; one without hears AI paused.
 *  - Opted out, or on Free (in-app notice only): nothing.
 *  - A send the mailer refuses gives the claim back, so the next run tries again.
 *  - Unsubscribe links are signed, verified, and turn the email off.
 *
 * Run: npx tsx scripts/smoke-credit-notices.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const P = "smoke-cn-";
const LOW = `${P}low`;
const JUMP = `${P}jump`;
const PACKS = `${P}packs`;
const OPTED_OUT = `${P}optout`;
const FREE = `${P}free`;
const LIFETIME = `${P}lifetime`;
const REFUSED = `${P}refused`;
const MAX = `${P}max`;
const DAY = 86_400_000;

run(async () => {
  const { eq, inArray } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const schema = await import("../src/db/schema");
  const notices = await import("../src/lib/credits/notices");

  check("below 80% is nothing", notices.noticeLevelFor(2_000_000, 500_000) === 0);
  check("80% used is the first level", notices.noticeLevelFor(2_000_000, 400_000) === 80);
  check("all used is 100", notices.noticeLevelFor(2_000_000, 0) === 100 && notices.noticeLevelFor(2_000_000, -5) === 100);

  const db = await getDb();
  const users = [LOW, JUMP, PACKS, OPTED_OUT, FREE, LIFETIME, REFUSED, MAX];
  const reset = async () => {
    await db.delete(schema.creditGrants).where(inArray(schema.creditGrants.userId, users));
    await db.delete(schema.errorEvents).where(inArray(schema.errorEvents.userId, users));
    await db.delete(schema.userSettings).where(inArray(schema.userSettings.userId, users));
  };
  await reset();

  const now = new Date();
  const periodStart = new Date(now.getTime() - 5 * DAY);
  const periodEnd = new Date(now.getTime() + 25 * DAY);
  const pro = (userId: string, extra: Partial<typeof schema.userSettings.$inferInsert> = {}) => ({
    userId, email: `${userId}@example.test`, subscriptionPlan: "orbit" as const, subscriptionStatus: "active" as const,
    subscriptionPeriodEnd: periodEnd, ...extra,
  });
  await db.insert(schema.userSettings).values([
    pro(LOW), pro(JUMP), pro(PACKS), pro(OPTED_OUT, { creditEmailEnabled: 0 }), pro(REFUSED),
    { userId: FREE, email: `${FREE}@example.test` },
    { userId: LIFETIME, email: `${LIFETIME}@example.test`, lifetimePurchasedAt: periodStart },
    { ...pro(MAX), subscriptionPlan: "max" },
  ]);
  const allowance = (userId: string, usedCredits: number, granted = 200) => ({
    userId, kind: "allowance" as const, grantKey: `${P}allow-${userId}`, plan: "orbit" as const,
    microsGranted: granted * 10_000, microsRemaining: (granted - usedCredits) * 10_000, periodStart, periodEnd,
  });
  await db.insert(schema.creditGrants).values([
    allowance(LOW, 170),
    allowance(JUMP, 200),
    allowance(PACKS, 200),
    { userId: PACKS, kind: "pack", grantKey: `${P}pack`, microsGranted: 2_500_000, microsRemaining: 2_500_000, amountCents: 500, stripeRef: "cs_cn" },
    allowance(OPTED_OUT, 200),
    allowance(FREE, 180),
    allowance(LIFETIME, 180),
    allowance(REFUSED, 180),
    allowance(MAX, 450, 500),
  ]);

  type Sent = Parameters<import("../src/lib/credits/notices").CreditEmailDeliver>[0];
  const sent: Sent[] = [];
  let refuse = new Set<string>([`${REFUSED}@example.test`]);
  const deliver = async (m: Sent) => {
    if (refuse.has(m.to)) return { ok: false, error: "rejected by stub" };
    sent.push(m);
    return { ok: true };
  };
  const to = (userId: string) => sent.filter((m) => m.to === `${userId}@example.test`);
  const runOnce = () => notices.sendCreditNotices({ deliver, now, pauseMs: 0 });

  console.log("\nThe first run");
  const first = await runOnce();
  check("80% used: one email saying 80%", to(LOW).length === 1 && /80%/.test(to(LOW)[0].subject), to(LOW).map((m) => m.subject));
  check("…that gives the reset date, the options, and says nothing is charged",
    /reset/i.test(to(LOW)[0].text) && /\$5 pack/.test(to(LOW)[0].text) && /move to Orbit Max/.test(to(LOW)[0].text) &&
      /never charges you automatically/.test(to(LOW)[0].text), to(LOW)[0].text);
  check("straight past both levels: only the 100% email", to(JUMP).length === 1 && /used up/.test(to(JUMP)[0].subject) &&
    /paused/.test(to(JUMP)[0].text), to(JUMP).map((m) => m.subject));
  check("at 100% with pack credits: now on packs, with how many", to(PACKS).length === 1 &&
    /pack credits/.test(to(PACKS)[0].subject) && /250 left/.test(to(PACKS)[0].text), to(PACKS)[0]?.text);
  check("opted out: nothing", to(OPTED_OUT).length === 0);
  check("Free: 90% used, in-app only, never an email", to(FREE).length === 0);
  check("a plan without included AI (Lifetime): nothing", to(LIFETIME).length === 0);
  check("Max is never offered Max", to(MAX).length === 1 && !/move to Orbit Max/.test(to(MAX)[0].text));
  check("every email carries its one-click unsubscribe link",
    sent.every((m) => m.unsubscribeUrl.includes("/api/credits/email/unsubscribe?token=") && m.text.includes(m.unsubscribeUrl) &&
      m.html.includes("Turn it off")));
  check("a refused send is counted and logged", first.failed === 1 &&
    (await db.select().from(schema.errorEvents).where(eq(schema.errorEvents.userId, REFUSED))).length === 1, first);

  console.log("\nThe next run");
  const before = sent.length;
  refuse = new Set();
  const second = await runOnce();
  check("nothing already sent this cycle goes again", sent.length - before === 1 && second.sent === 1, second);
  check("…and the refused one went through this time", to(REFUSED).length === 1);

  console.log("\nCrossing the next level");
  await db.update(schema.creditGrants).set({ microsRemaining: 0 }).where(eq(schema.creditGrants.grantKey, `${P}allow-${LOW}`));
  await runOnce();
  check("80% → 100%: the second email goes, once", to(LOW).length === 2 && /used up/.test(to(LOW)[1].subject));
  await runOnce();
  check("…and not again", to(LOW).length === 2);

  console.log("\nA new cycle");
  const nextStart = periodEnd;
  const nextEnd = new Date(periodEnd.getTime() + 30 * DAY);
  await db.insert(schema.creditGrants).values({
    ...allowance(LOW, 180), grantKey: `${P}allow-${LOW}-2`, periodStart: nextStart, periodEnd: nextEnd,
  });
  await notices.sendCreditNotices({ deliver, now: new Date(nextStart.getTime() + DAY), pauseMs: 0 });
  check("the next cycle's 80% is emailed afresh", to(LOW).length === 3 && /80%/.test(to(LOW)[2].subject));

  console.log("\nUnsubscribing");
  const token = notices.creditEmailUnsubscribeToken(LOW);
  check("the token names its account", notices.readCreditEmailUnsubscribeToken(token) === LOW);
  check("a forged token names nobody", notices.readCreditEmailUnsubscribeToken(token.replace(/.$/, "x")) === null &&
    notices.readCreditEmailUnsubscribeToken(`${Buffer.from(LOW).toString("base64url")}.bogus`) === null);
  check("unsubscribing turns it off", await notices.unsubscribeCreditEmail(token) &&
    (await db.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, LOW) }))?.creditEmailEnabled === 0);
  check("…a second click is fine", await notices.unsubscribeCreditEmail(token));
  check("…and a bad token changes nothing", !(await notices.unsubscribeCreditEmail("nope")));

  await reset();
  if (failures > 0) throw new Error(`${failures} credit-notice check(s) failed`);
  console.log("\nAll credit-notice checks passed.");
});
