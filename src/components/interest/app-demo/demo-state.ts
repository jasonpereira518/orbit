/**
 * The demo's whole state and its one reducer. The visitor's clicks and the autoplay tour
 * dispatch the same actions, so the tour exercises exactly what a visitor can do. Pure —
 * the smoke test runs it without React.
 */
import { DEMO_PEOPLE, DEMO_SUGGESTIONS, firstName, personById, tierOf, type ClusterId, type DemoPerson, type TimelineEntry, type TimelineSource, type TimelineType } from "./demo-cast";
import { answerQuestion, type NarratedAnswer } from "./demo-chat";

export type Screen = "dashboard" | "contacts" | "profile" | "chat" | "constellation";
export type ContactsFilter = "all" | "due" | "inner" | "reminders";

export type ChatTurn =
  | { id: number; role: "user"; text: string }
  | {
      id: number;
      role: "assistant";
      answer: NarratedAnswer;
      draft: null | { body: string; state: "editing" | "sent" | "discarded" };
    };

export type DemoState = {
  screen: Screen;
  /** Where Back on a profile returns to. */
  prevScreen: Exclude<Screen, "profile">;
  profileId: string | null;
  mode: "tour" | "explore";
  dismissed: string[];
  /** Follow-ups the visitor set or moved, by person: days from now. */
  followUps: Record<string, number>;
  done: string[];
  added: Record<string, TimelineEntry[]>;
  /** Closeness gained by logging, by person. */
  boost: Record<string, number>;
  search: string;
  strength: number;
  contactsFilter: ContactsFilter;
  chat: ChatTurn[];
  /** Assistant turns whose words have finished streaming in. */
  streamed: number[];
  star: string | null;
  cluster: ClusterId | "all";
  skyQuery: string;
  overlay: null | "palette" | "log";
  logFor: string | null;
  toast: { id: number; text: string } | null;
  seq: number;
};

export type DemoAction =
  | { type: "reset" }
  | { type: "mode"; mode: DemoState["mode"] }
  | { type: "go"; screen: Exclude<Screen, "profile">; filter?: ContactsFilter }
  | { type: "openProfile"; id: string }
  | { type: "back" }
  | { type: "dismiss"; id: string }
  | { type: "setFollowUp"; id: string; days: number }
  | { type: "completeFollowUp"; id: string }
  | { type: "log"; id: string; entryType: TimelineType; note: string; source?: TimelineSource }
  | { type: "search"; q: string }
  | { type: "strength"; n: number }
  | { type: "contactsFilter"; filter: ContactsFilter }
  | { type: "ask"; q: string }
  | { type: "newChat" }
  | { type: "streamed"; id: number }
  | { type: "draft"; turnId: number }
  | { type: "editDraft"; turnId: number; body: string }
  | { type: "sendDraft"; turnId: number }
  | { type: "discardDraft"; turnId: number }
  | { type: "star"; id: string | null }
  | { type: "cluster"; cluster: ClusterId | "all" }
  | { type: "skyQuery"; q: string }
  | { type: "overlay"; overlay: DemoState["overlay"]; logFor?: string | null }
  | { type: "toast"; text: string | null };

export function initialDemoState(mode: DemoState["mode"] = "tour"): DemoState {
  return {
    screen: "dashboard",
    prevScreen: "dashboard",
    profileId: null,
    mode,
    dismissed: [],
    followUps: {},
    done: [],
    added: {},
    boost: {},
    search: "",
    strength: 0,
    contactsFilter: "all",
    chat: [],
    streamed: [],
    star: null,
    cluster: "all",
    skyQuery: "",
    overlay: null,
    logFor: null,
    toast: null,
    seq: 1,
  };
}

function withToast(state: DemoState, text: string): DemoState {
  return { ...state, toast: { id: state.seq, text }, seq: state.seq + 1 };
}

function logEntry(state: DemoState, id: string, type: TimelineType, note: string, source: TimelineSource): DemoState {
  const entry: TimelineEntry = { id: `x${state.seq}`, type, daysAgo: 0, note, source };
  return {
    ...state,
    seq: state.seq + 1,
    added: { ...state.added, [id]: [entry, ...(state.added[id] ?? [])] },
    boost: { ...state.boost, [id]: (state.boost[id] ?? 0) + 4 },
    // Touching someone answers the engine's nudge about them.
    dismissed: state.dismissed.includes(id) ? state.dismissed : [...state.dismissed, id],
  };
}

function mapTurn(state: DemoState, turnId: number, fn: (t: Extract<ChatTurn, { role: "assistant" }>) => ChatTurn): DemoState {
  return { ...state, chat: state.chat.map((t) => (t.id === turnId && t.role === "assistant" ? fn(t) : t)) };
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case "reset":
      return initialDemoState(state.mode);
    case "mode":
      return { ...state, mode: action.mode };
    case "go":
      return {
        ...state,
        screen: action.screen,
        prevScreen: action.screen,
        contactsFilter: action.filter ?? (action.screen === "contacts" ? state.contactsFilter : "all"),
        overlay: null,
      };
    case "openProfile":
      return {
        ...state,
        screen: "profile",
        profileId: action.id,
        prevScreen: state.screen === "profile" ? state.prevScreen : state.screen,
        overlay: null,
      };
    case "back":
      return { ...state, screen: state.prevScreen };
    case "dismiss":
      return { ...state, dismissed: [...state.dismissed, action.id] };
    case "setFollowUp": {
      const p = personById(action.id);
      const next = {
        ...state,
        followUps: { ...state.followUps, [action.id]: action.days },
        done: state.done.filter((d) => d !== action.id),
        dismissed: state.dismissed.includes(action.id) ? state.dismissed : [...state.dismissed, action.id],
      };
      return withToast(next, `Follow-up set with ${p ? firstName(p) : "them"} for ${action.days === 7 ? "a week" : `${action.days} days`} from now`);
    }
    case "completeFollowUp": {
      const p = personById(action.id);
      return withToast({ ...state, done: [...state.done, action.id] }, `Done — ${p ? firstName(p) : "follow-up"} is off your list`);
    }
    case "log": {
      const p = personById(action.id);
      const next = logEntry({ ...state, overlay: null, logFor: null }, action.id, action.entryType, action.note, action.source ?? "You");
      return withToast(next, `Logged — ${p ? `${firstName(p)}'s` : "their"} closeness went up`);
    }
    case "search":
      return { ...state, search: action.q };
    case "strength":
      return { ...state, strength: action.n };
    case "contactsFilter":
      return { ...state, contactsFilter: action.filter };
    case "ask": {
      const q = action.q.trim();
      if (!q) return state;
      const userTurn: ChatTurn = { id: state.seq, role: "user", text: q };
      const reply: ChatTurn = { id: state.seq + 1, role: "assistant", answer: answerQuestion(q), draft: null };
      return { ...state, screen: "chat", prevScreen: "chat", overlay: null, chat: [...state.chat, userTurn, reply], seq: state.seq + 2 };
    }
    case "newChat":
      return { ...state, chat: [], streamed: [] };
    case "streamed":
      return state.streamed.includes(action.id) ? state : { ...state, streamed: [...state.streamed, action.id] };
    case "draft":
      return mapTurn(state, action.turnId, (t) => (t.answer.draft ? { ...t, draft: { body: t.answer.draft.body, state: "editing" } } : t));
    case "editDraft":
      return mapTurn(state, action.turnId, (t) => (t.draft ? { ...t, draft: { ...t.draft, body: action.body } } : t));
    case "discardDraft":
      return mapTurn(state, action.turnId, (t) => (t.draft ? { ...t, draft: { ...t.draft, state: "discarded" } } : t));
    case "sendDraft": {
      const turn = state.chat.find((t) => t.id === action.turnId);
      if (!turn || turn.role !== "assistant" || !turn.draft || !turn.answer.draft) return state;
      const to = personById(turn.answer.draft.personId)!;
      const sent = mapTurn(state, action.turnId, (t) => ({ ...t, draft: { ...t.draft!, state: "sent" } }));
      const logged = logEntry(sent, to.id, "Email", turn.draft.body.slice(0, 90) + (turn.draft.body.length > 90 ? "…" : ""), "Gmail");
      return withToast(logged, `Sent to ${firstName(to)} via Gmail`);
    }
    case "star":
      return { ...state, star: action.id };
    case "cluster":
      return { ...state, cluster: action.cluster, star: null };
    case "skyQuery":
      return { ...state, skyQuery: action.q };
    case "overlay":
      return { ...state, overlay: action.overlay, logFor: action.overlay === "log" ? (action.logFor ?? state.profileId ?? null) : state.logFor };
    case "toast":
      return action.text === null ? { ...state, toast: null } : withToast(state, action.text);
  }
}

// --- Selectors -------------------------------------------------------------------------

export function closenessOf(state: DemoState, p: DemoPerson) {
  return Math.min(99, p.closeness + (state.boost[p.id] ?? 0));
}

export function lastTouchOf(state: DemoState, p: DemoPerson) {
  return (state.added[p.id]?.length ?? 0) > 0 ? 0 : p.lastTouchDays;
}

export function timelineOf(state: DemoState, p: DemoPerson): TimelineEntry[] {
  return [...(state.added[p.id] ?? []), ...p.timeline];
}

/** Days until this person's follow-up, or null when there is none (or it's done). */
export function followUpOf(state: DemoState, p: DemoPerson): number | null {
  if (state.done.includes(p.id)) return null;
  return state.followUps[p.id] ?? p.followUpDays;
}

export function activeSuggestions(state: DemoState) {
  return DEMO_SUGGESTIONS.filter((s) => !state.dismissed.includes(s.personId));
}

/** Follow-ups due within two days, most overdue first. */
export function dueList(state: DemoState) {
  return DEMO_PEOPLE.map((p) => ({ p, days: followUpOf(state, p) }))
    .filter((x): x is { p: DemoPerson; days: number } => x.days !== null && x.days <= 2)
    .sort((a, b) => a.days - b.days);
}

export function stats(state: DemoState) {
  return {
    contacts: DEMO_PEOPLE.length,
    due: dueList(state).length,
    strong: DEMO_PEOPLE.filter((p) => tierOf(closenessOf(state, p)) === "inner").length,
    reminders: DEMO_PEOPLE.filter((p) => followUpOf(state, p) !== null).length,
  };
}

/** The Contacts list after search, strength and the Dashboard's stat-card filter. */
export function visibleContacts(state: DemoState) {
  const q = state.search.trim().toLowerCase();
  const due = new Set(dueList(state).map((d) => d.p.id));
  return DEMO_PEOPLE.filter((p) => {
    const c = closenessOf(state, p);
    if (q && ![p.name, p.company, p.title, p.city, ...p.tags].some((f) => f.toLowerCase().includes(q))) return false;
    if (state.strength > 0 && Math.ceil(c / 20) < state.strength) return false;
    if (state.contactsFilter === "due" && !due.has(p.id)) return false;
    if (state.contactsFilter === "inner" && tierOf(c) !== "inner") return false;
    if (state.contactsFilter === "reminders" && followUpOf(state, p) === null) return false;
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name));
}
