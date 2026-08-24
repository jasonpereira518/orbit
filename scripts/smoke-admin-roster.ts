/**
 * Guards the paginated roster query against the two ways it can silently go wrong.
 *
 * 1. DRIFT. `admin-roster.ts` re-implements `resolvePlan`'s precedence in SQL so the plan
 *    filter can run in the database. Two implementations of the paywall's identity rule is
 *    exactly the kind of thing that rots, so every filter is asserted to select the same
 *    set as the JS reduction over `loadAdminUserRows()`.
 *
 * 2. PAGING. A sort without a total order lets LIMIT/OFFSET return the same row on two
 *    pages and skip another entirely — a pager that loses accounts while looking correct.
 *    Every sort key is walked page by page and the union checked against the full set.
 *
 * Run: npx tsx scripts/smoke-admin-roster.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  adminAuditLog,
  chatMessages,
  chatThreads,
  contacts,
  imports,
  interactions,
  usageEvents,
  userSettings,
} from "../src/db/schema";
import { loadAdminUserRows, type AdminUserRow } from "../src/lib/admin-metrics";
import {
  loadAdminRoster,
  loadAdminRosterAll,
  type RosterPlanFilter,
  type RosterSort,
  type RosterStateFilter,
} from "../src/lib/admin-roster";
import { ensureUserSettings } from "../src/lib/user-settings";

const PREFIX = "smoke-roster-";
const U = {
  comped: `${PREFIX}comped`,
  compedLifetime: `${PREFIX}compedlifetime`,
  lifetime: `${PREFIX}lifetime`,
  subscribed: `${PREFIX}subscribed`,
  graceCanceled: `${PREFIX}gracecanceled`,
  lapsed: `${PREFIX}lapsed`,
  pastDue: `${PREFIX}pastdue`,
  free: `${PREFIX}free`,
  noKey: `${PREFIX}nokey`,
  failingAi: `${PREFIX}failingai`,
  suspended: `${PREFIX}suspended`,
  empty: `${PREFIX}empty`,
};
const IDS = Object.values(U);

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(Date.now() - d * DAY);
const ahead = (d: number) => new Date(Date.now() + d * DAY);

async function cleanup() {
  const db = await getDb();
  await db.delete(usageEvents).where(inArray(usageEvents.userId, IDS));
  await db.delete(interactions).where(inArray(interactions.userId, IDS));
  await db.delete(contacts).where(inArray(contacts.userId, IDS));
  await db.delete(chatMessages).where(inArray(chatMessages.userId, IDS));
  await db.delete(chatThreads).where(inArray(chatThreads.userId, IDS));
  await db.delete(imports).where(inArray(imports.userId, IDS));
  await db.delete(adminAuditLog).where(like(adminAuditLog.targetUserId, `${PREFIX}%`));
  await db.delete(userSettings).where(inArray(userSettings.userId, IDS));
}

async function seed() {
  const db = await getDb();
  for (const id of IDS) await ensureUserSettings(id);

  const set = (id: string, values: Partial<typeof userSettings.$inferInsert>) =>
    db.update(userSettings).set(values).where(inArray(userSettings.userId, [id]));

  // One account per branch of resolvePlan, including the two that are easy to get wrong:
  // a canceled subscription still inside its paid period (live), and one past it (free).
  await set(U.comped, { compedPlan: "orbit", compedAt: ago(10), email: "comped@a.test" });
  await set(U.compedLifetime, { compedPlan: "lifetime", email: "compedlife@a.test" });
  await set(U.lifetime, { lifetimePurchasedAt: ago(30), email: "lifetime@a.test" });
  await set(U.subscribed, {
    subscriptionPlan: "orbit",
    subscriptionStatus: "active",
    email: "subscribed@a.test",
  });
  await set(U.graceCanceled, {
    subscriptionPlan: "orbit",
    subscriptionStatus: "canceled",
    subscriptionPeriodEnd: ahead(5),
    email: "grace@a.test",
  });
  await set(U.lapsed, {
    subscriptionPlan: "orbit",
    subscriptionStatus: "canceled",
    subscriptionPeriodEnd: ago(5),
    email: "lapsed@a.test",
  });
  await set(U.pastDue, {
    subscriptionPlan: "orbit",
    subscriptionStatus: "past_due",
    subscriptionPeriodEnd: ahead(3),
    email: "pastdue@a.test",
  });
  await set(U.free, { email: "free@a.test" });
  await set(U.suspended, { suspendedAt: ago(1), email: "suspended@a.test" });
  await set(U.failingAi, { email: "failing@a.test" });
  await set(U.empty, { email: "empty@a.test" });

  // Everyone except `noKey` has a key for their selected provider.
  for (const id of IDS) {
    if (id === U.noKey) continue;
    await set(id, { geminiApiKeyEncrypted: "ciphertext" });
  }
  await set(U.noKey, { aiProvider: "anthropic", email: "nokey@a.test" });

  // Varied aggregate volumes so every sort key has something to order by.
  let n = 0;
  for (const id of IDS) {
    n += 1;
    if (id === U.empty) continue;
    for (let i = 0; i < n; i++) {
      await db.insert(contacts).values({ userId: id, fullName: `Contact ${i}` });
    }
    const [c] = await db.query.contacts.findMany({
      where: inArray(contacts.userId, [id]),
      limit: 1,
    });
    for (let i = 0; i < n * 2; i++) {
      await db.insert(interactions).values({
        userId: id,
        contactId: c.id,
        interactionType: "note",
        interactionDate: ago(i),
      });
    }
    for (let i = 0; i < n; i++) {
      await db.insert(usageEvents).values({
        userId: id,
        operation: "capture.parse",
        provider: "gemini",
        model: "gemini-3.5-flash",
        kind: "completion",
        keyOwner: "user",
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCostMicros: 250,
        success: 1,
      });
    }
  }

  // A clearly failing account: 5 failures out of 6 calls.
  for (let i = 0; i < 5; i++) {
    await db.insert(usageEvents).values({
      userId: U.failingAi,
      operation: "capture.parse",
      provider: "gemini",
      model: "gemini-3.5-flash",
      kind: "completion",
      keyOwner: "user",
      success: 0,
      errorKind: "auth",
    });
  }
}

/** The JS reduction the SQL filter has to agree with. */
function jsFilter(
  rows: AdminUserRow[],
  plan: RosterPlanFilter,
  state: RosterStateFilter
): Set<string> {
  return new Set(
    rows
      .filter((r) => {
        if (plan === "comped") {
          if (r.planSource !== "comp") return false;
        } else if (plan !== "all" && r.plan !== plan) {
          return false;
        }
        switch (state) {
          case "no-key":
            return !r.hasProviderKey;
          case "past-due":
            return r.subscriptionStatus === "past_due";
          case "inactive":
            return r.counts.contacts === 0;
          case "failing-ai":
            return (
              r.counts.aiFailures >= 3 &&
              r.counts.aiFailures * 4 >= r.counts.aiCalls
            );
          case "suspended":
            return r.suspendedAt != null;
          default:
            return true;
        }
      })
      .map((r) => r.userId)
  );
}

const PLANS: RosterPlanFilter[] = ["all", "free", "orbit", "lifetime", "comped"];
const STATES: RosterStateFilter[] = [
  "all",
  "no-key",
  "past-due",
  "inactive",
  "failing-ai",
  "suspended",
];
const SORTS: RosterSort[] = [
  "signup",
  "active",
  "contacts",
  "interactions",
  "ai",
  "email",
];

async function main() {
  console.log("Admin roster");
  await cleanup();
  await seed();

  const all = (await loadAdminUserRows()).filter((r) => r.userId.startsWith(PREFIX));
  check("seeded every account", all.length === IDS.length, `${all.length}`);

  /* ------------------------------------------------ plan precedence agrees with SQL */

  const byId = new Map(all.map((r) => [r.userId, r]));
  check("comped orbit resolves to orbit/comp", byId.get(U.comped)!.plan === "orbit");
  check(
    "comped lifetime outranks everything",
    byId.get(U.compedLifetime)!.plan === "lifetime"
  );
  check("lifetime purchase resolves to lifetime", byId.get(U.lifetime)!.plan === "lifetime");
  check("active subscription resolves to orbit", byId.get(U.subscribed)!.plan === "orbit");
  check(
    "canceled but still paid-through is orbit",
    byId.get(U.graceCanceled)!.plan === "orbit"
  );
  check("lapsed subscription is free", byId.get(U.lapsed)!.plan === "free");

  /* ---------------------------------------- every filter combination matches the JS */

  let combos = 0;
  for (const plan of PLANS) {
    for (const state of STATES) {
      const expected = jsFilter(all, plan, state);
      const actual = await loadAdminRosterAll({ plan, state, q: PREFIX });
      const got = new Set(actual.map((r) => r.userId));
      const missing = [...expected].filter((id) => !got.has(id));
      const extra = [...got].filter((id) => !expected.has(id));
      if (missing.length || extra.length) {
        throw new Error(
          `plan=${plan} state=${state}: missing [${missing}] extra [${extra}]`
        );
      }
      combos += 1;
    }
  }
  console.log(`  ok  ${combos} plan x state filter combinations match resolvePlan`);

  /* --------------------------------------------------------- paging loses no records */

  for (const sort of SORTS) {
    for (const dir of ["asc", "desc"] as const) {
      const seen: string[] = [];
      let page = 1;
      let pageCount = 1;
      do {
        const result = await loadAdminRoster({
          q: PREFIX,
          sort,
          dir,
          page,
          pageSize: 3,
        });
        pageCount = result.pageCount;
        check(
          `sort=${sort} dir=${dir} page=${page} reports the full total`,
          result.total === IDS.length,
          `${result.total}`
        );
        seen.push(...result.rows.map((r) => r.userId));
        page += 1;
      } while (page <= pageCount);

      const unique = new Set(seen);
      if (unique.size !== seen.length) {
        throw new Error(`sort=${sort} dir=${dir} returned a duplicate across pages`);
      }
      if (unique.size !== IDS.length) {
        throw new Error(
          `sort=${sort} dir=${dir} lost accounts: ${IDS.length - unique.size}`
        );
      }
    }
  }
  console.log(`  ok  ${SORTS.length * 2} sort/direction walks page cleanly, no gaps or dupes`);

  /* ------------------------------------------------------------------ sort ordering */

  const byContacts = await loadAdminRoster({ q: PREFIX, sort: "contacts", dir: "desc" });
  const counts = byContacts.rows.map((r) => r.counts.contacts);
  check(
    "contacts desc is actually descending",
    counts.every((v, i) => i === 0 || counts[i - 1] >= v),
    counts.join(",")
  );

  const byEmail = await loadAdminRoster({ q: PREFIX, sort: "email", dir: "asc" });
  const emails = byEmail.rows.map((r) => (r.email ?? r.userId).toLowerCase());
  check(
    "email asc is actually ascending",
    emails.every((v, i) => i === 0 || emails[i - 1] <= v),
    emails.join(",")
  );

  /* ---------------------------------------------------- aggregates match the fan-out */

  const rosterAll = await loadAdminRosterAll({ q: PREFIX });
  const rosterById = new Map(rosterAll.map((r) => [r.userId, r]));
  for (const row of all) {
    const mirror = rosterById.get(row.userId);
    if (!mirror) throw new Error(`roster dropped ${row.userId}`);
    const same =
      mirror.counts.contacts === row.counts.contacts &&
      mirror.counts.interactions === row.counts.interactions &&
      mirror.counts.imports === row.counts.imports &&
      mirror.counts.chatMessages === row.counts.chatMessages &&
      mirror.counts.aiCalls === row.counts.aiCalls &&
      mirror.counts.aiFailures === row.counts.aiFailures &&
      mirror.estimatedCostMicros === row.estimatedCostMicros &&
      mirror.aiTokens.input === row.aiTokens.input &&
      mirror.plan === row.plan &&
      mirror.planSource === row.planSource &&
      mirror.hasProviderKey === row.hasProviderKey;
    if (!same) {
      throw new Error(
        `roster disagrees with the fan-out for ${row.userId}: ` +
          `${JSON.stringify(mirror.counts)} vs ${JSON.stringify(row.counts)}`
      );
    }
  }
  console.log("  ok  CTE aggregates match the six-scan fan-out row for row");

  // The bigint trap: string concatenation would make these enormous, not merely wrong.
  const costs = rosterAll.map((r) => r.estimatedCostMicros);
  check(
    "bigint sums are added, not concatenated",
    costs.every((c) => Number.isFinite(c) && c < 1_000_000),
    costs.join(",")
  );

  /* ------------------------------------------------------------- injection and search */

  const injected = await loadAdminRoster({
    q: PREFIX,
    sort: "contacts; DROP TABLE user_settings" as RosterSort,
  });
  check(
    "an unknown sort key falls back rather than reaching SQL",
    injected.rows.length > 0
  );
  const stillThere = await loadAdminUserRows();
  check("user_settings survived the injection attempt", stillThere.length > 0);

  const quoted = await loadAdminRoster({ q: "' OR 1=1 --" });
  check("a quoted search term matches nothing", quoted.total === 0);

  const byExactId = await loadAdminRoster({ q: U.lifetime });
  check(
    "searching an exact user id finds that account",
    byExactId.total === 1 && byExactId.rows[0].userId === U.lifetime
  );

  const byEmailPrefix = await loadAdminRoster({ q: "lifetime@" });
  check("searching an email prefix finds that account", byEmailPrefix.total === 1);

  /* ----------------------------------------------------------------- empty and bounds */

  const noMatch = await loadAdminRoster({ q: `${PREFIX}nothing-matches-this` });
  check(
    "an empty result reports zero, not NaN",
    noMatch.total === 0 && noMatch.rows.length === 0 && noMatch.pageCount === 1
  );

  const beyondEnd = await loadAdminRoster({ q: PREFIX, page: 99, pageSize: 3 });
  check("a page past the end is empty, not an error", beyondEnd.rows.length === 0);

  const clamped = await loadAdminRoster({ q: PREFIX, pageSize: 10_000 });
  check("page size is clamped", clamped.pageSize <= 200);

  console.log("Done.");
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
