/**
 * `user_settings.account_kind`: the operator's control and the one-off seed.
 *
 * Pins:
 *   - a change needs a reason and writes an audit row; a no-op writes none; a kind that is not
 *     internal/tester/neither, or an account that does not exist, is refused;
 *   - the value really does take an account out of an aggregate (`internalAccountSql`) and
 *     returning it to a customer puts it back;
 *   - the seed marks ADMIN_USER_IDS and DEMO_ACCOUNT_USER_ID `internal`, leaves a deliberate
 *     `tester` alone, never invents an account, is idempotent, honours --dry-run, and its
 *     output carries counts only;
 *   - the server action is admin-gated and the user page offers the control.
 *
 * Run: npx tsx scripts/smoke-account-kind.ts
 */
import "./smoke/_env";

import { readFileSync } from "node:fs";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { adminAuditLog, userSettings } from "../src/db/schema";
import { getAccountKind, setAccountKindAsAdmin } from "../src/lib/admin-account-kind";
import { internalAccountSql } from "../src/lib/analytics-internal";
import { ensureUserSettings } from "../src/lib/user-settings";
import { seedAccountKinds } from "./seed-account-kind";
import { run } from "./smoke/_env";

const PREFIX = "user_smoke_kind_";
const OPERATOR = `${PREFIX}operator`;
const TARGET = `${PREFIX}target`;
const ADMIN_A = `${PREFIX}admin_a`;
const ADMIN_B_TESTER = `${PREFIX}admin_b`;
const ADMIN_C_MISSING = `${PREFIX}admin_missing`;
const SHOWCASE = `${PREFIX}showcase`;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function refuses(label: string, fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
  } catch (err) {
    check(label, pattern.test(err instanceof Error ? err.message : String(err)), String(err));
    return;
  }
  throw new Error(`${label} failed: expected a refusal`);
}

run(async () => {
  const db = await getDb();
  const cleanup = async () => {
    await db.delete(userSettings).where(like(userSettings.userId, `${PREFIX}%`));
    await db.delete(adminAuditLog).where(eq(adminAuditLog.adminUserId, OPERATOR));
    await db.delete(adminAuditLog).where(eq(adminAuditLog.adminUserId, "script:seed-account-kind"));
  };
  await cleanup();
  for (const id of [TARGET, ADMIN_A, ADMIN_B_TESTER, SHOWCASE]) await ensureUserSettings(id);
  const audit = async (action: string) =>
    db.select().from(adminAuditLog).where(and(eq(adminAuditLog.action, action), eq(adminAuditLog.targetUserId, TARGET)));

  console.log("the control…");
  await refuses("a change needs a reason", () => setAccountKindAsAdmin(OPERATOR, { targetUserId: TARGET, kind: "internal", reason: "  " }), /at least/i);
  await refuses("a kind outside the list is refused", () => setAccountKindAsAdmin(OPERATOR, { targetUserId: TARGET, kind: "vip" as never, reason: "testing the list" }), /internal, a tester/i);
  await refuses("an account that does not exist is refused", () => setAccountKindAsAdmin(OPERATOR, { targetUserId: `${PREFIX}ghost`, kind: "internal", reason: "no such person" }), /no such account/i);
  check("…and none of those wrote an audit row", (await audit("account_kind.set")).length === 0);
  check("a new account is a customer", (await getAccountKind(TARGET)) === null);
  check("an unknown account has no kind at all", (await getAccountKind(`${PREFIX}ghost`)) === undefined);

  const first = await setAccountKindAsAdmin(OPERATOR, { targetUserId: TARGET, kind: "tester", reason: "beta tester, asked to try it" });
  check("marking a tester reports the change", first.changed && first.from === null && first.to === "tester");
  check("…and stores it", (await getAccountKind(TARGET)) === "tester");
  const rows = await audit("account_kind.set");
  check("…with one audit row: who, what it was, what it is, and why", rows.length === 1 && rows[0]?.adminUserId === OPERATOR && rows[0]?.detail?.from === null && rows[0]?.detail?.to === "tester" && rows[0]?.reason === "beta tester, asked to try it");
  const again = await setAccountKindAsAdmin(OPERATOR, { targetUserId: TARGET, kind: "tester", reason: "saving the same thing again" });
  check("saving the same kind again changes nothing and logs nothing", !again.changed && (await audit("account_kind.set")).length === 1);

  console.log("\nthe effect on an aggregate…");
  const counted = async () => {
    const res = await db.execute(sql`SELECT count(*)::int AS n FROM user_settings s WHERE s.user_id = ${TARGET} AND NOT ${internalAccountSql(sql`s.user_id`)}`);
    return (res.rows[0] as { n: number }).n;
  };
  check("a tester is left out of an aggregate that wraps its id", (await counted()) === 0);
  await setAccountKindAsAdmin(OPERATOR, { targetUserId: TARGET, kind: "internal", reason: "teammate account" });
  check("internal is left out too", (await counted()) === 0);
  await setAccountKindAsAdmin(OPERATOR, { targetUserId: TARGET, kind: null, reason: "they are a real customer after all" });
  check("back to a customer, it counts again", (await counted()) === 1 && (await getAccountKind(TARGET)) === null);
  check("every change is its own audit row", (await audit("account_kind.set")).length === 3);

  console.log("\nthe seed…");
  const savedAdmins = process.env.ADMIN_USER_IDS;
  const savedShowcase = process.env.DEMO_ACCOUNT_USER_ID;
  try {
    process.env.ADMIN_USER_IDS = `${ADMIN_A} ${ADMIN_B_TESTER} ${ADMIN_C_MISSING}`;
    process.env.DEMO_ACCOUNT_USER_ID = SHOWCASE;
    await setAccountKindAsAdmin(OPERATOR, { targetUserId: ADMIN_B_TESTER, kind: "tester", reason: "an admin who is also a tester" });

    const dry = await seedAccountKinds({ dryRun: true });
    check("a dry run counts what it would do", dry.named === 4 && dry.marked === 2 && dry.alreadyMarked === 1 && dry.withoutAccount === 1, JSON.stringify(dry));
    check("…and writes nothing", (await getAccountKind(ADMIN_A)) === null && (await getAccountKind(SHOWCASE)) === null);

    const real = await seedAccountKinds();
    check("the seed marks the admin and the showcase account internal", real.marked === 2 && (await getAccountKind(ADMIN_A)) === "internal" && (await getAccountKind(SHOWCASE)) === "internal", JSON.stringify(real));
    check("…leaves a deliberate tester as it was", (await getAccountKind(ADMIN_B_TESTER)) === "tester");
    check("…and never invents an account for an id with none", (await getAccountKind(ADMIN_C_MISSING)) === undefined && real.withoutAccount === 1);
    const second = await seedAccountKinds();
    check("a second run changes nothing", second.marked === 0 && second.alreadyMarked === 3, JSON.stringify(second));
    const seedAudit = await db.select().from(adminAuditLog).where(eq(adminAuditLog.action, "account_kind.seed"));
    check("one summary audit row, counts only", seedAudit.length === 1 && JSON.stringify(seedAudit[0]?.detail).includes('"marked":2') && !JSON.stringify(seedAudit[0]).includes(PREFIX));
    process.env.ADMIN_USER_IDS = "";
    delete process.env.DEMO_ACCOUNT_USER_ID;
    check("with nothing in the environment it does nothing", (await seedAccountKinds()).named === 0);
    process.env.ADMIN_USER_IDS = "demo-user";
    check("the shared local-dev account is never labelled", (await seedAccountKinds()).named === 0);
  } finally {
    if (savedAdmins === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = savedAdmins;
    if (savedShowcase === undefined) delete process.env.DEMO_ACCOUNT_USER_ID;
    else process.env.DEMO_ACCOUNT_USER_ID = savedShowcase;
  }
  const seedSource = readFileSync("scripts/seed-account-kind.ts", "utf8");
  const mainBody = seedSource.slice(seedSource.indexOf("async function main()"));
  check(
    "the script prints counts only: main reads result fields, never the ids it was given",
    mainBody.includes("console.log(") && /r\.named/.test(mainBody) && !/adminUserIds|getShowcaseAccountId|\bids\b/.test(mainBody)
  );

  console.log("\nthe wiring…");
  const actions = readFileSync("src/actions/admin.ts", "utf8");
  const action = actions.slice(actions.indexOf("export async function setAccountKindAction"));
  check("the action is admin-gated before it does anything", /setAccountKindAction[\s\S]{0,400}?requireAdminUserId\(\)/.test(action.slice(0, 600)));
  const page = readFileSync("src/app/(clerk)/(admin)/admin/users/[userId]/page.tsx", "utf8");
  check("the user page offers the control", page.includes("<AccountKindControl") && page.includes("getAccountKind"));

  await cleanup();
  // Leave the shared database as found: the aggregate check above touched only prefixed rows.
  await db.delete(userSettings).where(inArray(userSettings.userId, [TARGET]));
  console.log("\naccount kind: all checks passed");
});
