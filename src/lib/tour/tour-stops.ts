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
  /** Only shown when the account has (or has not) a working AI key. */
  requires?: "ai_key" | "no_ai_key";
  /** Dropped when an operator has hidden this surface from the viewer. */
  surfaceKey?: string;
  /** Move keyboard focus into the anchor on arrival (search box, textarea). */
  focusAnchor?: boolean;
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
    body: `Who to reach out to today, and why. ${maya.firstName} is already overdue for a follow-up, so the due card has something to say.`,
    tryThis: "Glance at the four numbers, then press Next.",
    chip: "Today at a glance",
    doneWhen: null,
    surfaceKey: "page.dashboard",
    seconds: 12,
  },
  {
    id: "contacts.search",
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
    route: "/contacts",
    anchor: "contacts.row",
    title: "Open a person",
    body: "The chip on each row is closeness: how well you actually keep in touch, worked out from your notes and meetings.",
    tryThis: `Open ${maya.firstName}’s profile.`,
    chip: "Open a profile",
    doneWhen: "route:contact-detail",
    doneLabel: { pending: "Done when you open someone", done: "Opened" },
    surfaceKey: "page.contacts",
    seconds: 12,
  },
  {
    id: "contact.log",
    route: "/contacts/:id",
    anchor: "contact.log-interaction",
    title: "Log what happened",
    body: "A profile keeps the brief (where things stand), the timeline, and the follow-up. Logging an interaction is how the timeline grows and the follow-up moves.",
    tryThis: `Log an interaction: “Coffee — she’s moving to Berlin”.`,
    chip: "Log an interaction",
    doneWhen: "interaction.logged",
    doneLabel: { pending: "Done when you log one", done: "Logged, nice" },
    surfaceKey: "page.contacts",
    seconds: 25,
  },
  {
    id: "capture.extract",
    route: "/capture",
    anchor: "capture.notes",
    title: "Capture from messy notes",
    body: "Paste anything after a meeting. Orbit works out who you met and what to do next. A note is already in the box.",
    tryThis: "Press Extract people.",
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
    route: "/capture",
    anchor: "capture.keep",
    title: "Review, then keep",
    body: "Every person Orbit found is a card you confirm. Keep the ones that matter; the note, the follow-up and the reminder are written for you.",
    tryThis: "Keep the person on the card.",
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
    route: "/reminders",
    anchor: "reminders.row-done",
    chipAnchor: "reminders.rail-today",
    title: "Clear what’s due",
    body: `Today, Upcoming and Done. ${daniel.firstName}’s call is due today. Marking it done here also moves his follow-up; “s” snoozes a week.`,
    tryThis: "Mark a reminder done.",
    chip: "Mark done",
    doneWhen: "reminder.done",
    doneLabel: { pending: "Done when you clear one", done: "Done" },
    surfaceKey: "page.reminders",
    seconds: 18,
  },
  {
    id: "chat.ask",
    route: "/chat",
    anchor: "chat.suggestions",
    title: "Ask your network",
    body: "Answers come from your own notes, with the source behind every claim, and a Log it or Remind me button when there is something to do.",
    tryThis: `Ask: “Who do I know at ${EXAMPLE_COMPANY}?”`,
    chip: "Ask a question",
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
    body: "With an AI key, this answers questions like “who do I know at a fintech?” from your own notes, quotes the note it came from, and offers to log or remind you in one tap.",
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
    body: `People cluster by company and the brightest stars are your closest ties. The three at ${EXAMPLE_COMPANY} sit together.`,
    tryThis: "Click a star.",
    chip: "Click a star",
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
    body: "LinkedIn emails a ZIP, usually within a day. Drop it here as it arrived and every connection comes in at once. Google and Outlook contacts live on this page too.",
    tryThis: "Nothing to do yet; come back with the ZIP.",
    chip: "Drop the ZIP here",
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
};

/** The stops this account walks, in order. Never empty: the finish card is unconditional. */
export function resolveTourStops(ctx: TourContext): TourStop[] {
  return TOUR_STOPS.filter((stop) => {
    if (stop.requires === "ai_key" && !ctx.hasApiKey) return false;
    if (stop.requires === "no_ai_key" && ctx.hasApiKey) return false;
    if (stop.surfaceKey && ctx.hidden.has(stop.surfaceKey)) return false;
    return true;
  });
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
    case "/contacts/:id":
      return "Contacts";
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
