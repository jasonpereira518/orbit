import { and, desc, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  chatMessages,
  contacts,
  interactionMentions,
  interactions,
  suggestedReminders,
  userGoals,
} from "@/db/schema";
import { goalRelevanceComponent } from "@/lib/closeness";
import { getAttentionBrief } from "@/lib/chat-attention";
import { findMentions } from "@/lib/chat-mentions";
import { isRosterMatchableOrg, orgMatchKey } from "@/lib/chat-roster-match";
import { canonicalCompanyClusterName } from "@/lib/company-family";
import type { SuggestionSignals } from "@/lib/chat-suggestions";

/**
 * The database half of the composer's suggestion cards.
 *
 * Split from `chat-suggestions.ts` for the same reason `chat-attached.ts` splits load from
 * render, plus one of its own: `run-smoke.ts` refuses a pure-tier script that can reach
 * `../src/db`, and the ranking is the part worth testing exhaustively.
 *
 * Six statements in the steady state, seven when the user has been using `@` mentions.
 * Every sub-query catches to empty — a signal that fails should thin the row, never fail it.
 */

/** Wider than the ranker's own 7-day gate, so the boundary is decided in the pure layer. */
const INTERACTION_WINDOW_DAYS = 9;
/** A mention older than this is not news any more. */
const MENTION_WINDOW_DAYS = 60;
/** More goals than this and no single one is really the reason for a card. */
const GOAL_LIMIT = 5;
/** How recently a contact must have been added to be worth "nothing logged yet". */
/** Suppression window. Long enough to matter, short enough that a card comes back. */
const RECENT_QUESTION_DAYS = 14;
const RECENT_QUESTION_LIMIT = 50;
const SIGNAL_ROW_LIMIT = 12;
/** A question naming more people than this is not telling us who it is about. */
const MENTION_RESOLVE_LIMIT = 5;
const DAY_MS = 86_400_000;

type NamedPerson = { id: string; name: string; company: string | null };

/**
 * Companies shared by two or more of the people already in hand.
 *
 * Costs no query of its own: every source below already carries `company`, so the cluster
 * falls out of rows that were fetched anyway. That is also why the card says "{A} and {B}
 * both work there" rather than a total — a count would need a seventh statement *and* could
 * disagree with the roster the answer will quote.
 */
function clusterByCompany(
  people: NamedPerson[],
  lastActiveAt: Date
): SuggestionSignals["companyClusters"] {
  const groups = new Map<string, { company: string; names: string[]; ids: Set<string> }>();
  for (const p of people) {
    if (!p.company || !isRosterMatchableOrg(p.company)) continue;
    // Folded the way the roster folds, so "Ramp" and "Ramp Inc" are one cluster here too.
    const key = canonicalCompanyClusterName(p.company) ?? orgMatchKey(p.company);
    const group = groups.get(key) ?? { company: p.company, names: [], ids: new Set<string>() };
    if (!group.ids.has(p.id)) {
      group.ids.add(p.id);
      group.names.push(p.name);
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((g) => g.ids.size >= 2)
    .map((g) => ({ company: g.company, people: g.names, lastActiveAt }));
}

export async function loadSuggestionSignals(
  userId: string,
  now: Date = new Date()
): Promise<SuggestionSignals> {
  const db = await getDb();
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS);

  const [
    attention,
    recentRows,
    newRows,
    commitmentRows,
    mentionRows,
    goalRows,
    companyRows,
    questionRows,
  ] = await Promise.all([
    // Bare, with no `interactedIds`: the closeness-cohort path costs several more statements
    // and two full scans, and on a cold branch recomputes and *writes* scores — all to fill
    // `hasLoggedInteraction`, which nothing here reads.
    getAttentionBrief(userId).catch(() => null),
    db
      .select({
        contactId: interactions.contactId,
        fullName: contacts.fullName,
        preferredName: contacts.preferredName,
        company: contacts.company,
        interactionType: interactions.interactionType,
        interactionDate: interactions.interactionDate,
      })
      .from(interactions)
      .innerJoin(contacts, eq(contacts.id, interactions.contactId))
      .where(
        and(
          eq(interactions.userId, userId),
          gte(interactions.interactionDate, since(INTERACTION_WINDOW_DAYS)),
          lte(interactions.interactionDate, new Date(now.getTime() + 2 * DAY_MS))
        )
      )
      .orderBy(desc(interactions.interactionDate), desc(interactions.sameDayOrder))
      .limit(SIGNAL_ROW_LIMIT)
      .catch(() => []),
    // Unfiltered on purpose: this one query feeds two rungs. `new_contact` wants the recent
    // arrivals with nothing logged, the `newest_contact` starter wants the most recent
    // person whenever they arrived and however well annotated. The emptiness tests come back
    // as computed flags so the ranker can draw that line — and `notes` is still never
    // selected as a column, which `smoke-page-budgets.ts` asserts on every contacts scan
    // because it holds base64 when Blob storage is unconfigured.
    db
      .select({
        id: contacts.id,
        fullName: contacts.fullName,
        preferredName: contacts.preferredName,
        company: contacts.company,
        title: contacts.title,
        industry: contacts.industry,
        aiSummary: contacts.aiSummary,
        keyFacts: contacts.keyFacts,
        createdAt: contacts.createdAt,
        notesEmpty: sql<boolean>`(${contacts.notes} is null or btrim(${contacts.notes}) = '')`,
        hasInteraction: sql<boolean>`${contacts.firstInteractionAt} is not null`,
      })
      .from(contacts)
      .orderBy(desc(contacts.createdAt))
      .where(eq(contacts.userId, userId))
      .limit(SIGNAL_ROW_LIMIT)
      .catch(() => []),
    // A promise with a date on it, still awaiting review.
    db
      .select({
        contactId: suggestedReminders.contactId,
        fullName: contacts.fullName,
        preferredName: contacts.preferredName,
        rawDatePhrase: suggestedReminders.rawDatePhrase,
        sourceExcerpt: suggestedReminders.sourceExcerpt,
        dueDate: suggestedReminders.dueDate,
      })
      .from(suggestedReminders)
      .innerJoin(contacts, eq(contacts.id, suggestedReminders.contactId))
      .where(
        and(eq(suggestedReminders.userId, userId), eq(suggestedReminders.status, "pending"))
      )
      .orderBy(desc(suggestedReminders.dueDate))
      .limit(SIGNAL_ROW_LIMIT)
      .catch(() => []),
    // Someone named in a note about somebody else. `interactions.contactId` is whose note
    // it was; `interactionMentions.contactId` is who got named in it.
    db
      .select({
        mentionedId: interactionMentions.contactId,
        mentionedName: contacts.fullName,
        mentionedPreferred: contacts.preferredName,
        subjectId: interactions.contactId,
        at: interactions.interactionDate,
      })
      .from(interactionMentions)
      .innerJoin(interactions, eq(interactions.id, interactionMentions.interactionId))
      .innerJoin(contacts, eq(contacts.id, interactionMentions.contactId))
      .where(
        and(
          eq(interactionMentions.userId, userId),
          gte(interactions.interactionDate, since(MENTION_WINDOW_DAYS))
        )
      )
      .orderBy(desc(interactions.interactionDate))
      .limit(SIGNAL_ROW_LIMIT)
      .catch(() => []),
    db
      .select({ text: userGoals.text })
      .from(userGoals)
      .where(and(eq(userGoals.userId, userId), eq(userGoals.active, 1)))
      .orderBy(desc(userGoals.createdAt))
      .limit(GOAL_LIMIT)
      .catch(() => []),
    // The largest employer in the whole network, not just among recent rows — this is the
    // cold-start rung, and it has to fire when every window above is empty.
    db
      .select({ company: contacts.company, total: sql<number>`count(*)::int` })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), isNotNull(contacts.company)))
      .groupBy(contacts.company)
      .orderBy(desc(sql`count(*)`))
      .limit(3)
      .catch(() => []),
    // Not scoped to a thread on purpose: asking in the floating ask bar has to suppress the
    // card on /chat, and the other way round.
    db
      .select({ content: chatMessages.content, createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.userId, userId),
          eq(chatMessages.role, "user"),
          gte(chatMessages.createdAt, since(RECENT_QUESTION_DAYS))
        )
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(RECENT_QUESTION_LIMIT)
      .catch(() => []),
  ]);

  const overdue = (attention?.overdue ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    daysOverdue: c.daysOverdue,
  }));
  const goneQuiet = (attention?.suggestions ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    reason: c.reason,
  }));

  const recentInteractions = recentRows.map((r) => ({
    contactId: r.contactId,
    name: r.preferredName?.trim() || r.fullName,
    interactionType: r.interactionType,
    interactionDate: r.interactionDate,
  }));
  const newContacts = newRows.map((r) => ({
    id: r.id,
    name: r.preferredName?.trim() || r.fullName,
    company: r.company,
    createdAt: r.createdAt,
    notesEmpty: Boolean(r.notesEmpty),
    hasInteraction: Boolean(r.hasInteraction),
  }));

  const commitments = commitmentRows
    .filter((r) => Boolean(r.contactId))
    .map((r) => ({
      contactId: r.contactId as string,
      name: r.preferredName?.trim() || r.fullName,
      // The date phrase is the user's own words and the most concrete thing available;
      // the excerpt is the fallback when the phrase alone would read as a fragment.
      phrase: r.rawDatePhrase?.trim() || r.sourceExcerpt?.trim() || "",
    }));

  // Collapsed to one card per (mentioned person, subject) pair, carrying how often it
  // happened — twice in a month is a stronger signal than once, and the basis says so.
  const mentionPairs = new Map<
    string,
    { id: string; name: string; inNoteAboutId: string; times: number; lastAt: Date }
  >();
  for (const row of mentionRows) {
    if (!row.subjectId || row.subjectId === row.mentionedId) continue;
    const key = `${row.mentionedId}:${row.subjectId}`;
    const existing = mentionPairs.get(key);
    if (existing) {
      existing.times += 1;
      continue;
    }
    mentionPairs.set(key, {
      id: row.mentionedId,
      name: row.mentionedPreferred?.trim() || row.mentionedName,
      inNoteAboutId: row.subjectId,
      times: 1,
      lastAt: row.at,
    });
  }

  // Who the user has been asking about. `findMentions` with no name list uses its shape
  // heuristic, which is the right tool here: the attachment list is not persisted, so the
  // `@Name` token in the stored question is all that survives.
  const mentionedAt = new Map<string, Date>();
  for (const row of questionRows) {
    for (const m of findMentions(row.content)) {
      const key = m.name.trim().toLowerCase();
      if (key && !mentionedAt.has(key)) mentionedAt.set(key, row.createdAt);
    }
  }
  const mentionKeys = [...mentionedAt.keys()].slice(0, MENTION_RESOLVE_LIMIT);
  const askedRows = mentionKeys.length
    ? await db
        .select({
          id: contacts.id,
          fullName: contacts.fullName,
          preferredName: contacts.preferredName,
          company: contacts.company,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.userId, userId),
            or(
              inArray(sql`lower(${contacts.fullName})`, mentionKeys),
              inArray(sql`lower(coalesce(${contacts.preferredName}, ''))`, mentionKeys)
            )
          )
        )
        .limit(MENTION_RESOLVE_LIMIT * 2)
        .catch(() => [])
    : [];

  const askedAbout = askedRows.map((r) => {
    const name = r.preferredName?.trim() || r.fullName;
    const askedAt =
      mentionedAt.get(name.toLowerCase()) ??
      mentionedAt.get(r.fullName.toLowerCase()) ??
      now;
    return { id: r.id, name, askedAt };
  });

  const clusterPeople: NamedPerson[] = [
    ...(attention?.overdue ?? []).map((c) => ({ id: c.id, name: c.name, company: c.company })),
    ...(attention?.suggestions ?? []).map((c) => ({ id: c.id, name: c.name, company: c.company })),
    ...recentRows.map((r) => ({
      id: r.contactId,
      name: r.preferredName?.trim() || r.fullName,
      company: r.company,
    })),
    ...newRows.map((r) => ({
      id: r.id,
      name: r.preferredName?.trim() || r.fullName,
      company: r.company,
    })),
    ...askedRows.map((r) => ({
      id: r.id,
      name: r.preferredName?.trim() || r.fullName,
      company: r.company,
    })),
  ];

  // Names for the other half of each pair come from the rows already fetched, so this
  // costs no query. A pair whose subject is not among them is dropped rather than shown
  // half-named.
  const nameById = new Map<string, string>(clusterPeople.map((p) => [p.id, p.name]));
  for (const r of mentionRows) {
    nameById.set(r.mentionedId, r.mentionedPreferred?.trim() || r.mentionedName);
  }
  const mentions = [...mentionPairs.values()]
    .map((m) => ({ ...m, inNoteAboutName: nameById.get(m.inNoteAboutId) ?? "" }))
    .filter((m) => m.inNoteAboutName);

  // Scored in memory over the contacts already in hand — `goalRelevanceComponent` is pure,
  // so this costs one tiny query for the goals and nothing else. The haystack is thinner
  // than the dashboard's `goalAlignedContacts`: `notes` is deliberately absent, because the
  // row-width budget forbids selecting it on a contacts scan. That is why the ranker gates
  // on a minimum score — a thin haystack makes weak matches, and a weak match is noise.
  const goals = goalRows.map((g) => g.text).filter(Boolean);
  const goalMatches: SuggestionSignals["goalMatches"] = [];
  if (goals.length) {
    const scoreable = newRows.map((r) => ({
      id: r.id,
      name: r.preferredName?.trim() || r.fullName,
      company: r.company,
      title: r.title,
      industry: r.industry,
      aiSummary: r.aiSummary,
      keyFacts: r.keyFacts ?? [],
    }));
    for (const goal of goals) {
      let best: { id: string; name: string; score: number } | null = null;
      for (const c of scoreable) {
        const score = goalRelevanceComponent(
          {
            company: c.company,
            title: c.title,
            industry: c.industry,
            howMet: null,
            notes: null,
            aiSummary: c.aiSummary,
            keyFacts: c.keyFacts,
            sharedInterests: [],
            tags: [],
          } as Parameters<typeof goalRelevanceComponent>[0],
          [goal]
        );
        if (score > 0 && (!best || score > best.score)) {
          best = { id: c.id, name: c.name, score };
        }
      }
      if (best) goalMatches.push({ ...best, goal });
    }
  }

  const biggest = companyRows.find((r) => r.company && isRosterMatchableOrg(r.company));

  return {
    now,
    overdue,
    goneQuiet,
    recentInteractions,
    newContacts,
    commitments,
    mentions,
    goalMatches,
    biggestCompany: biggest?.company
      ? { company: biggest.company, total: Number(biggest.total) || 0 }
      : null,
    companyClusters: clusterByCompany(clusterPeople, now),
    askedAbout,
    recentQuestions: questionRows.map((r) => r.content),
  };
}
