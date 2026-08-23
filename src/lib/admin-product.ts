import { and, desc, eq, gt, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import {
  chatThreads,
  contacts,
  interactions,
  outreachCampaigns,
  recruiters,
  reminders,
  tags,
  usageEvents,
  userGoals,
  userSettings,
  webhookDeliveries,
} from "@/db/schema";
import { countInt, num, toDate, type AdminUserRow } from "@/lib/admin-metrics";

/**
 * Product-health reads for `/admin/product`: is the product actually being used, and is the
 * data healthy?
 *
 * Same shape as `admin-metrics.ts` — one `Promise.all` fan-out of GROUP BY aggregates,
 * joined in JS — but a separate module on purpose. `loadAdminUserRows()` is on the critical
 * path of three other screens, and loading it with product aggregates would tax the roster
 * to serve this page.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every `operation` a `recordUsage` call site can emit, so the screen can show what has
 * NEVER been used — which is the most decision-useful output on the page and is invisible
 * to a GROUP BY, since absent rows produce no group.
 *
 * Keep in sync with the `operation:` literals in `src/lib/ai.ts` and the `lib/*` callers.
 */
export const KNOWN_OPERATIONS = [
  "capture.parse",
  "capture.parse.identify",
  "capture.parse.details",
  "capture.parse.excerpt-retry",
  "capture.dates",
  "capture.transcribe.audio",
  "capture.transcribe.images",
  "chat.answer",
  "search.embed",
  "search.embed.batch",
  "contact.summary",
  "followup.draft",
  "outreach.draft",
  "outreach.apollo",
  "import.linkedin.timeline",
  "import.enrich",
] as const;

export type FeatureAdoptionRow = {
  operation: string;
  users: number;
  calls: number;
  failures: number;
};

export type ArtifactRow = { label: string; rows: number; users: number };

export type FunnelParking = { step: string; count: number };

export type WaitlistSummary = {
  total: number;
  recent: Array<{ email: string | null; at: Date }>;
};

export type DataQualityRow = {
  label: string;
  count: number;
  total?: number;
  hint?: string;
};

export type TrendRow = { period: string; values: number[] };

export type ProductSnapshot = {
  adoption: FeatureAdoptionRow[];
  neverUsed: string[];
  artifacts: ArtifactRow[];
  onboardingParking: FunnelParking[];
  wizardParking: FunnelParking[];
  wizardCompleted: number;
  waitlist: WaitlistSummary | null;
  dataQuality: DataQualityRow[];
  weekly: TrendRow[];
};

/**
 * Adoption over the last N days, sorted by DISTINCT USERS rather than call count.
 *
 * One power user making 400 chat calls is intensity, not adoption. Both numbers render;
 * the sort order is the opinion.
 */
export async function getFeatureAdoption(days = 30, now = new Date()) {
  const db = await getDb();
  const since = new Date(now.getTime() - days * DAY_MS);

  const rows = await db
    .select({
      operation: usageEvents.operation,
      users: sql<string>`count(distinct ${usageEvents.userId})`,
      calls: countInt,
      failures: sql<string>`count(*) filter (where ${usageEvents.success} = 0)`,
    })
    .from(usageEvents)
    .where(gt(usageEvents.createdAt, since))
    .groupBy(usageEvents.operation);

  const adoption: FeatureAdoptionRow[] = rows
    .map((r) => ({
      operation: r.operation,
      users: num(r.users),
      calls: r.calls,
      failures: num(r.failures),
    }))
    .sort((a, b) => b.users - a.users || b.calls - a.calls);

  const seen = new Set(adoption.map((a) => a.operation));
  return {
    adoption,
    neverUsed: KNOWN_OPERATIONS.filter((op) => !seen.has(op)),
  };
}

/**
 * Durable artifacts, one round trip.
 *
 * Catches what `usage_events` structurally cannot: reminders, tags, goals and the graph
 * leave no AI call behind, so a usage-only view would report them as unused.
 */
export async function getArtifacts(): Promise<ArtifactRow[]> {
  const db = await getDb();

  const [contactRows, interactionRows, reminderRows, threadRows, campaignRows, tagRows, goalRows, recruiterRows] =
    await Promise.all([
      db.select({ n: countInt, u: sql<string>`count(distinct ${contacts.userId})` }).from(contacts),
      db.select({ n: countInt, u: sql<string>`count(distinct ${interactions.userId})` }).from(interactions),
      db.select({ n: countInt, u: sql<string>`count(distinct ${reminders.userId})` }).from(reminders),
      db.select({ n: countInt, u: sql<string>`count(distinct ${chatThreads.userId})` }).from(chatThreads),
      db.select({ n: countInt, u: sql<string>`count(distinct ${outreachCampaigns.userId})` }).from(outreachCampaigns),
      db.select({ n: countInt, u: sql<string>`count(distinct ${tags.userId})` }).from(tags),
      db.select({ n: countInt, u: sql<string>`count(distinct ${userGoals.userId})` }).from(userGoals),
      db.select({ n: countInt }).from(recruiters),
    ]);

  return [
    { label: "Contacts", rows: contactRows[0]?.n ?? 0, users: num(contactRows[0]?.u) },
    { label: "Interactions", rows: interactionRows[0]?.n ?? 0, users: num(interactionRows[0]?.u) },
    { label: "Reminders", rows: reminderRows[0]?.n ?? 0, users: num(reminderRows[0]?.u) },
    { label: "Chat threads", rows: threadRows[0]?.n ?? 0, users: num(threadRows[0]?.u) },
    { label: "Campaigns", rows: campaignRows[0]?.n ?? 0, users: num(campaignRows[0]?.u) },
    { label: "Tags", rows: tagRows[0]?.n ?? 0, users: num(tagRows[0]?.u) },
    { label: "Goals", rows: goalRows[0]?.n ?? 0, users: num(goalRows[0]?.u) },
    // Global directory — no per-user count to give.
    { label: "Recruiters (shared)", rows: recruiterRows[0]?.n ?? 0, users: 0 },
  ];
}

/**
 * Where incomplete accounts are parked RIGHT NOW.
 *
 * Deliberately not a second copy of `buildFunnel` — the Overview owns the cumulative
 * funnel. This answers a different question, and comes with a caveat the UI must print:
 * the tour auto-advances on a 7-second timer, so `onboarding_step` records where the tab
 * was closed, not what the person engaged with. `wizard_step` is validated on write and
 * does reflect a real choice.
 */
export async function getFunnelParking() {
  const db = await getDb();

  const [onboarding, wizard, completed] = await Promise.all([
    db
      .select({ step: userSettings.onboardingStep, n: countInt })
      .from(userSettings)
      .where(
        and(
          isNull(userSettings.onboardingCompletedAt),
          isNotNull(userSettings.onboardingStep)
        )
      )
      .groupBy(userSettings.onboardingStep),
    db
      .select({ step: userSettings.wizardStep, n: countInt })
      .from(userSettings)
      .where(
        and(isNull(userSettings.wizardCompletedAt), isNotNull(userSettings.wizardStep))
      )
      .groupBy(userSettings.wizardStep),
    db
      .select({ n: countInt })
      .from(userSettings)
      .where(isNotNull(userSettings.wizardCompletedAt)),
  ]);

  const clean = (rows: Array<{ step: string | null; n: number }>): FunnelParking[] =>
    rows
      .filter((r): r is { step: string; n: number } => Boolean(r.step))
      .map((r) => ({ step: r.step, count: r.n }))
      .sort((a, b) => b.count - a.count);

  return {
    onboardingParking: clean(onboarding),
    wizardParking: clean(wizard),
    wizardCompleted: completed[0]?.n ?? 0,
  };
}

/**
 * Waitlist signups, read from the webhook ledger.
 *
 * The landing page posts straight to Clerk, so before `waitlistEntry.*` was handled there
 * was no local trace of this at all — and answering it otherwise needs a Clerk Backend API
 * call, which this codebase has never made.
 */
export async function getWaitlist(limit = 10): Promise<WaitlistSummary> {
  const db = await getDb();
  const [total, recent] = await Promise.all([
    db
      .select({ n: sql<string>`count(distinct ${webhookDeliveries.resourceId})` })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.eventType, "waitlistEntry.created")),
    db
      .select({ detail: webhookDeliveries.detail, at: webhookDeliveries.createdAt })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.eventType, "waitlistEntry.created"))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit),
  ]);

  return {
    total: num(total[0]?.n),
    recent: recent.map((r) => ({
      email: (r.detail as { email?: string })?.email ?? null,
      at: r.at,
    })),
  };
}

/**
 * Data-quality checks.
 *
 * Exact-key SQL only — no Levenshtein. `findDuplicateCandidates` compares one candidate
 * against a list; finding ALL pairs would be O(n²) edit distances inside a page render.
 * The exact-key version answers the real question: does the missing unique index bite?
 */
export async function getDataQuality(): Promise<DataQualityRow[]> {
  const db = await getDb();

  const [
    totals,
    unnormalized,
    noEmbedding,
    dupeEmail,
    dupeName,
    avatars,
    staleReminders,
    orphans,
  ] = await Promise.all([
    db.select({ n: countInt }).from(contacts),
    db
      .select({ n: countInt })
      .from(contacts)
      .where(
        and(
          isNotNull(contacts.company),
          ne(contacts.company, ""),
          isNull(contacts.companyId)
        )
      ),
    db.execute(sql`
      SELECT count(*)::int AS n FROM contacts c
      WHERE NOT EXISTS (SELECT 1 FROM contact_embeddings e WHERE e.contact_id = c.id)
    `),
    db.execute(sql`
      SELECT coalesce(sum(extra), 0)::int AS n FROM (
        SELECT count(*) - 1 AS extra FROM contacts
        WHERE email IS NOT NULL AND trim(email) <> ''
        GROUP BY user_id, lower(trim(email)) HAVING count(*) > 1
      ) d
    `),
    db.execute(sql`
      SELECT coalesce(sum(extra), 0)::int AS n FROM (
        SELECT count(*) - 1 AS extra FROM contacts
        GROUP BY user_id, lower(trim(full_name)) HAVING count(*) > 1
      ) d
    `),
    // The host list mirrors isUnusableAvatarUrl. Pushed into SQL on purpose — the JS path
    // would require selecting every profile_image_url in the database.
    db.execute(sql`
      SELECT
        count(*) filter (where profile_image_url LIKE 'data:%')::int AS inlined,
        count(*) filter (
          where profile_image_url LIKE '%unavatar.io%'
             OR profile_image_url LIKE '%static.licdn.com/aero%'
        )::int AS broken
      FROM contacts
    `),
    db
      .select({ n: countInt })
      .from(reminders)
      .where(
        and(
          eq(reminders.status, "pending"),
          lt(reminders.dueDate, new Date(Date.now() - 90 * DAY_MS))
        )
      ),
    // One UNION ALL instead of eight separate anti-joins.
    db.execute(sql`
      SELECT coalesce(sum(n), 0)::int AS n FROM (
        SELECT count(*) AS n FROM contacts c
          WHERE NOT EXISTS (SELECT 1 FROM user_settings u WHERE u.user_id = c.user_id)
        UNION ALL SELECT count(*) FROM interactions i
          WHERE NOT EXISTS (SELECT 1 FROM user_settings u WHERE u.user_id = i.user_id)
        UNION ALL SELECT count(*) FROM reminders r
          WHERE NOT EXISTS (SELECT 1 FROM user_settings u WHERE u.user_id = r.user_id)
        UNION ALL SELECT count(*) FROM imports im
          WHERE NOT EXISTS (SELECT 1 FROM user_settings u WHERE u.user_id = im.user_id)
      ) o
    `),
  ]);

  const total = totals[0]?.n ?? 0;
  const avatarRow = rowsOf<{ inlined: number; broken: number }>(avatars)[0];

  return [
    {
      label: "Company set but never normalized",
      count: unnormalized[0]?.n ?? 0,
      total,
      hint: "backfillContactCompanies() fixes these",
    },
    {
      label: "No embedding row",
      count: rowsOf<{ n: number }>(noEmbedding)[0]?.n ?? 0,
      total,
      hint: "invisible to semantic search",
    },
    { label: "Duplicate by email", count: rowsOf<{ n: number }>(dupeEmail)[0]?.n ?? 0 },
    { label: "Duplicate by name", count: rowsOf<{ n: number }>(dupeName)[0]?.n ?? 0 },
    {
      label: "Avatars on known-broken hosts",
      count: num(avatarRow?.broken),
      total,
    },
    {
      label: "Avatars inlined as base64",
      count: num(avatarRow?.inlined),
      total,
      hint: "Vercel Blob is not configured",
    },
    {
      label: "Reminders pending 90+ days overdue",
      count: staleReminders[0]?.n ?? 0,
    },
    {
      label: "Orphaned rows (no user_settings)",
      count: rowsOf<{ n: number }>(orphans)[0]?.n ?? 0,
      hint: "a purge that died mid-run",
    },
  ];
}

/**
 * Weekly event trends.
 *
 * Trends attach to EVENTS, never to accounts: signups per week at this scale is
 * `0,1,0,0,2,1,0`, which is noise, while AI calls run to hundreds a week even with a dozen
 * users. Rendered as a table rather than a sparkline — a sparkline autoscales, so noise
 * fills the frame and nothing looks small.
 */
export async function getWeeklyTrends(weeks = 8, now = new Date()): Promise<TrendRow[]> {
  const db = await getDb();
  const since = new Date(now.getTime() - weeks * 7 * DAY_MS);

  const bucket = (col: ReturnType<typeof sql>) =>
    sql<string>`date_trunc('week', ${col})`;

  const [signups, aiCalls, captures, chats, contactRows] = await Promise.all([
    db
      .select({ week: bucket(sql`${userSettings.createdAt}`), n: countInt })
      .from(userSettings)
      .where(gt(userSettings.createdAt, since))
      .groupBy(sql`1`),
    db
      .select({ week: bucket(sql`${usageEvents.createdAt}`), n: countInt })
      .from(usageEvents)
      .where(gt(usageEvents.createdAt, since))
      .groupBy(sql`1`),
    db
      .select({ week: bucket(sql`${usageEvents.createdAt}`), n: countInt })
      .from(usageEvents)
      .where(
        and(gt(usageEvents.createdAt, since), eq(usageEvents.operation, "capture.parse"))
      )
      .groupBy(sql`1`),
    db
      .select({ week: bucket(sql`${usageEvents.createdAt}`), n: countInt })
      .from(usageEvents)
      .where(
        and(gt(usageEvents.createdAt, since), eq(usageEvents.operation, "chat.answer"))
      )
      .groupBy(sql`1`),
    db
      .select({ week: bucket(sql`${contacts.createdAt}`), n: countInt })
      .from(contacts)
      .where(gt(contacts.createdAt, since))
      .groupBy(sql`1`),
  ]);

  // The bucket comes back as a STRING on both drivers, which is exactly why toDate exists.
  const index = (rows: Array<{ week: string; n: number }>) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const d = toDate(r.week);
      if (d) m.set(d.toISOString().slice(0, 10), r.n);
    }
    return m;
  };

  const maps = [signups, aiCalls, captures, chats, contactRows].map(index);

  const out: TrendRow[] = [];
  for (let i = 0; i < weeks; i++) {
    const start = new Date(now.getTime() - i * 7 * DAY_MS);
    // Align to the Monday date_trunc('week') uses.
    const day = (start.getUTCDay() + 6) % 7;
    const monday = new Date(start.getTime() - day * DAY_MS);
    const key = monday.toISOString().slice(0, 10);
    out.push({ period: key, values: maps.map((m) => m.get(key) ?? 0) });
  }
  return out;
}

/** Time from signup to first contact — the real activation metric. */
export function timeToFirstContact(rows: AdminUserRow[]) {
  const buckets = { hour: 0, day: 0, week: 0, later: 0, never: 0 };
  for (const row of rows) {
    if (!row.firstContactAt) {
      buckets.never += 1;
      continue;
    }
    const delta = row.firstContactAt.getTime() - row.signupAt.getTime();
    if (delta <= 3600_000) buckets.hour += 1;
    else if (delta <= DAY_MS) buckets.day += 1;
    else if (delta <= 7 * DAY_MS) buckets.week += 1;
    else buckets.later += 1;
  }
  return buckets;
}

export async function getProductSnapshot(now = new Date()): Promise<ProductSnapshot> {
  const [{ adoption, neverUsed }, artifacts, parking, waitlist, dataQuality, weekly] =
    await Promise.all([
      getFeatureAdoption(30, now),
      getArtifacts(),
      getFunnelParking(),
      getWaitlist().catch(() => null),
      getDataQuality(),
      getWeeklyTrends(8, now),
    ]);

  return {
    adoption,
    neverUsed: [...neverUsed],
    artifacts,
    ...parking,
    waitlist,
    dataQuality,
    weekly,
  };
}
