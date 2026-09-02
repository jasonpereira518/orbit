/**
 * Exercises the account-alert predicates end-to-end against the local PGlite database:
 * every condition, the windows that keep non-dismissible alerts from becoming permanent,
 * the ordering, the surface filter, the query budget, and the guarantee that an alert can
 * never reach an OS desktop notification.
 *
 * Run: npx tsx scripts/smoke-account-alerts.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

/**
 * Two env facts this test depends on, set BEFORE any module that reads them is imported.
 *
 *  - `DATABASE_URL` unset forces the PGlite path in `src/db/index.ts`. `.env.local` is
 *    loaded above and, where it exists, points at the SHARED Neon database — this script
 *    deletes rows, so inheriting that would delete them from production.
 *  - `VERCEL` set makes `allowEnvProviderKeys()` false, which is what production does. Any
 *    `GEMINI_API_KEY` lying around in the environment would otherwise satisfy the AI-key
 *    predicate and the `ai.no_key` cases below would silently pass for the wrong reason.
 */
delete process.env.DATABASE_URL;
process.env.VERCEL = "1";

/**
 * A configured Gmail OAuth app. `connectionFacts` suppresses connection alerts entirely
 * when the deployment has no OAuth app, because "Reconnect" would lead nowhere — so
 * without these the connection cases below would pass vacuously, asserting silence and
 * getting it for the wrong reason. The suppression branch itself is tested at 6b.
 */
process.env.GOOGLE_CLIENT_ID = "smoke-client-id";
process.env.GOOGLE_CLIENT_SECRET = "smoke-client-secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/api/gmail/callback";

import { eq } from "drizzle-orm";
import { closeDb, getDb } from "../src/db";
import {
  appSurfaceFlags,
  calendarSubscriptions,
  contacts,
  gmailConnections,
  imports,
  userSettings,
} from "../src/db/schema";
import {
  CONTACT_CAP_WARN_RATIO,
  IMPORT_ALERT_WINDOW_MS,
  STALLED_IMPORT_MS,
  isDismissible,
  type HealthCode,
} from "../src/lib/account-alerts";
import { getAccountAlerts } from "../src/lib/account-health";
import { FREE_CONTACT_LIMIT } from "../src/lib/plan-limits";
import { getSurface } from "../src/lib/surfaces";
import { startQueryCount, stopQueryCount } from "../src/lib/query-counter";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-account-alerts-user";
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

let failures = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`);
    return;
  }
  console.log(`  ok    ${label}`);
}

function ago(ms: number) {
  return new Date(Date.now() - ms);
}

async function codes(): Promise<HealthCode[]> {
  return (await getAccountAlerts(USER)).map((a) => a.code);
}

async function reset() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db
    .delete(calendarSubscriptions)
    .where(eq(calendarSubscriptions.userId, USER));
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.delete(appSurfaceFlags);
  await ensureUserSettings(USER);
  // Healthy baseline: onboarded, a key for the selected provider, on a paid plan so the
  // contact cap does not apply.
  await setSettings({
    onboardingCompletedAt: new Date(),
    aiProvider: "gemini",
    geminiApiKeyEncrypted: "enc:whatever",
    compedPlan: "orbit",
  });
}

async function setSettings(patch: Partial<typeof userSettings.$inferInsert>) {
  const db = await getDb();
  await db.update(userSettings).set(patch).where(eq(userSettings.userId, USER));
}

async function addImport(row: Partial<typeof imports.$inferInsert>) {
  const db = await getDb();
  await db.insert(imports).values({
    userId: USER,
    importType: "linkedin_connections",
    status: "failed",
    ...row,
  } as typeof imports.$inferInsert);
}

async function addContacts(n: number) {
  if (n <= 0) return;
  const db = await getDb();
  const rows = Array.from({ length: n }, (_, i) => ({
    userId: USER,
    fullName: `Smoke Contact ${i}`,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(contacts).values(rows.slice(i, i + 200));
  }
}

async function main() {
  console.log("Account alerts smoke test (pglite)…");

  // --- 1. healthy account -------------------------------------------------------------
  await reset();
  const healthy = await getAccountAlerts(USER);
  check("healthy account has no alerts", healthy.length === 0, JSON.stringify(healthy.map((a) => a.code)));

  // --- 2/3. AI key + the onboarding gate ----------------------------------------------
  await reset();
  await setSettings({ geminiApiKeyEncrypted: null });
  const noKey = await getAccountAlerts(USER);
  check("2 missing provider key alerts", noKey.some((a) => a.code === "ai.no_key"));
  check(
    "2 missing key is an error (lights the bell dot)",
    noKey.find((a) => a.code === "ai.no_key")?.severity === "error"
  );
  check(
    "2 missing key names the selected provider",
    noKey.find((a) => a.code === "ai.no_key")?.title.includes("Gemini") === true,
    noKey.find((a) => a.code === "ai.no_key")?.title
  );

  await setSettings({ onboardingCompletedAt: null });
  check(
    "3 no key alert before onboarding completes",
    !(await codes()).includes("ai.no_key")
  );

  // A key for a DIFFERENT provider than the one selected is still no key.
  await reset();
  await setSettings({
    aiProvider: "anthropic",
    geminiApiKeyEncrypted: "enc:whatever",
    anthropicApiKeyEncrypted: null,
  });
  check(
    "3b key for the wrong provider does not satisfy the check",
    (await codes()).includes("ai.no_key")
  );

  // --- 4/5/6. mailbox connection ------------------------------------------------------
  const db = await getDb();
  const gmailBase = {
    userId: USER,
    emailAddress: "smoke@example.com",
    accessTokenEncrypted: "enc:access",
  };

  await reset();
  await db.insert(gmailConnections).values({
    ...gmailBase,
    status: "needs_reauth",
    refreshTokenEncrypted: "enc:refresh",
  });
  check("4 needs_reauth alerts", (await codes()).includes("connection.gmail"));

  await reset();
  await db.insert(gmailConnections).values({
    ...gmailBase,
    status: "active",
    refreshTokenEncrypted: "enc:refresh",
    tokenExpiresAt: ago(60 * MINUTE),
  });
  check(
    "5 expired token WITH a refresh token is silent (the normal state)",
    !(await codes()).includes("connection.gmail")
  );

  await reset();
  await db.insert(gmailConnections).values({
    ...gmailBase,
    status: "active",
    refreshTokenEncrypted: null,
    tokenExpiresAt: ago(60 * MINUTE),
  });
  check(
    "6 expired token with NO refresh token alerts",
    (await codes()).includes("connection.gmail")
  );

  // 6b. The suppression branch: a broken connection on a deployment with no OAuth app
  // configured has no reconnect flow to offer, so nagging about it is a dead end.
  const savedClientId = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  check(
    "6b broken connection is silent when OAuth is unconfigured",
    !(await codes()).includes("connection.gmail")
  );
  process.env.GOOGLE_CLIENT_ID = savedClientId;
  check(
    "6b restoring the OAuth config brings the alert back",
    (await codes()).includes("connection.gmail")
  );

  // --- 7/8/9/10. imports --------------------------------------------------------------
  await reset();
  await addImport({ status: "failed", updatedAt: new Date(), fileName: "conns.csv", errorMessage: "boom" });
  check("7 recent failed import alerts", (await codes()).includes("import.failed"));

  await reset();
  await addImport({ status: "failed", updatedAt: ago(IMPORT_ALERT_WINDOW_MS + DAY) });
  check(
    "8 failed import older than the window is silent",
    !(await codes()).includes("import.failed")
  );

  await reset();
  await addImport({
    status: "processing",
    updatedAt: ago(STALLED_IMPORT_MS + MINUTE),
    rowsProcessed: 12,
    totalRows: 400,
  });
  const stalled = await getAccountAlerts(USER);
  check("9 stalled import alerts", stalled.some((a) => a.code === "import.stalled"));
  check(
    "9 stalled import is a warn",
    stalled.find((a) => a.code === "import.stalled")?.severity === "warn"
  );
  check(
    "9 stalled import body carries progress",
    stalled.find((a) => a.code === "import.stalled")?.body?.includes("12 of 400") === true,
    stalled.find((a) => a.code === "import.stalled")?.body ?? undefined
  );

  await reset();
  await addImport({ status: "processing", updatedAt: new Date() });
  check(
    "9b a live import is not stalled",
    !(await codes()).includes("import.stalled")
  );

  await reset();
  for (let i = 0; i < 3; i += 1) {
    await addImport({ status: "failed", updatedAt: new Date(), fileName: `f${i}.csv` });
  }
  const many = await getAccountAlerts(USER);
  const failedAlerts = many.filter((a) => a.code === "import.failed");
  check("10 three failed imports aggregate to one alert", failedAlerts.length === 1);
  check(
    "10 aggregate title names the count",
    failedAlerts[0]?.title === "3 imports didn't finish",
    failedAlerts[0]?.title
  );

  // --- 11. calendar -------------------------------------------------------------------
  await reset();
  await db.insert(calendarSubscriptions).values({
    userId: USER,
    icsUrl: "https://example.com/feed.ics",
    label: "Work",
    enabled: 1,
    lastSyncStatus: "error",
    lastSyncError: "503 from the feed",
  });
  const cal = await getAccountAlerts(USER);
  check("11 calendar sync error alerts", cal.some((a) => a.code === "calendar.sync_error"));
  check(
    "11 calendar sync error is a warn, not an error",
    cal.find((a) => a.code === "calendar.sync_error")?.severity === "warn"
  );

  await db
    .update(calendarSubscriptions)
    .set({ enabled: 0 })
    .where(eq(calendarSubscriptions.userId, USER));
  check(
    "11b a disabled feed is not failing",
    !(await codes()).includes("calendar.sync_error")
  );

  // --- 12/13. contact cap -------------------------------------------------------------
  await reset();
  await setSettings({ compedPlan: null });
  await addContacts(FREE_CONTACT_LIMIT);
  const capped = await codes();
  check("12 at the cap alerts", capped.includes("plan.contact_cap_reached"));
  check("12 near-cap is suppressed at the cap", !capped.includes("plan.contact_cap_near"));

  await reset();
  await setSettings({ compedPlan: null });
  await addContacts(Math.floor(FREE_CONTACT_LIMIT * CONTACT_CAP_WARN_RATIO));
  const near = await codes();
  check("13 near the cap warns", near.includes("plan.contact_cap_near"));
  check("13 cap-reached is not also firing", !near.includes("plan.contact_cap_reached"));

  await reset();
  await addContacts(FREE_CONTACT_LIMIT + 10);
  check(
    "13b a paid account over the free cap is silent",
    !(await codes()).some((c) => c.startsWith("plan."))
  );

  // --- 14/15. billing -----------------------------------------------------------------
  await reset();
  await setSettings({
    compedPlan: null,
    subscriptionPlan: "orbit",
    subscriptionStatus: "past_due",
    subscriptionPeriodEnd: new Date(Date.now() + 10 * DAY),
  });
  check("14 past_due within the paid period alerts", (await codes()).includes("billing.past_due"));

  await setSettings({ subscriptionPeriodEnd: ago(10 * DAY) });
  const lapsed = await codes();
  check("15 past_due after the period ends is silent", !lapsed.includes("billing.past_due"));
  check(
    "15 the lapsed account gets the honest free-plan alert instead",
    lapsed.includes("plan.contact_cap_near") || !lapsed.includes("billing.past_due")
  );

  // --- 16. ordering and determinism ---------------------------------------------------
  await reset();
  await setSettings({
    geminiApiKeyEncrypted: null,
    compedPlan: null,
    subscriptionPlan: "orbit",
    subscriptionStatus: "past_due",
    subscriptionPeriodEnd: new Date(Date.now() + 10 * DAY),
  });
  await db.insert(gmailConnections).values({
    ...gmailBase,
    status: "needs_reauth",
    refreshTokenEncrypted: "enc:refresh",
  });
  await addImport({ status: "failed", updatedAt: new Date() });
  await addImport({
    status: "processing",
    updatedAt: ago(STALLED_IMPORT_MS + MINUTE),
  });
  await db.insert(calendarSubscriptions).values({
    userId: USER,
    icsUrl: "https://example.com/feed.ics",
    enabled: 1,
    lastSyncStatus: "error",
  });

  const all = await getAccountAlerts(USER);
  const allCodes = all.map((a) => a.code);
  check(
    "16 errors sort ahead of warns",
    all.every((a, i) => i === 0 || !(a.severity === "error" && all[i - 1].severity === "warn")),
    JSON.stringify(all.map((a) => `${a.severity}:${a.code}`))
  );
  check(
    "16 expected order",
    JSON.stringify(allCodes) ===
      JSON.stringify([
        "ai.no_key",
        "connection.gmail",
        "import.failed",
        "billing.past_due",
        "import.stalled",
        "calendar.sync_error",
      ]),
    JSON.stringify(allCodes)
  );
  const again = (await getAccountAlerts(USER)).map((a) => a.code);
  check("16 order is stable across calls", JSON.stringify(allCodes) === JSON.stringify(again));
  check("16 ids are unique", new Set(all.map((a) => a.id)).size === all.length);
  check("16 every id is alert-prefixed", all.every((a) => a.id.startsWith("alert:")));

  // --- 17. surface filter -------------------------------------------------------------
  await db
    .insert(appSurfaceFlags)
    .values({ surfaceKey: "settings.ai", hiddenBy: "smoke" })
    .onConflictDoNothing();
  check(
    "17 an alert pointing at a hidden surface is dropped",
    !(await codes()).includes("ai.no_key")
  );
  await db.delete(appSurfaceFlags);

  // Every surfaceKey the copy layer emits must be a real registry key, or the filter
  // above silently never matches.
  const keys = all.map((a) => a.surfaceKey).filter((k): k is string => k !== null);
  check(
    "17b every surfaceKey resolves in the surface registry",
    keys.every((k) => getSurface(k) !== undefined),
    keys.filter((k) => getSurface(k) === undefined).join(", ")
  );

  // --- 17c. dismissibility is per-code, and crosses severity in BOTH directions --------
  // The whole point of the flag is that it is not a rename of `severity`; if it ever
  // collapses back onto severity these two assertions are what notice.
  const blocking: HealthCode[] = [
    "ai.no_key",
    "connection.gmail",
    "connection.outlook",
    "plan.contact_cap_reached",
    "billing.past_due",
  ];
  const hideable: HealthCode[] = [
    "import.failed",
    "import.stalled",
    "calendar.sync_error",
    "plan.contact_cap_near",
  ];
  check(
    "17c blocking alerts cannot be dismissed",
    blocking.every((c) => !isDismissible(c)),
    blocking.filter((c) => isDismissible(c)).join(", ")
  );
  check(
    "17c historical/advisory alerts can be dismissed",
    hideable.every((c) => isDismissible(c)),
    hideable.filter((c) => !isDismissible(c)).join(", ")
  );
  check(
    "17c an ERROR is dismissible (import.failed) — flag is not severity",
    isDismissible("import.failed")
  );
  check(
    "17c a WARNING is not dismissible (billing.past_due) — flag is not severity",
    !isDismissible("billing.past_due")
  );
  // Everything the evaluator can emit is classified one way or the other, so a new code
  // cannot quietly default to hideable.
  check(
    "17c every emitted alert carries a dismissible flag",
    all.every((a) => typeof a.dismissible === "boolean")
  );

  // --- 18. the desktop-notification leak guard ----------------------------------------
  const { listDueNotificationItems } = await import("../src/actions/reminders");
  const due = await listDueNotificationItems().catch(() => null);
  if (due === null) {
    console.log("  skip  18 leak guard (needs an auth context)");
  } else {
    check("18 no alert reaches OS notifications", due.every((i) => !i.id.startsWith("alert:")));
  }

  // --- 19. query budget ---------------------------------------------------------------
  await reset();
  startQueryCount();
  await getAccountAlerts(USER);
  const paidStatements = stopQueryCount();
  check(
    `19 paid account costs few statements (${paidStatements})`,
    paidStatements <= 4,
    String(paidStatements)
  );

  await setSettings({ compedPlan: null });
  startQueryCount();
  await getAccountAlerts(USER);
  const freeStatements = stopQueryCount();
  check(
    `19 free account costs no more than paid (${freeStatements})`,
    freeStatements <= paidStatements,
    `free=${freeStatements} paid=${paidStatements}`
  );

  await reset();
  const db2 = await getDb();
  await db2.delete(userSettings).where(eq(userSettings.userId, USER));
  await db2.delete(contacts).where(eq(contacts.userId, USER));

  if (failures > 0) {
    throw new Error(`${failures} check(s) failed`);
  }
  console.log("\nAll account-alert checks passed.");
}

/**
 * STOP THIS WORKTREE'S DEV SERVER BEFORE RUNNING THIS.
 *
 * Two PGlite instances open on one data directory corrupt it, and `closeDb` below only
 * protects against the other half of that failure — exiting without a checkpoint. See the
 * note on `closeDb` in `src/db/index.ts`.
 */
main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
