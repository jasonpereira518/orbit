import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  actionItems,
  aiSuggestions,
  contacts,
  interactions,
  reminders,
  userGoals,
} from "@/db/schema";
import { daysAgo } from "@/lib/duplicates";
import { isCometContact } from "@/lib/comet";
import {
  buildConstellationClusters,
  toNamedGraphClusters,
} from "@/lib/constellation-clusters";
import { computeNetworkMetrics, selectMetricsSample } from "@/lib/network-metrics";
import {
  getDashboardCounts,
  getDashboardVocabularies,
  getGoalAlignedContactIds,
} from "@/lib/dashboard-aggregates";
import { getClosenessCohort } from "@/lib/closeness-cohort";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";
import { contactHasNotesSql } from "@/lib/contact-notes-sql";
import { getConstellationConfig } from "@/lib/constellation-config";
import { constellationEligibility } from "@/lib/constellation-eligibility";

const AUTO_SUGGESTION_TYPES = [
  "dormant_high_value",
  "post_event",
  "linkedin_thread_quiet",
] as const;

const MAX_AUTO_SUGGESTIONS = 12;

/**
 * The dashboard's "Constellation preview" card is a decorative, non-interactive
 * glance at the network (no search/filter UI) — it doesn't need every contact,
 * just enough to read as a constellation. Capping it keeps the dashboard's
 * render/layout cost bounded regardless of network size, instead of paying
 * the full graph's DOM cost on every dashboard load. Closest ties first,
 * matching the card's own "closer ties sit nearer the center" framing.
 */
const GRAPH_PREVIEW_CONTACT_CAP = 150;
/** Rows on the "aligned with your goals" card. */
const GOAL_ALIGNED_CAP = 5;
/** Rows on the "recently updated" card. */
const RECENT_CONTACT_CAP = 6;
/** Rows on the "due follow-ups" card. */
const DUE_FOLLOW_UP_CAP = 12;
/** Rows on the reminders card. */
const REMINDER_CAP = 20;
/** Rows on the suggestions card. */
const SUGGESTION_CAP = 40;

const AUTO_TYPE_PRIORITY: Record<(typeof AUTO_SUGGESTION_TYPES)[number], number> = {
  post_event: 3,
  linkedin_thread_quiet: 2,
  dormant_high_value: 1,
};

function contactDisplayName(c: {
  fullName: string;
  preferredName?: string | null;
}) {
  return (c.preferredName || "").trim() || c.fullName;
}

/** Contacts without a scheduled follow-up are eligible for discovery suggestions. */
/**
 * Whether a contact can be suggested for outreach at all.
 *
 * An existing follow-up already covers them — and a contact pinned off the constellation is
 * one the user has explicitly said not to show them. Nagging "reach out to X, gone quiet"
 * about somebody they deliberately removed from their own chart is the most annoying way
 * this could leak, and it is the one place the pin has to reach beyond `/graph`.
 */
function isDiscoveryEligible(c: {
  nextFollowUpAt: Date | string | null;
  constellationPin: "in" | "out" | null;
}) {
  return !c.nextFollowUpAt && c.constellationPin !== "out";
}

/**
 * One rebuild per user at a time.
 *
 * `buildOutreachSuggestions` clears the pending auto suggestions and re-inserts them, so
 * two overlapping runs interleave as delete/delete/insert/insert and every suggestion
 * lands twice. That is not hypothetical: four concurrent cold dashboard loads produced
 * exactly four copies of every row, and a cold load is easy to hit twice at once —
 * Next prefetches the dashboard on link hover and then renders it on click.
 *
 * A second caller joins the first run's promise rather than starting its own, which is
 * also the semantics callers want: they await "the queue is current", not "I rebuilt it".
 * Per-process, so it does not cover two server instances racing; `filteredSuggestions`
 * in `getDashboardData` de-duplicates on read for that case (and for rows already
 * written by one).
 */
const suggestionRefreshInFlight = new Map<string, Promise<void>>();

export function refreshOutreachSuggestions(userId: string): Promise<void> {
  const existing = suggestionRefreshInFlight.get(userId);
  if (existing) return existing;

  // Result discarded on purpose: no caller reads the inserted rows, and a shared promise
  // must not hand two callers the same mutable array.
  const run = buildOutreachSuggestions(userId)
    .then(() => undefined)
    .finally(() => {
      suggestionRefreshInFlight.delete(userId);
    });
  suggestionRefreshInFlight.set(userId, run);
  return run;
}

async function buildOutreachSuggestions(userId: string) {
  const db = await getDb();
  // Only what the candidate predicates below read. This ran unprojected — every column,
  // notes and inline avatars included — on a first dashboard visit.
  const all = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: {
      id: true,
      fullName: true,
      preferredName: true,
      priorityLevel: true,
      relationshipScore: true,
      lastInteractionAt: true,
      firstInteractionAt: true,
      nextFollowUpAt: true,
      // Read by `isDiscoveryEligible`. Required, not optional, on that predicate's parameter:
      // an optional field here would let a caller forget the column and quietly never
      // suppress anything, with nothing failing to say so.
      constellationPin: true,
    },
  });

  // Clear pending auto suggestions so we regenerate fresh ones
  // (preserve user-facing AI suggestions like score_bump from enrichment)
  await db
    .delete(aiSuggestions)
    .where(
      and(
        eq(aiSuggestions.userId, userId),
        eq(aiSuggestions.status, "pending"),
        inArray(aiSuggestions.suggestionType, [...AUTO_SUGGESTION_TYPES])
      )
    );

  type Candidate = {
    suggestionType: (typeof AUTO_SUGGESTION_TYPES)[number];
    title: string;
    description: string;
    relatedContactIds: string[];
    confidenceScore: number;
  };

  const candidateByContact = new Map<string, Candidate>();

  function upsertCandidate(contactId: string, candidate: Candidate) {
    const existing = candidateByContact.get(contactId);
    if (!existing) {
      candidateByContact.set(contactId, candidate);
      return;
    }
    const existingPri =
      AUTO_TYPE_PRIORITY[existing.suggestionType as keyof typeof AUTO_TYPE_PRIORITY] ?? 0;
    const nextPri =
      AUTO_TYPE_PRIORITY[candidate.suggestionType] ?? 0;
    if (
      nextPri > existingPri ||
      (nextPri === existingPri &&
        candidate.confidenceScore > existing.confidenceScore)
    ) {
      candidateByContact.set(contactId, candidate);
    }
  }

  const dormantHighValue = all.filter(
    (c) =>
      isDiscoveryEligible(c) &&
      (c.priorityLevel >= 2 || c.relationshipScore >= 4) &&
      daysAgo(c.lastInteractionAt) >= 30
  );
  for (const c of dormantHighValue) {
    const idle = daysAgo(c.lastInteractionAt);
    upsertCandidate(c.id, {
      suggestionType: "dormant_high_value",
      title: `Reach out to ${contactDisplayName(c)}`,
      description: `Gone quiet — last touch ${idle} day${idle === 1 ? "" : "s"} ago`,
      relatedContactIds: [c.id],
      confidenceScore: 80,
    });
  }

  const withMessageHistory = await db.query.interactions.findMany({
    where: and(
      eq(interactions.userId, userId),
      eq(interactions.interactionType, "linkedin_message")
    ),
  });
  const messageStats = new Map<
    string,
    { count: number; last: Date; first: Date }
  >();
  for (const m of withMessageHistory) {
    const d = m.interactionDate || m.createdAt;
    const prev = messageStats.get(m.contactId);
    if (!prev) {
      messageStats.set(m.contactId, { count: 1, last: d, first: d });
    } else {
      prev.count += 1;
      if (d > prev.last) prev.last = d;
      if (d < prev.first) prev.first = d;
    }
  }

  for (const c of all) {
    if (!isDiscoveryEligible(c)) continue;
    const stats = messageStats.get(c.id);
    if (!stats || stats.count < 2) continue;
    const daysSinceLast = daysAgo(stats.last);
    if (daysSinceLast < 14 || daysSinceLast > 90) continue;
    upsertCandidate(c.id, {
      suggestionType: "linkedin_thread_quiet",
      title: `Reach out to ${contactDisplayName(c)}`,
      description: `LinkedIn thread went quiet — last activity ${daysSinceLast} days ago`,
      relatedContactIds: [c.id],
      confidenceScore: 78,
    });
  }

  for (const c of all) {
    if (!isDiscoveryEligible(c)) continue;
    if (!c.firstInteractionAt) continue;
    const days = daysAgo(c.firstInteractionAt);
    if (days < 7 || days > 21) continue;
    if (
      c.lastInteractionAt &&
      c.lastInteractionAt.getTime() !== c.firstInteractionAt.getTime()
    ) {
      continue;
    }
    upsertCandidate(c.id, {
      suggestionType: "post_event",
      title: `Reach out to ${contactDisplayName(c)}`,
      description: `Recent intro ${days} day${days === 1 ? "" : "s"} ago — no follow-up logged yet`,
      relatedContactIds: [c.id],
      confidenceScore: 85,
    });
  }

  const suggestions = [...candidateByContact.values()]
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
    .slice(0, MAX_AUTO_SUGGESTIONS);

  if (suggestions.length) {
    await db.insert(aiSuggestions).values(
      suggestions.map((s) => ({
        userId,
        ...s,
        status: "pending",
      }))
    );
  }

  return suggestions;
}

function followUpCandidateScore(contact: {
  priorityLevel: number;
  relationshipScore: number;
  lastInteractionAt: Date | string | null;
  nextFollowUpAt: Date | string | null;
}) {
  const idleDays = Math.min(daysAgo(contact.lastInteractionAt), 365);
  const idleScore = Number.isFinite(idleDays) ? idleDays / 30 : 2;
  return (
    (contact.priorityLevel || 0) * 4 +
    (contact.relationshipScore || 0) * 2 +
    idleScore -
    (contact.nextFollowUpAt ? 1 : 0)
  );
}

/**
 * Schedule additional due follow-ups from contacts that are not already due —
 * prefers high priority / strong / dormant people.
 */
export async function generateDueFollowUps(userId: string, limit = 8) {
  const db = await getDb();
  const now = new Date();
  const all = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: {
      id: true,
      fullName: true,
      preferredName: true,
      priorityLevel: true,
      relationshipScore: true,
      lastInteractionAt: true,
      nextFollowUpAt: true,
    },
  });

  const alreadyDueIds = new Set(
    all
      .filter((c) => c.nextFollowUpAt && new Date(c.nextFollowUpAt) <= now)
      .map((c) => c.id)
  );

  const candidates = all
    .filter((c) => !alreadyDueIds.has(c.id))
    .filter((c) => {
      // Skip people with a future follow-up still more than a day away
      if (c.nextFollowUpAt && new Date(c.nextFollowUpAt) > now) {
        const ms = new Date(c.nextFollowUpAt).getTime() - now.getTime();
        if (ms > 24 * 60 * 60 * 1000) return false;
      }
      // Prefer people who have gone quiet or have no follow-up yet
      const idle = daysAgo(c.lastInteractionAt);
      return (
        !c.nextFollowUpAt ||
        idle >= 14 ||
        (c.priorityLevel || 0) >= 2 ||
        (c.relationshipScore || 0) >= 4
      );
    })
    .sort((a, b) => followUpCandidateScore(b) - followUpCandidateScore(a))
    .slice(0, Math.max(1, Math.min(24, limit)));

  const candidateIds = candidates.map((c) => c.id);
  let created = 0;

  if (candidateIds.length) {
    // One lookup for every candidate's existing pending reminder, instead of a
    // findFirst per candidate — the update-vs-insert branch below is unchanged,
    // just informed in bulk rather than one round trip at a time.
    const existingReminders = await db.query.reminders.findMany({
      where: and(
        eq(reminders.userId, userId),
        inArray(reminders.contactId, candidateIds),
        eq(reminders.status, "pending")
      ),
      columns: { id: true, contactId: true },
    });
    const reminderIdByContact = new Map(
      existingReminders.map((r) => [r.contactId, r.id])
    );

    const rowsToInsert: (typeof reminders.$inferInsert)[] = [];

    for (const contact of candidates) {
      const name = contact.preferredName || contact.fullName;
      const title = `Follow up with ${name}`;
      const existingReminderId = reminderIdByContact.get(contact.id);

      if (existingReminderId) {
        await db
          .update(reminders)
          .set({
            title,
            dueDate: now,
            reminderType: "generated",
            actionKind: "follow_up",
            createdBy: "system",
          })
          .where(eq(reminders.id, existingReminderId));
      } else {
        rowsToInsert.push({
          userId,
          contactId: contact.id,
          title,
          description: "Generated from dashboard outreach queue",
          dueDate: now,
          reminderType: "generated",
          actionKind: "follow_up",
          createdBy: "system",
          status: "pending",
        });
      }
    }

    if (rowsToInsert.length) {
      await db.insert(reminders).values(rowsToInsert);
    }

    await db
      .update(contacts)
      .set({
        nextFollowUpAt: now,
        followUpStatus: "pending",
        updatedAt: now,
      })
      .where(and(inArray(contacts.id, candidateIds), eq(contacts.userId, userId)));

    created = candidates.length;
  }

  await refreshOutreachSuggestions(userId);
  return { created, contactIds: candidateIds };
}

const SUGGESTION_REFRESH_TTL_MS = 30 * 60 * 1000;

/**
 * Cold-start build of the outreach queue.
 *
 * `maybeRefreshOutreachSuggestions` is stale-while-revalidate, which is right once a
 * queue exists but wrong the very first time: there is nothing to be stale, so the
 * dashboard renders "No outreach opportunities" to someone whose network is full of
 * dormant contacts, and only the *second* visit shows the truth. Anyone demoing the
 * product, or seeing it for the first time, is looking at exactly that first load.
 *
 * So the first build blocks; every later one is deferred as before. Status-agnostic on
 * purpose — a user who dismissed every suggestion has a queue, just an empty one, and
 * must not have it rebuilt under them on the next page view.
 */
export async function ensureOutreachSuggestions(userId: string) {
  const db = await getDb();
  const existing = await db.query.aiSuggestions.findFirst({
    where: and(
      eq(aiSuggestions.userId, userId),
      inArray(aiSuggestions.suggestionType, [...AUTO_SUGGESTION_TYPES])
    ),
    columns: { id: true },
  });
  if (existing) return false;
  await refreshOutreachSuggestions(userId);
  return true;
}

export async function maybeRefreshOutreachSuggestions(userId: string) {
  const db = await getDb();
  const latest = await db.query.aiSuggestions.findFirst({
    where: and(
      eq(aiSuggestions.userId, userId),
      inArray(aiSuggestions.suggestionType, [...AUTO_SUGGESTION_TYPES])
    ),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
    columns: { createdAt: true },
  });

  const age = latest
    ? Date.now() - new Date(latest.createdAt).getTime()
    : Number.POSITIVE_INFINITY;

  // Skip the expensive delete/rebuild on every dashboard hit.
  if (age < SUGGESTION_REFRESH_TTL_MS) return;
  await refreshOutreachSuggestions(userId);
}

/**
 * Everything `getDashboardData`'s network scan deliberately does not select.
 *
 * The scan reads what the WHOLE network is needed for — clustering and constellation
 * eligibility — and nothing else. Every field here belongs to a contact that is actually
 * going to be rendered or analysed, and every one of those sets is bounded: the metrics
 * sample (≤750), the constellation preview (≤150), the goal-aligned card (5), and the
 * contacts named by the reminder and suggestion lists (≤60).
 */
type ContactDetailColumns = {
  fullName: string;
  preferredName: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  website: string | null;
  dateMet: Date | null;
  lastInteractionAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  profileImageUrl: string | null;
  tags: string[];
  aiSummary: string | null;
  keyFacts: string[] | null;
  sharedInterests: string[] | null;
  howMet: string | null;
  metContext: string | null;
};

/**
 * Fetch the wide text columns for a bounded set of contacts.
 *
 * One statement, or none at all when the set is empty — which is the common case for a new
 * account and must not cost a round trip. The `inArray` is bounded by construction: every
 * caller passes either the metrics sample (at most `METRICS_MAX_CONTACTS`) or the preview
 * payload (at most `GRAPH_PREVIEW_CONTACT_CAP`).
 */
async function hydrateContactDetail(
  userId: string,
  ids: string[]
): Promise<Map<string, ContactDetailColumns>> {
  const out = new Map<string, ContactDetailColumns>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;

  const db = await getDb();
  const rows = await db.query.contacts.findMany({
    where: and(eq(contacts.userId, userId), inArray(contacts.id, unique)),
    columns: {
      id: true,
      fullName: true,
      preferredName: true,
      title: true,
      email: true,
      phone: true,
      linkedinUrl: true,
      website: true,
      dateMet: true,
      lastInteractionAt: true,
      createdAt: true,
      updatedAt: true,
      profileImageUrl: false,
      aiSummary: true,
      keyFacts: true,
      sharedInterests: true,
      howMet: true,
      metContext: true,
    },
    extras: { avatarUrl: clientAvatarUrlSql.as("avatar_url") },
    with: { contactTags: { with: { tag: true } } },
  });

  for (const r of rows) {
    out.set(r.id, {
      fullName: r.fullName,
      preferredName: r.preferredName ?? null,
      title: r.title ?? null,
      email: r.email ?? null,
      phone: r.phone ?? null,
      linkedinUrl: r.linkedinUrl ?? null,
      website: r.website ?? null,
      dateMet: r.dateMet ?? null,
      lastInteractionAt: r.lastInteractionAt ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      profileImageUrl: r.avatarUrl,
      tags: r.contactTags.map((ct) => ct.tag.name),
      aiSummary: r.aiSummary ?? null,
      keyFacts: r.keyFacts ?? null,
      sharedInterests: r.sharedInterests ?? null,
      howMet: r.howMet ?? null,
      metContext: r.metContext ?? null,
    });
  }
  return out;
}

/**
 * The six contacts on the "recently updated" card.
 *
 * Its own query rather than the head of the network scan, because the scan no longer
 * selects `updated_at` — or a name, or an avatar — for anyone. Six rows, ordered in SQL.
 *
 * `updated_at` alone is not a total order: after a bulk import every contact carries the
 * same one, so `LIMIT 6` over it returns an arbitrary six that can change between loads
 * with nothing having changed. Hence the tiebreak on `id`.
 */
async function loadRecentContacts(userId: string) {
  const db = await getDb();
  return db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: {
      id: true,
      fullName: true,
      preferredName: true,
      company: true,
      title: true,
      school: true,
      email: true,
      linkedinUrl: true,
      relationshipScore: true,
      nextFollowUpAt: true,
      lastInteractionAt: true,
      createdAt: true,
      updatedAt: true,
      profileImageUrl: false,
    },
    extras: { avatarUrl: clientAvatarUrlSql.as("avatar_url") },
    orderBy: (c, { desc }) => [desc(c.updatedAt), desc(c.id)],
    limit: RECENT_CONTACT_CAP,
  });
}

export async function getDashboardData(
  userId: string,
  // userName may be a promise so the Clerk profile fetch can run concurrently
  // with the DB queries below (its only consumer is graphPreview.summary).
  options?: { userName?: string | Promise<string | undefined> }
) {
  const db = await getDb();

  // Promise.resolve pins a single execution: a drizzle query builder is a lazy
  // thenable that re-runs on every await, so handing the bare builder to the
  // cohort would quietly issue the same scan twice.
  const contactRowsPromise = Promise.resolve(
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      // Explicit projection rather than the whole row, and deliberately WITHOUT the two
      // wide columns: `notes` (multi-KB) and `profile_image_url` (base64 up to 120 KB).
      // Together they were most of the bytes this scan moved for every contact, and the
      // dashboard stripped both before rendering. The constellation preview searched
      // notes; it now matches /graph, which never had them. The browser-safe avatar URL
      // is computed in SQL instead (`avatarUrl` below). `contacts_user_updated_idx` backs
      // the ordering. `scripts/smoke-page-budgets.ts` asserts this shape.
      // ONLY what the whole network is needed for: clustering (company, school) and
      // constellation eligibility (the pin, notes, stated closeness, priority, the next
      // follow-up and a tag COUNT). Everything a contact needs in order to be *rendered* —
      // name, title, contact details, avatar, timestamps, the wide text — belongs to a
      // bounded set and is fetched by `hydrateContactDetail`.
      //
      // `last_interaction_at` is gone from here specifically: it was the widest field on the
      // row, and the only whole-network question it answered was "how many are dormant",
      // which `getDashboardCounts` now asks Postgres.
      //
      // The `contact_tags` JOIN is gone for the same reason. Eligibility wants a count, not
      // the names, and the vocabulary that wanted names is `getDashboardVocabularies`.
      columns: {
        id: true,
        company: true,
        school: true,
        relationshipScore: true,
        statedCloseness: true,
        priorityLevel: true,
        constellationPin: true,
        nextFollowUpAt: true,
        // Kept, unlike the rest of the display columns, because it is an ORDERING key rather
        // than something rendered: orbit scores are integers 1-5, so the preview's "closest
        // 150" is mostly a tie, and which 150 appear has always been decided by the scan's
        // `updated_at DESC` order underneath that sort. Dropping it would silently change
        // who is on the chart.
        updatedAt: true,
      },
      extras: {
        // Computed, never the column — see contact-notes-sql.ts and the budget smoke.
        hasNotes: contactHasNotesSql.as("has_notes"),
      },
      // The join key alone. Eligibility wants a tag COUNT, and the vocabulary that wanted
      // tag NAMES is `getDashboardVocabularies` now — so this carries one narrow row per
      // tag rather than a whole tags row (id, user, name, timestamp) per tag.
      //
      // NOT a correlated `(select count(*) …)` in `extras`: written that way it returned
      // zero for every contact rather than failing, which quietly made every tag-qualified
      // contact ineligible for the constellation. Drizzle builds the correlation for a
      // declared relation; hand-writing it here did not.
      with: { contactTags: { columns: { contactId: true } } },
      // The order the preview and the metrics sample break ties in. `id` makes it total.
      orderBy: (c, { desc }) => [desc(c.updatedAt), desc(c.id)],
    })
  );

  const [
    scannedRows,
    pendingReminders,
    suggestions,
    goals,
    closenessCohort,
    constellationConfig,
    counts,
    vocabularies,
    goalAlignedIds,
  ] = await Promise.all([
    contactRowsPromise,
    db.query.reminders.findMany({
      where: and(
        eq(reminders.userId, userId),
        eq(reminders.status, "pending")
      ),
      orderBy: (r, { asc }) => [asc(r.dueDate)],
    }),
    db.query.aiSuggestions.findMany({
      where: and(
        eq(aiSuggestions.userId, userId),
        eq(aiSuggestions.status, "pending")
      ),
      orderBy: (s, { desc }) => [desc(s.confidenceScore)],
    }),
    db.query.userGoals.findMany({
      where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
      orderBy: (g, { desc }) => [desc(g.createdAt)],
    }),
    // No longer donates the scan above: that scan is now narrow, and the cohort builder
    // needs the wide text columns to score goal relevance. The donation only ever mattered
    // on the REBUILD path — the normal path reads each contact's stored breakdown and never
    // looks at these rows at all — so what this gives up is one scan on the rare render that
    // also has to recalibrate, in exchange for every other render carrying five fewer
    // columns per contact. `ClosenessCohortRow` is typed precisely so this trade has to be
    // made deliberately rather than discovered.
    getClosenessCohort(userId),
    getConstellationConfig(),
    // Aggregates Postgres answers better than a pass over the scan would — and, more to the
    // point, each one lets a column come off that scan. See dashboard-aggregates.ts.
    getDashboardCounts(userId),
    getDashboardVocabularies(userId),
    getGoalAlignedContactIds(userId, GOAL_ALIGNED_CAP),
  ]);

  // `profileImageUrl` keeps its name for the cards that render these rows, but it is now
  // the browser-safe URL from SQL — never the stored data: URL.
  // The scan is minimal now, so nothing below reads a display field off it. These rows
  // answer exactly two whole-network questions — who clusters with whom, and who is on the
  // chart — and every contact that gets rendered is hydrated by id afterwards.
  const lightContacts = scannedRows;
  const lightById = new Map(lightContacts.map((c) => [c.id, c]));
  /** Every contact in the account, by id. The scan's one remaining whole-network duty. */
  const allContactIds = new Set(lightContacts.map((c) => c.id));

  // Constellation eligibility, for the whole network. Same shared predicate as
  // `loadGraphData` — this payload path is a parallel implementation, so the decision has to
  // come from one place or the two surfaces will quietly disagree about who is on the chart.
  const eligibleIds = new Set<string>();
  for (const c of lightContacts) {
    const { eligible } = constellationEligibility(
      closenessCohort.constellationSignals.get(c.id),
      {
        pin: c.constellationPin ?? null,
        hasNotesText: Boolean(c.hasNotes),
        statedCloseness: c.statedCloseness ?? null,
        priorityLevel: c.priorityLevel ?? 0,
        nextFollowUpAt: c.nextFollowUpAt ?? null,
        // A COUNT from SQL, where this used to be `(c.tags ?? []).length` over a joined
        // array of tag rows. The predicate only ever wanted the number.
        tagCount: c.contactTags.length,
      },
      constellationConfig.thresholds
    );
    if (eligible) eligibleIds.add(c.id);
  }

  // `selectMetricsSample` is the same function `computeNetworkMetrics` samples with, so
  // these are exactly the contacts the link analysis will read — not a query that resembles
  // that set.
  const metricsSampleIds = selectMetricsSample(lightContacts, closenessCohort.byId).map(
    (c) => c.id
  );

  const orbitScoreOf = (c: { id: string; relationshipScore: number | null }) =>
    closenessCohort.byId.get(c.id)?.orbitScore ?? 2;

  // The preview mirrors /graph: engaged-only by default. It has no "show all" of its own —
  // the link into /graph is where that lives — so this is always the engaged scope.
  const previewFilterActive = constellationConfig.enabled;
  const previewEligibleCount = eligibleIds.size;
  const previewVisibleContacts = previewFilterActive
    ? lightContacts.filter((c) => eligibleIds.has(c.id))
    : lightContacts;

  // Filter FIRST, then cap. Capping first would spend the budget on contacts that are about
  // to be hidden and render far fewer than the cap allows.
  const previewIds = (
    previewVisibleContacts.length > GRAPH_PREVIEW_CONTACT_CAP
      ? [...previewVisibleContacts]
          .sort((a, b) => orbitScoreOf(b) - orbitScoreOf(a))
          .slice(0, GRAPH_PREVIEW_CONTACT_CAP)
      : previewVisibleContacts
  ).map((c) => c.id);

  const now = new Date();
  const dueFollowUpIds = new Set(
    lightContacts
      .filter((c) => c.nextFollowUpAt && new Date(c.nextFollowUpAt) <= now)
      .map((c) => c.id)
  );

  const tierRank = { inner: 0, mid: 1, outer: 2 } as const;
  const dueFollowUpOrder = lightContacts
    .filter((c) => dueFollowUpIds.has(c.id))
    .sort((a, b) => {
      const aTime = a.nextFollowUpAt ? new Date(a.nextFollowUpAt).getTime() : 0;
      const bTime = b.nextFollowUpAt ? new Date(b.nextFollowUpAt).getTime() : 0;
      if (aTime !== bTime) return aTime - bTime;
      const aTier = closenessCohort.byId.get(a.id)?.tier ?? "outer";
      const bTier = closenessCohort.byId.get(b.id)?.tier ?? "outer";
      const tierDiff = tierRank[aTier] - tierRank[bTier];
      if (tierDiff !== 0) return tierDiff;
      const priorityDiff = (b.priorityLevel || 0) - (a.priorityLevel || 0);
      if (priorityDiff !== 0) return priorityDiff;
      // Without a final tiebreaker two contacts due the same day, in the same tier, at the
      // same priority order arbitrarily, and the list this is sliced to twelve from
      // reshuffles on every load.
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
  const dueFollowUpTopIds = dueFollowUpOrder.slice(0, DUE_FOLLOW_UP_CAP).map((c) => c.id);

  // The reminder and suggestion lists are filtered and capped HERE, before hydration, so
  // that the contacts hydrated are exactly the contacts rendered. Filtering afterwards
  // would hydrate the first twenty pending reminders and then render a different twenty,
  // leaving the card unable to name its own subjects.
  const filteredReminders = pendingReminders.filter((r) => {
    if (r.reminderType !== "generated") return true;
    if (!r.contactId) return true;
    return !dueFollowUpIds.has(r.contactId);
  });

  // Belt and braces against a cross-instance rebuild race writing the same suggestion
  // twice (see refreshOutreachSuggestions): one row per contact and type, whatever the
  // table holds. Also repairs rows a previous race already wrote, with no migration.
  const seenSuggestionKeys = new Set<string>();
  const filteredSuggestions = suggestions.filter((s) => {
    const contactId = s.relatedContactIds?.[0];
    const key = `${s.suggestionType}:${contactId ?? s.id}`;
    if (seenSuggestionKeys.has(key)) return false;
    seenSuggestionKeys.add(key);
    if (!contactId) return true;
    // `related_contact_ids` is a jsonb array, so deleting a contact does not cascade to
    // its suggestions. Left in, the card renders a row headed "Contact" with a real-looking
    // "gone quiet 105 days ago" under it — a ghost of someone the user removed. The
    // rebuild clears them on its own TTL; this stops them being shown in the meantime.
    //
    // Tested against the light scan's ids, which is every contact in the account. It used
    // to test `contactById`, which was the same set only because that map held everyone;
    // now that it holds the rendered contacts, using it here would drop every suggestion
    // whose subject is not already on screen.
    if (!allContactIds.has(contactId)) return false;
    return !dueFollowUpIds.has(contactId);
  });

  // Bounded: at most REMINDER_CAP + SUGGESTION_CAP contacts, and exactly the ones the two
  // cards will name through `contactMeta`.
  const referencedIds = [
    ...filteredReminders.slice(0, REMINDER_CAP).map((r) => r.contactId),
    ...filteredSuggestions.slice(0, SUGGESTION_CAP).map((s) => s.relatedContactIds?.[0]),
  ].filter((id): id is string => Boolean(id));

  // ONE hydration for every bounded set that needs a renderable contact.
  const [detail, recentContacts] = await Promise.all([
    hydrateContactDetail(userId, [
      ...metricsSampleIds,
      ...previewIds,
      ...dueFollowUpTopIds,
      ...goalAlignedIds.map((g) => g.id),
      ...referencedIds,
    ]),
    loadRecentContacts(userId),
  ]);

  const networkMetrics = computeNetworkMetrics(
    metricsSampleIds.flatMap((id) => {
      const d = detail.get(id);
      const light = lightById.get(id);
      if (!d || !light) return [];
      return [{
        id,
        fullName: d.fullName,
        preferredName: d.preferredName,
        company: light.company ?? null,
        school: light.school ?? null,
        title: d.title,
        relationshipScore: light.relationshipScore ?? 2,
        lastInteractionAt: d.lastInteractionAt,
        nextFollowUpAt: null,
        tags: d.tags,
        notes: null,
        aiSummary: d.aiSummary,
        keyFacts: d.keyFacts,
        howMet: d.howMet,
        sharedInterests: d.sharedInterests,
      }];
    }),
    closenessCohort.byId,
    counts.totalContacts
  );

  // The cohort IS the closeness map. It used to be rebuilt as a joined copy of every
  // contact (`contactsWithNetwork`) so that consumers could read `.tier` off it; they can
  // read it here, from the map the cohort already returned.
  const closenessById = closenessCohort.byId;

  /** The full graph-contact shape, built only for the contacts the preview draws. */
  const graphContacts = previewIds.flatMap((id) => {
    const d = detail.get(id);
    const light = lightById.get(id);
    if (!d || !light) return [];
    const closeness = closenessById.get(id);
    const lastAt = d.lastInteractionAt ?? null;
    return [{
      id,
      fullName: d.fullName,
      preferredName: d.preferredName,
      company: light.company ?? null,
      school: light.school ?? null,
      title: d.title,
      relationshipScore: light.relationshipScore ?? 2,
      closeness: closeness?.closeness ?? 0,
      closenessTier: closeness?.tier ?? ("outer" as const),
      orbitScore: closeness?.orbitScore ?? 2,
      lastInteractionAt: lastAt,
      hasLoggedInteraction: closenessCohort.interactedIds.has(id),
      nextFollowUpAt: light.nextFollowUpAt ?? null,
      tags: d.tags,
      aiSummary: d.aiSummary,
      keyFacts: d.keyFacts,
      howMet: d.howMet,
      metContext: d.metContext,
      dateMet: d.dateMet,
      notes: null as string | null,
      sharedInterests: d.sharedInterests,
      email: d.email,
      phone: d.phone,
      linkedinUrl: d.linkedinUrl,
      website: d.website,
      profileImageUrl: d.profileImageUrl,
      dormant: isCometContact(lastAt),
      substantive: eligibleIds.has(id),
    }];
  });

  const userName = (await options?.userName) || "You";

  // Clusters still see the whole network — a cluster's count is "how many people at Acme",
  // which a capped sample cannot answer — but they only ever needed three columns, and the
  // light scan has them.
  const { clusters: builtClusters } = buildConstellationClusters(lightContacts);
  const clusters = toNamedGraphClusters(builtClusters);

  // companies, schools and tags come from `getDashboardVocabularies`, not from a pass over
  // the scan. That is what lets the `contact_tags` join come off it: eligibility needs a tag
  // COUNT, which is a scalar subquery, where the vocabulary needed the tag NAMES.
  const { companies, schools, tags } = vocabularies;

  const scoreCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  // The histogram stays in JavaScript on purpose. `orbitScore` here is the cohort's, not the
  // `orbit_score` column — those agree for a scored contact and diverge for an unscored one
  // — and the cohort is already in memory, so counting it costs nothing while asking
  // Postgres would cost a round trip AND answer a subtly different question. The note in
  // dashboard-aggregates.ts records this in full.
  for (const c of lightContacts) {
    const s = Math.min(5, Math.max(1, orbitScoreOf(c) || 2));
    scoreCounts[s] = (scoreCounts[s] || 0) + 1;
  }
  // Both from SQL: `dormantCount` is why `last_interaction_at` — the widest column on the
  // row — no longer has to be selected for every contact.
  const dormantCount = counts.dormantCount;
  const overdueCount = counts.overdueCount;

  // Ranked and capped by Postgres (`getGoalAlignedContactIds`), then joined to the rows the
  // card renders. Goal relevance is a stored component of the closeness breakdown, so this
  // is an ordered read of a column — never a pass over every contact's summary and facts.
  const goalAlignedContacts = goalAlignedIds.flatMap(({ id, goalRelevance }) => {
    const d = detail.get(id);
    const light = lightById.get(id);
    if (!d || !light) return [];
    return [{
      id,
      fullName: d.fullName,
      preferredName: d.preferredName,
      company: light.company ?? null,
      title: d.title,
      goalRelevance,
    }];
  });

  const dueFollowUps = dueFollowUpTopIds.flatMap((id) => {
    const d = detail.get(id);
    const light = lightById.get(id);
    if (!d || !light) return [];
    return [{
      id,
      fullName: d.fullName,
      preferredName: d.preferredName,
      company: light.company ?? null,
      school: light.school ?? null,
      title: d.title,
      email: d.email,
      linkedinUrl: d.linkedinUrl,
      profileImageUrl: d.profileImageUrl,
      relationshipScore: light.relationshipScore ?? 2,
      priorityLevel: light.priorityLevel ?? 0,
      nextFollowUpAt: light.nextFollowUpAt ?? null,
      lastInteractionAt: d.lastInteractionAt,
      tags: d.tags,
    }];
  });

  // Only the contacts something on this page can name: the two cards' rows, the reminder
  // and suggestion subjects, and the preview. It used to be one entry per contact in the
  // account, to serve at most sixty lookups.
  const contactById = new Map<string, {
    id: string;
    fullName: string;
    preferredName: string | null;
    title: string | null;
    company: string | null;
  }>();
  const contactNameById = new Map<string, string>();
  for (const [id, d] of detail) {
    contactById.set(id, {
      id,
      fullName: d.fullName,
      preferredName: d.preferredName,
      title: d.title,
      company: lightById.get(id)?.company ?? null,
    });
    contactNameById.set(id, d.preferredName || d.fullName);
  }
  for (const c of recentContacts) {
    contactById.set(c.id, {
      id: c.id,
      fullName: c.fullName,
      preferredName: c.preferredName ?? null,
      title: c.title ?? null,
      company: c.company ?? null,
    });
    contactNameById.set(c.id, c.preferredName || c.fullName);
  }

  const strongTies =
    networkMetrics.tierCounts.inner + networkMetrics.tierCounts.mid;

  // Already chosen (`previewIds`), already hydrated, already built: `graphContacts` IS the
  // preview. It used to be the whole network, built in full and then thrown away down to
  // this cap.
  const graphPreviewContacts = graphContacts;

  return {
    stats: {
      totalContacts: counts.totalContacts,
      // The count of everyone due, not the length of the capped list below — the stat and
      // the card answer different questions and the card only ever showed twelve.
      dueFollowUps: counts.dueFollowUpCount,
      strongConnections: strongTies,
      pendingReminders: filteredReminders.length,
      topCompany: null as { name: string; count: number } | null,
    },
    recentContacts,
    dueFollowUps,
    reminders: filteredReminders.slice(0, REMINDER_CAP),
    suggestions: filteredSuggestions.slice(0, SUGGESTION_CAP),
    totalSuggestions: filteredSuggestions.length,
    goals,
    networkMetrics,
    goalAlignedContacts,
    closenessById,
    contactNameById,
    contactById,
    // Layout (nodes/edges) is computed client-side in NetworkGraph from contacts.
    graphPreview: {
      contacts: graphPreviewContacts,
      companies,
      schools,
      tags,
      clusters,
      userId,
      summary: {
        total: counts.totalContacts,
        companyCount: companies.length,
        scoreCounts,
        // Absolute-tier count, matching /graph — see the note there on why the
        // quota rings above cannot be used for this.
        strongTies,
        dormantCount,
        overdueCount,
        // Computed over the WHOLE network, not the capped preview list: the cap is a
        // rendering budget, and `active` still has to reflect the real shape of the network
        // or a 150-contact slice would look like a filtered one.
        constellationFilter: {
          active: previewFilterActive,
          enabled: constellationConfig.enabled,
          scope: "engaged" as const,
          shown: graphPreviewContacts.length,
          engaged: previewEligibleCount,
          // The whole network, not the preview: this is what "show all" would reveal, and
          // `graphContacts` is now the capped preview rather than everyone.
          available: counts.totalContacts,
        },
        userName,
        userImageUrl: null,
        userEmail: null,
        socialLinks: {},
        goals: [],
      },
    },
  };
}

/**
 * What `snoozeReminder` overwrote, so an Undo can put it back.
 *
 * `snoozedTo` is the guard: an Undo only restores a field that still holds the value the
 * snooze wrote. If something else rescheduled the reminder or the contact's follow-up in
 * the seconds since — the dashboard's day presets write the same `nextFollowUpAt` — that
 * newer choice wins and the Undo leaves it alone rather than clobbering it.
 *
 * ISO strings rather than Dates so it crosses the Server Action boundary unambiguously.
 */
export type SnoozeSnapshot = {
  reminderId: string;
  snoozedTo: string;
  previousDueDate: string | null;
  previousStatus: string;
  contactId: string | null;
  previousNextFollowUpAt: string | null;
  previousFollowUpStatus: string | null;
};

export async function snoozeReminder(
  userId: string,
  reminderId: string,
  days = 7
): Promise<SnoozeSnapshot | null> {
  const db = await getDb();
  const due = new Date();
  // Same 1..90 clamp as `scheduleContactFollowUp`. Both write `contacts.nextFollowUpAt`
  // for the same contact by different routes (the dashboard's day presets vs. the
  // reminder row's snooze), so they must not disagree about what a day count means.
  due.setDate(due.getDate() + Math.max(1, Math.min(90, days)));

  const reminder = await db.query.reminders.findFirst({
    where: and(eq(reminders.id, reminderId), eq(reminders.userId, userId)),
    columns: { id: true, contactId: true, dueDate: true, status: true },
  });
  if (!reminder) return null;

  // Read the contact's clock BEFORE overwriting it — this used to be discarded, which is
  // what made a snooze impossible to take back.
  const contact = reminder.contactId
    ? await db.query.contacts.findFirst({
        where: and(eq(contacts.id, reminder.contactId), eq(contacts.userId, userId)),
        columns: { nextFollowUpAt: true, followUpStatus: true },
      })
    : null;

  await db
    .update(reminders)
    .set({ dueDate: due, status: "pending" })
    .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)));

  // Keep contact due clock aligned with reminder snooze.
  if (reminder.contactId) {
    await db
      .update(contacts)
      .set({
        nextFollowUpAt: due,
        followUpStatus: "pending",
        updatedAt: new Date(),
      })
      .where(
        and(eq(contacts.id, reminder.contactId), eq(contacts.userId, userId))
      );
  }

  return {
    reminderId,
    snoozedTo: due.toISOString(),
    previousDueDate: reminder.dueDate ? reminder.dueDate.toISOString() : null,
    previousStatus: reminder.status,
    contactId: reminder.contactId ?? null,
    previousNextFollowUpAt: contact?.nextFollowUpAt
      ? contact.nextFollowUpAt.toISOString()
      : null,
    previousFollowUpStatus: contact?.followUpStatus ?? null,
  };
}

/**
 * Put back what a snooze overwrote. Each field is restored only if it still holds the
 * value the snooze wrote — see `SnoozeSnapshot`. Returns whether the reminder itself was
 * restored, so the caller can say so honestly rather than claiming "Undone".
 */
export async function unsnoozeReminder(
  userId: string,
  snap: SnoozeSnapshot
): Promise<{ restored: boolean }> {
  const db = await getDb();
  const snoozedTo = new Date(snap.snoozedTo).getTime();

  const reminder = await db.query.reminders.findFirst({
    where: and(eq(reminders.id, snap.reminderId), eq(reminders.userId, userId)),
    columns: { dueDate: true },
  });
  if (!reminder || reminder.dueDate?.getTime() !== snoozedTo) {
    return { restored: false };
  }

  await db
    .update(reminders)
    .set({
      dueDate: snap.previousDueDate ? new Date(snap.previousDueDate) : null,
      status: snap.previousStatus,
    })
    .where(and(eq(reminders.id, snap.reminderId), eq(reminders.userId, userId)));

  if (snap.contactId) {
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, snap.contactId), eq(contacts.userId, userId)),
      columns: { nextFollowUpAt: true },
    });
    if (contact?.nextFollowUpAt?.getTime() === snoozedTo) {
      await db
        .update(contacts)
        .set({
          nextFollowUpAt: snap.previousNextFollowUpAt
            ? new Date(snap.previousNextFollowUpAt)
            : null,
          followUpStatus: snap.previousFollowUpStatus,
          updatedAt: new Date(),
        })
        .where(and(eq(contacts.id, snap.contactId), eq(contacts.userId, userId)));
    }
  }

  return { restored: true };
}

/** What `completeReminder` changed, so an Undo can reverse exactly that and no more. */
export type CompletionSnapshot = {
  reminderId: string;
  previousStatus: string;
  closedActionItemIds: string[];
};

export async function completeReminder(
  userId: string,
  reminderId: string
): Promise<CompletionSnapshot | null> {
  const db = await getDb();
  const reminder = await db.query.reminders.findFirst({
    where: and(eq(reminders.id, reminderId), eq(reminders.userId, userId)),
    columns: { status: true },
  });
  if (!reminder) return null;

  await db
    .update(reminders)
    .set({ status: "done" })
    .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)));

  // Only the OPEN items. This used to set every linked item to done, which also
  // re-stamped `completedAt` on items finished days earlier — a silent rewrite of when
  // they were done, and the reason an Undo could not tell which items it had closed.
  const closed = await db
    .update(actionItems)
    .set({ status: "done", completedAt: new Date() })
    .where(
      and(
        eq(actionItems.userId, userId),
        eq(actionItems.reminderId, reminderId),
        eq(actionItems.status, "open")
      )
    )
    .returning();

  return {
    reminderId,
    previousStatus: reminder.status,
    closedActionItemIds: closed.map((row) => row.id),
  };
}

/**
 * Reverse a `completeReminder`: the reminder's status, and the action items that call
 * closed — not every item on the reminder, because some were already done beforehand and
 * reopening those would undo the person's own earlier work. Only acts on a reminder that
 * is still done; if it has moved on since, there is nothing honest to undo.
 */
export async function reopenReminder(
  userId: string,
  snap: CompletionSnapshot
): Promise<{ restored: boolean }> {
  const db = await getDb();
  const reminder = await db.query.reminders.findFirst({
    where: and(eq(reminders.id, snap.reminderId), eq(reminders.userId, userId)),
    columns: { status: true },
  });
  if (!reminder || reminder.status !== "done") return { restored: false };

  await db
    .update(reminders)
    .set({ status: snap.previousStatus })
    .where(and(eq(reminders.id, snap.reminderId), eq(reminders.userId, userId)));

  if (snap.closedActionItemIds.length > 0) {
    await db
      .update(actionItems)
      .set({ status: "open", completedAt: null })
      .where(
        and(
          eq(actionItems.userId, userId),
          inArray(actionItems.id, snap.closedActionItemIds)
        )
      );
  }

  return { restored: true };
}
