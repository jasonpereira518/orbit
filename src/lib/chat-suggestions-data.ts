import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages, contacts, interactions } from "@/db/schema";
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
/** How recently a contact must have been added to be worth "nothing logged yet". */
const NEW_CONTACT_WINDOW_DAYS = 14;
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

  const [attention, recentRows, newRows, questionRows] = await Promise.all([
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
    // `notes` is tested in the predicate and never selected: `smoke-page-budgets.ts` asserts
    // row width as well as statement count, and a bare `notes` column on a contacts scan is
    // exactly what it exists to catch.
    db
      .select({
        id: contacts.id,
        fullName: contacts.fullName,
        preferredName: contacts.preferredName,
        company: contacts.company,
        createdAt: contacts.createdAt,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          gte(contacts.createdAt, since(NEW_CONTACT_WINDOW_DAYS)),
          sql`(${contacts.notes} is null or btrim(${contacts.notes}) = '')`,
          sql`(${contacts.aiSummary} is null or btrim(${contacts.aiSummary}) = '')`,
          isNull(contacts.firstInteractionAt)
        )
      )
      .orderBy(desc(contacts.createdAt))
      .limit(SIGNAL_ROW_LIMIT)
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
    createdAt: r.createdAt,
  }));

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

  return {
    now,
    overdue,
    goneQuiet,
    recentInteractions,
    newContacts,
    companyClusters: clusterByCompany(clusterPeople, now),
    askedAbout,
    recentQuestions: questionRows.map((r) => r.content),
  };
}
