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
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { daysAgo } from "@/lib/duplicates";
import { isCometContact } from "@/lib/comet";
import {
  buildConstellationClusters,
  toNamedGraphClusters,
} from "@/lib/constellation-clusters";
import { computeNetworkMetrics } from "@/lib/network-metrics";
import { getClosenessCohort } from "@/lib/closeness-cohort";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";

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
function isDiscoveryEligible(c: { nextFollowUpAt: Date | string | null }) {
  return !c.nextFollowUpAt;
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

  let created = 0;
  for (const contact of candidates) {
    const name = contact.preferredName || contact.fullName;
    const title = `Follow up with ${name}`;

    const existing = await db.query.reminders.findFirst({
      where: and(
        eq(reminders.userId, userId),
        eq(reminders.contactId, contact.id),
        eq(reminders.status, "pending")
      ),
    });

    if (existing) {
      await db
        .update(reminders)
        .set({
          title,
          dueDate: now,
          reminderType: "generated",
          actionKind: "follow_up",
          createdBy: "system",
        })
        .where(eq(reminders.id, existing.id));
    } else {
      await db.insert(reminders).values({
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

    await db
      .update(contacts)
      .set({
        nextFollowUpAt: now,
        followUpStatus: "pending",
        updatedAt: now,
      })
      .where(and(eq(contacts.id, contact.id), eq(contacts.userId, userId)));

    created += 1;
  }

  await refreshOutreachSuggestions(userId);
  return { created, contactIds: candidates.map((c) => c.id) };
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
      columns: {
        id: true,
        userId: true,
        fullName: true,
        firstName: true,
        lastName: true,
        preferredName: true,
        company: true,
        title: true,
        location: true,
        school: true,
        email: true,
        phone: true,
        linkedinUrl: true,
        website: true,
        profileImageUrl: false,
        relationshipScore: true,
        statedCloseness: true,
        priorityLevel: true,
        source: true,
        industry: true,
        metContext: true,
        dateMet: true,
        howMet: true,
        keyFacts: true,
        sharedInterests: true,
        aiSummary: true,
        firstInteractionAt: true,
        lastInteractionAt: true,
        nextFollowUpAt: true,
        followUpStatus: true,
        closeness: true,
        closenessTier: true,
        orbitScore: true,
        createdAt: true,
        updatedAt: true,
        notes: false,
      },
      extras: { avatarUrl: clientAvatarUrlSql.as("avatar_url") },
      orderBy: (c, { desc }) => [desc(c.updatedAt)],
      with: { contactTags: { with: { tag: true } } },
    })
  );

  const [
    scannedRows,
    pendingReminders,
    suggestions,
    goals,
    goalTexts,
    closenessCohort,
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
    listActiveGoalTextsForUser(userId),
    // Donates the scan above rather than repeating it.
    getClosenessCohort(userId, contactRowsPromise),
  ]);

  // `profileImageUrl` keeps its name for the cards that render these rows, but it is now
  // the browser-safe URL from SQL — never the stored data: URL.
  const allContactRows = scannedRows.map((c) => ({ ...c, profileImageUrl: c.avatarUrl }));

  const enrichedContacts = allContactRows.map((c) => {
    const tags = c.contactTags.map((ct) => ct.tag.name);
    return { ...c, tags };
  });

  const { metrics: networkMetrics, contactsWithNetwork } =
    computeNetworkMetrics(
      enrichedContacts,
      goalTexts,
      closenessCohort.byId
    );

  const closenessById = new Map(
    contactsWithNetwork.map((c) => [c.id, c])
  );

  const graphContacts = enrichedContacts.map((c) => {
    const closeness = closenessById.get(c.id);
    const lastAt = c.lastInteractionAt
      ? c.lastInteractionAt instanceof Date
        ? c.lastInteractionAt
        : new Date(c.lastInteractionAt)
      : null;
    const dormant = isCometContact(lastAt);
    return {
      id: c.id,
      fullName: c.fullName,
      preferredName: c.preferredName ?? null,
      company: c.company ?? null,
      school: c.school ?? null,
      title: c.title ?? null,
      relationshipScore: c.relationshipScore ?? 2,
      closeness: closeness?.closeness ?? 0,
      closenessTier: closeness?.tier ?? ("outer" as const),
      orbitScore: closeness?.orbitScore ?? 2,
      lastInteractionAt: lastAt,
      hasLoggedInteraction: closenessCohort.interactedIds.has(c.id),
      nextFollowUpAt: c.nextFollowUpAt
        ? c.nextFollowUpAt instanceof Date
          ? c.nextFollowUpAt
          : new Date(c.nextFollowUpAt)
        : null,
      tags: c.tags ?? [],
      aiSummary: c.aiSummary ?? null,
      keyFacts: c.keyFacts ?? null,
      howMet: c.howMet ?? null,
      metContext: c.metContext ?? null,
      dateMet: c.dateMet ?? null,
      notes: null as string | null,
      sharedInterests: c.sharedInterests ?? null,
      email: c.email ?? null,
      phone: c.phone ?? null,
      linkedinUrl: c.linkedinUrl ?? null,
      website: c.website ?? null,
      profileImageUrl: c.profileImageUrl,
      dormant,
    };
  });

  const userName = (await options?.userName) || "You";

  const { clusters: builtClusters } = buildConstellationClusters(graphContacts);
  const clusters = toNamedGraphClusters(builtClusters);

  const companies = [
    ...new Set(
      graphContacts.map((c) => (c.company || "").trim()).filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b));

  const schools = [
    ...new Set(
      graphContacts.map((c) => (c.school || "").trim()).filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b));

  const tags = [
    ...new Set(
      allContactRows.flatMap((c) =>
        c.contactTags.map((ct) => ct.tag.name)
      )
    ),
  ];

  const scoreCounts: Record<number, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  };
  let dormantCount = 0;
  let overdueCount = 0;
  for (const c of graphContacts) {
    const s = Math.min(5, Math.max(1, (c.orbitScore ?? c.relationshipScore) || 2));
    scoreCounts[s] = (scoreCounts[s] || 0) + 1;
    if (c.dormant) dormantCount += 1;
    if (c.nextFollowUpAt && c.nextFollowUpAt.getTime() < Date.now()) {
      overdueCount += 1;
    }
  }

  const goalAlignedContacts = [...contactsWithNetwork]
    .filter((c) => c.goalRelevance > 0)
    .sort((a, b) => b.goalRelevance - a.goalRelevance)
    .slice(0, 5);

  const contactNameById = new Map(
    allContactRows.map((c) => [c.id, c.preferredName || c.fullName])
  );

  const now = new Date();
  const dueFollowUpIds = new Set(
    allContactRows
      .filter((c) => c.nextFollowUpAt && new Date(c.nextFollowUpAt) <= now)
      .map((c) => c.id)
  );

  const tierRank = { inner: 0, mid: 1, outer: 2 } as const;

  const dueFollowUps = allContactRows
    .filter((c) => dueFollowUpIds.has(c.id))
    .sort((a, b) => {
      const aTime = a.nextFollowUpAt
        ? new Date(a.nextFollowUpAt).getTime()
        : 0;
      const bTime = b.nextFollowUpAt
        ? new Date(b.nextFollowUpAt).getTime()
        : 0;
      if (aTime !== bTime) return aTime - bTime;
      const aTier = closenessById.get(a.id)?.tier ?? "outer";
      const bTier = closenessById.get(b.id)?.tier ?? "outer";
      const tierDiff = tierRank[aTier] - tierRank[bTier];
      if (tierDiff !== 0) return tierDiff;
      return (b.priorityLevel || 0) - (a.priorityLevel || 0);
    });

  const filteredReminders = pendingReminders.filter((r) => {
    if (r.reminderType !== "generated") return true;
    if (!r.contactId) return true;
    return !dueFollowUpIds.has(r.contactId);
  });

  const contactById = new Map(allContactRows.map((c) => [c.id, c]));

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
    if (!contactById.has(contactId)) return false;
    return !dueFollowUpIds.has(contactId);
  });

  const strongTies =
    networkMetrics.tierCounts.inner + networkMetrics.tierCounts.mid;

  const graphPreviewContacts =
    graphContacts.length > GRAPH_PREVIEW_CONTACT_CAP
      ? [...graphContacts]
          .sort(
            (a, b) =>
              (b.orbitScore ?? b.relationshipScore ?? 0) -
              (a.orbitScore ?? a.relationshipScore ?? 0)
          )
          .slice(0, GRAPH_PREVIEW_CONTACT_CAP)
      : graphContacts;

  return {
    stats: {
      totalContacts: allContactRows.length,
      dueFollowUps: dueFollowUps.length,
      strongConnections: strongTies,
      pendingReminders: filteredReminders.length,
      topCompany: null as { name: string; count: number } | null,
    },
    recentContacts: allContactRows.slice(0, 6),
    dueFollowUps: dueFollowUps.slice(0, 12),
    reminders: filteredReminders.slice(0, 20),
    suggestions: filteredSuggestions.slice(0, 40),
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
        total: allContactRows.length,
        companyCount: companies.length,
        scoreCounts,
        // Absolute-tier count, matching /graph — see the note there on why the
        // quota rings above cannot be used for this.
        strongTies,
        dormantCount,
        overdueCount,
        userName,
        userImageUrl: null,
        userEmail: null,
        socialLinks: {},
        goals: [],
      },
    },
  };
}

export async function snoozeReminder(
  userId: string,
  reminderId: string,
  days = 7
) {
  const db = await getDb();
  const due = new Date();
  due.setDate(due.getDate() + days);

  const reminder = await db.query.reminders.findFirst({
    where: and(eq(reminders.id, reminderId), eq(reminders.userId, userId)),
    columns: { id: true, contactId: true },
  });
  if (!reminder) return;

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
}

export async function completeReminder(userId: string, reminderId: string) {
  const db = await getDb();
  await db
    .update(reminders)
    .set({ status: "done" })
    .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)));
  await db
    .update(actionItems)
    .set({ status: "done", completedAt: new Date() })
    .where(and(eq(actionItems.userId, userId), eq(actionItems.reminderId, reminderId)));
}
