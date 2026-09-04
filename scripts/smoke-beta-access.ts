/**
 * Exercises testing accounts (`user_settings.beta_access`) end to end: the plan precedence,
 * the surface resolver, the operator write path, and the one interaction that is easy to get
 * wrong — surviving a data purge.
 *
 * SAFETY. `./smoke/_env` forces a throwaway PGlite database, so nothing here can reach the
 * shared Neon instance. It still confines itself to `smoke-beta-*` user ids, because the
 * accounts it creates and purges would be real accounts if that guard ever regressed.
 *
 * Run: npx tsx scripts/smoke-beta-access.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { adminAuditLog, appSurfaceFlags, userSettings } from "../src/db/schema";
import { isBetaUser } from "../src/lib/beta";
import {
  getEntitlements,
  isPayingSource,
  resolvePlan,
} from "../src/lib/entitlements";
import {
  isSurfaceHiddenError,
  requireVisibleSurface,
  resolveSurfaceVisibility,
} from "../src/lib/surface-visibility";
import { BETA_SURFACE_KEYS, SURFACES, getSurface } from "../src/lib/surfaces";
import { setBetaAccess } from "../src/lib/admin-operations";
import { purgeUserData } from "../src/lib/user-data";
import { SHOWCASE_PEOPLE, seedShowcase } from "../src/lib/fixtures/showcase";
import { buildChatDiagnostics } from "../src/lib/chat-diagnostics";
import type { ChatContext } from "../src/lib/chat-context";
import { contacts, interactions, reminders, tags } from "../src/db/schema";

const ADMIN = "smoke-beta-admin";
const TESTER = "smoke-beta-tester";
const NORMAL = "smoke-beta-normal";
const PURGED = "smoke-beta-purged";
const ALL_IDS = [ADMIN, TESTER, NORMAL, PURGED];

/** The surface every visibility assertion below is written against. */
const TARGET = "page.testing";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function expectThrows(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    console.log(`  ok  ${label}`);
    return;
  }
  throw new Error(`${label} failed: expected a throw`);
}

async function seedAccount(userId: string, beta: boolean) {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, userId));
  await db.insert(userSettings).values({ userId, email: `${userId}@example.test`, betaAccess: beta });
}

async function readBeta(userId: string): Promise<boolean | undefined> {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { betaAccess: true },
  });
  return row?.betaAccess;
}

/* ------------------------------------------------------------------ registry -------- */

function registryChecks() {
  console.log("\nregistry");

  check("page.testing is a beta surface", BETA_SURFACE_KEYS.has(TARGET));
  check("settings.beta is a beta surface", BETA_SURFACE_KEYS.has("settings.beta"));
  check("there is at least one beta surface", BETA_SURFACE_KEYS.size > 0);

  // A surface cannot be both "nobody may be locked out of this" and "almost nobody may
  // reach this". `isAlwaysVisible` short-circuits the resolver, so the beta flag on such a
  // surface would be silently ignored rather than loudly wrong.
  check(
    "no beta surface is also alwaysVisible",
    SURFACES.every((s) => !(s.beta && s.alwaysVisible))
  );
  check(
    "every beta key resolves to a registry entry",
    [...BETA_SURFACE_KEYS].every((k) => getSurface(k)?.beta === true)
  );
}

/* --------------------------------------------------------------------- plan --------- */

function planChecks() {
  console.log("\nplan resolution");

  check(
    "beta resolves to orbit/beta",
    JSON.stringify(resolvePlan({ betaAccess: true })) ===
      JSON.stringify({ plan: "orbit", source: "beta" })
  );

  // orbit, not lifetime: canUseHostedEnrichment is the one entitlement lifetime lacks, so
  // a tester resolved to lifetime could not reach every gated path.
  check(
    "beta resolves to orbit rather than lifetime",
    resolvePlan({ betaAccess: true }).plan === "orbit"
  );

  check(
    "beta outranks a lifetime comp",
    resolvePlan({ betaAccess: true, compedPlan: "lifetime" }).source === "beta"
  );
  check(
    "beta outranks a lifetime purchase",
    resolvePlan({ betaAccess: true, lifetimePurchasedAt: new Date() }).source === "beta"
  );
  check(
    "beta outranks a live subscription",
    resolvePlan({
      betaAccess: true,
      subscriptionPlan: "orbit",
      subscriptionStatus: "active",
    }).source === "beta"
  );

  // Revoking beta must not disturb the billing state underneath it.
  check(
    "clearing beta reveals the comp again",
    resolvePlan({ betaAccess: false, compedPlan: "lifetime" }).source === "comp"
  );
  check("a false flag changes nothing", resolvePlan({ betaAccess: false }).plan === "free");

  check("beta is not a paying source", !isPayingSource("beta"));
  check("comp is not a paying source", !isPayingSource("comp"));
  check("subscription is a paying source", isPayingSource("subscription"));
  check("lifetime is a paying source", isPayingSource("lifetime"));
}

async function entitlementChecks() {
  console.log("\nentitlements");

  const tester = await getEntitlements(TESTER);
  check("tester is on a paid plan", tester.plan === "orbit");
  check("tester is sourced as beta", tester.source === "beta");
  check("tester has no contact limit", tester.contactLimit === null);
  check("tester reaches hosted enrichment", tester.canUseHostedEnrichment);
  check("tester reaches outreach", tester.canUseOutreach);
  check("tester reaches recruiters", tester.canUseRecruiters);
  check("tester reaches sync", tester.canUseSync);
  check("tester reaches the extension", tester.canUseExtension);

  const normal = await getEntitlements(NORMAL);
  check("a normal account is untouched", normal.plan === "free" && normal.source === "free");
}

/* --------------------------------------------------------------- visibility --------- */

async function visibilityChecks() {
  console.log("\nsurface visibility");

  check("isBetaUser is true for a tester", await isBetaUser(TESTER));
  check("isBetaUser is false for a normal account", !(await isBetaUser(NORMAL)));
  // The shared demo session is refused outside demo mode: a production deploy that lost
  // its Clerk keys would put every visitor on that one account, and the testing tools
  // include one that wipes it. `isDemoMode` needs NODE_ENV === "development" AND no Clerk
  // keys; the smoke harness sets neither, so this asserts the production behaviour.
  const env = process.env as Record<string, string | undefined>;
  const priorNodeEnv = env.NODE_ENV;
  try {
    env.NODE_ENV = "production";
    check("isBetaUser refuses the demo session in production", !(await isBetaUser("demo-user")));
  } finally {
    env.NODE_ENV = priorNodeEnv;
  }
  check("isBetaUser is false for an empty id", !(await isBetaUser("")));

  const normal = await resolveSurfaceVisibility(NORMAL);
  check("a normal user cannot see the testing console", normal.hidden.has(TARGET));
  check("a normal user tags nothing beta", normal.betaKeys.size === 0);
  check("a normal user is not flagged beta", !normal.beta);

  const tester = await resolveSurfaceVisibility(TESTER);
  check("a tester can see the testing console", !tester.hidden.has(TARGET));
  check("a tester gets the surface tagged beta", tester.betaKeys.has(TARGET));
  check("a tester is flagged beta", tester.beta);
  // The nav renders "Hidden"/"Beta" tags off this set, so it has to describe the general
  // user rather than the viewer, even when the viewer can see the surface themselves.
  check("hiddenForUsers still lists the beta surface", tester.hiddenForUsers.has(TARGET));

  // `adminAccessEnabled` needs a Clerk key as well as the id list — "admin requires a real,
  // Clerk-verified identity" — and both are read at call time, which is what makes them
  // settable here. No request context exists, so `isViewingAsUser` resolves false and the
  // operator is exempt, which is the normal case.
  const priorAdmins = process.env.ADMIN_USER_IDS;
  const priorClerk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  try {
    process.env.ADMIN_USER_IDS = ADMIN;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke";
    const admin = await resolveSurfaceVisibility(ADMIN);
    check("an admin is exempt", admin.exempt);
    check("an admin sees the testing console", !admin.hidden.has(TARGET));
    check("an admin is not flagged beta", !admin.beta);
    check("an admin still sees what users cannot", admin.hiddenForUsers.has(TARGET));
  } finally {
    if (priorAdmins === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = priorAdmins;
    if (priorClerk === undefined) {
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    } else {
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = priorClerk;
    }
  }

  await expectThrows("requireVisibleSurface refuses a normal user", async () => {
    await requireVisibleSurface(NORMAL, TARGET);
  });
  try {
    await requireVisibleSurface(NORMAL, TARGET);
  } catch (err) {
    check("the refusal is a SurfaceHiddenError", isSurfaceHiddenError(err));
  }
  await requireVisibleSurface(TESTER, TARGET);
  console.log("  ok  requireVisibleSurface admits a tester");
}

/** The kill switch must not have a hole in it for the people most likely to hit a break. */
async function hidingOutranksBeta() {
  console.log("\nhiding outranks beta");

  const db = await getDb();
  await db
    .insert(appSurfaceFlags)
    .values({ surfaceKey: TARGET, hiddenBy: ADMIN })
    .onConflictDoNothing();
  try {
    const tester = await resolveSurfaceVisibility(TESTER);
    check("an explicitly hidden beta surface stays dark for a tester", tester.hidden.has(TARGET));
    check("and is not tagged beta", !tester.betaKeys.has(TARGET));
    await expectThrows("requireVisibleSurface refuses even a tester", async () => {
      await requireVisibleSurface(TESTER, TARGET);
    });
  } finally {
    await db.delete(appSurfaceFlags).where(eq(appSurfaceFlags.surfaceKey, TARGET));
  }

  const restored = await resolveSurfaceVisibility(TESTER);
  check("unhiding restores the tester's access", !restored.hidden.has(TARGET));
}

/* ------------------------------------------------------------- write path ----------- */

async function writePathChecks() {
  console.log("\noperator write path");

  await expectThrows("a grant without a reason is refused", async () => {
    await setBetaAccess(ADMIN, { targetUserId: NORMAL, enabled: true, reason: "" });
  });
  await expectThrows("a grant to an unknown account is refused", async () => {
    await setBetaAccess(ADMIN, {
      targetUserId: "smoke-beta-nobody",
      enabled: true,
      reason: "checking the guard",
    });
  });
  check("the refused grant wrote nothing", (await readBeta(NORMAL)) === false);

  await setBetaAccess(ADMIN, {
    targetUserId: NORMAL,
    enabled: true,
    reason: "smoke test grant",
  });
  check("granting sets the flag", (await readBeta(NORMAL)) === true);
  check("the granted account resolves as beta", (await getEntitlements(NORMAL)).source === "beta");

  await setBetaAccess(ADMIN, {
    targetUserId: NORMAL,
    enabled: false,
    reason: "smoke test revoke",
  });
  check("revoking clears the flag", (await readBeta(NORMAL)) === false);

  const db = await getDb();
  const audit = await db
    .select({ action: adminAuditLog.action, reason: adminAuditLog.reason })
    .from(adminAuditLog)
    .where(eq(adminAuditLog.targetUserId, NORMAL));
  const actions = audit.map((r) => r.action);
  check("the grant was audited", actions.includes("account.beta.grant"));
  check("the revoke was audited", actions.includes("account.beta.revoke"));
  check(
    "the reason was recorded",
    audit.some((r) => r.reason === "smoke test grant")
  );
}

/**
 * The trap this whole script exists for.
 *
 * `purgeUserData` deletes the settings row and recreates it from an explicit column list,
 * so a flag missing from that list is silently dropped. Since the reset button IS a beta
 * surface, losing it here would mean every reset revoked the tester's access to the tool
 * that performed it — and the failure would look like the toggle "not saving".
 */
async function purgeChecks() {
  console.log("\nsurviving a purge");

  check("the account starts out beta", (await readBeta(PURGED)) === true);
  await purgeUserData(PURGED);
  check("beta survives purgeUserData", (await readBeta(PURGED)) === true);

  await purgeUserData(PURGED, { keepSettings: false });
  check("a hard delete still removes the row", (await readBeta(PURGED)) === undefined);
}

/**
 * The reseed the testing console offers. Worth covering here because the fixture was moved
 * out of `scripts/seed-showcase.ts` so the console could share it, and nothing else would
 * notice if the extraction had dropped rows or broken the day-offset arithmetic.
 */
async function reseedChecks() {
  console.log("\nshowcase reseed");

  const result = await seedShowcase(PURGED, { now: new Date() });
  check(
    "seeds every person in the fixture",
    result.contacts === SHOWCASE_PEOPLE.length,
    `${result.contacts} of ${SHOWCASE_PEOPLE.length}`
  );
  check("the fixture is not empty", result.contacts > 20, String(result.contacts));
  check("interactions came with it", result.interactions > 0);
  check("reminders came with it", result.reminders > 0);
  check("tags came with it", result.tags > 0 && result.tagLinks > 0);
  check("companies repeat, so clusters form", result.companies < result.contacts);
  check("there are overdue follow-ups", result.overdueFollowUps > 0);
  check("there are upcoming follow-ups", result.upcomingFollowUps > 0);

  const db = await getDb();
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.userId, PURGED));
  check("the contacts are really there", rows.length === result.contacts);

  // Reseeding replaces rather than appends — the console's reset button would otherwise
  // double the network every time it was pressed.
  const again = await seedShowcase(PURGED, { now: new Date() });
  const after = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.userId, PURGED));
  check(
    "reseeding replaces rather than appends",
    after.length === again.contacts,
    `${after.length}`
  );

  check("the account is still beta after a reseed", (await readBeta(PURGED)) === true);
}

/**
 * The chat trace is built from whole `RankedContact` rows — which carry notes, AI summaries
 * and key facts — and is serialized straight into an SSE frame. `buildChatDiagnostics`
 * therefore names every field it emits rather than spreading the row, and this asserts it:
 * a field added to `RankedContact` later must not ride along into a chat response.
 */
function diagnosticsChecks() {
  console.log("\nchat diagnostics");

  const secret = "PRIVATE-NOTE-THAT-MUST-NOT-LEAK";
  const ctx = {
    trace: {
      stages: [{ name: "hybrid search", ms: 12 }],
      embedded: true,
      parsed: { semanticQuery: "who works at acme", filters: { company: ["Acme"] }, expansionTerms: ["acme"] },
      candidateCount: 60,
      rerank: { ran: true, outcome: "kept" as const, scores: [{ id: "c1", relevance: 9 }] },
      finalCount: 1,
      constants: { candidatePool: 60, finalContactCount: 12 },
    },
    retrieved: [
      {
        id: "c1",
        fullName: "Ada Lovelace",
        company: "Acme",
        notes: secret,
        aiSummary: secret,
        keyFacts: [secret],
        email: "ada@example.test",
        matchedArms: ["fts", "semantic"],
        rrfScore: 0.0312,
        relevance: 8.5,
        filterMatched: true,
      },
    ],
  } as unknown as ChatContext;

  const diag = buildChatDiagnostics(ctx);
  const serialized = JSON.stringify(diag);

  check("no note or summary text reaches the wire", !serialized.includes(secret));
  check("no email reaches the wire", !serialized.includes("ada@example.test"));

  const keys = Object.keys(diag.contacts[0]).sort();
  check(
    "the contact row is exactly the declared whitelist",
    keys.join(",") ===
      "company,fullName,filterMatched,id,matchedArms,relevance,rerankScore,rrfScore"
        .split(",")
        .sort()
        .join(","),
    keys.join(",")
  );

  check("the rerank score is joined back on", diag.contacts[0].rerankScore === 9);
  check("filters are flattened for display", diag.parsed.filters[0]?.value === "Acme");
  check("stage times are totalled", diag.totalMs === 12);
}

async function cleanup() {
  const db = await getDb();
  for (const id of ALL_IDS) {
    await db.delete(reminders).where(eq(reminders.userId, id));
    await db.delete(interactions).where(eq(interactions.userId, id));
    await db.delete(contacts).where(eq(contacts.userId, id));
    await db.delete(tags).where(eq(tags.userId, id));
    await db.delete(adminAuditLog).where(eq(adminAuditLog.targetUserId, id));
    await db.delete(userSettings).where(eq(userSettings.userId, id));
  }
}

run(async () => {
  console.log("beta access");
  registryChecks();
  planChecks();
  diagnosticsChecks();

  await seedAccount(TESTER, true);
  await seedAccount(NORMAL, false);
  await seedAccount(PURGED, true);

  try {
    await entitlementChecks();
    await visibilityChecks();
    await hidingOutranksBeta();
    await writePathChecks();
    await reseedChecks();
    await purgeChecks();
  } finally {
    await cleanup();
  }

  console.log("\nall beta-access checks passed");
});
