/**
 * Read tools added with the chat answer loop (docs/superpowers/plans/2026-10-19-chat-agent.md,
 * Phase 1): exact counts and breakdowns over contacts and interactions, and one door into
 * each feature chat could not see before — events, opportunities, radar, outreach,
 * recruiters, the knowledge dossier, sent email, captures and imports.
 *
 * On both surfaces since Phase 4, each with an MCP field allowlist written next to it. Every
 * one is read-only, user-scoped by the lib function it wraps, and returns no raw note text; a
 * tool behind a page that can ship closed (`releasedSurface`) is offered to an outside agent
 * only once that page is released to the user, exactly as in chat (`releasedToolsFor`).
 */
import { z } from "zod";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactOpportunities,
  contacts,
  emailSends,
  imports,
  outreachCampaigns,
  outreachMessages,
  outreachProspects,
  userRecruiterLinks,
} from "@/db/schema";
import { listCaptureHistoryFor } from "@/lib/capture-history";
import { getEventForUser, listEventsForUser, listRosterForUser } from "@/lib/events/store";
import { listEventsTogetherForContact } from "@/lib/events/people-store";
import { whoToTalkTo } from "@/lib/events/who-to-talk-to";
import { loadKnowledgeDossier } from "@/lib/knowledge-dossier";
import { campaignMetricAggregates, metricsFromAggregates } from "@/lib/outreach-metrics-sql";
import { listPendingRecommendations } from "@/lib/radar/store";
import { leadReason } from "@/lib/radar/types";
import { toolError } from "@/lib/tools/registry";
import {
  CONTACT_GROUPS,
  CONTACT_SORTS,
  queryContacts,
  type ContactMissingField,
} from "@/lib/hybrid-search";
import { INTERACTION_GROUPS, queryInteractions } from "@/lib/interaction-queries";
import type { OrbitTool } from "@/lib/tools/registry";

const BOTH = ["mcp", "chat"] as const;
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const few = (max = 4) => z.array(z.string().min(1).max(80)).max(max).optional();
const day = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : null);

export const FEATURE_TOOLS: OrbitTool[] = [
  {
    name: "query_contacts",
    title: "Count and list contacts",
    description:
      "Exact counts and lists over the whole network by what Orbit records about people. Use it " +
      "for how many, who was added when, who has never been contacted, who is missing an email " +
      "or company, and breakdowns (group_by company, industry, tag, tier, school or location). " +
      "With no filters it covers everyone. limit 0 returns only the count and groups. " +
      "interacted_after/before limits to people the user was in touch with in that window.",
    inputSchema: {
      companies: few(),
      industries: few(),
      schools: few(),
      locations: few(8),
      tags: few(),
      tiers: z.array(z.enum(["inner", "mid", "outer"])).max(3).optional().describe("Closeness tiers."),
      added_after: isoDay.optional(),
      added_before: isoDay.optional(),
      interacted_after: isoDay.optional(),
      interacted_before: isoDay.optional(),
      never_interacted: z.boolean().optional(),
      missing: z.array(z.enum(["email", "phone", "company", "title", "linkedin"])).max(5).optional(),
      sort: z.enum(CONTACT_SORTS).optional(),
      group_by: z.enum(CONTACT_GROUPS).optional(),
      limit: z.number().int().min(0).max(50).default(20),
    },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "contacts",
    fields: { chat: ["total", "groups", "rows"], mcp: ["total", "groups", "rows"] },
    async run(
      userId,
      args: {
        companies?: string[];
        industries?: string[];
        schools?: string[];
        locations?: string[];
        tags?: string[];
        tiers?: Array<"inner" | "mid" | "outer">;
        added_after?: string;
        added_before?: string;
        interacted_after?: string;
        interacted_before?: string;
        never_interacted?: boolean;
        missing?: ContactMissingField[];
        sort?: (typeof CONTACT_SORTS)[number];
        group_by?: (typeof CONTACT_GROUPS)[number];
        limit: number;
      }
    ) {
      return queryContacts(userId, {
        filters: {
          companies: args.companies,
          industries: args.industries,
          schools: args.schools,
          locations: args.locations,
          tags: args.tags,
          closenessTiers: args.tiers,
        },
        window:
          args.interacted_after || args.interacted_before
            ? { mode: "interacted", after: args.interacted_after, before: args.interacted_before }
            : null,
        addedAfter: args.added_after,
        addedBefore: args.added_before,
        neverInteracted: args.never_interacted,
        missing: args.missing,
        sort: args.sort,
        groupBy: args.group_by,
        limit: args.limit,
      });
    },
  },

  {
    name: "query_interactions",
    title: "Count and list interactions",
    description:
      "Exact counts and lists of logged interactions (notes, coffees, meetings, calls, emails, " +
      "messages) across the whole network or with one person: how many in a period, who the " +
      "user saw most, a month-by-month breakdown (group_by type, month, contact or source). " +
      "Rows carry a short summary, not the full note — use search_notes for what was said. " +
      "limit 0 returns only the count and groups.",
    inputSchema: {
      contactId: z.string().uuid().optional(),
      types: z.array(z.string().min(1).max(30)).max(8).optional().describe("e.g. coffee, meeting, call, email, note."),
      source: z.string().max(40).optional().describe("Where it came from, e.g. gmail, linkedin, calendar, chat_proposed."),
      after: isoDay.optional(),
      before: isoDay.optional(),
      group_by: z.enum(INTERACTION_GROUPS).optional(),
      limit: z.number().int().min(0).max(50).default(20),
    },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "interactions",
    fields: { chat: ["total", "groups", "rows"], mcp: ["total", "groups", "rows"] },
    async run(
      userId,
      args: {
        contactId?: string;
        types?: string[];
        source?: string;
        after?: string;
        before?: string;
        group_by?: (typeof INTERACTION_GROUPS)[number];
        limit: number;
      }
    ) {
      return queryInteractions(userId, {
        contactId: args.contactId,
        types: args.types,
        source: args.source,
        after: args.after,
        before: args.before,
        groupBy: args.group_by,
        limit: args.limit,
      });
    },
  },
  /* ------------------------------------------------------------------- events ----- */
  {
    name: "list_events",
    title: "List events",
    description:
      "The user's events (conferences, meetups, mixers) from Orbit's events page: upcoming, " +
      "past or both, with how many are on each roster and how many of those are already " +
      "contacts. Use an event's id with get_event_roster or who_to_talk_to.",
    inputSchema: {
      when: z.enum(["upcoming", "past", "all"]).default("all"),
      limit: z.number().int().min(1).max(20).default(10),
    },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "events",
    fields: { mcp: ["id", "title", "date", "venue", "city", "hosted", "rosterSize", "inYourContacts"] },
    releasedSurface: "page.events",
    async run(userId, args: { when: "upcoming" | "past" | "all"; limit: number }) {
      const rows = await listEventsForUser(userId, args.limit, args.when === "all" ? {} : { when: args.when });
      return rows.map((e) => ({
        id: e.id,
        title: e.title,
        date: day(e.startsAt),
        venue: e.venue,
        city: e.city,
        hosted: e.role === "hosted",
        rosterSize: e.attendeeCount,
        inYourContacts: e.connectedCount,
      }));
    },
  },

  {
    name: "get_event_roster",
    title: "Who is at an event",
    description:
      "The roster of one event: each person's attendeeId, name, company, title, role, whether " +
      "the user marked that they spoke to them, and their contact id when they are already a contact. " +
      "Filter to the people the user spoke to, or to people already in their contacts.",
    inputSchema: {
      eventId: z.string().uuid(),
      spoke_to: z.boolean().optional().describe("Only people the user did (true) or did not (false) speak to."),
      in_contacts: z.boolean().optional().describe("Only people already in (true) or not in (false) the user's contacts."),
      limit: z.number().int().min(1).max(100).default(50),
    },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "people",
    fields: { mcp: ["event", "total", "people"] },
    releasedSurface: "page.events",
    async run(userId, args: { eventId: string; spoke_to?: boolean; in_contacts?: boolean; limit: number }) {
      const event = await getEventForUser(userId, args.eventId);
      if (!event) return toolError("No event with that id.");
      const roster = (await listRosterForUser(userId, args.eventId)).filter(
        (r) =>
          (args.spoke_to === undefined || r.spokeTo === args.spoke_to) &&
          (args.in_contacts === undefined || Boolean(r.contactId) === args.in_contacts)
      );
      return {
        event: { id: event.id, title: event.title, date: day(event.startsAt) },
        total: roster.length,
        people: roster.slice(0, args.limit).map((r) => ({
          // For mark_spoke_to: a roster row is named by its own id, contact or not.
          attendeeId: r.id,
          name: r.fullName,
          company: r.company,
          title: r.title,
          role: r.attendeeRole,
          spokeTo: r.spokeTo,
          contactId: r.contactId,
        })),
      };
    },
  },

  {
    name: "who_to_talk_to",
    title: "Who to talk to at an event",
    description:
      "Orbit's ranking of the people on one event's roster worth meeting (upcoming) or following " +
      "up with (past), with the reasons — the same list the event page shows.",
    inputSchema: {
      eventId: z.string().uuid(),
      limit: z.number().int().min(1).max(10).default(5),
    },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "people",
    fields: { mcp: ["event", "when", "people"] },
    releasedSurface: "page.events",
    async run(userId, args: { eventId: string; limit: number }) {
      const event = await getEventForUser(userId, args.eventId);
      if (!event) return toolError("No event with that id.");
      const ranked = await whoToTalkTo(userId, event, { limit: args.limit });
      return {
        event: { id: event.id, title: event.title, date: day(event.startsAt) },
        when: ranked.when,
        people: ranked.rows.map((r) => ({
          attendeeId: r.attendeeId,
          name: r.name,
          company: r.company,
          title: r.title,
          contactId: r.contactId,
          priority: r.bucket,
          why: r.reasons.map((reason) => reason.label).slice(0, 3),
        })),
      };
    },
  },

  {
    name: "events_with_contact",
    title: "Events shared with someone",
    description: "Every event a contact was on the roster of, newest first, and whether the user spoke to them there.",
    inputSchema: { contactId: z.string().uuid() },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "events",
    fields: { mcp: ["eventId", "title", "date", "spokeTo"] },
    releasedSurface: "page.events",
    async run(userId, args: { contactId: string }) {
      const rows = await listEventsTogetherForContact(userId, args.contactId);
      return rows.map((e) => ({ eventId: e.eventId, title: e.title, date: day(e.startsAt), spokeTo: e.spokeTo }));
    },
  },

  /* --------------------------------------------------------- opportunities, radar ----- */
  {
    name: "list_opportunities",
    title: "Opportunities",
    description:
      "Opportunities Orbit tracks on people — referrals, intros, roles, investments, asks — " +
      "for one contact or across the network, open by default, with any due date.",
    inputSchema: {
      contactId: z.string().uuid().optional(),
      status: z.enum(["open", "all"]).default("open"),
      limit: z.number().int().min(1).max(30).default(15),
    },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "opportunities",
    fields: { mcp: ["id", "contactId", "contactName", "kind", "label", "status", "direction", "dueDate"] },
    async run(userId, args: { contactId?: string; status: "open" | "all"; limit: number }) {
      const db = await getDb();
      const rows = await db
        .select({
          id: contactOpportunities.id,
          contactId: contactOpportunities.contactId,
          contactName: contacts.fullName,
          kind: contactOpportunities.kind,
          label: contactOpportunities.label,
          status: contactOpportunities.status,
          direction: contactOpportunities.direction,
          dueDate: contactOpportunities.dueDate,
        })
        .from(contactOpportunities)
        .innerJoin(contacts, and(eq(contacts.id, contactOpportunities.contactId), eq(contacts.userId, userId)))
        .where(
          and(
            eq(contactOpportunities.userId, userId),
            ...(args.contactId ? [eq(contactOpportunities.contactId, args.contactId)] : []),
            ...(args.status === "open" ? [eq(contactOpportunities.status, "open")] : [])
          )
        )
        .orderBy(sql`${contactOpportunities.dueDate} asc nulls last`, desc(contactOpportunities.createdAt))
        .limit(args.limit);
      return rows.map((r) => ({ ...r, dueDate: day(r.dueDate) }));
    },
  },

  {
    name: "list_radar_cards",
    title: "Radar suggestions",
    description:
      "Who Orbit's radar currently suggests reaching out to, and why — job changes, news, " +
      "events, going quiet, goals — the same cards the radar page shows.",
    inputSchema: { limit: z.number().int().min(1).max(10).default(5) },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "suggestions",
    fields: { mcp: ["id", "contactId", "name", "company", "kind", "priority", "why"] },
    releasedSurface: "page.radar",
    async run(userId, args: { limit: number }) {
      const cards = await listPendingRecommendations(userId, args.limit);
      return cards.map((c) => ({
        // The card's own id: what schedule/snooze/dismiss_recommendation name.
        id: c.id,
        contactId: c.contactId,
        name: c.contactName,
        company: c.company,
        kind: c.kind,
        priority: c.bucket,
        why: c.aiAngle ?? leadReason(c.reasons)?.label ?? null,
      }));
    },
  },

  /* ----------------------------------------------------------- outreach, recruiters ----- */
  {
    name: "list_campaigns",
    title: "Outreach campaigns",
    description: "The user's outreach campaigns with their status and counts: prospects, drafts, sent, replies.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "campaigns",
    fields: { mcp: ["id", "name", "status", "updated", "metrics"] },
    releasedSurface: "page.outreach",
    async run(userId) {
      const db = await getDb();
      const rows = await db
        .select({
          id: outreachCampaigns.id,
          name: outreachCampaigns.name,
          status: outreachCampaigns.status,
          updatedAt: outreachCampaigns.updatedAt,
          counts: campaignMetricAggregates(new Date()),
        })
        .from(outreachCampaigns)
        .leftJoin(outreachProspects, eq(outreachProspects.campaignId, outreachCampaigns.id))
        .leftJoin(outreachMessages, eq(outreachMessages.prospectId, outreachProspects.id))
        .where(eq(outreachCampaigns.userId, userId))
        .groupBy(outreachCampaigns.id)
        .orderBy(desc(outreachCampaigns.updatedAt))
        .limit(20);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        updated: day(r.updatedAt),
        metrics: metricsFromAggregates(r.counts),
      }));
    },
  },

  {
    name: "list_outreach_messages",
    title: "A campaign's messages",
    description:
      "One outreach campaign's messages (campaign id from list_campaigns): each message's messageId, the prospect, " +
      "channel, step, status, outcome and current subject and text — so a draft can be edited or a reply logged.",
    inputSchema: {
      campaignId: z.string().uuid(),
      status: z.enum(["unsent", "sent", "all"]).default("all"),
      limit: z.number().int().min(1).max(40).default(20),
    },
    annotations: { readOnlyHint: true },
    // Chat only: a draft's text is the user's own, but this is not a door outside agents need.
    surfaces: ["chat"],
    scope: "read",
    resultLabel: "messages",
    releasedSurface: "page.outreach",
    async run(userId, args: { campaignId: string; status: "unsent" | "sent" | "all"; limit: number }) {
      const db = await getDb();
      const campaign = await db.query.outreachCampaigns.findFirst({
        where: and(eq(outreachCampaigns.id, args.campaignId), eq(outreachCampaigns.userId, userId)),
        columns: { id: true, name: true },
      });
      if (!campaign) return toolError("No campaign with that id.");
      const rows = await db
        .select({
          messageId: outreachMessages.id,
          prospect: outreachProspects.fullName,
          channel: outreachMessages.channel,
          step: outreachMessages.stepIndex,
          status: outreachMessages.status,
          outcome: outreachMessages.outcome,
          subject: outreachMessages.subject,
          body: outreachMessages.body,
        })
        .from(outreachMessages)
        .innerJoin(outreachProspects, eq(outreachProspects.id, outreachMessages.prospectId))
        .where(
          and(
            eq(outreachProspects.campaignId, campaign.id),
            ...(args.status === "sent" ? [eq(outreachMessages.status, "sent")] : []),
            ...(args.status === "unsent" ? [ne(outreachMessages.status, "sent")] : [])
          )
        )
        .orderBy(desc(outreachMessages.updatedAt))
        .limit(args.limit);
      return {
        campaign: { id: campaign.id, name: campaign.name },
        messages: rows.map((r) => ({ ...r, body: r.body.slice(0, 1500) })),
      };
    },
  },

  {
    name: "list_my_recruiters",
    title: "The user's recruiters",
    description: "Recruiters the user has logged: name, firm, specialty, the user's status with them and their own rating.",
    inputSchema: { limit: z.number().int().min(1).max(30).default(15) },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "recruiters",
    fields: { mcp: ["recruiterId", "name", "firm", "specialty", "status", "personalRating", "updated"] },
    releasedSurface: "page.recruiters",
    async run(userId, args: { limit: number }) {
      const db = await getDb();
      const links = await db.query.userRecruiterLinks.findMany({
        where: eq(userRecruiterLinks.userId, userId),
        with: { recruiter: { columns: { id: true, fullName: true, firm: true, specialty: true } } },
        orderBy: [desc(userRecruiterLinks.updatedAt)],
        limit: args.limit,
      });
      // Contact details stay behind the recruiters page's own unlock rules.
      return links.map((l) => ({
        recruiterId: l.recruiter.id,
        name: l.recruiter.fullName,
        firm: l.recruiter.firm,
        specialty: l.recruiter.specialty,
        status: l.status,
        personalRating: l.personalRating,
        updated: day(l.updatedAt),
      }));
    },
  },

  /* ---------------------------------------------------------------- knowledge ----- */
  {
    name: "get_dossier",
    title: "Relationship dossier",
    description:
      "Orbit's written brief on one relationship — where things stand, the suggested next step, " +
      "recent discussions, and which of the user's goals the person bears on.",
    inputSchema: { contactId: z.string().uuid() },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "dossier",
    releasedSurface: "page.knowledge",
    fields: { chat: ["contact", "brief", "goals", "stale"], mcp: ["contact", "brief", "goals", "stale"] },
    async run(userId, args: { contactId: string }) {
      const dossier = await loadKnowledgeDossier(userId, args.contactId);
      return dossier ?? toolError("No contact with that id.");
    },
  },

  /* ------------------------------------------------------- email, captures, imports ----- */
  {
    name: "list_sent_emails",
    title: "Emails sent from Orbit",
    description:
      "Emails the user sent, scheduled or queued from Orbit — to whom, subject, status and when — " +
      "for one contact or overall. Subjects only, never bodies.",
    inputSchema: {
      contactId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(20).default(10),
    },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "emails",
    fields: { mcp: ["to", "subject", "status", "date", "from"] },
    async run(userId, args: { contactId?: string; limit: number }) {
      const db = await getDb();
      const rows = await db
        .select({
          to: emailSends.to,
          subject: emailSends.subject,
          status: emailSends.status,
          sendAt: emailSends.sendAt,
          sentAt: emailSends.sentAt,
          origin: emailSends.origin,
        })
        .from(emailSends)
        .where(
          and(
            eq(emailSends.userId, userId),
            ...(args.contactId ? [sql`${emailSends.contactIds} @> ${JSON.stringify([args.contactId])}::jsonb`] : [])
          )
        )
        .orderBy(desc(emailSends.sendAt))
        .limit(args.limit);
      return rows.map((r) => ({
        to: r.to,
        subject: r.subject,
        status: r.status,
        date: day(r.sentAt ?? r.sendAt),
        from: r.origin,
      }));
    },
  },

  {
    name: "recent_captures",
    title: "Recent captures",
    description:
      "What the user recently captured — notes, photos, business cards, voice — with how many " +
      "people and reminders each one saved.",
    inputSchema: { limit: z.number().int().min(1).max(10).default(5) },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "captures",
    // A capture's title and excerpt are its raw text: they stay in Orbit's own chat, behind
    // its fence, and never fan out to an outside agent across several captures at once.
    fields: { mcp: ["date", "status", "kinds", "people", "reminders"] },
    releasedSurface: "page.capture",
    async run(userId, args: { limit: number }) {
      const page = await listCaptureHistoryFor(userId, { limit: args.limit });
      return page.items.map((c) => ({
        date: c.createdAt.slice(0, 10),
        status: c.status,
        kinds: c.kinds,
        title: c.title,
        excerpt: c.excerpt.slice(0, 200),
        people: c.peopleCount,
        reminders: c.reminderCount,
      }));
    },
  },

  {
    name: "recent_imports",
    title: "Recent imports",
    description: "The user's recent imports (LinkedIn, CSV, calendar, Google, Outlook, chats): what, when, status and how many contacts each added.",
    inputSchema: { limit: z.number().int().min(1).max(10).default(5) },
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "imports",
    fields: { mcp: ["type", "fileName", "status", "createdAt", "contactsCreated"] },
    releasedSurface: "page.imports",
    async run(userId, args: { limit: number }) {
      const db = await getDb();
      const rows = await db
        .select({
          type: imports.importType,
          fileName: imports.fileName,
          status: imports.status,
          createdAt: imports.createdAt,
          contactsCreated: imports.contactsCreated,
        })
        .from(imports)
        .where(and(eq(imports.userId, userId), ne(imports.status, "staging")))
        .orderBy(desc(imports.createdAt))
        .limit(args.limit);
      return rows.map((r) => ({ ...r, createdAt: day(r.createdAt) }));
    },
  },
];
