/**
 * Meetings are Pro and Lifetime only — at every entry point, not just in the UI.
 * Run: npx tsx scripts/smoke-meeting-gate.ts
 */
import "./smoke/_env";
import { setDeepgramEnabledForSmoke } from "./smoke/_env";

import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { meetingSessions, speechUsage, userSettings } from "../src/db/schema";
import { entitlementsForPlan, FEATURE_DENIAL, isPaywallError, requireEntitlement } from "../src/lib/entitlements";
import { createMeetingSession } from "../src/actions/meetings";
import { monthWindow } from "../src/lib/speech-limits";

const USER = "demo-user";
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

/**
 * Isolates one top-level `export async function <name>(...) { ... }` from a source string —
 * everything from its declaration up to the next top-level `export async function`, or EOF.
 * Pure, so it can be proven against a synthetic sample before it is trusted against the
 * real file (same shape as the sample checks in scripts/smoke-ai-access.ts).
 */
function extractFunction(source: string, name: string): string {
  const marker = new RegExp(String.raw`export\s+async\s+function\s+${name}\s*\(`);
  const m = marker.exec(source);
  if (!m) throw new Error(`function ${name} not found`);
  const rest = source.slice(m.index + m[0].length);
  const next = rest.search(/\n\s*export\s+async\s+function\s+/);
  return next === -1 ? rest : rest.slice(0, next);
}

const MEETINGS_ACTIONS = "src/actions/meetings.ts";
/** Cost money to start/continue: must go through the plan gate, not bare auth. */
const GATED_ACTIONS = ["createMeetingSession", "resumeMeetingSession", "endMeetingSession", "analyzeMeetingSession"];
/**
 * Read or delete a meeting a user already recorded: must stay on bare auth, DELIBERATELY —
 * a downgraded account must keep access to its own recordings (see src/lib/plan-guards.ts).
 */
const UNGATED_ACTIONS = ["loadMeetingTranscript", "discardMeetingSession"];

/**
 * Source guard: proves `src/actions/meetings.ts` actually calls `requireMeetingsUser()` for
 * the four actions that cost money, and stays on bare `requireUserId()` for the two that
 * read or delete a meeting already recorded. A passing `requireEntitlement("meetings")`
 * check (above) proves the GATE works in isolation; it says nothing about whether any given
 * action actually calls it — an action that quietly kept `requireUserId()` would pass every
 * other check in this file and still let a free account record meetings for free. This is
 * what closes that gap.
 */
function sourceGuard() {
  console.log("\nsource guard — requireMeetingsUser wiring in " + MEETINGS_ACTIONS);

  // Prove the extraction itself bites before trusting it against the real file.
  const sample = [
    "export async function foo(x: number) {",
    "  const userId = await requireUserId();",
    "  return userId;",
    "}",
    "",
    "export async function bar() {",
    "  const userId = await requireMeetingsUser();",
    "  return userId;",
    "}",
  ].join("\n");
  check(
    "extractFunction isolates one function's body",
    /requireUserId/.test(extractFunction(sample, "foo")) && !/requireMeetingsUser/.test(extractFunction(sample, "foo"))
  );
  check("...and stops before the next one", /requireMeetingsUser/.test(extractFunction(sample, "bar")) && !/requireUserId/.test(extractFunction(sample, "bar")));

  const raw = readFileSync(MEETINGS_ACTIONS, "utf8");
  // Strip comments first, the same way scripts/smoke-ai-access.ts does, so a doc comment
  // that merely NAMES the other guard (as this file's own comments do) cannot fool the scan.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const name of GATED_ACTIONS) {
    const body = extractFunction(code, name);
    const callsGuard = /\brequireMeetingsUser\s*\(/.test(body);
    const callsBareAuth = /\brequireUserId\s*\(/.test(body);
    check(
      `${name} calls requireMeetingsUser, not bare requireUserId`,
      callsGuard && !callsBareAuth,
      `requireMeetingsUser=${callsGuard} requireUserId=${callsBareAuth}`
    );
  }

  // The entitlement says this plan MAY record; the allowance says whether there is anything
  // left to record with. `createMeetingSession` checked only the first, so an account at 100%
  // got a share picker, a started recording, an instant "Recording stopped" and an empty
  // session row — instead of being told, before any of that, when its hours come back.
  const createBody = extractFunction(code, "createMeetingSession");
  check(
    "createMeetingSession also checks the meeting allowance, not just the entitlement",
    /\bspeechAllowance\s*\(/.test(createBody) && /\bexhausted\b/.test(createBody),
    createBody.slice(0, 200)
  );
  check(
    "…and names the reset date when it refuses",
    /resetLabel\s*\(\s*allowance\.resetsAt\s*\)/.test(createBody)
  );
  // The cap meters ORBIT's Deepgram key. `ORBIT_DEEPGRAM=off` is an incident lever that sends
  // transcription back to the user's own OpenAI/Gemini key, where a meeting costs Orbit
  // nothing — so enforcing a spent cap there locks a paying account out of a meeting nobody
  // is paying for, and tells them their hours are gone when their hours are not the problem.
  check(
    "…and only enforces the cap while Deepgram is the engine",
    /\bdeepgramEnabled\s*\(\s*\)/.test(createBody),
    createBody.slice(0, 400)
  );

  for (const name of UNGATED_ACTIONS) {
    const body = extractFunction(code, name);
    const callsGuard = /\brequireMeetingsUser\s*\(/.test(body);
    const callsBareAuth = /\brequireUserId\s*\(/.test(body);
    check(
      `${name} stays on bare requireUserId, not requireMeetingsUser`,
      callsBareAuth && !callsGuard,
      `requireMeetingsUser=${callsGuard} requireUserId=${callsBareAuth}`
    );
  }
}

async function setPlan(plan: "free" | "orbit" | "lifetime") {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({
    userId: USER,
    ...(plan === "lifetime" ? { lifetimePurchasedAt: new Date() } : {}),
    ...(plan === "orbit" ? { subscriptionStatus: "active", subscriptionPlan: "orbit" } : {}),
  });
}

async function main() {
  sourceGuard();

  console.log("\nentitlements");
  check("free cannot meet", entitlementsForPlan("free", "free").canUseMeetings === false);
  check("Pro can meet", entitlementsForPlan("orbit", "subscription").canUseMeetings === true);
  check("Lifetime can meet", entitlementsForPlan("lifetime", "lifetime").canUseMeetings === true);
  check("the denial names both paid plans", /Pro/.test(FEATURE_DENIAL.meetings) && /Lifetime/.test(FEATURE_DENIAL.meetings));

  // `requireMeetingsUser()` (src/lib/plan-guards.ts) is `requireUserId()` then
  // `requireEntitlement(userId, "meetings")`. This exercises that second half against the
  // real DB-backed plan resolution, the same way smoke-entitlements.ts exercises every
  // other feature key — deliberately WITHOUT going through demo mode: `isDemoAccount()`
  // (src/lib/demo-account.ts) treats every account as exempt from every gate whenever
  // `NODE_ENV=development`, which is also the only way `requireUserId()` can resolve an
  // identity without real Clerk keys. Flipping NODE_ENV to reach the action's auth step
  // would therefore ALSO lift the very paywall being tested, so the free/paid distinction
  // has to be proven at the `requireEntitlement` layer instead.
  console.log("\nrequireEntitlement(\"meetings\") — the guard requireMeetingsUser calls");
  await setPlan("free");
  let freeThrew: unknown = null;
  try {
    await requireEntitlement(USER, "meetings");
  } catch (err) {
    freeThrew = err;
  }
  check("a free account is refused", isPaywallError(freeThrew), String(freeThrew));

  await setPlan("orbit");
  let proThrew: unknown = null;
  try {
    await requireEntitlement(USER, "meetings");
  } catch (err) {
    proThrew = err;
  }
  check("a Pro account is allowed", proThrew === null, String(proThrew));

  await setPlan("lifetime");
  let lifetimeThrew: unknown = null;
  try {
    await requireEntitlement(USER, "meetings");
  } catch (err) {
    lifetimeThrew = err;
  }
  check("a Lifetime account is allowed", lifetimeThrew === null, String(lifetimeThrew));

  // Wiring sanity check ONLY — this cannot distinguish free from Pro. It runs in demo mode
  // (no Clerk keys locally), and `isDemoAccount()` bypasses every plan gate unconditionally
  // there, so this call would return ok:true identically even if `requireMeetingsUser` had
  // never been wired into `createMeetingSession` at all — a free demo-user would sail
  // through it too. What actually proves the wiring is `sourceGuard()` above, which reads
  // the action's own source and asserts it calls `requireMeetingsUser`, not bare
  // `requireUserId`. This just confirms the action still reaches the database and returns
  // `ok: true` for an authenticated call, i.e. that nothing else broke.
  console.log("\ncreateMeetingSession — wiring sanity check (authenticated, NOT a plan check)");
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  process.env.ORBIT_DEMO_DATA = "off";
  (process.env as Record<string, string>).NODE_ENV = "development";
  const allowed = await createMeetingSession({ includesMic: true, recorderId: "r2" });
  check("the action still works end to end when authenticated", allowed.ok === true, JSON.stringify(allowed));

  // A spent month is refused BEFORE a session row exists — no share picker, no recording that
  // stops a second later, nothing to clean up. This one does distinguish real states: the
  // allowance is read from `speech_usage`, which demo mode does not bypass.
  console.log("\ncreateMeetingSession — a spent month is refused up front, with the reset date");
  {
    const db = await getDb();
    await db.delete(meetingSessions).where(eq(meetingSessions.userId, USER));
    await db.delete(speechUsage).where(eq(speechUsage.userId, USER));
    // Above both caps (Pro 18,000 s, Lifetime 36,000 s), so this holds whichever plan demo
    // mode resolves for the synthetic user.
    await db.insert(speechUsage).values({ userId: USER, kind: "meeting", seconds: 40_000, source: "stream" });

    // The cap only exists while Orbit is the one paying, so the switch has to be ON for it
    // to bite at all. `_env` strips the key from every smoke, which is the off state.
    setDeepgramEnabledForSmoke(true);
    const refused = await createMeetingSession({ includesMic: true, recorderId: "r3" });
    check("a spent month is refused", refused.ok === false, JSON.stringify(refused));
    const resetDay = monthWindow(new Date()).resetsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    check(
      `…with copy naming the reset date (${resetDay})`,
      refused.ok === false && refused.error.includes(resetDay),
      refused.ok === false ? refused.error : ""
    );
    const rows = await db.select().from(meetingSessions).where(eq(meetingSessions.userId, USER));
    check("…and no session row is left behind", rows.length === 0, `${rows.length} rows`);

    // The kill switch, with the very same spent month: transcription now runs on the user's
    // OWN OpenAI/Gemini key at no cost to Orbit, so the meeting must start. Before this, an
    // incident that switched Deepgram off also locked every paying account whose cap was
    // spent out of recording anything at all.
    console.log("\n…but with ORBIT_DEEPGRAM off, a spent cap blocks nothing");
    setDeepgramEnabledForSmoke(false);
    const allowedAnyway = await createMeetingSession({ includesMic: true, recorderId: "r4" });
    check("the meeting starts on the user's own key", allowedAnyway.ok === true, JSON.stringify(allowedAnyway));
    check(
      "…and no stale “you’ve used this month’s hours” copy is produced",
      allowedAnyway.ok === true || !/this month’s meeting hours/.test(allowedAnyway.error),
      allowedAnyway.ok === false ? allowedAnyway.error : ""
    );

    await db.delete(speechUsage).where(eq(speechUsage.userId, USER));
    await db.delete(meetingSessions).where(eq(meetingSessions.userId, USER));
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll meeting gate checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
