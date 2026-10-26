/**
 * Chat-proposed actions: the model proposes a change and a person's click is what actually makes
 * it. Never the other way around — see the rule at the top of `src/lib/mcp/server.ts`, which
 * applies here in full. Every proposal names one of the chat writes (`CHAT_WRITES` in
 * @/lib/tools/chat-writes) and is committed through that catalog entry by
 * `commitProposedAction` (@/actions/chat-actions), from the stored input, re-validated.
 *
 * This module holds the stored shape, and `parseAnswerTail`: what the one-pass answer's JSON
 * tail may propose, bounded before it reaches the catalog. Pure.
 */
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
  z.object({
    kind: z.literal("update_contact"),
    contact_id: z.string(),
    title: z.string().nullish(),
    company: z.string().nullish(),
    location: z.string().nullish(),
    email: z.string().nullish(),
    how_met: z.string().nullish(),
  }),
  z.object({
    kind: z.literal("create_contact"),
    full_name: z.string().min(1),
    title: z.string().nullish(),
    company: z.string().nullish(),
    email: z.string().nullish(),
    how_met: z.string().nullish(),
  }),
  z.object({ kind: z.literal("complete_reminder"), reminder_id: z.string() }),
  z.object({ kind: z.literal("snooze_reminder"), reminder_id: z.string(), days: z.number().nullish() }),
]);

/**
 * A proposal: one of the chat writes (`CHAT_WRITES` in @/lib/tools/chat-writes), by name, and
 * the input it will be committed with. The answer loop makes these by calling the write
 * (`@/lib/tools/chat-proposals`); the one-pass answer's JSON tail is turned into the same shape
 * by `parseAnswerTail` below. Either way it is committed through the catalog entry, re-validated
 * against that entry's schema from the stored input.
 *
 * `kind` is always "tool". It is the stored format: rows written before every proposal was a
 * catalog write carried other kinds, and `scripts/migrate-legacy-chat-proposals.ts` rewrote them.
 */
export type ProposedActionArgs = { kind: "tool"; tool: string; input: Record<string, unknown> };

export type ProposedAction = {
  /** Minted by Orbit, never taken from the model — the commit action addresses a proposal by this. */
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
  /** `undoing` and `undone` only ever follow `done`, on a proposal whose commit left an `undo`. */
  status: "proposed" | "committing" | "done" | "dismissed" | "failed" | "undoing" | "undone";
  /** The id of the row the commit produced or changed, once it has. */
  resultId?: string | null;
  /** The inverse the done card's Undo runs, stored by the commit. */
  undo?: { tool: string; input: Record<string, unknown> } | null;
  /** Where the done card's "View" goes. */
  href?: string | null;
  /** Whether this may be applied without a click (Phase 3), or always asks. */
  tier?: "auto" | "confirm";
  /** The card warns, and there is no undo. */
  destructive?: boolean;
  /** The contact the card shows. */
  contactId?: string | null;
  /** Applied by chat itself under the person's auto-apply setting (`@/lib/chat-auto-apply`). */
  autoApplied?: boolean;
};

function clampDays(raw: number | null | undefined): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.min(90, Math.round(raw))) : 7;
}

/** A valid ISO day/date-time within the window `createReminderForUser` itself would accept. */
function validDueDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const now = Date.now();
  if (d.getTime() < now - 24 * 60 * 60 * 1000 || d.getTime() > now + ONE_YEAR_MS) return null;
  return d.toISOString();
}

/** A cleaned text field, or nothing: an empty string is never stored as a change. */
function clean(raw: string | null | undefined, max: number): string | undefined {
  const out = raw ? sanitizeAgentText(raw).slice(0, max).trim() : "";
  return out || undefined;
}

/** Each profile field the model offered, cleaned; a bad email is dropped, never stored half-valid. */
function contactFields(p: { title?: string | null; company?: string | null; location?: string | null; email?: string | null; how_met?: string | null }) {
  const out: Record<string, string> = {};
  const set = (key: string, value: string | undefined) => {
    if (value) out[key] = value;
  };
  set("title", clean(p.title, 200));
  set("company", clean(p.company, 200));
  set("location", clean(p.location, 200));
  set("how_met", clean(p.how_met, 500));
  if (p.email && z.string().email().safeParse(p.email.trim()).success) out.email = p.email.trim();
  return out;
}

/**
 * Turn the one-pass answer's raw `proposed_actions` JSON into chat-write proposals: which write,
 * and its input. `proposalsFromAnswerTail` (@/lib/tools/chat-proposals) then checks each against
 * its catalog entry and writes the card.
 *
 * `allowedContacts` is the SAME allowlist `filterRecommendations` closes over — a contact id
 * the model was not actually shown (budgeted-in, on a roster, or in the attention brief)
 * cannot appear in a proposal either. `reminders` is the same for reminder ids: the open
 * reminders the model was shown. Unknown kinds, malformed shapes, forged ids, dates outside a
 * sane window and duplicates are all dropped rather than surfaced malformed. Pure.
 */
export function parseAnswerTail(
  raw: unknown,
  allowedContacts: ReadonlySet<string>,
  reminders: ReadonlySet<string> = new Set()
): ProposedActionArgs[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: ProposedActionArgs[] = [];
  const tool = (name: string, input: Record<string, unknown>): ProposedActionArgs => ({ kind: "tool", tool: name, input });

  for (const item of list) {
    if (out.length >= MAX_ACTIONS) break;
    const parsed = RawShape.safeParse(item);
    if (!parsed.success) continue;
    const p = parsed.data;

    let args: ProposedActionArgs;
    if (p.kind === "log_interaction") {
      if (!allowedContacts.has(p.contact_id)) continue;
      const text = clean(p.text, 500);
      if (!text) continue;
      args = tool("log_note", { contactId: p.contact_id, text });
    } else if (p.kind === "create_reminder") {
      if (p.contact_id && !allowedContacts.has(p.contact_id)) continue;
      const title = clean(p.title, 200);
      if (!title) continue;
      const description = clean(p.description, 2000);
      const due = validDueDate(p.due_date);
      args = tool("create_reminder", {
        title,
        ...(p.contact_id ? { contactId: p.contact_id } : {}),
        ...(description ? { description } : {}),
        ...(due ? { due_date: due } : {}),
      });
    } else if (p.kind === "schedule_follow_up") {
      if (!allowedContacts.has(p.contact_id)) continue;
      args = tool("schedule_follow_up", { contactId: p.contact_id, days: clampDays(p.days) });
    } else if (p.kind === "update_contact") {
      if (!allowedContacts.has(p.contact_id)) continue;
      const fields = contactFields(p);
      if (!Object.keys(fields).length) continue;
      args = tool("update_contact", { contactId: p.contact_id, ...fields });
    } else if (p.kind === "create_contact") {
      const fullName = clean(p.full_name, 200);
      if (!fullName) continue;
      args = tool("create_contact", { full_name: fullName, ...contactFields({ ...p, location: null }) });
    } else if (p.kind === "complete_reminder") {
      if (!reminders.has(p.reminder_id)) continue;
      args = tool("complete_reminder", { reminderId: p.reminder_id });
    } else {
      if (!reminders.has(p.reminder_id)) continue;
      args = tool("snooze_reminder", { reminderId: p.reminder_id, days: clampDays(p.days) });
    }

    // Dedupe on the shape of the write itself — the same reminder proposed twice in one
    // answer (a common model tic) shows once, not as two identical cards.
    const dedupeKey = JSON.stringify(args);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(args);
  }

  return out;
}
