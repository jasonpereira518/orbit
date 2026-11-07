/**
 * Rewriting stored chat proposals from the shape they had before every proposal was a chat
 * write (`CHAT_WRITES` in src/lib/tools/chat-writes.ts) into that shape, so the app no longer
 * carries a second commit path or a second card for them. Shared by the one-off
 * `scripts/migrate-legacy-chat-proposals.ts` and its smoke.
 *
 * A legacy proposal named its write by `args.kind` and carried camelCase fields
 * (`{ kind: "update_contact", contactId, fields: { howMet } }`). Each kind maps onto one
 * catalog write with the same effect. The id, preview and status a person saw are kept, and a
 * done card keeps the "View" link it had; it gains no Undo, since its commit stored none.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../../src/db";
import type { StoredProposedAction } from "../../src/lib/chat-proposed-actions";
import { chatWriteNamed } from "../../src/lib/tools/chat-writes";
import { tierOf } from "../../src/lib/tools/chat-write-kit";

type LegacyFields = Partial<Record<"title" | "company" | "location" | "email" | "howMet", string>>;

type LegacyArgs =
  | { kind: "log_interaction"; contactId: string; text: string }
  | { kind: "create_reminder"; contactId: string | null; title: string; description: string | null; dueDate: string | null }
  | { kind: "schedule_follow_up"; contactId: string; days: number }
  | { kind: "update_contact"; contactId: string; fields: LegacyFields }
  | { kind: "create_contact"; fullName: string; fields: LegacyFields }
  | { kind: "complete_reminder"; reminderId: string }
  | { kind: "snooze_reminder"; reminderId: string; days: number };

/** The legacy profile fields as the catalog's `update_contact` / `create_contact` name them. */
function fieldsInput(fields: LegacyFields | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof value === "string" && value) out[key === "howMet" ? "how_met" : key] = value;
  }
  return out;
}

/** The catalog write and input for one legacy proposal, and where its done card linked. */
function translate(args: LegacyArgs, resultId: string | null): { tool: string; input: Record<string, unknown>; href: string | null } | null {
  switch (args.kind) {
    case "log_interaction":
      return { tool: "log_note", input: { contactId: args.contactId, text: args.text }, href: null };
    case "create_reminder":
      return {
        tool: "create_reminder",
        input: {
          title: args.title,
          ...(args.contactId ? { contactId: args.contactId } : {}),
          ...(args.description ? { description: args.description } : {}),
          ...(args.dueDate ? { due_date: args.dueDate } : {}),
        },
        href: "/reminders",
      };
    case "schedule_follow_up":
      return { tool: "schedule_follow_up", input: { contactId: args.contactId, days: args.days }, href: "/reminders" };
    case "update_contact":
      return { tool: "update_contact", input: { contactId: args.contactId, ...fieldsInput(args.fields) }, href: resultId ? `/contacts/${resultId}` : null };
    case "create_contact":
      return { tool: "create_contact", input: { full_name: args.fullName, ...fieldsInput(args.fields) }, href: resultId ? `/contacts/${resultId}` : null };
    case "complete_reminder":
      return { tool: "complete_reminder", input: { reminderId: args.reminderId }, href: "/reminders" };
    case "snooze_reminder":
      return { tool: "snooze_reminder", input: { reminderId: args.reminderId, days: args.days }, href: "/reminders" };
    default:
      return null;
  }
}

/**
 * One stored proposal in the catalog shape: the same object when it already is one, null when
 * it is legacy of a kind this does not know (left as it is, and counted).
 */
export function migrateLegacyAction(action: StoredProposedAction): StoredProposedAction | null {
  const args = action.args as { kind?: string };
  if (args?.kind === "tool") return action;
  const resultId = action.resultId ?? null;
  const target = translate(action.args as unknown as LegacyArgs, resultId);
  const write = target ? chatWriteNamed(target.tool) : undefined;
  if (!target || !write) return null;
  const contactId = write.contactOf?.(target.input) ?? null;
  return {
    ...action,
    args: { kind: "tool", tool: target.tool, input: target.input },
    tier: tierOf(write, target.input),
    destructive: false,
    contactId,
    href: action.status === "done" ? target.href : null,
    undo: null,
  };
}

export type MigrationStats = {
  messagesSeen: number;
  messagesRewritten: number;
  proposalsConverted: number;
  /** Legacy proposals of a kind nobody knows, left as they were. */
  unknown: number;
  /** Messages whose proposals changed between the read and the write (a click); the next run picks them up. */
  conflicts: number;
};

const BATCH = 200;

/**
 * Rewrite every chat message that still holds a legacy proposal. Each row is replaced only if
 * its `proposed_actions` is still exactly what was read — the same compare-and-swap
 * `commitProposedAction` claims with — so a click landing mid-run is never overwritten; that
 * row is counted as a conflict and the next run converts it. Idempotent: a converted row no
 * longer matches. `dry` reads and counts, and writes nothing.
 */
export async function migrateLegacyChatProposals(options: { dry?: boolean } = {}): Promise<MigrationStats> {
  const db = await getDb();
  const stats: MigrationStats = { messagesSeen: 0, messagesRewritten: 0, proposalsConverted: 0, unknown: 0, conflicts: 0 };
  let after = "00000000-0000-0000-0000-000000000000";

  for (;;) {
    const result = await db.execute(sql`
      select id, proposed_actions
      from chat_messages
      where id > ${after}::uuid
        and jsonb_typeof(proposed_actions) = 'array'
        and exists (
          select 1 from jsonb_array_elements(proposed_actions) as p
          where p->'args'->>'kind' is distinct from 'tool'
        )
      order by id
      limit ${BATCH}
    `);
    const rows = rowsOf<{ id: string; proposed_actions: StoredProposedAction[] }>(result);
    if (!rows.length) break;
    after = rows[rows.length - 1]!.id;

    for (const row of rows) {
      stats.messagesSeen += 1;
      const before = row.proposed_actions;
      let converted = 0;
      const next = before.map((action) => {
        const migrated = migrateLegacyAction(action);
        if (!migrated) {
          stats.unknown += 1;
          return action;
        }
        if (migrated !== action) converted += 1;
        return migrated;
      });
      if (!converted) continue;
      if (options.dry) {
        stats.messagesRewritten += 1;
        stats.proposalsConverted += converted;
        continue;
      }
      const updated = await db.execute(sql`
        update chat_messages
        set proposed_actions = ${JSON.stringify(next)}::jsonb
        where id = ${row.id}::uuid and proposed_actions = ${JSON.stringify(before)}::jsonb
        returning id
      `);
      if (rowsOf(updated).length) {
        stats.messagesRewritten += 1;
        stats.proposalsConverted += converted;
      } else {
        stats.conflicts += 1;
      }
    }
  }
  return stats;
}
