/**
 * Running Orbit's read tools for chat — shared by the research step (`@/lib/chat-gather`) and
 * the answer loop (`@/lib/chat-agent-loop`), so both use the same tool list, the same
 * validation and audit trail, the same step lines and the same rule for which contact ids a
 * result vouches for.
 *
 * SECURITY. Read-only by construction: the tools are `toolsFor(ORBIT_TOOLS, "chat", ["read"])`
 * and `runTool` refuses anything else on the chat surface (`checkToolCall`). A note an attacker
 * wrote can steer which lookups happen; it cannot make one write, send or fetch anything.
 */
import type { ToolCall } from "@/lib/ai-tools";
import { recordAiSecurityEvent } from "@/lib/ai-security";
import type { ChatContext } from "@/lib/chat-context";
import { plural } from "@/lib/chat-steps";
import { sanitizeProfileLine } from "@/lib/contact-profile-format";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { ORBIT_TOOLS } from "@/lib/tools/definitions";
import { isToolError, releasedTools, runTool, toolsFor, type OrbitTool } from "@/lib/tools/registry";

/** "Searching your notes…" → "Searched your notes…", for a lookup that finished. */
export function pastTense(label: string): string {
  return label.replace(/^(Search|Check|Look|Count)ing\b/, "$1ed").replace(/^Reading\b/, "Read");
}

/** What one lookup came back with, as the end of its step line. */
export function describeOutcome(out: { ok: boolean; result: unknown }): string {
  if (!out.ok) return "failed";
  const r = out.result as Record<string, unknown> | unknown[] | null;
  // One record (a contact, a meeting) came back: it was found. Counting the first list inside
  // it — an empty timeline — used to report a contact that was read as "nothing found".
  if (r && !Array.isArray(r) && typeof r === "object" && typeof (r as Record<string, unknown>).id === "string") {
    return "found";
  }
  const rows = Array.isArray(r)
    ? r
    : r && typeof r === "object"
      ? (Object.values(r).find(Array.isArray) as unknown[] | undefined)
      : undefined;
  if (!rows) return "done";
  return rows.length ? `${plural(rows.length, "result")}` : "nothing found";
}

/** The step line for one lookup — model-chosen text, so sanitized and shortened. */
export function describeCall(call: ToolCall, ctx: ChatContext): string {
  const args = (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>;
  const text = (key: string) =>
    typeof args[key] === "string" ? sanitizeProfileLine(args[key] as string).slice(0, 60) : "";
  const nameOf = (id: string) =>
    ctx.retrieved.find((c) => c.id === id)?.fullName ??
    ctx.attachedPeople.find((p) => p.id === id)?.name ??
    null;
  switch (call.name) {
    case "search_notes": {
      const range = text("after") || text("before") ? ` (${text("after") || "…"} to ${text("before") || "now"})` : "";
      return `Searching your notes for “${text("query")}”${range}`;
    }
    case "search_meetings":
      return `Searching your recorded meetings for “${text("query")}”`;
    case "search_contacts":
      return `Searching your contacts for “${text("query")}”`;
    case "get_contact": {
      const name = typeof args.contactId === "string" ? nameOf(args.contactId) : null;
      return name ? `Reading ${name}'s full record` : "Reading a contact's full record";
    }
    case "who_do_i_know_at":
      return `Checking who you know at ${text("company")}`;
    case "due_followups":
      return "Checking who you owe a follow-up";
    case "list_reminders":
      return "Checking your reminders";
    case "get_network_overview":
      return "Looking at your network as a whole";
    case "get_timeline": {
      const name = typeof args.contactId === "string" ? nameOf(args.contactId) : null;
      return name ? `Reading your history with ${name}` : "Reading a person's history";
    }
    case "get_goals":
      return "Checking what you're working towards";
    case "find_path_to":
      return `Looking for a way in to ${text("target")}`;
    case "list_open_commitments":
      return "Checking what you owe people";
    case "upcoming_meetings":
      return "Checking your calendar";
    case "free_time":
      return "Checking when you're free";
    case "meeting_context":
      return text("query") ? `Preparing for “${text("query")}”` : "Preparing for your meeting";
    case "query_contacts":
      return typeof args.group_by === "string" ? `Counting your contacts by ${text("group_by")}` : "Counting your contacts";
    case "query_interactions":
      return typeof args.group_by === "string" ? `Counting your interactions by ${text("group_by")}` : "Counting your interactions";
    case "list_events":
      return "Checking your events";
    case "get_event_roster":
      return "Reading an event's roster";
    case "who_to_talk_to":
      return "Checking who to talk to at an event";
    case "events_with_contact": {
      const name = typeof args.contactId === "string" ? nameOf(args.contactId) : null;
      return name ? `Checking events you shared with ${name}` : "Checking events you shared with someone";
    }
    case "list_opportunities":
      return "Checking open opportunities";
    case "list_radar_cards":
      return "Checking your radar";
    case "list_campaigns":
      return "Checking your outreach campaigns";
    case "list_my_recruiters":
      return "Checking your recruiters";
    case "get_dossier": {
      const name = typeof args.contactId === "string" ? nameOf(args.contactId) : null;
      return name ? `Reading your brief on ${name}` : "Reading a relationship brief";
    }
    case "list_sent_emails":
      return "Checking emails you sent";
    case "recent_captures":
      return "Checking your recent captures";
    case "recent_imports":
      return "Checking your recent imports";
    default:
      return "Looking something up";
  }
}

/**
 * The contact ids a tool's result vouches for, by tool. Explicit rather than a walk over
 * every `id` field: a reminder's id is not a contact's, and letting it into the allowlist
 * would let a recommendation point at nothing.
 */
export function contactsIn(name: string, result: unknown): Array<{ id: string; name: string | null }> {
  const rows = Array.isArray(result) ? result : [];
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  switch (name) {
    case "search_contacts":
      return rows.flatMap((r) => (str(r?.id) ? [{ id: r.id, name: str(r.name) }] : []));
    case "get_event_roster":
    case "who_to_talk_to": {
      const people = (result as { people?: unknown } | null)?.people;
      return (Array.isArray(people) ? people : []).flatMap((p: { contactId?: unknown; name?: unknown }) =>
        str(p?.contactId) ? [{ id: p.contactId as string, name: str(p.name) }] : []
      );
    }
    case "list_opportunities":
      return rows.flatMap((r) => (str(r?.contactId) ? [{ id: r.contactId as string, name: str(r.contactName) }] : []));
    case "list_radar_cards":
      return rows.flatMap((r) => (str(r?.contactId) ? [{ id: r.contactId as string, name: str(r.name) }] : []));
    case "query_contacts": {
      const listed = (result as { rows?: unknown } | null)?.rows;
      return (Array.isArray(listed) ? listed : []).flatMap((r: { id?: unknown; name?: unknown }) =>
        str(r?.id) ? [{ id: r.id as string, name: str(r.name) }] : []
      );
    }
    case "query_interactions": {
      const r = result as { rows?: unknown; groups?: unknown } | null;
      const fromRows = (Array.isArray(r?.rows) ? r.rows : []).flatMap((x: { contactId?: unknown; contactName?: unknown }) =>
        str(x?.contactId) ? [{ id: x.contactId as string, name: str(x.contactName) }] : []
      );
      const fromGroups = (Array.isArray(r?.groups) ? r.groups : []).flatMap((g: { contactId?: unknown; key?: unknown }) =>
        str(g?.contactId) ? [{ id: g.contactId as string, name: str(g.key) }] : []
      );
      return [...fromRows, ...fromGroups];
    }
    case "get_contact": {
      const r = result as { id?: unknown; name?: unknown } | null;
      return r && str(r.id) ? [{ id: r.id as string, name: str(r.name) }] : [];
    }
    case "who_do_i_know_at":
      return rows.flatMap((roster) =>
        Array.isArray(roster?.people)
          ? roster.people.flatMap((p: { id?: unknown; name?: unknown }) =>
              str(p?.id) ? [{ id: p.id as string, name: str(p.name) }] : []
            )
          : []
      );
    case "due_followups":
    case "list_reminders":
    case "list_open_commitments":
      return rows.flatMap((r) => (str(r?.contactId) ? [{ id: r.contactId, name: str(r.name ?? r.contactName) }] : []));
    case "meeting_context": {
      // The people on the meeting: Orbit's own contacts, by id.
      const people = (result as { people?: unknown } | null)?.people;
      return Array.isArray(people)
        ? people.flatMap((p: { contactId?: unknown; name?: unknown }) =>
            str(p?.contactId) ? [{ id: p.contactId as string, name: str(p.name) }] : []
          )
        : [];
    }
    case "get_timeline": {
      // Not an array: one person, the one the caller asked for.
      const r = result as { contactId?: unknown; name?: unknown } | null;
      return r && str(r.contactId) ? [{ id: r.contactId as string, name: str(r.name) }] : [];
    }
    case "find_path_to": {
      const r = result as { alreadyKnown?: unknown; introducers?: unknown } | null;
      const people = [
        ...(Array.isArray(r?.alreadyKnown) ? r.alreadyKnown : []),
        ...(Array.isArray(r?.introducers) ? r.introducers : []),
      ] as Array<{ contactId?: unknown; name?: unknown }>;
      return people.flatMap((p) => (str(p?.contactId) ? [{ id: p.contactId as string, name: str(p.name) }] : []));
    }
    case "upcoming_meetings":
      return rows.flatMap((e) =>
        Array.isArray(e?.attendees)
          ? e.attendees.flatMap((a: { contactId?: unknown; name?: unknown }) =>
              str(a?.contactId) ? [{ id: a.contactId as string, name: str(a.name) }] : []
            )
          : []
      );
    case "meeting_context": {
      const r = result as { people?: unknown } | null;
      return (Array.isArray(r?.people) ? r.people : []).flatMap((p: { contactId?: unknown; name?: unknown }) =>
        str(p?.contactId) ? [{ id: p.contactId as string, name: str(p.name) }] : []
      );
    }
    case "search_notes":
      return rows.flatMap((r) =>
        Array.isArray(r?.contactIds) ? r.contactIds.filter(str).map((id: string) => ({ id, name: null })) : []
      );
    default:
      return [];
  }
}

/**
 * Run a model-chosen call on the chat surface.
 *
 * Validation, surface and scope are enforced by `runTool` itself (`checkToolCall`), so the
 * rule holds for every surface rather than only for callers that remember it. The read scope
 * is passed explicitly: the chat surface never writes, and a refusal is recorded — a model
 * reaching for a tool it was not offered is exactly the behaviour worth a row.
 */
export function executorFor(
  userId: string,
  tools: OrbitTool[],
  /** Where the call came from, for the security audit trail. */
  surface: "chat.gather" | "chat.answer" = "chat.gather"
) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return async (call: ToolCall) => {
    const tool = byName.get(call.name);
    if (!tool) {
      void recordAiSecurityEvent({
        kind: "tool_refused",
        userId,
        surface,
        detail: { tool: String(call.name).slice(0, 60), reason: "unknown_tool" },
      });
      return { ok: false, result: { error: `No tool named ${call.name}.` } };
    }
    const result = await runTool(tool, userId, call.args ?? {}, {
      surface: "chat",
      scopes: ["read"],
      // A mistyped argument is a model slip, answered with a message it can correct from; a
      // reach for a tool outside the read surface is the signal worth a row.
      onRefused: (name, reason) => {
        if (reason === "invalid_args") return;
        void recordAiSecurityEvent({ kind: "tool_refused", userId, surface, detail: { tool: name, reason } });
      },
    });
    return { ok: !isToolError(result), result };
  };
}

/**
 * The read tools this asker's chat may use: every chat tool, minus those whose page has not
 * been released to them. A visibility read that fails drops the gated tools — closed, not open.
 */
export async function chatToolsFor(userId: string): Promise<OrbitTool[]> {
  const all = toolsFor(ORBIT_TOOLS, "chat", ["read"]);
  if (!all.some((t) => t.releasedSurface)) return all;
  try {
    const { hidden, comingSoon } = await resolveSurfaceVisibility(userId);
    return releasedTools(all, (key) => !hidden.has(key) && !comingSoon.has(key));
  } catch {
    return releasedTools(all, () => false);
  }
}

