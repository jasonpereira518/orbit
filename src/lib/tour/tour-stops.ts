/**
 * The guided tour's in-app stops, as data. Pure — no React, no icons — so the server action
 * that persists `user_settings.tour_stop` validates against the same table the coach rail
 * walks, and the smoke can prove every route, anchor and predicate exists.
 *
 * Budget: about three minutes after the setup stage. `seconds` is the honest estimate per
 * stop, and the smoke keeps the resolved list at or under 200 seconds either way.
 */
import type { TourAnchorId } from "@/lib/tour/tour-anchors";
import type { TourEventName } from "@/lib/tour/tour-events";
import { EXAMPLE_COMPANY, examplePerson } from "@/lib/onboarding-examples/cast";

/**
 * What ends a stop on its own. Event predicates come from `emitTourEvent` in the real
 * success paths; the two capture predicates read the capture job store; the route
 * predicate is a pure pathname match.
 */
export type TourPredicateId =
  | TourEventName
  | "route:contact-detail"
  | "capture.extracted"
  | "capture.saved";

/**
 * What the guide cursor does at a stop. `click` really clicks the anchor and is only for
 * harmless steps (navigating, opening a panel, focusing a field) — the smoke keeps an
 * allowlist; anything that saves or spends the AI key is at most a `demo-click`.
 */
export type TourCursorMode = "point" | "demo-click" | "click";

/** The stops where the cursor may press the control for real. Checked by the smoke. */
export const CURSOR_CLICK_ALLOWED: readonly string[] = ["contacts.search", "contacts.open", "contact.log"];

export type TourStop = {
  id: TourStopId;
  /** Exact path, or a pattern like "/contacts/:id" the tour never pushes itself. */
  route: string;
  anchor: TourAnchorId | null;
  /** A second anchor the desktop chip names once the first is done (informational). */
  chipAnchor?: TourAnchorId;
  title: string;
  body: string;
  tryThis?: string;
  /** The ≤5-word desktop chip beside the cutout. */
  chip?: string;
  doneWhen: TourPredicateId | null;
  /** The word the rail shows while the predicate is unmet, and the tick's label once met. */
  doneLabel?: { pending: string; done: string };
  /**
   * What to do when the control is not on screen (a view switched, a search emptied the
   * list). Shown under the instruction rather than instead of it.
   */
  missingHint?: string;
  /**
   * A stop that only makes sense after another one completed (the cards to keep exist only
   * once a note was extracted). Skipped in both directions while that stop is not done.
   */
  requiresDone?: TourStopId;
  /** Only shown when the account has (or has not) a working AI key. */
  requires?: "ai_key" | "no_ai_key";
  /** Dropped when an operator has hidden this surface from the viewer. */
  surfaceKey?: string;
  /** Move keyboard focus into the anchor on arrival (search box, textarea). */
  focusAnchor?: boolean;
  /** The guide cursor's gesture here; "point" when omitted. */
  cursor?: TourCursorMode;
  /** Side effect to run just before navigating to the stop's route. */
  onEnter?: "prefill-capture-note";
  seconds: number;
};

export const TOUR_STOP_IDS_LIST = [
  "dashboard.home",
  "contacts.search",
  "contacts.open",
  "contact.log",
  "capture.extract",
  "capture.keep",
  "capture.linkedin",
  "reminders.done",
  "chat.ask",
  "chat.preview",
  "graph.star",
  "imports.linkedin",
  "finish",
] as const;

export type TourStopId = (typeof TOUR_STOP_IDS_LIST)[number];

/** A `Record` so a stop added to the tuple without a decision here is a compile error. */
export const TOUR_STOP_IDS: Record<TourStopId, true> = {
  "dashboard.home": true,
  "contacts.search": true,
  "contacts.open": true,
  "contact.log": true,
  "capture.extract": true,
  "capture.keep": true,
  "capture.linkedin": true,
  "reminders.done": true,
  "chat.ask": true,
  "chat.preview": true,
  "graph.star": true,
  "imports.linkedin": true,
  finish: true,
};

export function isTourStopId(value: string | null | undefined): value is TourStopId {
  return value != null && Object.hasOwn(TOUR_STOP_IDS, value);
}

const maya = examplePerson("maya");
const daniel = examplePerson("daniel");

export const TOUR_STOPS: readonly TourStop[] = [
  {
    id: "dashboard.home",
    route: "/dashboard",
    anchor: "dashboard.stats",
    title: "Your dashboard",
    body: `What needs you today. ${maya.firstName} is overdue for a follow-up, so Due follow-ups already counts one; the cards further down say who and why.`,
    tryThis: "Glance at the four numbers, then press Next.",
    chip: "Today at a glance",
    doneWhen: null,
    surfaceKey: "page.dashboard",
    seconds: 12,
  },
  {
    id: "contacts.search",
    cursor: "click",
    route: "/contacts",
    anchor: "contacts.search",
    title: "Find anyone in a keystroke",
    body: "Contacts is everyone you know, with how you met, what you discussed and how close you are.",
    tryThis: `Type “${maya.firstName}” in the search box.`,
    chip: "Search here",
    doneWhen: "contacts.searched",
    doneLabel: { pending: "Done when you search", done: "Found" },
    surfaceKey: "page.contacts",
    focusAnchor: true,
    seconds: 15,
  },
  {
    id: "contacts.open",
    cursor: "click",
    route: "/contacts",
    anchor: "contacts.row",
    title: "Open a person",
    body: "The chip on each row is closeness: how well you actually keep in touch, worked out from your notes and meetings.",
    tryThis: "Open the highlighted person, or anyone else.",
    missingHint: "Nobody matches the search. Clear it to see everyone.",
    chip: "Open a profile",
    doneWhen: "route:contact-detail",
    doneLabel: { pending: "Done when you open someone", done: "Opened" },
    surfaceKey: "page.contacts",
    seconds: 12,
  },
  {
    id: "contact.log",
    cursor: "click",
    route: "/contacts/:id",
    anchor: "contact.log-interaction",
    title: "Log what happened",
    body: "A profile keeps where things stand, the timeline and what’s next. Everything you log lands on the timeline.",
    tryThis: "Press Log interaction, write a line under Notes, then press Log interaction at the bottom.",
    missingHint: "Scroll to the Timeline card; the button sits in its header.",
    chip: "Log an interaction",
    doneWhen: "interaction.logged",
    doneLabel: { pending: "Done when you log one", done: "Logged, nice" },
    surfaceKey: "page.contacts",
    seconds: 25,
  },
  {
    id: "capture.extract",
    cursor: "demo-click",
    route: "/capture",
    anchor: "capture.notes",
    title: "Capture from messy notes",
    body: `Paste anything after a meeting and Orbit works out who you met and what to do next. A note about ${maya.firstName} is already in the box.`,
    tryThis: "Press Extract people under the note.",
    missingHint: "Switch to the Messy Notes tab, or finish the capture on screen first.",
    chip: "Press Extract",
    doneWhen: "capture.extracted",
    doneLabel: { pending: "Done when Orbit extracts", done: "Extracted" },
    requires: "ai_key",
    surfaceKey: "page.capture",
    onEnter: "prefill-capture-note",
    focusAnchor: true,
    seconds: 20,
  },
  {
    id: "capture.keep",
    cursor: "demo-click",
    route: "/capture",
    anchor: "capture.keep",
    title: "Review, then keep",
    body: "Every person Orbit found is a card you confirm. Keep the ones that matter; the note, the follow-up and the reminder are written for you.",
    tryThis: "Press the round tick to keep them. With more than one card, press Save at the end.",
    missingHint: "The cards appear once Orbit has read the note.",
    requiresDone: "capture.extract",
    chip: "Keep this person",
    doneWhen: "capture.saved",
    doneLabel: { pending: "Done when you keep someone", done: "Kept" },
    requires: "ai_key",
    surfaceKey: "page.capture",
    seconds: 15,
  },
  {
    id: "capture.linkedin",
    route: "/capture",
    anchor: "capture.notes",
    title: "Capture, with or without a key",
    body: "Paste notes here and Orbit’s AI works out who you met and what to do next, once you add a key in Settings. A LinkedIn profile URL on its own works today, no key needed.",
    tryThis: "Paste a LinkedIn profile URL to log a person.",
    chip: "Paste notes or a URL",
    doneWhen: null,
    requires: "no_ai_key",
    surfaceKey: "page.capture",
    seconds: 15,
  },
  {
    id: "reminders.done",
    cursor: "demo-click",
    route: "/reminders",
    anchor: "reminders.row-done",
    chipAnchor: "reminders.rail-today",
    title: "Clear what’s due",
    body: `Today holds what’s due and anything overdue: ${maya.firstName}’s deck is late and ${daniel.firstName}’s call is due today. Upcoming, Anytime and Done are one click away.`,
    tryThis: "Tick the circle beside a reminder to mark it done.",
    missingHint: "Switch to Today to see what’s due.",
    chip: "Mark done",
    doneWhen: "reminder.done",
    doneLabel: { pending: "Done when you clear one", done: "Done" },
    surfaceKey: "page.reminders",
    seconds: 18,
  },
  {
    id: "chat.ask",
    cursor: "demo-click",
    route: "/chat",
    anchor: "chat.composer",
    title: "Ask your network",
    body: "Answers come from your own notes, with a numbered source behind each claim. When there’s something to do, Orbit proposes it and waits for you to confirm.",
    tryThis: `Type “Who do I know at ${EXAMPLE_COMPANY}?” and press Enter.`,
    chip: "Ask here",
    doneWhen: "chat.answered",
    doneLabel: { pending: "Done when Orbit answers", done: "Answered" },
    requires: "ai_key",
    surfaceKey: "page.chat",
    focusAnchor: true,
    seconds: 25,
  },
  {
    id: "chat.preview",
    route: "/chat",
    anchor: "chat.composer",
    title: "Ask your network",
    body: "With an AI key, this answers questions like “who do I know at a fintech?” from your own notes, with a numbered source behind each claim.",
    tryThis: "Add a key in Settings when you’re ready; this page lights up.",
    chip: "Needs your AI key",
    doneWhen: null,
    requires: "no_ai_key",
    surfaceKey: "page.chat",
    seconds: 10,
  },
  {
    id: "graph.star",
    route: "/graph",
    anchor: "graph.stage",
    chipAnchor: "graph.show-all",
    title: "Your network as a sky",
    body: `You’re the sun. Companies and schools form constellations around you, each traced by its own people; the three at ${EXAMPLE_COMPANY} make one.`,
    tryThis: "Pick a star to see who it is.",
    chip: "Pick a star",
    doneWhen: "graph.star-selected",
    doneLabel: { pending: "Done when you pick a star", done: "Found" },
    surfaceKey: "page.graph",
    seconds: 20,
  },
  {
    id: "imports.linkedin",
    route: "/imports",
    anchor: "imports.connections",
    title: "When your LinkedIn export lands",
    body: "LinkedIn emails a ZIP, usually within a day. Press Choose file and pick it as it arrived, no unzipping needed, and every connection comes in at once. Google and Outlook contacts sit further down this page.",
    tryThis: "Nothing to do yet; come back with the ZIP.",
    chip: "Upload the ZIP here",
    doneWhen: null,
    surfaceKey: "page.imports",
    seconds: 10,
  },
  {
    id: "finish",
    route: "/dashboard",
    anchor: null,
    title: "You’re in orbit",
    body: "That’s every page. Here is what’s set up, and what’s left.",
    doneWhen: null,
    seconds: 20,
  },
];

export type TourContext = {
  hasApiKey: boolean;
  hidden: ReadonlySet<string>;
  /** Whether the stage recorded "I've requested it" on the LinkedIn step. */
  linkedinRequested?: boolean;
};

/** The Imports stop for someone who never started the export on the LinkedIn step. */
const IMPORTS_NOT_REQUESTED: Pick<TourStop, "title" | "body" | "tryThis"> = {
  title: "Bring in everyone you know",
  body: "LinkedIn packages your connections as a ZIP and emails it within a day. Choose it on this card when it lands. Google and Outlook contacts sit further down this page.",
  tryThis: "Press How to export on this card whenever you’re ready.",
};

/** The stops this account walks, in order. Never empty: the finish card is unconditional. */
export function resolveTourStops(ctx: TourContext): TourStop[] {
  return TOUR_STOPS.filter((stop) => {
    if (stop.requires === "ai_key" && !ctx.hasApiKey) return false;
    if (stop.requires === "no_ai_key" && ctx.hasApiKey) return false;
    if (stop.surfaceKey && ctx.hidden.has(stop.surfaceKey)) return false;
    return true;
  }).map((stop) =>
    stop.id === "imports.linkedin" && ctx.linkedinRequested === false ? { ...stop, ...IMPORTS_NOT_REQUESTED } : stop,
  );
}

/** Where a stored stop resumes: itself when it is still in the list, else the first stop. */
export function resumeTourStop(stored: string | null | undefined, stops: readonly TourStop[]): TourStop {
  const found = isTourStopId(stored) ? stops.find((s) => s.id === stored) : undefined;
  return found ?? stops[0];
}

/** A person's profile: `/contacts/<id>`, but not the New or Duplicates pages. */
export function isContactDetailPath(pathname: string): boolean {
  return /^\/contacts\/(?!new$|duplicates$)[^/]+$/.test(pathname);
}

/** True when `pathname` is the page the stop lives on. */
export function stopMatchesPath(stop: TourStop, pathname: string): boolean {
  if (stop.route === "/contacts/:id") return isContactDetailPath(pathname);
  return pathname === stop.route;
}

/** The page's nav label for the off-route card. */
export function stopPageLabel(stop: TourStop): string {
  switch (stop.route) {
    case "/dashboard":
      return "Dashboard";
    case "/contacts":
      return "Contacts";
    case "/contacts/:id":
      return "a profile";
    case "/capture":
      return "Capture";
    case "/reminders":
      return "Reminders";
    case "/chat":
      return "Chat";
    case "/graph":
      return "Constellation";
    case "/imports":
      return "Imports";
    default:
      return stop.route;
  }
}
