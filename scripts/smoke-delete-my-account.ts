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

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, userSettings } from "../src/db/schema";
import { deleteOwnAccount, type AccountDeletionDeps } from "../src/lib/account-deletion";
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
  const paid = fakeDeps();
  await deleteOwnAccount(PAYER, paid.deps);
  check("its subscription was cancelled first", paid.calls.cancelled.join() === "cus_smoke_payer");
  check("then everything was deleted", (await counts(PAYER)).settings === 0);

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
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll account-deletion checks passed.");
});
