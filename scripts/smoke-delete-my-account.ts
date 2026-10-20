/**
 * Self-service account deletion: cancel billing, purge everything (settings row included),
 * then remove the sign-in. Order matters — if billing cannot be stopped, nothing is deleted;
 * if the sign-in cannot be removed, the data is still gone and the person is told. Running
 * it twice (or the Clerk webhook purging afterwards) must be harmless.
 *
 * Run: npx tsx scripts/smoke-delete-my-account.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-delete-my-account";
process.env.ADMIN_USER_IDS = "smoke-delete-my-account-operator";

import { and, eq, inArray, like, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { accountAuditLog, billingEvents, contacts, creditGrants, interestListSignups, userSettings } from "../src/db/schema";
import { deleteOwnAccount, type AccountDeletionDeps } from "../src/lib/account-deletion";
import { setStripeCustomerRetirerForTest } from "../src/lib/stripe-customer-retire";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-delete-my-account-user";
const PAYER = "smoke-delete-my-account-payer";
const OPERATOR = "smoke-delete-my-account-operator";
const IDS = [USER, PAYER, OPERATOR];

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function fakeDeps(opts: { cancelThrows?: boolean; loginThrows?: boolean } = {}) {
  const calls = { cancelled: [] as string[], deleted: [] as string[] };
  const deps: AccountDeletionDeps = {
    async cancelSubscriptions(customerId) {
      if (opts.cancelThrows) throw new Error("stripe down");
      calls.cancelled.push(customerId);
    },
    async deleteLogin(userId) {
      if (opts.loginThrows) throw new Error("clerk down");
      calls.deleted.push(userId);
    },
  };
  return { deps, calls };
}

async function seed(userId: string, stripeCustomerId: string | null) {
  const db = await getDb();
  await db.insert(userSettings).values({ userId, email: `${userId}@example.test`, stripeCustomerId });
  await db.insert(contacts).values({ userId, fullName: "Ada Lovelace" });
}

async function counts(userId: string) {
  const db = await getDb();
  return {
    settings: (await db.query.userSettings.findMany({ where: eq(userSettings.userId, userId) })).length,
    contacts: (await db.query.contacts.findMany({ where: eq(contacts.userId, userId) })).length,
  };
}

async function refusal(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
}

run(async () => {
  const db = await getDb();
  for (const id of IDS) {
    await db.delete(contacts).where(eq(contacts.userId, id));
  }
  await db.delete(userSettings).where(inArray(userSettings.userId, IDS));
  await db.delete(accountAuditLog).where(inArray(accountAuditLog.subjectUserId, IDS));
  await db.delete(billingEvents).where(like(billingEvents.eventId, "smoke-delete-my-account-%"));
  await db.delete(creditGrants).where(like(creditGrants.grantKey, "smoke-delete-my-account-%"));
  await db.delete(interestListSignups).where(like(interestListSignups.email, "smoke-delete-my-account-%"));

  // Stripe is never called: the customer "retire" is recorded here instead (audit M-09).
  const retired: Array<{ customerId: string; at: Date }> = [];
  setStripeCustomerRetirerForTest(async (customerId, at) => {
    retired.push({ customerId, at });
  });

  console.log("An account with no subscription");
  await seed(USER, null);
  const plain = fakeDeps();
  await deleteOwnAccount(USER, plain.deps);
  const after = await counts(USER);
  check("its settings row is gone", after.settings === 0);
  check("its contacts are gone", after.contacts === 0);
  check("its sign-in was removed", plain.calls.deleted.join() === USER);
  check("no billing call was made", plain.calls.cancelled.length === 0);

  console.log("Running it again, as the Clerk webhook will");
  await purgeUserData(USER, { keepSettings: false });
  const again = fakeDeps();
  check("a second deletion does not throw", (await refusal(() => deleteOwnAccount(USER, again.deps))) === null);

  console.log("A paying account whose billing cannot be stopped");
  await seed(PAYER, "cus_smoke_payer");
  const stuck = fakeDeps({ cancelThrows: true });
  const stuckErr = await refusal(() => deleteOwnAccount(PAYER, stuck.deps));
  check("it refuses with copy that says nothing was deleted", stuckErr?.name === "UserFacingError" && /nothing was deleted/.test(stuckErr.message), stuckErr?.message);
  check("and nothing was deleted", (await counts(PAYER)).contacts === 1);

  console.log("A paying account");
  // The residue account deletion used to leave behind (audit M-09).
  await db.insert(billingEvents).values({
    source: "stripe", eventId: "smoke-delete-my-account-evt", kind: "new", userId: PAYER, mrrDeltaCents: 500,
    effectiveAt: new Date(), detail: { invoiceId: "in_smoke", email: `${PAYER}@example.test`, targetUserId: PAYER },
  });
  await db.insert(creditGrants).values([
    { userId: PAYER, kind: "pack", grantKey: "smoke-delete-my-account-pack", microsGranted: 100, microsRemaining: 50, amountCents: 500 },
    { userId: PAYER, kind: "starter", grantKey: `smoke-delete-my-account-starter:${PAYER}`, microsGranted: 100, microsRemaining: 100 },
  ]);
  await db.insert(interestListSignups).values([
    { email: `${PAYER}@example.test`, unsubscribeToken: "smoke-delete-my-account-tok-1" },
    { email: "smoke-delete-my-account-someone-else@example.test", unsubscribeToken: "smoke-delete-my-account-tok-2" },
  ]);
  const paid = fakeDeps();
  await deleteOwnAccount(PAYER, paid.deps);
  check("its subscription was cancelled first", paid.calls.cancelled.join() === "cus_smoke_payer");
  check("then everything was deleted", (await counts(PAYER)).settings === 0);
  const [billing] = await db.select().from(billingEvents).where(eq(billingEvents.eventId, "smoke-delete-my-account-evt"));
  check("its billing record is kept, anonymised", billing?.userId === null && billing.mrrDeltaCents === 500);
  check("…with personal fields stripped and Stripe ids kept", !("email" in (billing?.detail ?? {})) && !("targetUserId" in (billing?.detail ?? {})) && billing?.detail.invoiceId === "in_smoke", JSON.stringify(billing?.detail));
  const grants = await db.select().from(creditGrants).where(like(creditGrants.grantKey, "smoke-delete-my-account-%"));
  check("its credit grants are deleted, not just anonymised", grants.length === 0, JSON.stringify(grants.map((g) => g.grantKey)));
  const waitlist = (await db.select().from(interestListSignups).where(like(interestListSignups.email, "smoke-delete-my-account-%"))).map((r) => r.email);
  check("the waitlist row with its address is dropped, others kept", JSON.stringify(waitlist) === JSON.stringify(["smoke-delete-my-account-someone-else@example.test"]), JSON.stringify(waitlist));
  check("the Stripe customer is marked deleted, not deleted", retired.length === 1 && retired[0].customerId === "cus_smoke_payer");
  const audit = await db.select().from(accountAuditLog).where(and(eq(accountAuditLog.subjectUserId, PAYER), eq(accountAuditLog.action, "account.delete")));
  check("the deletion itself is on the account's audit log, and survives the purge", audit.length === 1 && audit[0].actor === "user");

  console.log("Deleting data but keeping the account");
  await seed(USER, null);
  await db.insert(creditGrants).values({ userId: USER, kind: "pack", grantKey: "smoke-delete-my-account-keep", microsGranted: 100, microsRemaining: 50, amountCents: 500 });
  await db.insert(interestListSignups).values({ email: `${USER}@example.test`, unsubscribeToken: "smoke-delete-my-account-tok-3" });
  await purgeUserData(USER);
  const keptGrant = await db.select().from(creditGrants).where(eq(creditGrants.grantKey, "smoke-delete-my-account-keep"));
  check("credit grants are anonymised, as before (the account still exists)", keptGrant.length === 1 && keptGrant[0].userId === null);
  check("the waitlist row stays", (await db.select({ n: sql<number>`1` }).from(interestListSignups).where(eq(interestListSignups.email, `${USER}@example.test`))).length === 1);
  await purgeUserData(USER, { keepSettings: false });

  console.log("When the sign-in cannot be removed");
  await seed(USER, null);
  const loginDown = fakeDeps({ loginThrows: true });
  const loginErr = await refusal(() => deleteOwnAccount(USER, loginDown.deps));
  check("the data is still deleted", (await counts(USER)).contacts === 0);
  check("and the person is told the sign-in remains", loginErr?.name === "UserFacingError" && /sign-in couldn’t be removed/.test(loginErr.message), loginErr?.message);

  console.log("An operator account");
  await seed(OPERATOR, null);
  const opErr = await refusal(() => deleteOwnAccount(OPERATOR, fakeDeps().deps));
  check("is refused", opErr?.name === "UserFacingError" && /Operator accounts/.test(opErr.message), opErr?.message);
  check("and keeps its data", (await counts(OPERATOR)).contacts === 1);

  for (const id of IDS) {
    await db.delete(contacts).where(eq(contacts.userId, id));
  }
  await db.delete(userSettings).where(inArray(userSettings.userId, IDS));
  await db.delete(accountAuditLog).where(inArray(accountAuditLog.subjectUserId, IDS));
  await db.delete(billingEvents).where(like(billingEvents.eventId, "smoke-delete-my-account-%"));
  await db.delete(creditGrants).where(like(creditGrants.grantKey, "smoke-delete-my-account-%"));
  await db.delete(interestListSignups).where(like(interestListSignups.email, "smoke-delete-my-account-%"));
  setStripeCustomerRetirerForTest(null);
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll account-deletion checks passed.");
});
