/**
 * Chat-proposed actions: the model suggests logging a note, setting a reminder or scheduling
 * a follow-up; a person's click is what actually does it. Never the other way around — see the
 * rule at the top of `src/lib/mcp/server.ts`, which applies here in full. Chat's tool registry
 * stays read-only by construction (`surfaces: MCP_ONLY` on every write tool); this is the one
 * path from a chat answer to a write, and it goes through a stored proposal a human confirms,
 * never through a tool call the model itself can trigger.
 *
 * Pure: validation only. The write itself (`commitProposedAction` in `@/actions/chat-actions`)
 * re-validates everything here again against the database before it runs — this module bounds
 * what the model's OWN JSON is allowed to shape, not what ends up committed.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sanitizeAgentText } from "@/lib/mcp/sanitize";

const MAX_ACTIONS = 3;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const RawShape = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("log_interaction"),
    contact_id: z.string(),
    text: z.string().min(1),
  }),
  z.object({
    kind: z.literal("create_reminder"),
    contact_id: z.string().nullish(),
    title: z.string().min(1),
    description: z.string().nullish(),
    due_date: z.string().nullish(),
  }),
  z.object({
    kind: z.literal("schedule_follow_up"),
    contact_id: z.string(),
    days: z.number().nullish(),
  }),
]);

export type ProposedActionArgs =
  | { kind: "log_interaction"; contactId: string; text: string }
  | { kind: "create_reminder"; contactId: string | null; title: string; description: string | null; dueDate: string | null }
  | { kind: "schedule_follow_up"; contactId: string; days: number };

export type ProposedAction = {
  /** Minted here, never taken from the model — the commit action addresses a proposal by this. */
  id: string;
  args: ProposedActionArgs;
  /** The exact text or plain-language summary the confirm card shows. Never re-derived later. */
  preview: string;
  status: "proposed";
};

/**
 * What actually lives in `chat_messages.proposed_actions`, after a proposal has possibly been
 * acted on. `committing` is the claimed-but-not-yet-settled state a single CAS update passes
 * through — see `@/actions/chat-actions` — and should never be visible for more than the
 * length of one write; a row stuck there is evidence of a crashed commit, not a valid state
 * to build UI around.
 */
export type StoredProposedAction = Omit<ProposedAction, "status"> & {
  status: "proposed" | "committing" | "done" | "dismissed" | "failed";
  /** The reminder or interaction id the commit produced, once it has. */
  resultId?: string | null;
};

/** A valid ISO day/date-time within the window `createReminderForUser` itself would accept. */
function validDueDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const now = Date.now();
  if (d.getTime() < now - 24 * 60 * 60 * 1000 || d.getTime() > now + ONE_YEAR_MS) return null;
  return d.toISOString();
}

function preview(args: ProposedActionArgs, contactName: string | null): string {
  const who = contactName ?? "this contact";
  switch (args.kind) {
    case "log_interaction":
      return `Log a note on ${who}: “${args.text}”`;
    case "create_reminder":
      return args.contactId
        ? `Remind you to ${args.title.toLowerCase().startsWith("follow") ? args.title : `${args.title.toLowerCase()}`} — ${who}${args.dueDate ? ` by ${args.dueDate.slice(0, 10)}` : ""}`
        : `Remind you: ${args.title}${args.dueDate ? ` by ${args.dueDate.slice(0, 10)}` : ""}`;
    case "schedule_follow_up":
      return `Schedule a follow-up with ${who} in ${args.days} day${args.days === 1 ? "" : "s"}`;
  }
}

/**
 * Turn the model's raw `proposed_actions` JSON into proposals safe to store and show.
 *
 * `allowedContacts` is the SAME allowlist `filterRecommendations` closes over — a contact id
 * the model was not actually shown (budgeted-in, on a roster, or in the attention brief)
 * cannot appear in a proposal either. Unknown kinds, malformed shapes, forged ids, dates
 * outside a sane window and duplicates are all dropped rather than surfaced malformed; a
 * proposal is either something a person could reasonably click Confirm on, or it does not
 * exist.
 */
export function validateProposedActions(
  raw: unknown,
  allowedContacts: ReadonlySet<string>,
  contactNames: ReadonlyMap<string, string> = new Map()
): ProposedAction[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: ProposedAction[] = [];

  for (const item of list) {
    if (out.length >= MAX_ACTIONS) break;
    const parsed = RawShape.safeParse(item);
    if (!parsed.success) continue;
    const p = parsed.data;

    let args: ProposedActionArgs;
    if (p.kind === "log_interaction") {
      if (!allowedContacts.has(p.contact_id)) continue;
      const text = sanitizeAgentText(p.text).slice(0, 500);
      if (!text) continue;
      args = { kind: "log_interaction", contactId: p.contact_id, text };
    } else if (p.kind === "create_reminder") {
      if (p.contact_id && !allowedContacts.has(p.contact_id)) continue;
      const title = sanitizeAgentText(p.title).slice(0, 200);
      if (!title) continue;
      args = {
        kind: "create_reminder",
        contactId: p.contact_id ?? null,
        title,
        description: p.description ? sanitizeAgentText(p.description).slice(0, 2000) : null,
        dueDate: validDueDate(p.due_date),
      };
    } else {
      if (!allowedContacts.has(p.contact_id)) continue;
      const days = typeof p.days === "number" && Number.isFinite(p.days) ? Math.max(1, Math.min(90, Math.round(p.days))) : 7;
      args = { kind: "schedule_follow_up", contactId: p.contact_id, days };
    }

    // Dedupe on the shape of the write itself — the same reminder proposed twice in one
    // answer (a common model tic) shows once, not as two identical cards.
    const dedupeKey = JSON.stringify(args);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const contactId = "contactId" in args ? args.contactId : null;
    out.push({
      id: randomUUID(),
      args,
      preview: preview(args, contactId ? (contactNames.get(contactId) ?? null) : null),
      status: "proposed",
    });
  }

  return out;
}
