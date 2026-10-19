/**
 * Read tools added with the chat answer loop (docs/superpowers/plans/2026-10-19-chat-agent.md,
 * Phase 1): exact counts and breakdowns over contacts and interactions, and one door into
 * each feature chat could not see before — events, opportunities, radar, outreach,
 * recruiters, the knowledge dossier, sent email, captures and imports.
 *
 * Chat only for now: MCP gets these once each has an MCP field allowlist (Phase 4). Every
 * one is read-only, user-scoped by the lib function it wraps, and returns no raw note text.
 */
import { z } from "zod";
import {
  CONTACT_GROUPS,
  CONTACT_SORTS,
  queryContacts,
  type ContactMissingField,
} from "@/lib/hybrid-search";
import { INTERACTION_GROUPS, queryInteractions } from "@/lib/interaction-queries";
import type { OrbitTool } from "@/lib/tools/registry";

const CHAT_ONLY = ["chat"] as const;
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const few = (max = 4) => z.array(z.string().min(1).max(80)).max(max).optional();

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
    surfaces: CHAT_ONLY,
    scope: "read",
    resultLabel: "contacts",
    fields: { chat: ["total", "groups", "rows"] },
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
    surfaces: CHAT_ONLY,
    scope: "read",
    resultLabel: "interactions",
    fields: { chat: ["total", "groups", "rows"] },
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
];
