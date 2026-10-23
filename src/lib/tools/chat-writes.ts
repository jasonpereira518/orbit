/**
 * Every change Orbit's chat can make — for contacts, reminders and events — as a catalog the
 * answer loop offers as tools, and the confirm card commits.
 *
 * THE WRITE INVARIANT. No write here runs from a model's tool call. In the loop, each entry is
 * offered as a PROPOSER (`proposerTools`): its schema is what the model fills in, and its run
 * only stores a validated proposal on the turn — the same "an agent composes, a person
 * commits" rule as the top of `src/lib/mcp/server.ts`. `commit` runs later, from
 * `commitProposedAction` (@/actions/chat-actions), on the row that was stored, after a
 * person's click, re-validated against the schema and scoped to the caller by the lib
 * function it calls. The registry still refuses every `write` tool on the chat surface; these
 * never appear in `ORBIT_TOOLS` at all.
 *
 * A proposal is admitted only when every id it names was in front of the model this turn —
 * in the prompt or in a lookup's result (`ProposalScope`). A note that tells the model to
 * "delete contact 1234" names an id the turn never saw, and is dropped.
 *
 * Each entry says how far it reaches:
 *   - `tier: "auto"`: additive or reversible, with an undo — Phase 3 may apply these itself
 *     for an account that opts in. Until then every proposal waits for a click.
 *   - `tier: "confirm"`: always a click.
 *   - `destructive`: the card says what will be lost; there is no undo.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { setActionItemStatusForUser } from "@/lib/action-items";
import { deleteContactForUser } from "@/lib/contact-delete";
import { findConfidentDuplicate } from "@/lib/contact-resolve";
import {
  createContactForUser,
  deleteInteractionForUser,
  logNoteInteractionForUser,
  updateContactForUser,
} from "@/lib/contact-writes";
import { DUPLICATE_MERGE_CONFIDENCE } from "@/lib/duplicates";
import { UserFacingError } from "@/lib/errors";
import { toolError, type OrbitTool } from "@/lib/tools/registry";
import {
  isoDay,
  name,
  plural,
  s,
  text,
  uuid,
  type ChatWrite,
  type ProposalScope,
  type UndoFn,
  type UndoStep,
} from "@/lib/tools/chat-write-kit";
import { FEATURE_UNDO, FEATURE_WRITES } from "@/lib/tools/chat-writes-features";
import { createEventForUser, deleteEventForUser, getEventForUser, setSpokeToForUser } from "@/lib/events/store";
import { createReminderForUser, scheduleContactFollowUpForUser } from "@/lib/reminder-writes";
import {
  completeReminder,
  dismissReminder,
  reopenReminder,
  restoreDismissedReminder,
  snoozeReminder,
  snoozeReminderTo,
  unsnoozeReminder,
  type CompletionSnapshot,
  type DismissSnapshot,
  type SnoozeSnapshot,
} from "@/lib/reminders";

export type { ChatWrite, CommitOutcome, ProposalScope, UndoStep } from "@/lib/tools/chat-write-kit";

/** A due date inside the window `createReminderForUser` accepts, as ISO, or null. */
function dueWithinYear(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const now = Date.now();
  if (d.getTime() < now - 86_400_000 || d.getTime() > now + 365 * 86_400_000) return null;
  return d.toISOString();
}

async function ownedContact(userId: string, contactId: string) {
  const db = await getDb();
  return db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: {
      id: true,
      fullName: true,
      title: true,
      company: true,
      location: true,
      howMet: true,
      email: true,
      phone: true,
      linkedinUrl: true,
      notes: true,
    },
    with: { contactTags: { with: { tag: { columns: { name: true } } } } },
  });
}

/** The contact fields `update_contact` may set, input key → `ContactInput` key. */
const CONTACT_FIELDS = {
  title: "title",
  company: "company",
  location: "location",
  how_met: "howMet",
  email: "email",
  phone: "phone",
  linkedin_url: "linkedinUrl",
} as const;
/** A change to one of these always asks — they are how Orbit tells people apart. */
const IDENTITY_FIELDS = new Set(["email", "phone", "linkedin_url"]);
const FIELD_LABEL: Record<keyof typeof CONTACT_FIELDS, string> = {
  title: "title",
  company: "company",
  location: "location",
  how_met: "how you met",
  email: "email",
  phone: "phone",
  linkedin_url: "LinkedIn",
};

/* ------------------------------------------------------------------- the catalog ----- */

const CORE_WRITES: readonly ChatWrite[] = [
  // ------------------------------------------------------------------- contacts
  {
    name: "log_note",
    title: "Log a note",
    description:
      "Propose logging a dated note on a contact's timeline — something that happened or was " +
      "said. The user confirms it before it is written.",
    inputSchema: { contactId: uuid, text: z.string().min(1).max(2000) },
    tier: "auto",
    refs: (i) => ({ contacts: [s(i.contactId)] }),
    contactOf: (i) => s(i.contactId),
    preview: (i, sc) => `Log a note on ${name(sc.contacts, i.contactId, "this contact")}: “${text(i.text, 500)}”`,
    async commit(userId, i, ref) {
      const contactId = s(i.contactId);
      const { row } = await logNoteInteractionForUser(
        userId,
        {
          contactId,
          rawNotes: text(i.text, 2000),
          source: "chat_proposed",
          externalId: `chat:${ref.messageId}:${ref.actionId}`,
          direction: "out",
        },
        { skipRevalidate: true }
      );
      return { resultId: row.id, href: `/contacts/${contactId}`, undo: { tool: "delete_interaction", input: { interactionId: row.id } } };
    },
  },
  {
    name: "update_contact",
    title: "Update a contact",
    description:
      "Propose changing what Orbit records about a contact: title, company, location, how you " +
      "met, email, phone, LinkedIn, or a dated line appended to their notes. Only the fields " +
      "the user said changed. The user confirms it first.",
    inputSchema: {
      contactId: uuid,
      title: z.string().max(200).optional(),
      company: z.string().max(200).optional(),
      location: z.string().max(200).optional(),
      how_met: z.string().max(500).optional(),
      email: z.string().email().max(320).optional(),
      phone: z.string().max(40).optional(),
      linkedin_url: z.string().url().max(500).optional(),
      notes_append: z.string().max(2000).optional().describe("Added to the end of their notes, dated. Never replaces them."),
    },
    tier: "confirm",
    refs: (i) => ({ contacts: [s(i.contactId)] }),
    contactOf: (i) => s(i.contactId),
    preview(i, sc) {
      const changes = (Object.keys(CONTACT_FIELDS) as Array<keyof typeof CONTACT_FIELDS>)
        .filter((k) => typeof i[k] === "string" && i[k])
        .map((k) => `${FIELD_LABEL[k]} → “${text(i[k], 200)}”`);
      if (typeof i.notes_append === "string" && i.notes_append) changes.push(`add to notes: “${text(i.notes_append, 200)}”`);
      return `Update ${name(sc.contacts, i.contactId, "this contact")}: ${changes.join(", ") || "nothing"}`;
    },
    async commit(userId, i) {
      const contactId = s(i.contactId);
      const before = await ownedContact(userId, contactId);
      if (!before) throw new UserFacingError("That contact is gone — it may have been deleted");
      const patch: Record<string, string> = {};
      const previous: Record<string, string | null> = {};
      for (const [key, column] of Object.entries(CONTACT_FIELDS)) {
        if (typeof i[key] !== "string" || !i[key]) continue;
        patch[column] = text(i[key], key === "how_met" ? 500 : 500);
        previous[column] = (before as Record<string, unknown>)[column] as string | null;
      }
      if (typeof i.notes_append === "string" && i.notes_append) {
        const day = new Date().toISOString().slice(0, 10);
        const line = `[${day}] ${text(i.notes_append, 2000)}`;
        patch.notes = before.notes?.trim() ? `${before.notes.trimEnd()}\n\n${line}` : line;
        previous.notes = before.notes ?? null;
      }
      if (!Object.keys(patch).length) throw new UserFacingError("Nothing to change");
      await updateContactForUser(userId, contactId, patch, { skipRevalidate: true });
      return { resultId: contactId, href: `/contacts/${contactId}`, undo: { tool: "restore_contact_fields", input: { contactId, fields: previous } } };
    },
  },
  {
    name: "add_tags",
    title: "Tag a contact",
    description: "Propose adding tags to a contact (existing tags stay). The user confirms it first.",
    inputSchema: { contactId: uuid, tags: z.array(z.string().min(1).max(40)).min(1).max(5) },
    tier: "auto",
    refs: (i) => ({ contacts: [s(i.contactId)] }),
    contactOf: (i) => s(i.contactId),
    preview: (i, sc) =>
      `Tag ${name(sc.contacts, i.contactId, "this contact")} ${(Array.isArray(i.tags) ? i.tags : []).map((t) => `“${text(t, 40)}”`).join(", ")}`,
    async commit(userId, i) {
      const contactId = s(i.contactId);
      const before = await ownedContact(userId, contactId);
      if (!before) throw new UserFacingError("That contact is gone — it may have been deleted");
      const current = before.contactTags.map((ct) => ct.tag.name);
      const added = (Array.isArray(i.tags) ? i.tags : []).map((t) => text(t, 40)).filter(Boolean);
      const next = [...new Set([...current, ...added])];
      await updateContactForUser(userId, contactId, { tagNames: next }, { skipRevalidate: true });
      return { resultId: contactId, href: `/contacts/${contactId}`, undo: { tool: "restore_tags", input: { contactId, tags: current } } };
    },
  },
  {
    name: "remove_tags",
    title: "Remove tags from a contact",
    description: "Propose removing tags from a contact. The user confirms it first.",
    inputSchema: { contactId: uuid, tags: z.array(z.string().min(1).max(40)).min(1).max(5) },
    tier: "confirm",
    refs: (i) => ({ contacts: [s(i.contactId)] }),
    contactOf: (i) => s(i.contactId),
    preview: (i, sc) =>
      `Remove ${(Array.isArray(i.tags) ? i.tags : []).map((t) => `“${text(t, 40)}”`).join(", ")} from ${name(sc.contacts, i.contactId, "this contact")}`,
    async commit(userId, i) {
      const contactId = s(i.contactId);
      const before = await ownedContact(userId, contactId);
      if (!before) throw new UserFacingError("That contact is gone — it may have been deleted");
      const current = before.contactTags.map((ct) => ct.tag.name);
      const drop = new Set((Array.isArray(i.tags) ? i.tags : []).map((t) => text(t, 40).toLowerCase()));
      await updateContactForUser(userId, contactId, { tagNames: current.filter((t) => !drop.has(t.toLowerCase())) }, { skipRevalidate: true });
      return { resultId: contactId, href: `/contacts/${contactId}`, undo: { tool: "restore_tags", input: { contactId, tags: current } } };
    },
  },
  {
    name: "create_contact",
    title: "Add a contact",
    description:
      "Propose adding someone the user says they met to their contacts — never a person from " +
      "the lists. A confident duplicate is refused when the user confirms.",
    inputSchema: {
      full_name: z.string().min(1).max(200),
      title: z.string().max(200).optional(),
      company: z.string().max(200).optional(),
      email: z.string().email().max(320).optional(),
      how_met: z.string().max(500).optional(),
    },
    tier: "confirm",
    refs: () => ({}),
    preview(i) {
      const role = [text(i.title, 200), text(i.company, 200)].filter(Boolean).join(" @ ");
      return `Add ${text(i.full_name, 200)}${role ? ` (${role})` : ""} to your contacts`;
    },
    async commit(userId, i) {
      const fields = {
        fullName: text(i.full_name, 200),
        ...(i.title ? { title: text(i.title, 200) } : {}),
        ...(i.company ? { company: text(i.company, 200) } : {}),
        ...(i.email ? { email: s(i.email).trim() } : {}),
        ...(i.how_met ? { howMet: text(i.how_met, 500) } : {}),
      };
      const best = await findConfidentDuplicate(userId, fields);
      if (best && best.confidence >= DUPLICATE_MERGE_CONFIDENCE) {
        throw new UserFacingError(`${best.contact.fullName} is already in your contacts`);
      }
      const created = await createContactForUser(userId, { ...fields, source: "chat_proposed" }, { skipRevalidate: true });
      return { resultId: created.id, href: `/contacts/${created.id}`, undo: { tool: "delete_created_contact", input: { contactId: created.id } } };
    },
  },
  {
    name: "delete_contact",
    title: "Delete a contact",
    description:
      "Propose deleting a contact and everything Orbit holds on them. Only when the user asks " +
      "for exactly that. Cannot be undone.",
    inputSchema: { contactId: uuid },
    tier: "confirm",
    destructive: true,
    refs: (i) => ({ contacts: [s(i.contactId)] }),
    contactOf: (i) => s(i.contactId),
    preview: (i, sc) =>
      `Delete ${name(sc.contacts, i.contactId, "this contact")} and their notes, reminders and history. This cannot be undone.`,
    async commit(userId, i) {
      const { deleted } = await deleteContactForUser(userId, s(i.contactId));
      if (!deleted) throw new UserFacingError("That contact is gone — it may have been deleted");
      return { resultId: null, href: "/contacts", undo: null };
    },
  },
  {
    name: "complete_action_item",
    title: "Tick off a commitment",
    description: "Propose marking an open action item from the user's notes as done, by its item_id.",
    inputSchema: { actionItemId: uuid },
    tier: "auto",
    refs: (i) => ({ actionItems: [s(i.actionItemId)] }),
    preview: (i, sc) => `Mark “${name(sc.actionItems, i.actionItemId, "this commitment")}” done`,
    async commit(userId, i) {
      const row = await setActionItemStatusForUser(userId, s(i.actionItemId), "done");
      if (!row) throw new UserFacingError("That item is gone — it may have been deleted");
      return { resultId: s(i.actionItemId), href: null, undo: { tool: "reopen_action_item", input: { actionItemId: s(i.actionItemId) } } };
    },
  },

  // ------------------------------------------------------------------ reminders
  {
    name: "create_reminder",
    title: "Set a reminder",
    description:
      "Propose a reminder, optionally about a contact and with a due date (ISO). The user " +
      "confirms it first.",
    inputSchema: {
      title: z.string().min(1).max(200),
      contactId: uuid.optional(),
      description: z.string().max(2000).optional(),
      due_date: z.string().max(40).optional().describe("ISO date or date-time, within a year."),
    },
    tier: "auto",
    refs: (i) => ({ contacts: i.contactId ? [s(i.contactId)] : [] }),
    contactOf: (i) => (i.contactId ? s(i.contactId) : null),
    preview(i, sc) {
      const due = dueWithinYear(i.due_date);
      const who = i.contactId ? ` — ${name(sc.contacts, i.contactId, "this contact")}` : "";
      return `Remind you: ${text(i.title, 200)}${who}${due ? ` by ${due.slice(0, 10)}` : ""}`;
    },
    async commit(userId, i) {
      const row = await createReminderForUser(userId, {
        title: text(i.title, 200),
        contactId: i.contactId ? s(i.contactId) : undefined,
        description: i.description ? text(i.description, 2000) : undefined,
        dueDate: dueWithinYear(i.due_date) ?? undefined,
        reminderType: "manual",
      });
      if (!row) throw new UserFacingError("Couldn’t set that reminder");
      return { resultId: row.id, href: "/reminders", undo: { tool: "dismiss_created_reminder", input: { reminderId: row.id } } };
    },
  },
  {
    name: "complete_reminder",
    title: "Complete a reminder",
    description: "Propose marking one of the user's reminders done, by its reminder_id.",
    inputSchema: { reminderId: uuid },
    tier: "auto",
    refs: (i) => ({ reminders: [s(i.reminderId)] }),
    preview: (i, sc) => `Mark “${name(sc.reminders, i.reminderId, "this reminder")}” done`,
    async commit(userId, i) {
      const snap = await completeReminder(userId, s(i.reminderId));
      if (!snap) throw new UserFacingError("That reminder is gone — it may have been deleted");
      return { resultId: s(i.reminderId), href: "/reminders", undo: { tool: "reopen_reminder", input: { snapshot: snap } } };
    },
  },
  {
    name: "snooze_reminder",
    title: "Snooze a reminder",
    description: "Propose pushing one of the user's reminders back a number of days (1–90).",
    inputSchema: { reminderId: uuid, days: z.number().int().min(1).max(90) },
    tier: "auto",
    refs: (i) => ({ reminders: [s(i.reminderId)] }),
    preview: (i, sc) => `Snooze “${name(sc.reminders, i.reminderId, "this reminder")}” for ${plural(Number(i.days), "day")}`,
    async commit(userId, i) {
      const snap = await snoozeReminder(userId, s(i.reminderId), Number(i.days));
      if (!snap) throw new UserFacingError("That reminder is gone — it may have been deleted");
      return { resultId: s(i.reminderId), href: "/reminders", undo: { tool: "unsnooze_reminder", input: { snapshot: snap } } };
    },
  },
  {
    name: "reschedule_reminder",
    title: "Move a reminder to a date",
    description: "Propose moving one of the user's reminders to a specific day (YYYY-MM-DD, within a year).",
    inputSchema: { reminderId: uuid, due_date: isoDay },
    tier: "auto",
    refs: (i) => ({ reminders: [s(i.reminderId)] }),
    preview: (i, sc) => `Move “${name(sc.reminders, i.reminderId, "this reminder")}” to ${s(i.due_date).slice(0, 10)}`,
    async commit(userId, i) {
      const due = dueWithinYear(`${s(i.due_date).slice(0, 10)}T12:00:00Z`);
      if (!due) throw new UserFacingError("That date is outside the next year");
      const snap = await snoozeReminderTo(userId, s(i.reminderId), new Date(due));
      if (!snap) throw new UserFacingError("That reminder is gone — it may have been deleted");
      return { resultId: s(i.reminderId), href: "/reminders", undo: { tool: "unsnooze_reminder", input: { snapshot: snap } } };
    },
  },
  {
    name: "delete_reminder",
    title: "Delete a reminder",
    description: "Propose deleting one of the user's reminders, by its reminder_id. Only when asked.",
    inputSchema: { reminderId: uuid },
    tier: "confirm",
    refs: (i) => ({ reminders: [s(i.reminderId)] }),
    preview: (i, sc) => `Delete the reminder “${name(sc.reminders, i.reminderId, "this reminder")}”`,
    async commit(userId, i) {
      const snap = await dismissReminder(userId, s(i.reminderId));
      if (!snap) throw new UserFacingError("That reminder is gone — it may have been deleted");
      return { resultId: null, href: "/reminders", undo: { tool: "restore_reminder", input: { snapshot: snap } } };
    },
  },
  {
    name: "schedule_follow_up",
    title: "Schedule a follow-up",
    description: "Propose a follow-up with a contact in a number of days (1–90).",
    inputSchema: { contactId: uuid, days: z.number().int().min(1).max(90) },
    tier: "confirm",
    refs: (i) => ({ contacts: [s(i.contactId)] }),
    contactOf: (i) => s(i.contactId),
    preview: (i, sc) => `Schedule a follow-up with ${name(sc.contacts, i.contactId, "this contact")} in ${plural(Number(i.days), "day")}`,
    async commit(userId, i) {
      const result = await scheduleContactFollowUpForUser(userId, s(i.contactId), Number(i.days));
      return { resultId: result.reminder?.id ?? null, href: "/reminders", undo: null };
    },
  },

  // --------------------------------------------------------------------- events
  {
    name: "create_event",
    title: "Add an event",
    description:
      "Propose adding an event the user is going to or went to: title, day, venue and city. " +
      "No link — Orbit does not fetch pages a chat names.",
    inputSchema: {
      title: z.string().min(1).max(200),
      starts_on: isoDay.optional(),
      venue: z.string().max(200).optional(),
      city: z.string().max(120).optional(),
    },
    tier: "confirm",
    refs: () => ({}),
    preview(i) {
      const where = [text(i.venue, 200), text(i.city, 120)].filter(Boolean).join(", ");
      return `Add the event “${text(i.title, 200)}”${i.starts_on ? ` on ${s(i.starts_on).slice(0, 10)}` : ""}${where ? ` at ${where}` : ""}`;
    },
    async commit(userId, i) {
      const startsAt = i.starts_on ? new Date(`${s(i.starts_on).slice(0, 10)}T12:00:00Z`) : null;
      const row = await createEventForUser(userId, {
        title: text(i.title, 200),
        startsAt: startsAt && !Number.isNaN(startsAt.getTime()) ? startsAt : null,
        venue: i.venue ? text(i.venue, 200) : null,
        city: i.city ? text(i.city, 120) : null,
      });
      return { resultId: row.id, href: `/events/${row.id}`, undo: { tool: "delete_created_event", input: { eventId: row.id } } };
    },
  },
  {
    name: "mark_spoke_to",
    title: "Mark who the user spoke to",
    description:
      "Propose marking people on an event's roster as people the user spoke to, by the " +
      "attendeeId values get_event_roster returns.",
    inputSchema: { eventId: uuid, attendeeIds: z.array(uuid).min(1).max(20) },
    tier: "auto",
    refs: (i) => ({ events: [s(i.eventId)], attendees: (Array.isArray(i.attendeeIds) ? i.attendeeIds : []).map(s) }),
    preview(i, sc) {
      const ids = (Array.isArray(i.attendeeIds) ? i.attendeeIds : []).map(s);
      const names = ids.map((id) => sc.attendees.get(id) ?? "someone").slice(0, 4);
      const more = ids.length > names.length ? ` and ${ids.length - names.length} more` : "";
      return `Mark that you spoke to ${names.join(", ")}${more} at ${name(sc.events, i.eventId, "this event")}`;
    },
    async commit(userId, i) {
      const eventId = s(i.eventId);
      const attendeeIds = (Array.isArray(i.attendeeIds) ? i.attendeeIds : []).map(s);
      // The write below is scoped to the user's own rows already; this makes another account's
      // event (or a deleted one) a refusal rather than a "done" that changed nothing.
      if (!(await getEventForUser(userId, eventId))) throw new UserFacingError("That event is gone — it may have been deleted");
      await setSpokeToForUser(userId, eventId, attendeeIds, true);
      return { resultId: eventId, href: `/events/${eventId}`, undo: { tool: "unmark_spoke_to", input: { eventId, attendeeIds } } };
    },
  },
  {
    name: "delete_event",
    title: "Delete an event",
    description: "Propose deleting one of the user's events and its roster. Only when asked. Cannot be undone.",
    inputSchema: { eventId: uuid },
    tier: "confirm",
    destructive: true,
    refs: (i) => ({ events: [s(i.eventId)] }),
    preview: (i, sc) => `Delete the event “${name(sc.events, i.eventId, "this event")}” and its roster. This cannot be undone.`,
    async commit(userId, i) {
      await deleteEventForUser(userId, s(i.eventId));
      return { resultId: null, href: "/events", undo: null };
    },
  },
];

/** Every change chat can make: the core catalog above and the feature writes. */
export const CHAT_WRITES: readonly ChatWrite[] = [...CORE_WRITES, ...FEATURE_WRITES];

/* ------------------------------------------------------------------------ undo ----- */

const CORE_UNDO = {
  async delete_interaction(userId: string, input: Record<string, unknown>) {
    await deleteInteractionForUser(userId, s(input.interactionId), { skipRevalidate: true });
  },
  async restore_contact_fields(userId: string, input: Record<string, unknown>) {
    const fields = (input.fields ?? {}) as Record<string, string | null>;
    // A field that was empty before goes back to empty, not to the proposed value.
    const patch = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v ?? ""]));
    await updateContactForUser(userId, s(input.contactId), patch, { skipRevalidate: true });
  },
  async restore_tags(userId: string, input: Record<string, unknown>) {
    const tags = Array.isArray(input.tags) ? input.tags.map(s) : [];
    await updateContactForUser(userId, s(input.contactId), { tagNames: tags }, { skipRevalidate: true });
  },
  async delete_created_contact(userId: string, input: Record<string, unknown>) {
    await deleteContactForUser(userId, s(input.contactId));
  },
  async reopen_action_item(userId: string, input: Record<string, unknown>) {
    await setActionItemStatusForUser(userId, s(input.actionItemId), "open");
  },
  async dismiss_created_reminder(userId: string, input: Record<string, unknown>) {
    await dismissReminder(userId, s(input.reminderId));
  },
  async reopen_reminder(userId: string, input: Record<string, unknown>) {
    const { restored } = await reopenReminder(userId, input.snapshot as CompletionSnapshot);
    if (!restored) throw new UserFacingError("That reminder has changed since — open it to undo by hand");
  },
  async unsnooze_reminder(userId: string, input: Record<string, unknown>) {
    const { restored } = await unsnoozeReminder(userId, input.snapshot as SnoozeSnapshot);
    if (!restored) throw new UserFacingError("That reminder has changed since — open it to undo by hand");
  },
  async restore_reminder(userId: string, input: Record<string, unknown>) {
    const { restored } = await restoreDismissedReminder(userId, input.snapshot as DismissSnapshot);
    if (!restored) throw new UserFacingError("That reminder has changed since — open it to undo by hand");
  },
  async delete_created_event(userId: string, input: Record<string, unknown>) {
    await deleteEventForUser(userId, s(input.eventId));
  },
  async unmark_spoke_to(userId: string, input: Record<string, unknown>) {
    await setSpokeToForUser(userId, s(input.eventId), (Array.isArray(input.attendeeIds) ? input.attendeeIds : []).map(s), false);
  },
} as const;

const UNDO: Record<string, UndoFn> = { ...CORE_UNDO, ...FEATURE_UNDO };

export type UndoName = keyof typeof UNDO;

export function chatWriteNamed(toolName: string): ChatWrite | undefined {
  return CHAT_WRITES.find((w) => w.name === toolName);
}

/** Validate stored input against the write's own schema again — a row is data, not trusted. */
export function parseWriteInput(write: ChatWrite, input: unknown): Record<string, unknown> | null {
  const parsed = z.object(write.inputSchema).safeParse(input);
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}

export async function runUndo(userId: string, step: UndoStep): Promise<void> {
  const fn = UNDO[step.tool];
  if (!fn) throw new UserFacingError("That can’t be undone from here");
  await fn(userId, step.input ?? {});
}

/** True when the input touches a field Orbit uses to tell people apart. */
export function touchesIdentity(write: ChatWrite, input: Record<string, unknown>): boolean {
  return write.name === "update_contact" && [...IDENTITY_FIELDS].some((k) => typeof input[k] === "string" && input[k]);
}

/* ------------------------------------------------------------ the MCP face ----- */

/**
 * The catalog writes an outside agent may make over MCP that it could not before (`docs/mcp-vision.md`:
 * read broadly, write carefully, never delete), with the descriptions an agent reads. They run
 * the catalog's own commit — same validation, same ownership checks — directly, as MCP writes
 * always have; nothing here proposes. Left out: every delete and `remove_tags` (MCP never
 * removes anything — `smoke-mcp-server` holds that line), the writes MCP
 * already has under its own tools (`log_interaction`, `update_contact`, `create_reminder`,
 * `complete_reminder`, `snooze_reminder`, `schedule_follow_up`, `create_contact`), and
 * `complete_action_item`, since no MCP read returns an action item's id.
 */
const MCP_WRITE_DESCRIPTIONS: Record<string, string> = {
  add_tags: "Add up to 5 tags to one of the user's contacts, by contactId. A tag the user does not have yet is created.",
  reschedule_reminder:
    "Move one of the user's reminders (reminderId from list_reminders) to a day in the next year, as YYYY-MM-DD.",
  create_event:
    "Add an event the user is going to or went to: title, day (YYYY-MM-DD), venue and city. There is no link field: " +
    "Orbit does not fetch pages an agent names.",
  mark_spoke_to:
    "Mark that the user spoke to people at one of their events, by eventId and the attendeeIds get_event_roster returned.",
};

export const MCP_CHAT_WRITE_TOOLS: readonly OrbitTool[] = CHAT_WRITES.filter((w) => w.name in MCP_WRITE_DESCRIPTIONS).map(
  (write): OrbitTool => ({
    name: write.name,
    title: write.title,
    description: MCP_WRITE_DESCRIPTIONS[write.name],
    inputSchema: write.inputSchema,
    surfaces: ["mcp"],
    scope: "write",
    resultLabel: null,
    async run(userId, args: Record<string, unknown>) {
      try {
        const out = await write.commit(userId, args, { messageId: "mcp", actionId: randomUUID() });
        return { done: true, ...(out.resultId ? { id: out.resultId } : {}) };
      } catch (err) {
        if (err instanceof UserFacingError) return toolError(err.message);
        throw err;
      }
    },
  })
);
