/**
 * The answer loop's side of the chat writes: one turn's proposals.
 *
 * `createProposalSink` holds what the model proposed this turn and what it may name.
 * `proposerTools` turns every chat write (@/lib/tools/chat-writes) into a tool the model can
 * call. Its run never writes: it checks every id the input names against the ids the turn has
 * actually seen, writes the card's sentence from those ids' own names, and stores the
 * proposal. The commit is `commitProposedAction`, after a click.
 *
 * `harvest` widens what the turn has seen as lookups return — a reminder `list_reminders`
 * found, an attendee `get_event_roster` listed — so a proposal can name what a lookup found,
 * and nothing else. A note that tells the model to delete some contact id never seen this turn
 * produces a refusal the model reads, and no card.
 */
import { randomUUID } from "node:crypto";
import { parseAnswerTail, type StoredProposedAction } from "@/lib/chat-proposed-actions";
import { CHAT_WRITES, chatWriteNamed, parseWriteInput, type ProposalScope } from "@/lib/tools/chat-writes";
import { SCOPE_KINDS, tierOf } from "@/lib/tools/chat-write-kit";
import { toolError, type OrbitTool } from "@/lib/tools/registry";

/** How a refusal names each kind of id. */
const KIND_NOUN: Record<keyof ProposalScope, string> = {
  contacts: "contact",
  reminders: "reminder",
  events: "event",
  attendees: "attendee",
  actionItems: "action item",
  goals: "goal",
  opportunities: "opportunity",
  recommendations: "radar card",
  campaigns: "campaign",
  outreachMessages: "outreach message",
  recruiters: "recruiter",
  meetings: "meeting",
  calendarEvents: "calendar event",
};

/** Cards per answer. A model that proposes more is told so, and the rest are not stored. */
export const MAX_PROPOSALS = 10;

type MutableScope = { [K in keyof ProposalScope]: Map<string, string> };

export type ProposalSink = {
  readonly scope: ProposalScope;
  list(): StoredProposedAction[];
  /** Records ids a read tool's result vouches for, so proposals may name them. */
  harvest(toolName: string, result: unknown): void;
  /** Admits one id the caller has confirmed (a contact a lookup found, checked as the user's own). */
  allow(kind: keyof ProposalScope, id: string, label: string): void;
  propose(toolName: string, input: Record<string, unknown>): { ok: true; action: StoredProposedAction } | { ok: false; error: string };
  /** The card the last successful `propose` stored or found. */
  latest(): StoredProposedAction | null;
  /** Puts a card back as it now stands (an auto-applied one, done with its undo). */
  replace(action: StoredProposedAction): void;
};

export function createProposalSink(seen: Partial<{ [K in keyof ProposalScope]: ReadonlyMap<string, string> }>): ProposalSink {
  const scope = Object.fromEntries(SCOPE_KINDS.map((kind) => [kind, new Map(seen[kind] ?? [])])) as MutableScope;
  const proposals: StoredProposedAction[] = [];
  const keys = new Set<string>();
  let latest: StoredProposedAction | null = null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const rowsOf = (v: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(v) ? v : []).filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object");

  return {
    scope,
    list: () => proposals.slice(),
    latest: () => latest,
    replace(action) {
      const i = proposals.findIndex((p) => p.id === action.id);
      if (i !== -1) proposals[i] = action;
      if (latest?.id === action.id) latest = action;
    },
    allow(kind, id, label) {
      if (!scope[kind].has(id)) scope[kind].set(id, label);
    },
    harvest(toolName, result) {
      const r = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      const add = (map: Map<string, string>, id: unknown, label: unknown) => {
        const key = str(id);
        if (key && !map.has(key)) map.set(key, str(label) ?? "");
      };
      switch (toolName) {
        case "list_reminders":
          for (const row of rowsOf(Array.isArray(result) ? result : r.items ?? r.reminders)) add(scope.reminders, row.id, row.title);
          break;
        case "list_open_commitments":
          for (const row of rowsOf(result)) {
            if (row.kind === "reminder") add(scope.reminders, row.id, row.text);
            else add(scope.actionItems, row.id, row.text);
          }
          break;
        case "list_events":
          for (const row of rowsOf(result)) add(scope.events, row.id, row.title);
          break;
        case "events_with_contact":
          for (const row of rowsOf(result)) add(scope.events, row.eventId, row.title);
          break;
        case "get_event_roster": {
          const event = (r.event ?? {}) as Record<string, unknown>;
          add(scope.events, event.id, event.title);
          for (const row of rowsOf(r.people)) add(scope.attendees, row.attendeeId, row.name);
          break;
        }
        case "who_to_talk_to": {
          const event = (r.event ?? {}) as Record<string, unknown>;
          add(scope.events, event.id, event.title);
          for (const row of rowsOf(r.people)) add(scope.attendees, row.attendeeId, row.name);
          break;
        }
        case "get_goals":
          for (const row of rowsOf(r.items)) add(scope.goals, row.id, row.text);
          break;
        case "list_opportunities":
          for (const row of rowsOf(result)) add(scope.opportunities, row.id, row.label);
          break;
        case "list_radar_cards":
          for (const row of rowsOf(result)) add(scope.recommendations, row.id, row.name);
          break;
        case "list_campaigns":
          for (const row of rowsOf(result)) add(scope.campaigns, row.id, row.name);
          break;
        case "list_outreach_messages":
          for (const row of rowsOf(r.messages)) add(scope.outreachMessages, row.messageId, row.prospect);
          break;
        case "list_my_recruiters":
          for (const row of rowsOf(result)) add(scope.recruiters, row.recruiterId, row.name);
          break;
        case "search_meetings":
          for (const row of rowsOf(Array.isArray(result) ? result : r.meetings)) add(scope.meetings, row.meetingId, row.title);
          break;
        case "upcoming_meetings":
          for (const row of rowsOf(result)) add(scope.calendarEvents, row.eventId, row.title);
          break;
        case "meeting_context": {
          const event = (r.event ?? {}) as Record<string, unknown>;
          add(scope.calendarEvents, event.eventId, event.title);
          break;
        }
      }
    },
    propose(toolName, input) {
      const write = CHAT_WRITES.find((w) => w.name === toolName);
      if (!write) return { ok: false, error: `No change called ${toolName}.` };
      if (proposals.length >= MAX_PROPOSALS) {
        return { ok: false, error: `This answer already proposes ${MAX_PROPOSALS} changes; that is the most one answer may.` };
      }
      const refs = write.refs(input);
      for (const [kind, ids] of Object.entries(refs) as Array<[keyof ProposalScope, string[] | undefined]>) {
        for (const id of ids ?? []) {
          if (!scope[kind].has(id)) {
            return { ok: false, error: `That ${KIND_NOUN[kind]} id was not in anything you were shown this turn. Use only ids from the sections or a lookup.` };
          }
        }
      }
      const key = `${toolName}:${JSON.stringify(input)}`;
      const existing = proposals.find((p) => `${p.args.tool}:${JSON.stringify(p.args.input)}` === key);
      if (keys.has(key) && existing) {
        latest = existing;
        return { ok: true, action: existing };
      }
      keys.add(key);
      const action: StoredProposedAction = {
        id: randomUUID(),
        args: { kind: "tool", tool: write.name, input },
        preview: write.preview(input, scope),
        status: "proposed",
        tier: tierOf(write, input),
        destructive: Boolean(write.destructive),
        contactId: write.contactOf?.(input) ?? null,
      };
      proposals.push(action);
      latest = action;
      return { ok: true, action };
    },
  };
}

/**
 * The one-pass answer's proposals (its JSON tail, bounded by `parseAnswerTail`) as the same
 * cards the loop makes: each input checked against its catalog entry's schema, its ids against
 * what the answer was shown, its sentence written from those ids' own names. Used while the
 * loop is off (`CHAT_LOOP_V2`); the loop proposes through `proposerTools` instead.
 */
export function proposalsFromAnswerTail(
  raw: unknown,
  allowedContacts: ReadonlySet<string>,
  contactNames: ReadonlyMap<string, string>,
  reminderTitles: ReadonlyMap<string, string> = new Map()
): StoredProposedAction[] {
  const contacts = new Map([...allowedContacts].map((id) => [id, contactNames.get(id) ?? "this contact"]));
  const sink = createProposalSink({ contacts, reminders: reminderTitles });
  for (const args of parseAnswerTail(raw, allowedContacts, new Set(reminderTitles.keys()))) {
    const write = chatWriteNamed(args.tool);
    const input = write ? parseWriteInput(write, args.input) : null;
    if (input) sink.propose(args.tool, input);
  }
  return sink.list();
}

/**
 * Every chat write as a tool the loop offers. `scope: "read"` because running one writes
 * nothing — it stores a proposal in this turn's sink — and that is checked: the registry still
 * refuses a `write` tool on chat, and these are never in `ORBIT_TOOLS`.
 */
export function proposerTools(sink: ProposalSink): OrbitTool[] {
  return CHAT_WRITES.map(
    (write): OrbitTool => ({
      name: write.name,
      title: write.title,
      description: `${write.description} Proposes only: the change happens when the user confirms the card.`,
      inputSchema: write.inputSchema,
      annotations: { readOnlyHint: true },
      surfaces: ["chat"],
      scope: "read",
      resultLabel: "proposal",
      async run(_userId, args: Record<string, unknown>) {
        const out = sink.propose(write.name, args);
        if (!out.ok) return toolError(out.error);
        return {
          status: "proposed",
          preview: out.action.preview,
          note: "Shown to the user as a card to confirm. Do not say it is done.",
        };
      },
    })
  );
}
