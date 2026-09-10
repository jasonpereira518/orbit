import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  actionItems,
  contacts,
  reminders,
  userGoals,
} from "@/db/schema";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { isCometContact } from "@/lib/comet";
import {
  buildConstellationClusters,
  toNamedGraphClusters,
} from "@/lib/constellation-clusters";
import { computeNetworkMetrics } from "@/lib/network-metrics";
import { getClosenessCohort } from "@/lib/closeness-cohort";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";
import { contactHasNotesSql } from "@/lib/contact-notes-sql";
import { getConstellationConfig } from "@/lib/constellation-config";
import { constellationEligibility } from "@/lib/constellation-eligibility";

/**
 * The dashboard's "Constellation preview" card is a decorative, non-interactive
 * glance at the network (no search/filter UI) — it doesn't need every contact,
 * just enough to read as a constellation. Capping it keeps the dashboard's
 * render/layout cost bounded regardless of network size, instead of paying
 * the full graph's DOM cost on every dashboard load. Closest ties first,
 * matching the card's own "closer ties sit nearer the center" framing.
 */
const GRAPH_PREVIEW_CONTACT_CAP = 150;

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
        constellationPin: true,
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
      extras: {
        avatarUrl: clientAvatarUrlSql.as("avatar_url"),
        // Computed, never the column — see contact-notes-sql.ts and the budget smoke.
        hasNotes: contactHasNotesSql.as("has_notes"),
      },
      orderBy: (c, { desc }) => [desc(c.updatedAt)],
      with: { contactTags: { with: { tag: true } } },
    })
  );

  const [
    scannedRows,
    pendingReminders,
    goals,
    goalTexts,
    closenessCohort,
    constellationConfig,
  ] = await Promise.all([
    contactRowsPromise,
    db.query.reminders.findMany({
      where: and(
        eq(reminders.userId, userId),
        eq(reminders.status, "pending")
      ),
      orderBy: (r, { asc }) => [asc(r.dueDate)],
    }),
    db.query.userGoals.findMany({
      where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
      orderBy: (g, { desc }) => [desc(g.createdAt)],
    }),
    listActiveGoalTextsForUser(userId),
    // Donates the scan above rather than repeating it.
    getClosenessCohort(userId, contactRowsPromise),
    getConstellationConfig(),
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
      // Same rule and the same shared predicate as `loadGraphData` — this payload path is a
      // parallel implementation, so the decision has to come from one place or the two
      // surfaces will quietly disagree about who is on the chart.
      substantive: constellationEligibility(
        closenessCohort.constellationSignals.get(c.id),
        {
          pin: c.constellationPin ?? null,
          hasNotesText: Boolean(c.hasNotes),
          statedCloseness: c.statedCloseness ?? null,
          priorityLevel: c.priorityLevel ?? 0,
          nextFollowUpAt: c.nextFollowUpAt ?? null,
          tagCount: (c.tags ?? []).length,
        },
        constellationConfig.thresholds
      ).eligible,
    };
  });

  const userName = (await options?.userName) || "You";

  // The preview mirrors /graph: engaged-only by default. It has no "show all" of its own —
  // the link into /graph is where that lives — so this is always the engaged scope.
  const previewEligibleCount = graphContacts.filter((c) => c.substantive).length;
  const previewFilterActive = constellationConfig.enabled;
  const previewVisible = previewFilterActive
    ? graphContacts.filter((c) => c.substantive)
    : graphContacts;

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

  const strongTies =
    networkMetrics.tierCounts.inner + networkMetrics.tierCounts.mid;

  // Filter FIRST, then cap. Capping first would spend the budget on contacts that are about
  // to be hidden and render far fewer than the cap allows.
  const graphPreviewContacts =
    previewVisible.length > GRAPH_PREVIEW_CONTACT_CAP
      ? [...previewVisible]
          .sort(
            (a, b) =>
              (b.orbitScore ?? b.relationshipScore ?? 0) -
              (a.orbitScore ?? a.relationshipScore ?? 0)
          )
          .slice(0, GRAPH_PREVIEW_CONTACT_CAP)
      : previewVisible;

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
    goals,
    networkMetrics,
    goalAlignedContacts,
    closenessById,
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
        // Computed over the WHOLE network, not the capped preview list: the cap is a
        // rendering budget, and `active` still has to reflect the real shape of the network
        // or a 150-contact slice would look like a filtered one.
        constellationFilter: {
          active: previewFilterActive,
          enabled: constellationConfig.enabled,
          scope: "engaged" as const,
          shown: graphPreviewContacts.length,
          engaged: previewEligibleCount,
          available: graphContacts.length,
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

export async function snoozeReminder(
  userId: string,
  reminderId: string,
  days = 7
) {
  const db = await getDb();
  const due = new Date();
  // Same 1..90 clamp as `scheduleContactFollowUp`. Both write `contacts.nextFollowUpAt`
  // for the same contact by different routes (the dashboard's day presets vs. the
  // reminder row's snooze), so they must not disagree about what a day count means.
  due.setDate(due.getDate() + Math.max(1, Math.min(90, days)));

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
