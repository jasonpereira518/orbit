/**
 * Turning "a role opened at a company you know somebody at" into one notification.
 *
 * ## It is driven from the opportunity side, not the posting side
 *
 * Open internship and referral opportunities number in the tens to low hundreds across the
 * whole product; `job_postings` is the largest table in the database. Iterating postings
 * would need a new global index to answer a question the small table already answers in one
 * query — and `contacts_user_company_norm_idx` cannot serve it, because `user_id` leads and
 * there is no global probe.
 *
 * So: read every open internship/referral opportunity, collect the companies they name, and
 * look those up in `job_postings` by bucket key.
 *
 * ## Three volume guards, and none of them lose a row
 *
 *   PER RUN, PER USER (`MAX_MATCHES_PER_USER_PER_RUN`). Beyond it the match row is still
 *   WRITTEN, with `status: "suppressed"` and no suggestion. The unique index then blocks a
 *   re-notification forever, which is the right answer — "we already decided this one was
 *   noise" is a decision worth keeping — and the row is the only record of why the user was
 *   never told.
 *
 *   OPEN SUGGESTIONS (`MAX_OPEN_JOB_SUGGESTIONS`). A user who has not triaged the last five
 *   does not need a sixth.
 *
 *   ONE SUGGESTION PER (USER, CONTACT) PER RUN. Not a nicety: `filteredSuggestions` in
 *   `src/lib/reminders.ts` dedupes on `suggestionType:contactId`, so per-posting rows would
 *   render in the notification bell and then silently collapse to one on the dashboard —
 *   two surfaces disagreeing about how much happened.
 *
 * ## A match is an `ai_suggestion`, never a reminder
 *
 * `loadNotificationPanel` maps `aiSuggestions` at a hardcoded `urgency: "info"`, so this
 * respects "an unconfirmed guess never fires an OS notification" structurally, with no edits
 * to that file and no new discipline to remember. The reason is stronger here than for the
 * suggestions that rule was written for: this text came from an anonymous pull request to a
 * public repository, so firing an OS notification off it would be a content-injection
 * channel into the operating system's own UI. The panel item's `url` is `/contacts/{id}`,
 * so no third-party URL is ever a clickable link in the bell either.
 *
 * Accepting one is what creates a reminder, and `scheduleFromSuggestion`, `dismissSuggestion`
 * and `restoreSuggestion` already exist — so the triage UI is free.
 */
import { and, asc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import {
  aiSuggestions,
  contactOpportunities,
  contacts,
  jobPostingMatches,
  jobPostings,
} from "@/db/schema";
import { MAX_POSTING_AGE_DAYS } from "@/lib/jobs/feed-sources";
import { JOB_SIGNAL_KINDS, OPEN_OPPORTUNITY_STATUSES } from "@/lib/opportunity-kinds";
import {
  companiesMatch,
  jobCompanyBucketKey,
  jobCompanyKeys,
  type CompanyKeySet,
} from "@/lib/jobs/company-match";

/**
 * The suggestion type. Deliberately NOT a member of `AUTO_SUGGESTION_TYPES` in
 * `src/lib/reminders.ts`: that list is what `buildOutreachSuggestions` DELETES and rebuilds
 * on a dashboard load, and adding this to it would wipe every job signal the moment somebody
 * opened the dashboard.
 */
export const JOB_SIGNAL_SUGGESTION_TYPE = "job_posting_signal";

export const MAX_MATCHES_PER_USER_PER_RUN = 10;
export const MAX_OPEN_JOB_SUGGESTIONS = 5;
/** Rows per UPDATE ... FROM (VALUES) when linking matches to their suggestions. */
const MATCH_LINK_CHUNK = 1000;
/** The opportunity scan's ceiling. Far above any plausible real total; a bound, not a policy. */
export const MAX_WATCHED_OPPORTUNITIES = 5_000;
/** Postings read per run, newest first. Bounds the run when a feed lands a large batch. */
export const MAX_CANDIDATE_POSTINGS = 4_000;
/** Role titles named in one suggestion's body before it becomes "and N more". */
const MAX_TITLES_IN_BODY = 3;

type Watcher = {
  userId: string;
  contactId: string;
  contactName: string;
  opportunityId: string;
  matchKind: "internship" | "referral";
  keys: CompanyKeySet;
};

export type MatchStats = {
  watchedOpportunities: number;
  watchedCompanies: number;
  candidatePostings: number;
  /** Rows written to `job_posting_matches` this run — new pairs only. */
  matchesCreated: number;
  suggestionsCreated: number;
  suppressed: number;
  usersNotified: number;
};

function displayName(c: { fullName: string; preferredName: string | null }) {
  return (c.preferredName || "").trim() || c.fullName;
}

/**
 * Every company somebody is waiting on, keyed by the bucket `job_postings` files under.
 *
 * One contact can carry several opportunities and one company can be watched by several
 * users, so this is a map of arrays. The contact's `company` is the only source of the
 * name — an opportunity's own label is prose ("summer internship on the infra team") and
 * was never a company name.
 */
async function loadWatchers(pivot: string = crypto.randomUUID()): Promise<Map<string, Watcher[]>> {
  const db = await getDb();
  // Past the cap, which opportunities a run sees must rotate. The scan used to take the
  // first MAX_WATCHED_OPPORTUNITIES in whatever order the planner produced, so the same
  // users could be skipped on every run forever. Now each run starts at a random point in
  // the (uniformly random, v4) id space and wraps around. Below the cap that is the whole
  // table, same as before; above it, every opportunity gets its turn.
  const scan = (range: SQL) => db
    .select({
      opportunityId: contactOpportunities.id,
      userId: contactOpportunities.userId,
      kind: contactOpportunities.kind,
      contactId: contacts.id,
      fullName: contacts.fullName,
      preferredName: contacts.preferredName,
      company: contacts.company,
    })
    .from(contactOpportunities)
    // Same owner on both sides: an opportunity's contactId must never surface a contact from
    // another account in this user's suggestions.
    .innerJoin(
      contacts,
      and(
        eq(contacts.id, contactOpportunities.contactId),
        eq(contacts.userId, contactOpportunities.userId)
      )
    )
    .where(
      and(
        // Both lists come from `opportunity-kinds.ts` rather than being re-typed here: the
        // taxonomy is one `as const satisfies` array by convention, and a second copy is how
        // a kind added there silently stops being watched.
        inArray(contactOpportunities.status, [...OPEN_OPPORTUNITY_STATUSES]),
        inArray(contactOpportunities.kind, [...JOB_SIGNAL_KINDS]),
        range
      )
    )
    .orderBy(asc(contactOpportunities.id))
    .limit(MAX_WATCHED_OPPORTUNITIES);
  const head = await scan(gte(contactOpportunities.id, pivot));
  const rows =
    head.length >= MAX_WATCHED_OPPORTUNITIES
      ? head
      : [...head, ...(await scan(lt(contactOpportunities.id, pivot))).slice(0, MAX_WATCHED_OPPORTUNITIES - head.length)];

  const byBucket = new Map<string, Watcher[]>();
  for (const row of rows) {
    const keys = jobCompanyKeys(row.company);
    // No company on the contact, or a name too degenerate to key — there is nothing to
    // match against, and guessing from the opportunity's prose is how "summer" becomes an
    // employer.
    if (!keys) continue;
    const bucket = jobCompanyBucketKey(keys);
    const watcher: Watcher = {
      userId: row.userId,
      contactId: row.contactId,
      contactName: displayName(row),
      opportunityId: row.opportunityId,
      matchKind: row.kind === "referral" ? "referral" : "internship",
      keys,
    };
    const existing = byBucket.get(bucket);
    if (existing) existing.push(watcher);
    else byBucket.set(bucket, [watcher]);
  }
  return byBucket;
}

/**
 * Match every watched company against recent postings and notify what survives the guards.
 *
 * Safe to run twice: the unique index on (user, posting, contact) is what makes a second
 * pass over the same postings produce nothing, so a retried or overlapping sweep cannot
 * double-notify.
 */
export async function matchJobPostings(opts: { now?: Date } = {}): Promise<MatchStats> {
  const db = await getDb();
  const now = opts.now ?? new Date();
  const stats: MatchStats = {
    watchedOpportunities: 0,
    watchedCompanies: 0,
    candidatePostings: 0,
    matchesCreated: 0,
    suggestionsCreated: 0,
    suppressed: 0,
    usersNotified: 0,
  };

  const byBucket = await loadWatchers();
  stats.watchedCompanies = byBucket.size;
  stats.watchedOpportunities = [...byBucket.values()].reduce((n, w) => n + w.length, 0);
  if (!byBucket.size) return stats;

  // A backfilled row that first appears today may have been posted in March, and an old
  // posting matching is worse than none: it trains people to ignore the notification.
  const cutoff = new Date(now.getTime() - MAX_POSTING_AGE_DAYS * 24 * 60 * 60 * 1000);
  const postings = await db
    .select({
      id: jobPostings.id,
      companyName: jobPostings.companyName,
      companyKey: jobPostings.companyKey,
      title: jobPostings.title,
      datePosted: jobPostings.datePosted,
    })
    .from(jobPostings)
    .where(
      and(
        inArray(jobPostings.companyKey, [...byBucket.keys()]),
        eq(jobPostings.active, true),
        eq(jobPostings.isVisible, true),
        gte(jobPostings.datePosted, cutoff)
      )
    )
    .orderBy(sql`${jobPostings.datePosted} desc`)
    .limit(MAX_CANDIDATE_POSTINGS);
  stats.candidatePostings = postings.length;
  if (!postings.length) return stats;

  type Candidate = {
    userId: string;
    postingId: string;
    contactId: string;
    contactName: string;
    opportunityId: string;
    companyKey: string;
    companyName: string;
    title: string;
    datePosted: Date;
    matchKind: "internship" | "referral";
  };
  const candidates: Candidate[] = [];
  for (const posting of postings) {
    const watchers = byBucket.get(posting.companyKey);
    if (!watchers) continue;
    const postingKeys = jobCompanyKeys(posting.companyName);
    for (const w of watchers) {
      // The bucket got us here; `companiesMatch` decides. Sharing a bucket is a cheap
      // pre-filter, and this is the rule a match can actually be audited against.
      if (postingKeys && !companiesMatch(postingKeys, w.keys)) continue;
      candidates.push({
        userId: w.userId,
        postingId: posting.id,
        contactId: w.contactId,
        contactName: w.contactName,
        opportunityId: w.opportunityId,
        companyKey: posting.companyKey,
        companyName: posting.companyName,
        title: posting.title,
        datePosted: posting.datePosted,
        matchKind: w.matchKind,
      });
    }
  }
  if (!candidates.length) return stats;

  // Written first, as `suppressed`, and promoted afterwards. `onConflictDoNothing` then
  // makes the RETURNED rows exactly the pairs nobody has ever been told about — which is
  // both the dedupe and the race guard, without a read-then-write that two overlapping
  // sweeps could both win.
  const inserted = await db
    .insert(jobPostingMatches)
    .values(
      candidates.map((c) => ({
        userId: c.userId,
        postingId: c.postingId,
        contactId: c.contactId,
        opportunityId: c.opportunityId,
        companyKey: c.companyKey,
        matchKind: c.matchKind,
        status: "suppressed" as const,
      }))
    )
    .onConflictDoNothing({
      target: [jobPostingMatches.userId, jobPostingMatches.postingId, jobPostingMatches.contactId],
    })
    .returning();
  stats.matchesCreated = inserted.length;
  if (!inserted.length) return stats;

  const byKey = new Map(
    candidates.map((c) => [`${c.userId}:${c.postingId}:${c.contactId}`, c])
  );
  const freshByUser = new Map<string, { row: typeof inserted[number]; candidate: Candidate }[]>();
  for (const row of inserted) {
    const candidate = byKey.get(`${row.userId}:${row.postingId}:${row.contactId}`);
    if (!candidate) continue;
    const list = freshByUser.get(row.userId);
    if (list) list.push({ row, candidate });
    else freshByUser.set(row.userId, [{ row, candidate }]);
  }

  const userIds = [...freshByUser.keys()];
  const openCounts = new Map<string, number>();
  if (userIds.length) {
    const rows = await db
      .select({ userId: aiSuggestions.userId, n: sql<number>`count(*)::int` })
      .from(aiSuggestions)
      .where(
        and(
          inArray(aiSuggestions.userId, userIds),
          eq(aiSuggestions.suggestionType, JOB_SIGNAL_SUGGESTION_TYPE),
          eq(aiSuggestions.status, "pending")
        )
      )
      .groupBy(aiSuggestions.userId);
    for (const r of rows) openCounts.set(r.userId, Number(r.n));
  }

  const suggestionRows: {
    userId: string;
    suggestionType: string;
    title: string;
    description: string;
    relatedContactIds: string[];
    confidenceScore: number;
    matchIds: string[];
  }[] = [];

  for (const [userId, fresh] of freshByUser) {
    // Newest first, so what survives the cap is what actually just happened — the whole
    // promise of this feature is timeliness, and truncating in arbitrary order would drop a
    // role posted this morning in favour of one from three weeks ago.
    fresh.sort((a, b) => b.candidate.datePosted.getTime() - a.candidate.datePosted.getTime());
    const allowed = fresh.slice(0, MAX_MATCHES_PER_USER_PER_RUN);
    stats.suppressed += fresh.length - allowed.length;

    // One suggestion per contact per run — see the header.
    const byContact = new Map<string, typeof allowed>();
    for (const item of allowed) {
      const list = byContact.get(item.candidate.contactId);
      if (list) list.push(item);
      else byContact.set(item.candidate.contactId, [item]);
    }

    let budget = Math.max(0, MAX_OPEN_JOB_SUGGESTIONS - (openCounts.get(userId) ?? 0));
    for (const [contactId, items] of byContact) {
      if (budget <= 0) {
        // Over the open-suggestion cap. The rows stay `suppressed`, which is exactly what
        // they are: matched, deliberately not shown, and never to be offered again.
        stats.suppressed += items.length;
        continue;
      }
      budget -= 1;
      const first = items[0]!.candidate;
      const titles = items.slice(0, MAX_TITLES_IN_BODY).map((i) => i.candidate.title);
      const more = items.length - titles.length;
      const roleWord = items.length === 1 ? "role" : "roles";
      suggestionRows.push({
        userId,
        suggestionType: JOB_SIGNAL_SUGGESTION_TYPE,
        // Company and role titles are third-party text, sanitised at ingest
        // (`listing-schema.ts`) — no newlines, no tags, no markdown links. They are rendered
        // as plain text, and the item's link goes to the contact, never to the posting.
        title: `${items.length} new ${roleWord} at ${first.companyName}`,
        description: `${first.contactName} works there — ${titles.join(", ")}${more > 0 ? `, and ${more} more` : ""}`,
        relatedContactIds: [contactId],
        // A deterministic match on a company name, not a model's guess. High, and equal for
        // every row, so ordering falls back to recency rather than to a fabricated score.
        confidenceScore: 75,
        matchIds: items.map((i) => i.row.id),
      });
    }
  }

  if (suggestionRows.length) {
    const created = await db
      .insert(aiSuggestions)
      .values(
        suggestionRows.map((s) => ({
          userId: s.userId,
          suggestionType: s.suggestionType,
          title: s.title,
          description: s.description,
          relatedContactIds: s.relatedContactIds,
          confidenceScore: s.confidenceScore,
          status: "pending",
        }))
      )
      .returning();

    // Point every match at its suggestion in one UPDATE ... FROM (VALUES) per chunk rather
    // than one statement per suggestion. Paired by (user, contact) — unique across
    // `suggestionRows`, one suggestion per contact per run — so nothing hangs on the order
    // RETURNING hands the rows back in.
    const suggestionIdByUserContact = new Map(
      created.map((row) => [`${row.userId}|${row.relatedContactIds?.[0] ?? ""}`, row.id])
    );
    const links: SQL[] = [];
    for (const source of suggestionRows) {
      const suggestionId = suggestionIdByUserContact.get(
        `${source.userId}|${source.relatedContactIds[0] ?? ""}`
      );
      if (!suggestionId) continue;
      for (const matchId of source.matchIds) {
        links.push(sql`(${matchId}::uuid, ${source.userId}::text, ${suggestionId}::uuid)`);
      }
    }
    for (let i = 0; i < links.length; i += MATCH_LINK_CHUNK) {
      await db.execute(sql`
        UPDATE job_posting_matches AS m
           SET status = 'notified', suggestion_id = v.suggestion_id
          FROM (VALUES ${sql.join(links.slice(i, i + MATCH_LINK_CHUNK), sql`, `)})
            AS v(id, user_id, suggestion_id)
         WHERE m.id = v.id AND m.user_id = v.user_id
      `);
    }
    stats.suggestionsCreated = created.length;
    stats.usersNotified = new Set(suggestionRows.map((s) => s.userId)).size;
  }

  return stats;
}
