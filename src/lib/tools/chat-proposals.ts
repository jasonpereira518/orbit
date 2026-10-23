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
import type { StoredProposedAction } from "@/lib/chat-proposed-actions";
import { CHAT_WRITES, type ProposalScope } from "@/lib/tools/chat-writes";
import { toolError, type OrbitTool } from "@/lib/tools/registry";

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
  const scope: MutableScope = {
    contacts: new Map(seen.contacts ?? []),
    reminders: new Map(seen.reminders ?? []),
    events: new Map(seen.events ?? []),
    attendees: new Map(seen.attendees ?? []),
    actionItems: new Map(seen.actionItems ?? []),
  };
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
            return { ok: false, error: `That ${kind === "actionItems" ? "action item" : kind.slice(0, -1)} id was not in anything you were shown this turn. Use only ids from the sections or a lookup.` };
          }
        }
      }
      const key = `${toolName}:${JSON.stringify(input)}`;
      const existing = proposals.find((p) => p.args.kind === "tool" && `${p.args.tool}:${JSON.stringify(p.args.input)}` === key);
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
        tier: write.tier,
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
