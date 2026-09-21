/**
 * The tools themselves. One list, read by the MCP server and by Orbit's own chat.
 *
 * ============================================================================
 * READ THE SECURITY COMMENT AT THE TOP OF `src/lib/mcp/server.ts` FIRST.
 * ============================================================================
 *
 * Its two rules bind every definition below: nothing here sends, fetches a URL or registers
 * a webhook, and nothing here approves a draft. `request_send` stages a row and returns
 * `pending_approval`; the send happens in `approveAgentSend`, which no tool, key or scope
 * reaches. If you are adding a tool, that comment is the thing to read first.
 *
 * Each `run` returns PLAIN DATA. Fencing, truncation and the per-surface field allowlist are
 * applied by the caller (`@/lib/tools/registry`), because they differ by surface and a tool
 * that decided its own presentation would have to know who was asking.
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactions } from "@/db/schema";
import { hybridSearchContacts } from "@/lib/hybrid-search";
import { findOrgRosters } from "@/lib/chat-roster";
import { getDashboardData } from "@/lib/reminders";
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
import {
  createAgentSendRequest,
  getAgentSendRequest,
  MAX_BODY_CHARS,
} from "@/lib/agent-sends";
import { toolError, type OrbitTool } from "@/lib/tools/registry";

const BOTH = ["mcp", "chat"] as const;
const MCP_ONLY = ["mcp"] as const;

/** One contact the user owns, or nothing. The tenant check every contact-scoped tool starts with. */
async function ownedContact(userId: string, contactId: string) {
  const db = await getDb();
  return db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { id: true, fullName: true, email: true },
  });
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
      mcp: ["id", "name", "company", "title", "location", "closenessTier", "relevance", "summary"],
      chat: [
        "id", "name", "company", "title", "location", "closenessTier", "relevance", "summary",
        "notes",
      ],
    },
    async run(userId, args: { query: string; limit: number }) {
      const ranked = await hybridSearchContacts(userId, {
        query: args.query,
        limit: args.limit,
      });
      return ranked.map((c) => ({
        id: c.id,
        name: c.fullName,
        company: c.company,
        title: c.title,
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
      // Scoped by userId as well as id: an id is guessable in principle, and this is the
      // one tool that returns free-text notes.
      const contact = await db.query.contacts.findFirst({
        where: and(eq(contacts.id, args.contactId), eq(contacts.userId, userId)),
      });
      if (!contact) return toolError("No such contact.");

      const recent = await db.query.interactions.findMany({
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
      });

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
    // Read-only BY CONSTRUCTION: it reads getDashboardData, not generateDueFollowUps,
    // which creates reminders. A tool named like a reader that writes is how an agent
    // surprises the person it is working for.
    annotations: { readOnlyHint: true },
    surfaces: BOTH,
    scope: "read",
    resultLabel: "followups",
    async run(userId, args: { limit: number }) {
      const data = await getDashboardData(userId);
      return data.dueFollowUps.slice(0, args.limit).map((c) => ({
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
      const [stats, dashboard] = await Promise.all([
        getNetworkStats(userId),
        getDashboardData(userId),
      ]);
      // The headline copy is written for a dashboard card ("Gravity well detected"), which
      // would read as nonsense quoted back by an assistant. Only the numbers cross over.
      return {
        stats: stats.items.map((i) => ({ label: i.label, value: i.value })),
        dueFollowUpCount: dashboard.dueFollowUps.length,
        recentContacts: dashboard.dueFollowUps.slice(0, 5).map((c) => ({
          contactId: c.id,
          name: c.fullName,
          company: c.company,
        })),
      };
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
      const draft = await createAgentSendRequest(userId, {
        toEmail: args.to,
        subject: args.subject,
        body: args.body,
        contactId: args.contactId,
        clientName: args.clientName,
      });
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
      const { contactId, ...fields } = args;
      const existing = await ownedContact(userId, contactId);
      if (!existing) return toolError("No such contact.");

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
        ...(fields.notes !== undefined ? { notes: sanitizeAgentText(fields.notes) } : {}),
        ...(fields.howMet !== undefined ? { howMet: sanitizeAgentText(fields.howMet) } : {}),
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
            notes: args.notes ? sanitizeAgentText(args.notes) : undefined,
            howMet: args.howMet ? sanitizeAgentText(args.howMet) : undefined,
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
