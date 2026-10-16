/**
 * The tools themselves. One list, read by the MCP server and by Orbit's own chat.
 *
 * ============================================================================
 * READ THE SECURITY COMMENT AT THE TOP OF `src/lib/mcp/server.ts` FIRST.
 * ============================================================================
 *
 * Its two rules bind every definition below: nothing here sends, fetches a URL or registers
 * a webhook, and nothing here approves a draft. (The web research tools ask the user's AI
 * provider to search; Orbit itself fetches nothing for them, and they are chat-only.) `request_send` stages a row and returns
 * `pending_approval`; the send happens in `approveAgentSend`, which no tool, key or scope
 * reaches. If you are adding a tool, that comment is the thing to read first.
 *
 * Each `run` returns PLAIN DATA. Fencing, truncation and the per-surface field allowlist are
 * applied by the caller (`@/lib/tools/registry`), because they differ by surface and a tool
 * that decided its own presentation would have to know who was asking.
 */
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { actionItems, contactBriefs, contacts, interactions, reminders, userSettings } from "@/db/schema";
import { hybridSearchContacts } from "@/lib/hybrid-search";
import { matchContactsByName } from "@/lib/chat-lanes";
import { findOrgRosters } from "@/lib/chat-roster";
import { loadDueFollowUps } from "@/lib/due-follow-ups";
import { getClosenessCohortSlim } from "@/lib/closeness-cohort";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { finalizeIngest, ingestEvents, openIngestContext } from "@/lib/ingest/events";
import { getNetworkStats } from "@/lib/network-stats";
import { queryRemindersPage } from "@/lib/reminders-page-query";
import { getInboxListId } from "@/lib/reminder-lists";
import { completeReminder, snoozeReminder } from "@/lib/reminders";
import {
  createReminderForUser,
  scheduleContactFollowUpForUser,
} from "@/lib/reminder-writes";
import {
  createContactForUser,
  logNoteInteractionForUser,
  updateContactForUser,
} from "@/lib/contact-writes";
import { DUPLICATE_MERGE_CONFIDENCE } from "@/lib/duplicates";
import { findConfidentDuplicate } from "@/lib/contact-resolve";
import { sanitizeAgentText } from "@/lib/mcp/sanitize";
import { cleanAgentContactFields, recordAiSecurityEvent } from "@/lib/ai-security";
import {
  AgentSendLimitError,
  createAgentSendRequest,
  getAgentSendRequest,
  MAX_BODY_CHARS,
} from "@/lib/agent-sends";
import { toolError, type OrbitTool } from "@/lib/tools/registry";
import { searchMemories } from "@/lib/memory-search";
import { getQueryEmbedding } from "@/lib/embedding-cache";
import { searchMeetingPassagesFor } from "@/lib/meetings-list";
import { listUpcomingEvents, type CalendarEventRow } from "@/lib/calendar-events";
import { resolveTimeZone, ymdInZone } from "@/lib/reminder-due-bucket";
import { requireReleasedSurface } from "@/lib/surface-visibility";
import { discoverPeople, researchCompany, researchPerson } from "@/lib/web-research";

const BOTH = ["mcp", "chat"] as const;
const MCP_ONLY = ["mcp"] as const;
/**
 * Orbit's own chat only. For a tool whose whole purpose is to return free text the user —
 * or anything that could write to their notes — wrote, which is exactly the fan-out the
 * security comment in `mcp/server.ts` keeps off the MCP surface.
 */
const CHAT_ONLY = ["chat"] as const;

/** A `YYYY-MM-DD` day, read as the start (or end) of that day in UTC. */
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
function dayBound(day: string | undefined, end: boolean): Date | null {
  if (!day) return null;
  const d = new Date(`${day}T${end ? "23:59:59" : "00:00:00"}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A web lookup's share of chat's research budget (`GATHER_MAX_MS` is 25s in chat-gather).
 * A search that needs longer is finished on /find, which has a 150s route.
 */
const RESEARCH_TOOL_TIMEOUT_MS = 20_000;
const RESEARCH_TIMEOUT_MESSAGE =
  "The web search needs longer than chat allows. Tell the user to run it on Find people (/find), where it can finish.";

/** One contact the user owns, or nothing. The tenant check every contact-scoped tool starts with. */
async function ownedContact(userId: string, contactId: string) {
  const db = await getDb();
  return db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { id: true, fullName: true, email: true },
  });
}

/** The ranking fields for a set of the user's own contacts. Tenant-scoped, like everything here. */
async function contactsByIds(userId: string, ids: string[]) {
  if (!ids.length) return [];
  const db = await getDb();
  return db.query.contacts.findMany({
    where: and(eq(contacts.userId, userId), inArray(contacts.id, ids)),
    columns: {
      id: true,
      fullName: true,
      company: true,
      title: true,
      closenessTier: true,
      relationshipScore: true,
      lastInteractionAt: true,
    },
  });
}

/** The user's own zone, as Settings/Radar last saw it; UTC until then. */
async function userTimeZone(userId: string): Promise<string> {
  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { radarDigestTz: true },
  });
  return resolveTimeZone(settings?.radarDigestTz);
}

/** One calendar event as both calendar tools return it: local times, no emails. */
function eventView(e: CalendarEventRow, tz: string) {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return {
    eventId: e.id,
    title: e.title,
    day: ymdInZone(e.startAt, tz),
    start: e.allDay ? "all day" : when.format(e.startAt),
    end: e.endAt && !e.allDay ? when.format(e.endAt) : null,
    timeZone: tz,
    location: e.location,
    call: e.conferenceKind,
    response: e.selfResponse,
    attendees: e.attendees.map((a) => ({ name: a.name || a.email, contactId: a.contactId })),
    attendeeCount: e.attendeeCount,
    guestListHidden: e.guestsHidden,
  };
}

/** "15:00" in `tz` for an instant — what "my 3pm" is matched against. */
function hhmmInZone(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

export const ORBIT_TOOLS: readonly OrbitTool[] = [
  /* ------------------------------------------------------------------- read tools ----- */
  {
    name: "search_contacts",
    title: "Search contacts",
    description:
      "Search the user's professional network by name, company, school, role or free text. " +
      "Returns matching people with how close the relationship is.",
    inputSchema: {
      query: z.string().min(1).max(200).describe("What to look for."),
      limit: z.number().int().min(1).max(25).default(10),
    },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "contacts",
    // `notes` is absent from the MCP allowlist and present in chat's, and that asymmetry is
    // the whole reason `fields` exists. A search fans out over many contacts at once, which
    // makes it the highest-leverage channel for injected text to reach an outside model —
    // so MCP gets the curated summary only. In Orbit's own chat the same text is already in
    // the prompt behind a fence, so withholding it would cost grounding and buy nothing.
    fields: {
      mcp: ["id", "name", "company", "title", "school", "location", "closenessTier", "relevance", "summary"],
      chat: [
        "id", "name", "company", "title", "school", "location", "closenessTier", "relevance", "summary",
        "notes",
      ],
    },
    async run(userId, args: { query: string; limit: number }, ctx) {
      const ranked = await hybridSearchContacts(userId, {
        query: args.query,
        limit: args.limit,
        // MCP's allowlist drops `notes`, so it is not read for that surface at all.
        withProse: ctx.surface === "chat",
      });
      return ranked.map((c) => ({
        id: c.id,
        name: c.fullName,
        company: c.company,
        title: c.title,
        school: c.school ?? null,
        location: c.location,
        closenessTier: c.closenessTier ?? null,
        relevance: c.relevance,
        summary: c.aiSummary ?? null,
        notes: c.notes ?? null,
      }));
    },
  },

  {
    name: "get_contact",
    title: "Get one contact",
    description:
      "Everything Orbit knows about one person, including recent interactions. " +
      "Use search_contacts first to find their id.",
    inputSchema: { contactId: z.string().uuid() },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "contact",
    async run(userId, args: { contactId: string }, ctx) {
      const db = await getDb();
      // Both reads at once: the interactions are scoped by userId too, so a contact that is
      // not the caller's reads nothing of anyone else's and the result is simply discarded.
      const [contact, recent] = await Promise.all([
        // Scoped by userId as well as id: an id is guessable in principle, and this is the
        // one tool that returns free-text notes. Only the fields returned below — the row
        // also carries the stored avatar, up to ~120 KB of base64 this never used.
        db.query.contacts.findFirst({
          where: and(eq(contacts.id, args.contactId), eq(contacts.userId, userId)),
          columns: {
            id: true,
            fullName: true,
            company: true,
            title: true,
            school: true,
            email: true,
            location: true,
            linkedinUrl: true,
            closenessTier: true,
            notes: true,
            aiSummary: true,
          },
        }),
        db.query.interactions.findMany({
          where: and(eq(interactions.userId, userId), eq(interactions.contactId, args.contactId)),
          orderBy: [desc(interactions.interactionDate)],
          limit: 10,
          columns: {
            interactionType: true,
            interactionDate: true,
            source: true,
            aiSummary: true,
            rawNotes: true,
          },
        }),
      ]);
      if (!contact) return toolError("No such contact.");

      // Truncated for MCP: that is the field an attacker can write to, and there is no
      // reason an outside model needs more than this much of it at once. Chat gets the
      // whole thing — it is one person, asked for by id, and the answer is only as good as
      // the record it was given.
      const wide = ctx.surface === "chat";
      const noteCap = wide ? Number.POSITIVE_INFINITY : 2000;
      const entryCap = wide ? Number.POSITIVE_INFINITY : 500;
      const clip = (value: string | null, cap: number) =>
        value ? (Number.isFinite(cap) ? value.slice(0, cap) : value) : null;

      return {
        id: contact.id,
        name: contact.fullName,
        company: contact.company,
        title: contact.title,
        school: contact.school,
        email: contact.email,
        location: contact.location,
        linkedinUrl: contact.linkedinUrl,
        closenessTier: contact.closenessTier,
        notes: clip(contact.notes, noteCap),
        summary: contact.aiSummary,
        interactions: recent.map((i) => ({
          type: i.interactionType,
          at: i.interactionDate ? new Date(i.interactionDate).toISOString() : null,
          // Provenance is surfaced so a reader can weigh a note an integration wrote
          // differently from one the user typed.
          source: i.source,
          summary: i.aiSummary,
          notes: clip(i.rawNotes, entryCap),
        })),
      };
    },
  },

  {
    name: "who_do_i_know_at",
    title: "Who do I know at a company",
    description:
      "The people in the user's network at a given company or organisation — the warm path in.",
    inputSchema: {
      company: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(20).default(10),
    },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "rosters",
    async run(userId, args: { company: string; limit: number }) {
      // `findOrgRosters` takes the raw question and extracts organisation names itself, so
      // the company is passed through as prose rather than pre-parsed.
      const rosters = await findOrgRosters(userId, args.company);
      return rosters.map((r) => ({ ...r, people: r.people.slice(0, args.limit) }));
    },
  },

  {
    name: "due_followups",
    title: "Who to follow up with",
    description: "People the user owes a follow-up, or whose relationship is going cold.",
    inputSchema: { limit: z.number().int().min(1).max(25).default(10) },
    // Read-only BY CONSTRUCTION: it reads the dashboard's due list (`loadDueFollowUps`),
    // not generateDueFollowUps, which creates reminders. A tool named like a reader that
    // writes is how an agent surprises the person it is working for.
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "followups",
    async run(userId, args: { limit: number }) {
      const due = await loadDueFollowUps(userId);
      return due.slice(0, args.limit).map((c) => ({
        contactId: c.id,
        name: c.fullName,
        company: c.company,
        dueAt: c.nextFollowUpAt ? new Date(c.nextFollowUpAt).toISOString() : null,
        lastInteractionAt: c.lastInteractionAt
          ? new Date(c.lastInteractionAt).toISOString()
          : null,
      }));
    },
  },

  {
    name: "list_reminders",
    title: "List reminders",
    description:
      "The user's reminders and to-dos: what is due today, what is coming up, what has no " +
      "date, and what is already done. Use due_followups instead for people going cold.",
    inputSchema: {
      view: z
        .enum(["today", "upcoming", "anytime", "done"])
        .default("today")
        .describe("today includes anything overdue."),
      contactId: z.string().uuid().optional().describe("Only this person's reminders."),
      query: z.string().max(200).optional().describe("Match the title or contact name."),
      limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "reminders",
    async run(
      userId,
      args: { view: "today" | "upcoming" | "anytime" | "done"; contactId?: string; query?: string; limit: number }
    ) {
      const db = await getDb();
      const inboxId = await getInboxListId(userId);
      // UTC, not the user's zone: an assistant request carries no `orbit-tz` cookie, and
      // guessing a zone would put a reminder in the wrong day rather than admit it. Every
      // row carries its own `dueDate`, so a model can say "tomorrow" correctly anyway.
      const page = await queryRemindersPage(
        db,
        userId,
        {
          view: args.view,
          listId: null,
          contactId: args.contactId,
          q: args.query,
          limit: args.limit,
          tz: "UTC",
        },
        { inboxId }
      );
      return page.items.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        dueDate: r.dueDate,
        status: r.status,
        kind: r.actionKind,
        contactId: r.contactId,
        contactName: r.contactName,
      }));
    },
  },

  {
    name: "get_network_overview",
    title: "Network overview",
    description:
      "How big the user's network is and how it is doing right now: totals, inner circle, " +
      "recent activity, what is overdue. Good for a weekly review or a first question.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "overview",
    async run(userId) {
      // One cohort read for both halves: `cache()` would not share it in a route handler.
      const cohort = getClosenessCohortSlim(userId);
      const [stats, due] = await Promise.all([
        getNetworkStats(userId, { cohort }),
        loadDueFollowUps(userId, { cohort }),
      ]);
      // The headline copy is written for a dashboard card ("Gravity well detected"), which
      // would read as nonsense quoted back by an assistant. Only the numbers cross over.
      return {
        stats: stats.items.map((i) => ({ label: i.label, value: i.value })),
        dueFollowUpCount: due.length,
        recentContacts: due.slice(0, 5).map((c) => ({
          contactId: c.id,
          name: c.fullName,
          company: c.company,
        })),
      };
    },
  },

  {
    name: "get_timeline",
    title: "One person's history",
    description:
      "The dated history with one person — meetings, calls, notes and messages, newest " +
      "first — and a total for the range. Use it for when they last spoke, how often they " +
      "meet, or what happened over a period; narrow with since/until (YYYY-MM-DD). " +
      "get_contact returns only the handful most recent.",
    inputSchema: {
      contactId: z.string().uuid(),
      since: isoDay.optional().describe("Only entries on or after this day."),
      until: isoDay.optional().describe("Only entries on or before this day."),
      limit: z.number().int().min(1).max(20).default(10),
    },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "timeline",
    async run(
      userId,
      args: { contactId: string; since?: string; until?: string; limit: number },
      ctx
    ) {
      const db = await getDb();
      const since = dayBound(args.since, false);
      const until = dayBound(args.until, true);
      const where = and(
        eq(interactions.userId, userId),
        eq(interactions.contactId, args.contactId),
        ...(since ? [gte(interactions.interactionDate, since)] : []),
        ...(until ? [lte(interactions.interactionDate, until)] : [])
      );

      // The count is the point of half the questions this answers ("how often do we
      // actually talk?"), and it has to be the real total rather than the length of a
      // capped list, for the same reason `findOrgRosters` counts separately from listing.
      // The ownership check runs alongside rather than first: both reads are scoped by
      // userId, so for a contact that is not the caller's they find nothing and are dropped.
      const [contact, rows, totals] = await Promise.all([
        ownedContact(userId, args.contactId),
        db.query.interactions.findMany({
          where,
          orderBy: [desc(interactions.interactionDate), desc(interactions.sameDayOrder)],
          limit: args.limit,
          columns: {
            interactionType: true,
            interactionDate: true,
            source: true,
            aiSummary: true,
            rawNotes: true,
          },
        }),
        db.select({ n: sql<number>`count(*)::int` }).from(interactions).where(where),
      ]);
      if (!contact) return toolError("No such contact.");

      // Raw note text is withheld over MCP, not truncated. `get_contact` is the ONE
      // documented exception to the fan-out rule — one person, by id, capped — and a
      // timeline is a wider window on the same field for the same person. Widening an
      // exception is how it stops being one, so MCP gets the dates, the kinds and the
      // summaries, which is enough to say when and how often without quoting anything.
      const wide = ctx.surface === "chat";
      return {
        contactId: contact.id,
        name: contact.fullName,
        total: Number(totals[0]?.n ?? 0),
        entries: rows.map((i) => ({
          at: i.interactionDate ? new Date(i.interactionDate).toISOString() : null,
          type: i.interactionType,
          source: i.source,
          summary: i.aiSummary,
          ...(wide ? { notes: i.rawNotes } : {}),
        })),
      };
    },
  },

  {
    name: "get_goals",
    title: "What the user is working towards",
    description:
      "The user's active networking goals, in their own words. Use it when a question is " +
      "open-ended — who to reconnect with, who matters right now, what to say — so the " +
      "answer serves what they are actually trying to do.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "goals",
    async run(userId) {
      // The user's own words, typed into settings — not a field anything else writes, which
      // is why this one crosses to MCP whole.
      return { goals: await listActiveGoalTextsForUser(userId, { limit: 10 }) };
    },
  },

  {
    name: "find_path_to",
    title: "Find a way in",
    description:
      "Who in the user's network could open a door to a company, a school or a person, " +
      "ranked by how well the user actually knows them. Give an organisation (\"Stripe\") or " +
      "a person's name. If that person is already in the network it says so, because then " +
      "there is no path to find.",
    inputSchema: {
      target: z.string().min(2).max(200).describe("A company, a school, or a person's name."),
      limit: z.number().int().min(1).max(15).default(8),
    },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "paths",
    async run(userId, args: { target: string; limit: number }) {
      // Two readings of one string, because "how do I get to Stripe" and "how do I get to
      // Dana Wu" are the same question with different answers, and the caller should not
      // have to know which kind of name they are holding.
      const [rosters, named] = await Promise.all([
        findOrgRosters(userId, args.target),
        matchContactsByName(userId, args.target),
      ]);

      // The shortest path is no path: if the target is already a contact, say so first.
      // Only a strong name match ("Dana" ↔ "Dana Wu") counts: a shared surname is not
      // "already known", and a path search for the person should still run.
      const alreadyKnown = named.strong
        .slice(0, 3)
        .map((c) => ({ contactId: c.id, name: c.name, company: c.company, title: c.title }));

      const known = new Set(alreadyKnown.map((c) => c.contactId));
      const via = new Map<string, string>();
      for (const roster of rosters) {
        for (const person of roster.people) {
          if (!known.has(person.id) && !via.has(person.id)) via.set(person.id, roster.name);
        }
      }
      if (!via.size) return { target: args.target, alreadyKnown, introducers: [] };

      const rows = await contactsByIds(userId, [...via.keys()]);
      // Ranked on the closeness the rest of the app already shows, rather than by recomputing
      // a cohort: `getClosenessCohort` scores the WHOLE network to produce these same
      // numbers, and a question about eight people should not pay for that.
      const TIERS: Record<string, number> = { inner: 0, mid: 1, outer: 2 };
      const at = (v: Date | string | null) => (v ? new Date(v).getTime() : 0);
      const ranked = rows
        .sort(
          (a, b) =>
            (TIERS[a.closenessTier ?? ""] ?? 3) - (TIERS[b.closenessTier ?? ""] ?? 3) ||
            (b.relationshipScore ?? 0) - (a.relationshipScore ?? 0) ||
            at(b.lastInteractionAt) - at(a.lastInteractionAt)
        )
        .slice(0, args.limit);

      return {
        target: args.target,
        alreadyKnown,
        introducers: ranked.map((c) => ({
          contactId: c.id,
          name: c.fullName,
          company: c.company,
          title: c.title,
          closenessTier: c.closenessTier ?? null,
          lastInteractionAt: c.lastInteractionAt
            ? new Date(c.lastInteractionAt).toISOString()
            : null,
          via: via.get(c.id) ?? null,
        })),
      };
    },
  },

  {
    name: "search_notes",
    title: "Search your notes",
    description:
      "Search what the user has written — notes, meeting and call logs — by meaning and by " +
      "words. Use it for what was discussed, said or promised, and when; for details that are " +
      "not in a contact's summary; and for questions that name a topic rather than a person. " +
      "Narrow by person with contactId and by date with after/before (YYYY-MM-DD). Returns " +
      "dated passages with the people they mention.",
    inputSchema: {
      query: z.string().min(1).max(200).describe("What to look for, in plain words."),
      contactId: z.string().uuid().optional().describe("Only passages about this person."),
      after: isoDay.optional().describe("Only passages on or after this day."),
      before: isoDay.optional().describe("Only passages on or before this day."),
      limit: z.number().int().min(1).max(8).default(6),
    },
    annotations: { readOnlyHint: true },
    surfaces: CHAT_ONLY,
    scope: "read",
    resultLabel: "passages",
    fields: {
      chat: ["sourceId", "date", "kind", "contactIds", "snippet"],
    },
    async run(
      userId,
      args: { query: string; contactId?: string; after?: string; before?: string; limit: number }
    ) {
      // The meaning arm when the account can embed, the words arm always. A failed embedding
      // — no key, an Anthropic-only account, a provider hiccup — degrades to words, which is
      // exactly what every one of those accounts gets from passage search anyway.
      const embedding = await getQueryEmbedding(userId, args.query).catch(() => null);
      const passages = await searchMemories(userId, {
        query: args.query,
        embedding,
        contactIds: args.contactId ? [args.contactId] : null,
        after: dayBound(args.after, false),
        before: dayBound(args.before, true),
        limit: args.limit,
      });
      return passages.map((p) => ({
        sourceId: p.sourceId,
        date: p.occurredAt ? new Date(p.occurredAt).toISOString().slice(0, 10) : null,
        kind: p.sourceKind,
        contactIds: p.contactIds,
        snippet: p.snippet,
      }));
    },
  },

  {
    name: "search_meetings",
    title: "Search your recorded meetings",
    description:
      "Search the transcripts and summaries of calls the user recorded with Orbit, by the " +
      "words in them. Use it when the question is about a call: what came up about a topic, " +
      "what was decided, what someone said in a meeting. Give short keywords — a name or a " +
      "topic — not a whole sentence. Each passage says when in the meeting something was said " +
      "but NOT who said it: speakers are not named, so never attribute a line to a person. " +
      "A name matches the meetings that person was invited to. Narrow by date with after/before (YYYY-MM-DD).",
    inputSchema: {
      query: z.string().min(1).max(200).describe("Keywords: a topic and/or a name."),
      after: isoDay.optional().describe("Only meetings on or after this day."),
      before: isoDay.optional().describe("Only meetings on or before this day."),
      limit: z.number().int().min(1).max(8).default(6),
    },
    annotations: { readOnlyHint: true },
    // Transcripts are other people's words, verbatim — the same free-text fan-out that keeps
    // `search_notes` off the MCP surface.
    surfaces: CHAT_ONLY,
    scope: "read",
    resultLabel: "meeting passages",
    fields: {
      chat: ["meetingId", "title", "date", "startMs", "kind", "snippet"],
    },
    async run(userId, args: { query: string; after?: string; before?: string; limit: number }) {
      return searchMeetingPassagesFor(userId, {
        query: args.query,
        after: dayBound(args.after, false),
        before: dayBound(args.before, true),
        limit: args.limit,
      });
    },
  },

  {
    name: "upcoming_meetings",
    title: "The user's calendar",
    description:
      "Meetings and events on the user's calendar, from two days ago to two weeks ahead. Use it " +
      "for anything about their schedule: what is on today or tomorrow, when they next see " +
      "someone, who they are meeting this week, or which meeting \"my 3pm\" is. Each event has " +
      "the attendees Orbit knows (contactId), so follow up with get_contact or get_timeline to " +
      "prepare for a meeting. Times are already in the user's own time zone. Narrow by day with " +
      "after/before (YYYY-MM-DD, the user's local days) and to one person with contactId.",
    inputSchema: {
      after: isoDay.optional().describe("Only events on or after this local day. Default: now."),
      before: isoDay.optional().describe("Only events on or before this local day. Default: a week ahead."),
      contactId: z.string().uuid().optional().describe("Only events this person is on."),
      query: z.string().max(100).optional().describe("Match words in the event title."),
      limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: { readOnlyHint: true },
    // Event titles and guest lists are written by whoever sent the invite — a stranger can put
    // text in front of the model just by inviting the user — so this stays off MCP like the
    // other free-text fan-outs.
    surfaces: CHAT_ONLY,
    scope: "read",
    resultLabel: "calendar events",
    async run(
      userId,
      args: { after?: string; before?: string; contactId?: string; query?: string; limit: number }
    ) {
      const tz = await userTimeZone(userId);
      const now = new Date();
      // Local days, read loosely in SQL (a day is at most 14h off UTC) and exactly below.
      const pad = 14 * 3_600_000;
      const from = args.after ? new Date(dayBound(args.after, false)!.getTime() - pad) : now;
      const to = args.before
        ? new Date(dayBound(args.before, true)!.getTime() + pad)
        : new Date(now.getTime() + 7 * 86_400_000);
      const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const rows = (await listUpcomingEvents(userId, { from, to, contactId: args.contactId, limit: 200 }))
        .filter((e) => {
          const day = ymdInZone(e.startAt, tz);
          if (args.after && day < args.after) return false;
          if (args.before && day > args.before) return false;
          return words.every((w) => e.title.toLowerCase().includes(w));
        })
        .slice(0, args.limit);
      return rows.map((e) => eventView(e, tz));
    },
  },

  {
    name: "meeting_context",
    title: "Prepare for a meeting",
    description:
      "Everything worth knowing before one meeting, in one call: the event, and for each " +
      "attendee Orbit knows their standing and suggested next step, the last few times you " +
      "spoke, and what is still open with them. Pick the meeting by eventId (from " +
      "upcoming_meetings), by local time (\"15:00\" for \"my 3pm\", optionally with a day), or " +
      "by words in its title; with none of those it is the next meeting with someone you know. " +
      "Use it for \"prep me\", \"what should I know before…\" and \"who is on my next call\".",
    inputSchema: {
      eventId: z.string().uuid().optional(),
      time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24-hour.")
        .optional()
        .describe("Local start time, 24-hour: \"15:00\" for 3pm."),
      day: isoDay.optional().describe("Local day for time. Default: the next one at that time."),
      query: z.string().max(100).optional().describe("Words in the event title."),
    },
    annotations: { readOnlyHint: true },
    // Notes summaries and to-dos across several people, plus a stranger-written invite title:
    // the same reasons the other calendar and notes tools stay off MCP.
    surfaces: CHAT_ONLY,
    scope: "read",
    resultLabel: "meeting context",
    async run(userId, args: { eventId?: string; time?: string; day?: string; query?: string }) {
      const tz = await userTimeZone(userId);
      const now = new Date();
      const all = await listUpcomingEvents(userId, {
        from: new Date(now.getTime() - 2 * 86_400_000),
        to: new Date(now.getTime() + 14 * 86_400_000),
        limit: 200,
      });
      // Started up to an hour ago still counts as "my next meeting" — they may be in it.
      const soon = all.filter((e) => !e.allDay && (e.endAt ?? e.startAt).getTime() > now.getTime() - 3_600_000);
      const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const event = args.eventId
        ? all.find((e) => e.id === args.eventId)
        : args.time
          ? soon.find((e) => hhmmInZone(e.startAt, tz) === args.time && (!args.day || ymdInZone(e.startAt, tz) === args.day))
          : words.length
            ? soon.find((e) => words.every((w) => e.title.toLowerCase().includes(w)))
            : soon.find((e) => e.startAt.getTime() > now.getTime() - 3_600_000 && e.attendees.some((a) => a.contactId));
      if (!event) return toolError("No matching meeting on the calendar in the next two weeks.");

      const ids = [...new Set(event.attendees.map((a) => a.contactId).filter((c): c is string => !!c))].slice(0, 8);
      const db = await getDb();
      const [people, briefs, todos, items, recent] = await Promise.all([
        ids.length
          ? db.query.contacts.findMany({
              where: and(eq(contacts.userId, userId), inArray(contacts.id, ids)),
              columns: { id: true, fullName: true, company: true, title: true },
            })
          : [],
        ids.length
          ? db.query.contactBriefs.findMany({
              where: and(eq(contactBriefs.userId, userId), inArray(contactBriefs.contactId, ids)),
              columns: { contactId: true, standing: true, nextStep: true },
            })
          : [],
        ids.length
          ? db.query.reminders.findMany({
              where: and(
                eq(reminders.userId, userId),
                inArray(reminders.contactId, ids),
                eq(reminders.status, "pending"),
                // Not the meeting's own prep/follow-up reminders: those are about this event.
                isNull(reminders.calendarEventKey)
              ),
              columns: { contactId: true, title: true, dueDate: true },
              orderBy: [asc(reminders.dueDate)],
              limit: 40,
            })
          : [],
        ids.length
          ? db.query.actionItems.findMany({
              where: and(eq(actionItems.userId, userId), inArray(actionItems.contactId, ids), eq(actionItems.status, "open")),
              columns: { contactId: true, text: true },
              limit: 40,
            })
          : [],
        Promise.all(
          ids.map((id) =>
            db.query.interactions.findMany({
              // The past only: calendar sync logs this very meeting as an interaction too.
              where: and(eq(interactions.userId, userId), eq(interactions.contactId, id), lte(interactions.interactionDate, now)),
              orderBy: [desc(interactions.interactionDate)],
              limit: 3,
              columns: { contactId: true, interactionType: true, interactionDate: true, aiSummary: true },
            })
          )
        ),
      ]);
      const recentBy = new Map(recent.map((rows, i) => [ids[i], rows]));
      return {
        event: eventView(event, tz),
        people: people.map((c) => {
          const brief = briefs.find((b) => b.contactId === c.id);
          return {
            contactId: c.id,
            name: c.fullName,
            company: c.company,
            title: c.title,
            standing: brief?.standing ?? null,
            nextStep: brief?.nextStep ?? null,
            recent: (recentBy.get(c.id) ?? []).map((i) => ({
              day: i.interactionDate ? ymdInZone(i.interactionDate, tz) : null,
              type: i.interactionType,
              summary: i.aiSummary,
            })),
            open: [
              ...todos.filter((t) => t.contactId === c.id).map((t) => t.title),
              ...items.filter((t) => t.contactId === c.id).map((t) => t.text),
            ].slice(0, 5),
          };
        }),
        // On the invite but not in Orbit — worth a "who is this?" before the call.
        notInOrbit: event.attendees.filter((a) => !a.contactId).map((a) => a.name || a.email).slice(0, 10),
      };
    },
  },

  {
    name: "research_person",
    title: "Research someone outside the network",
    description:
      "Search the public web for a person who is NOT in the user's network — someone they are " +
      "about to meet, were introduced to, or want to reach. Only use it after search_contacts " +
      "found nobody by that name. Needs the person's name plus at least one of company, " +
      "domain or linkedinUrl; a name alone is refused. Returns a short cited brief: current " +
      "role, summary, things worth bringing up, and source links. match 'unsure' means the " +
      "pages might be about a namesake: say so, and report no facts as theirs. It can take a " +
      "while; if it times out, tell the user they can finish it on Find people.",
    inputSchema: {
      name: z.string().min(2).max(100).describe("Their full name."),
      company: z.string().max(100).optional().describe("Where they work."),
      domain: z.string().max(253).optional().describe("Their company's website domain, e.g. stripe.com."),
      linkedinUrl: z
        .string()
        .max(300)
        .regex(/^(https?:\/\/)?([a-z]{2,3}\.)?linkedin\.com\/in\/[^\s]+$/i, "Use a linkedin.com/in/ profile link.")
        .optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    // Chat only: the security comment in `mcp/server.ts` keeps anything that reaches the
    // web off MCP. The search runs on the user's own AI provider, with only these typed
    // fields; no URL here is fetched by Orbit (LinkedIn is a search anchor, never read).
    surfaces: CHAT_ONLY,
    scope: "read",
    resultLabel: "web research",
    releasedSurface: "page.find",
    fields: {
      chat: ["match", "name", "headline", "currentRole", "location", "summary", "talkingPoints", "experience", "sources", "note"],
    },
    async run(userId, args: { name: string; company?: string; domain?: string; linkedinUrl?: string }) {
      try {
        await requireReleasedSurface(userId, "page.find");
      } catch {
        return toolError("research_person is not available here.");
      }
      // Read the signal, not the error: `webSearchJson` rewraps a provider's abort.
      const signal = AbortSignal.timeout(RESEARCH_TOOL_TIMEOUT_MS);
      try {
        const res = await researchPerson(
          userId,
          { fullName: args.name, company: args.company, domain: args.domain, linkedinUrl: args.linkedinUrl },
          { signal },
        );
        if (!res.ok) return toolError(res.message);
        const d = res.dossier;
        return {
          match: d.match,
          name: d.subject.fullName,
          headline: d.headline,
          currentRole: d.current ? [d.current.title, d.current.organization].filter(Boolean).join(" at ") : null,
          location: d.location,
          summary: d.summary,
          talkingPoints: d.talkingPoints,
          experience: d.experiences
            .slice(0, 6)
            .map((e) => [e.title, e.organization, e.startYear ? `${e.startYear}–${e.isCurrent ? "now" : e.endYear ?? ""}` : null].filter(Boolean).join(", ")),
          sources: d.sources.slice(0, 5).map((s) => s.url),
          note: d.match === "confident" ? "From the public web; not in the user's network." : "Not confirmed to be this person — report no facts as theirs.",
        };
      } catch (err) {
        if (signal.aborted) return toolError(RESEARCH_TIMEOUT_MESSAGE);
        throw err;
      }
    },
  },

  {
    name: "research_company",
    title: "Research a company on the web",
    description:
      "Search the public web for a company: what they do, recent news, and people there worth " +
      "talking to, each with the page that names them. Use it when the user asks about a " +
      "company beyond who they already know there — use who_do_i_know_at for that, first. " +
      "match 'unsure' means it might be a different company with the same name: say so, and " +
      "report nothing as fact. It can take a while; if it times out, tell the user they can " +
      "finish it on Find people.",
    inputSchema: {
      name: z.string().min(2).max(100).describe("The company's name."),
      domain: z.string().max(253).optional().describe("Their website domain, e.g. stripe.com, if known."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    // Chat only, like research_person. The homepage read is for /find, where a person typed
    // the domain; here the domain is the model's, so it is a search hint and nothing more.
    surfaces: CHAT_ONLY,
    scope: "read",
    resultLabel: "web research",
    releasedSurface: "page.find",
    fields: {
      chat: ["match", "name", "website", "description", "headquarters", "founded", "size", "news", "people", "sources", "note"],
    },
    async run(userId, args: { name: string; domain?: string }) {
      try {
        await requireReleasedSurface(userId, "page.find");
      } catch {
        return toolError("research_company is not available here.");
      }
      const signal = AbortSignal.timeout(RESEARCH_TOOL_TIMEOUT_MS);
      try {
        const res = await researchCompany(
          userId,
          { name: args.name, domain: args.domain },
          { signal },
        );
        if (!res.ok) return toolError(res.message);
        const d = res.dossier;
        return {
          match: d.match,
          name: d.subject.name,
          website: d.website,
          description: d.description,
          headquarters: d.headquarters,
          founded: d.founded,
          size: d.size,
          news: d.news,
          people: d.people,
          sources: d.sources.slice(0, 5).map((s) => s.url),
          note:
            d.match === "confident"
              ? "From the public web. These people are not in the user's network."
              : "Not confirmed to be this company — report nothing as fact.",
        };
      } catch (err) {
        if (signal.aborted) return toolError(RESEARCH_TIMEOUT_MESSAGE);
        throw err;
      }
    },
  },

  {
    name: "find_people",
    title: "Find new people on the web",
    description:
      "Search the public web for people the user does NOT know yet who match a description — " +
      "a role, a company, a school, a place: \"product managers at Stripe who went to Michigan\". " +
      "Use it only when the user asks to find new people or people outside their network; for " +
      "who they already know, use search_contacts or who_do_i_know_at. Returns at most 10 " +
      "people, each with the page that shows the match and why they fit. It is never a complete " +
      "list — say so. It can take a while; if it times out, tell the user they can finish it on Find people.",
    inputSchema: {
      query: z.string().min(3).max(300).describe("Who to look for, in plain words."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    // Chat only, like research_person: reaching the web stays off MCP.
    surfaces: CHAT_ONLY,
    scope: "read",
    resultLabel: "web research",
    releasedSurface: "page.find",
    fields: {
      chat: ["query", "candidates", "note"],
    },
    async run(userId, args: { query: string }) {
      try {
        await requireReleasedSurface(userId, "page.find");
      } catch {
        return toolError("find_people is not available here.");
      }
      const signal = AbortSignal.timeout(RESEARCH_TOOL_TIMEOUT_MS);
      try {
        const res = await discoverPeople(userId, args.query, { signal });
        if (!res.ok) return toolError(res.message);
        return {
          query: res.result.query,
          candidates: res.result.candidates,
          note: "Found on the public web; not a complete list, and none of these people are in the user's network.",
        };
      } catch (err) {
        if (signal.aborted) return toolError(RESEARCH_TIMEOUT_MESSAGE);
        throw err;
      }
    },
  },

  {
    name: "list_open_commitments",
    title: "What the user owes",
    description:
      "Open promises and to-dos across the whole network: reminders that are overdue or due " +
      "today, reminders with no date, and action items taken from notes. Narrow to one " +
      "person with contactId. Use list_reminders for what is coming up later, and " +
      "due_followups for people going quiet.",
    inputSchema: {
      contactId: z.string().uuid().optional().describe("Only what is owed to this person."),
      limit: z.number().int().min(1).max(25).default(15),
    },
    annotations: { readOnlyHint: true },
    // Chat only, which is a deliberate narrowing of what the plan for this tool said.
    // An action item is text a model pulled OUT of a note, so a list of them across many
    // contacts is the same fan-out of attacker-writable text that keeps `search_notes` off
    // MCP — and the MCP surface already has `list_reminders` for the dated half of this.
    // (`list_reminders` does carry AI-drafted reminder titles over MCP today, which are
    // note-derived by the same route. That is worth a look, but widening it further here
    // is not the way to settle it.)
    surfaces: CHAT_ONLY,
    scope: "read",
    resultLabel: "commitments",
    fields: {
      chat: ["kind", "id", "contactId", "contactName", "text", "dueDate", "sourceId"],
    },
    async run(userId, args: { contactId?: string; limit: number }) {
      const db = await getDb();
      const inboxId = await getInboxListId(userId);
      // "today" is overdue AND today; "anytime" is the undated pile. Both are things the
      // user is already late on or has never scheduled — which is what "owe" means. What is
      // merely coming up is `list_reminders`, and it is a different question.
      const page = (view: "today" | "anytime") =>
        queryRemindersPage(
          db,
          userId,
          { view, listId: null, contactId: args.contactId, limit: args.limit, tz: "UTC" },
          { inboxId }
        );

      const [dueNow, undated, items] = await Promise.all([
        page("today"),
        page("anytime"),
        db
          .select({
            id: actionItems.id,
            text: actionItems.text,
            contactId: actionItems.contactId,
            contactName: contacts.fullName,
            interactionId: actionItems.interactionId,
          })
          .from(actionItems)
          .innerJoin(contacts, eq(contacts.id, actionItems.contactId))
          .where(
            and(
              eq(actionItems.userId, userId),
              eq(actionItems.status, "open"),
              ...(args.contactId ? [eq(actionItems.contactId, args.contactId)] : [])
            )
          )
          .orderBy(desc(actionItems.createdAt))
          .limit(args.limit),
      ]);

      const fromReminders = [...dueNow.items, ...undated.items].map((r) => ({
        kind: "reminder" as const,
        id: r.id,
        contactId: r.contactId,
        contactName: r.contactName,
        text: r.title,
        dueDate: r.dueDate,
        sourceId: null as string | null,
      }));
      const fromNotes = items.map((i) => ({
        kind: "action_item" as const,
        id: i.id,
        contactId: i.contactId,
        contactName: i.contactName,
        text: i.text,
        dueDate: null,
        // The interaction it was taken from, so an answer can point at the note rather than
        // assert the promise on its own authority.
        sourceId: i.interactionId,
      }));

      // Dated first and soonest first — the overdue ones — then everything with no date.
      const dated = fromReminders.filter((r) => r.dueDate);
      const rest = [...fromReminders.filter((r) => !r.dueDate), ...fromNotes];
      dated.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
      return [...dated, ...rest].slice(0, args.limit);
    },
  },

  /* ------------------------------------------------------------------ write tools -----
   *
   * MCP only, deliberately. Orbit's own chat proposes a write and a person commits it from
   * the transcript; it does not hold the commit itself. Giving the chat surface a write tool
   * would put a write one poisoned note away from happening, on the one surface where the
   * note is already in the prompt.
   */
  {
    name: "log_interaction",
    title: "Log an interaction",
    description:
      "Record that the user talked to someone — a meeting, a call, an email or a message.",
    inputSchema: {
      contactId: z.string().uuid(),
      notes: z.string().min(1).max(5000),
      interactionType: z.enum(["meeting", "email", "message", "call"]).default("message"),
      occurredAt: z.string().datetime().optional(),
      externalId: z.string().max(200).optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
    surfaces: MCP_ONLY,
    scope: "write",
    resultLabel: null,
    async run(
      userId,
      args: {
        contactId: string;
        notes: string;
        interactionType: "meeting" | "email" | "message" | "call";
        occurredAt?: string;
        externalId?: string;
      }
    ) {
      const contact = await ownedContact(userId, args.contactId);
      if (!contact) return toolError("No such contact.");

      const ctx = await openIngestContext(userId, {
        // Provenance, so the timeline can badge what an agent wrote.
        source: "mcp",
        createsContacts: false,
        matchConfidence: 0,
      });
      const stats = await ingestEvents(ctx, [
        {
          externalIdBase: `mcp:${args.externalId ?? `${args.contactId}:${Date.now()}`}`,
          type: args.interactionType,
          timestamp: args.occurredAt ? new Date(args.occurredAt) : new Date(),
          participants: [{ name: contact.fullName, email: contact.email }],
          notes: sanitizeAgentText(args.notes),
        },
      ]);
      await finalizeIngest(ctx);
      return { logged: stats.interactionsLogged > 0 };
    },
  },

  {
    name: "request_send",
    title: "Write an email for the user to send",
    description:
      "Draft an email and put it in front of the user for approval. THIS DOES NOT SEND " +
      "ANYTHING. The user reads the recipient and the message in Orbit and decides; tell " +
      "them the draft is waiting rather than implying it has gone out.",
    inputSchema: {
      to: z.string().email().describe("The recipient's email address."),
      subject: z.string().max(200).optional(),
      body: z.string().min(1).max(MAX_BODY_CHARS),
      contactId: z
        .string()
        .uuid()
        .optional()
        .describe("The Orbit contact this is for, when there is one."),
      clientName: z
        .string()
        .max(80)
        .optional()
        .describe("Your product's name, shown to the user on the approval card."),
    },
    // Not destructive and not idempotent: each call stages another draft, and nothing
    // leaves Orbit as a result of any of them.
    annotations: { destructiveHint: false, idempotentHint: false },
    surfaces: MCP_ONLY,
    scope: "write",
    resultLabel: null,
    async run(
      userId,
      args: { to: string; subject?: string; body: string; contactId?: string; clientName?: string }
    ) {
      let draft: Awaited<ReturnType<typeof createAgentSendRequest>>;
      try {
        draft = await createAgentSendRequest(userId, {
          toEmail: args.to,
          subject: args.subject,
          body: args.body,
          contactId: args.contactId,
          clientName: args.clientName,
        });
      } catch (err) {
        if (err instanceof AgentSendLimitError) {
          void recordAiSecurityEvent({ kind: "draft_flood", userId, surface: "mcp.request_send" });
          return toolError(err.message);
        }
        throw err;
      }
      return {
        status: "pending_approval",
        sent: false,
        draftId: draft.id,
        approveUrl: draft.approveUrl,
        expiresAt: draft.expiresAt.toISOString(),
        note: "Waiting for the user to approve it in Orbit. Nothing has been sent.",
      };
    },
  },

  {
    name: "get_send_status",
    title: "Check a draft",
    description:
      "Whether a draft from request_send is still waiting, was sent, or was turned down.",
    inputSchema: { draftId: z.string().uuid() },
    annotations: { readOnlyHint: true },
    surfaces: MCP_ONLY,
    scope: "write",
    resultLabel: null,
    async run(userId, args: { draftId: string }) {
      const draft = await getAgentSendRequest(userId, args.draftId);
      if (!draft) return toolError("No such draft.");
      return {
        draftId: draft.id,
        status: draft.status,
        to: draft.toEmail,
        subject: draft.subject,
        sentAt: draft.sentAt,
        error: draft.errorMessage,
      };
    },
  },

  {
    name: "update_contact",
    title: "Update a contact",
    description:
      "Change what Orbit knows about someone — their role, company, location, how the " +
      "user met them, or the notes on their profile.",
    inputSchema: {
      contactId: z.string().uuid(),
      fullName: z.string().min(1).max(200).optional(),
      company: z.string().max(200).optional(),
      title: z.string().max(200).optional(),
      location: z.string().max(200).optional(),
      email: z.string().email().optional(),
      linkedinUrl: z.string().max(500).optional(),
      notes: z.string().max(5000).optional().describe("Replaces the existing notes."),
      howMet: z.string().max(500).optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
    surfaces: MCP_ONLY,
    scope: "write",
    resultLabel: null,
    async run(
      userId,
      args: {
        contactId: string;
        fullName?: string;
        company?: string;
        title?: string;
        location?: string;
        email?: string;
        linkedinUrl?: string;
        notes?: string;
        howMet?: string;
      }
    ) {
      const { contactId, ...raw } = args;
      const existing = await ownedContact(userId, contactId);
      if (!existing) return toolError("No such contact.");
      // Every field cleaned, not only the prose ones: a name, title or company is read into
      // Orbit's chat prompt as a row, and a link ends up in an `href`.
      const { fields, badUrl } = cleanAgentContactFields(raw);
      if (badUrl) return toolError("linkedinUrl must be an http(s) URL.");

      // An allowlist, spelled out field by field rather than spread from the arguments.
      // The tool's own schema already bounds this, but `updateContactForUser` accepts a
      // much wider `ContactInput` — including fields an agent has no business setting —
      // and the next person to widen the schema should have to come here to do it.
      const patch = {
        ...(fields.fullName !== undefined ? { fullName: fields.fullName } : {}),
        ...(fields.company !== undefined ? { company: fields.company } : {}),
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.location !== undefined ? { location: fields.location } : {}),
        ...(fields.email !== undefined ? { email: fields.email } : {}),
        ...(fields.linkedinUrl !== undefined ? { linkedinUrl: fields.linkedinUrl } : {}),
        ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
        ...(fields.howMet !== undefined ? { howMet: fields.howMet } : {}),
      };
      if (Object.keys(patch).length === 0) {
        return { updated: false, error: "Nothing to change." };
      }

      // `skipRevalidate` for the same reason as create_contact: a tool call has no page.
      await updateContactForUser(userId, contactId, patch, { skipRevalidate: true });
      return { updated: true, contactId, fields: Object.keys(patch) };
    },
  },

  {
    name: "add_note",
    title: "Add a note about someone",
    description:
      "Append a dated note to a person's timeline — something the user learned, said or " +
      "wants to remember. Use log_interaction instead when they actually spoke.",
    inputSchema: {
      contactId: z.string().uuid(),
      note: z.string().min(1).max(5000),
      occurredAt: z.string().datetime().optional(),
      externalId: z
        .string()
        .max(200)
        .optional()
        .describe("Pass a stable id to make a retry idempotent."),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
    surfaces: MCP_ONLY,
    scope: "write",
    resultLabel: null,
    async run(
      userId,
      args: { contactId: string; note: string; occurredAt?: string; externalId?: string }
    ) {
      const contact = await ownedContact(userId, args.contactId);
      if (!contact) return toolError("No such contact.");

      const { created } = await logNoteInteractionForUser(
        userId,
        {
          contactId: args.contactId,
          interactionType: "note",
          interactionDate: args.occurredAt ? new Date(args.occurredAt) : new Date(),
          rawNotes: sanitizeAgentText(args.note),
          source: "mcp",
          externalId: `mcp:note:${args.externalId ?? `${args.contactId}:${Date.now()}`}`,
        },
        { skipRevalidate: true }
      );
      return { added: created, contactId: args.contactId };
    },
  },

  {
    name: "create_reminder",
    title: "Create a reminder",
    description:
      "Add a to-do, optionally about a person and optionally with a due date. " +
      "Undated reminders live in Anytime.",
    inputSchema: {
      title: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      contactId: z.string().uuid().optional(),
      dueDate: z
        .string()
        .datetime()
        .optional()
        .describe("ISO timestamp. Omit for no date."),
    },
    annotations: { destructiveHint: false },
    surfaces: MCP_ONLY,
    scope: "write",
    resultLabel: null,
    async run(
      userId,
      args: { title: string; description?: string; contactId?: string; dueDate?: string }
    ) {
      if (args.contactId) {
        const contact = await ownedContact(userId, args.contactId);
        if (!contact) return toolError("No such contact.");
      }
      const row = await createReminderForUser(userId, {
        title: sanitizeAgentText(args.title),
        description: args.description ? sanitizeAgentText(args.description) : undefined,
        contactId: args.contactId,
        dueDate: args.dueDate,
        reminderType: "manual",
      });
      return { created: true, reminderId: row?.id ?? null };
    },
  },

  {
    name: "complete_reminder",
    title: "Complete a reminder",
    description: "Mark a reminder done. Find its id with list_reminders.",
    inputSchema: { reminderId: z.string().uuid() },
    // Not destructive: completing is reversible in the UI, and nothing is deleted.
    annotations: { destructiveHint: false, idempotentHint: true },
    surfaces: MCP_ONLY,
    scope: "write",
    resultLabel: null,
    async run(userId, args: { reminderId: string }) {
      const snapshot = await completeReminder(userId, args.reminderId);
      if (!snapshot) return toolError("No such reminder.");
      return { completed: true, reminderId: args.reminderId };
    },
  },

  {
    name: "snooze_reminder",
    title: "Snooze a reminder",
    description: "Push a reminder out by a number of days, from today.",
    inputSchema: {
      reminderId: z.string().uuid(),
      days: z.number().int().min(1).max(90).default(7),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
    surfaces: MCP_ONLY,
    scope: "write",
    resultLabel: null,
    async run(userId, args: { reminderId: string; days: number }) {
      const snapshot = await snoozeReminder(userId, args.reminderId, args.days);
      if (!snapshot) return toolError("No such reminder.");
      return { snoozed: true, reminderId: args.reminderId, days: args.days };
    },
  },

  {
    name: "schedule_follow_up",
    title: "Schedule a follow-up",
    description:
      "Put someone back on the user's calendar in a number of days. Reuses their pending " +
      "reminder if they already have one, rather than creating a second.",
    inputSchema: {
      contactId: z.string().uuid(),
      days: z.number().int().min(1).max(90).default(7),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
    surfaces: MCP_ONLY,
    scope: "write",
    resultLabel: null,
    async run(userId, args: { contactId: string; days: number }) {
      try {
        const result = await scheduleContactFollowUpForUser(userId, args.contactId, args.days);
        return {
          scheduled: true,
          contactId: args.contactId,
          dueDate: result.dueDate,
          reminderId: result.reminder?.id ?? null,
        };
      } catch {
        return toolError("No such contact.");
      }
    },
  },

  {
    name: "create_contact",
    title: "Add a contact",
    description:
      "Add someone new to the user's network. Checks for an existing match first and " +
      "refuses rather than creating a duplicate unless force is set.",
    inputSchema: {
      fullName: z.string().min(1).max(200),
      email: z.string().email().optional(),
      company: z.string().max(200).optional(),
      title: z.string().max(200).optional(),
      linkedinUrl: z.string().max(500).optional(),
      notes: z.string().max(5000).optional(),
      howMet: z.string().max(500).optional(),
      force: z.boolean().default(false),
    },
    annotations: { destructiveHint: false },
    surfaces: MCP_ONLY,
    scope: "write",
    resultLabel: null,
    async run(
      userId,
      args: {
        fullName: string;
        email?: string;
        company?: string;
        title?: string;
        linkedinUrl?: string;
        notes?: string;
        howMet?: string;
        force: boolean;
      }
    ) {
      const cleaned = cleanAgentContactFields({
        fullName: args.fullName,
        company: args.company,
        title: args.title,
        linkedinUrl: args.linkedinUrl,
        notes: args.notes,
        howMet: args.howMet,
      });
      if (cleaned.badUrl) return toolError("linkedinUrl must be an http(s) URL.");
      if (!cleaned.fields.fullName) return toolError("fullName is required.");
      args = { ...args, ...cleaned.fields, fullName: cleaned.fields.fullName };
      if (!args.force) {
        // Bounded the same way /api/v1/contacts is: an indexed `contact_identities`
        // lookup for the identifier tiers, then a narrow by-name scan — never a
        // `findMany` of every contact on the account on every single tool call.
        const best = await findConfidentDuplicate(userId, {
          fullName: args.fullName,
          email: args.email,
          linkedinUrl: args.linkedinUrl,
          company: args.company,
          title: args.title,
        });
        // Same line as /api/v1/contacts: confident tiers match, a bare full name does not.
        if (best && best.confidence >= DUPLICATE_MERGE_CONFIDENCE) {
          return {
            created: false,
            matched: true,
            confidence: best.confidence,
            contactId: best.contact.id,
            name: best.contact.fullName,
            hint: "Pass force:true to create anyway.",
          };
        }
      }

      try {
        const created = await createContactForUser(
          userId,
          {
            fullName: args.fullName,
            email: args.email,
            company: args.company,
            title: args.title,
            linkedinUrl: args.linkedinUrl,
            notes: args.notes || undefined,
            howMet: args.howMet || undefined,
            source: "mcp",
          },
          // A tool call has no page to revalidate, and the `(app)` group is already
          // force-dynamic — see the identical fix on /api/v1/contacts.
          { skipRevalidate: true }
        );
        return { created: true, contactId: created.id, name: created.fullName };
      } catch (err) {
        // A paywall refusal is information the agent can act on, not a crash.
        return {
          created: false,
          error: err instanceof Error ? err.message : "Could not create contact.",
        };
      }
    },
  },
];
