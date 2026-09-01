import { and, desc, eq, gt, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import {
  chatThreads,
  contacts,
  interactions,
  interestListSignups,
  outreachCampaigns,
  recruiters,
  reminders,
  tags,
  usageEvents,
  userGoals,
  userSettings,
} from "@/db/schema";
import { countInt, num } from "@/lib/admin-metrics";

/**
 * Product reads that `/admin/growth` cannot answer from `admin-trends.ts`.
 *
 * `admin-trends.ts` already covers adoption, activation cohorts and retention. What it
 * cannot show is what has NEVER been used (absent rows produce no group), what exists
 * outside `usage_events` entirely (reminders and tags leave no AI call), where incomplete
 * accounts are parked, who is on the waitlist, and whether the data itself is sound.
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

export type AiOperationRow = {
  operation: string;
  users: number;
  calls: number;
  failures: number;
};

/**
 * Adoption of individual AI operations.
 *
 * Complementary to `featureAdoption` in `admin-trends.ts`, which counts distinct users per
 * *table* — that answers "does anyone use chat", this answers "does anyone use the audio
 * transcription path". Sorted by distinct users rather than call count, because one power
 * user making 400 chat calls is intensity, not adoption.
 */
export async function getAiOperationAdoption(days = 30, now = new Date()) {
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

  const adoption: AiOperationRow[] = rows
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
    // Absent operations produce no group, so this has to be diffed against the known call
    // sites rather than read from the data.
    neverUsed: KNOWN_OPERATIONS.filter((op) => !seen.has(op)),
  };
}

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
 * Interest list ("Waitlist" on this page) signups, read from Orbit's own table.
 *
 * The landing page's form calls `joinInterestList` directly (`src/actions/interest-list.ts`)
 * rather than Clerk's `joinWaitlist()` — that call needs the whole instance's sign-up mode
 * set to "Waitlist", which would block this app's normal, already-live sign-up flow.
 */
export async function getWaitlist(limit = 10): Promise<WaitlistSummary> {
  const db = await getDb();
  const [total, recent] = await Promise.all([
    db.select({ n: countInt }).from(interestListSignups),
    db
      .select({ email: interestListSignups.email, at: interestListSignups.createdAt })
      .from(interestListSignups)
      .orderBy(desc(interestListSignups.createdAt))
      .limit(limit),
  ]);

  return {
    total: total[0]?.n ?? 0,
    recent: recent.map((r) => ({ email: r.email, at: r.at })),
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


