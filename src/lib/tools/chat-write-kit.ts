/**
 * The shared shape of a chat write (@/lib/tools/chat-writes and its feature catalog,
 * @/lib/tools/chat-writes-features): the types every entry fills in and the small helpers they
 * build inputs and previews from. Split out so the two catalogs share them without importing
 * each other.
 */
import { z, type ZodRawShape } from "zod";
import { sanitizeAgentText } from "@/lib/mcp/sanitize";

/** Ids the turn has seen, by kind — what a proposal may name. Names, where known, for previews. */
export type ProposalScope = {
  contacts: ReadonlyMap<string, string>;
  reminders: ReadonlyMap<string, string>;
  events: ReadonlyMap<string, string>;
  attendees: ReadonlyMap<string, string>;
  actionItems: ReadonlyMap<string, string>;
  goals: ReadonlyMap<string, string>;
  opportunities: ReadonlyMap<string, string>;
  recommendations: ReadonlyMap<string, string>;
  campaigns: ReadonlyMap<string, string>;
  outreachMessages: ReadonlyMap<string, string>;
  recruiters: ReadonlyMap<string, string>;
  meetings: ReadonlyMap<string, string>;
  calendarEvents: ReadonlyMap<string, string>;
};

/** The kinds `ProposalScope` holds — for code that builds an empty one. */
export const SCOPE_KINDS = [
  "contacts",
  "reminders",
  "events",
  "attendees",
  "actionItems",
  "goals",
  "opportunities",
  "recommendations",
  "campaigns",
  "outreachMessages",
  "recruiters",
  "meetings",
  "calendarEvents",
] as const satisfies ReadonlyArray<keyof ProposalScope>;

/** An inverse a done card can run, stored on the proposal. Never offered to a model. */
export type UndoStep = { tool: string; input: Record<string, unknown> };

/** One inverse, by name: what `runUndo` calls. */
export type UndoFn = (userId: string, input: Record<string, unknown>) => Promise<void>;

export type CommitOutcome = {
  resultId: string | null;
  /** Where the card's "View" goes. */
  href: string | null;
  undo: UndoStep | null;
};

export type ChatWrite = {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  tier: "auto" | "confirm";
  /**
   * A tier that depends on the input — `update_recruiter_link` applies a status change itself
   * but asks before it writes notes. Never looser than `tier` should read.
   */
  tierFor?(input: Record<string, unknown>): "auto" | "confirm";
  destructive?: boolean;
  /**
   * The card opens a dialog instead of committing (`draft_email` opens the Gmail send dialog;
   * its own Send is the only send). Never auto-applied.
   */
  opensDialog?: "gmail_send";
  /** Every id the input names, by kind; each must be in the turn's `ProposalScope`. */
  refs(input: Record<string, unknown>): Partial<Record<keyof ProposalScope, string[]>>;
  /** The card's sentence. Built from the input and the scope's names, never from model prose. */
  preview(input: Record<string, unknown>, scope: ProposalScope): string;
  /** The contact the card shows, when there is one. */
  contactOf?(input: Record<string, unknown>): string | null;
  /**
   * The input as it is stored, once the card's sentence is written: a wall-clock time the
   * model gave in the user's zone becomes the instant it names, so the commit needs no zone.
   */
  normalize?(input: Record<string, unknown>, ctx: { timeZone: string }): Record<string, unknown>;
  commit(userId: string, input: Record<string, unknown>, ref: { messageId: string; actionId: string }): Promise<CommitOutcome>;
};

export const uuid = z.string().uuid();
export const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Use YYYY-MM-DD.");
/** Free text a write will store: sanitized the way every agent-written field is. */
export const text = (s: unknown, max: number) => sanitizeAgentText(String(s ?? "")).slice(0, max).trim();
export const s = (v: unknown) => (typeof v === "string" ? v : "");
export const name = (map: ReadonlyMap<string, string>, id: unknown, fallback: string) => map.get(s(id)) ?? fallback;
export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** The tier a proposal with this input gets. */
export const tierOf = (write: ChatWrite, input: Record<string, unknown>) => write.tierFor?.(input) ?? write.tier;
