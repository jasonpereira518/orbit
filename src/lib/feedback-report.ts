/**
 * The client half of the feedback widget: what the browser knows about where someone was.
 *
 * Pure and dependency-free on purpose. `src/lib/feedback-submission.ts` reaches `@/db`
 * transitively, and a client component that imports anything reaching `@/db` fails the
 * build with a `node:fs` chunking error naming neither file — so the shared vocabulary
 * lives here and the server module owns storage.
 */

/**
 * Which part of Orbit a report is about. Offered by the form (prefilled from the route)
 * and validated by `feedbackSubmissionSchema` in `src/lib/feedback-submission.ts`.
 *
 * `feedback.area` is plain text with no CHECK, so this list can grow without DDL or a
 * `SCHEMA_VERSION` bump — but it is still a closed set at the boundary, because an
 * open-ended string would turn the console's filter into a free-text search.
 */
export const FEEDBACK_AREAS = [
  "dashboard",
  "contacts",
  "capture",
  "import",
  "reminders",
  "radar",
  "chat",
  "graph",
  "outreach",
  "knowledge",
  "settings",
  "onboarding",
  "other",
] as const;
export type FeedbackArea = (typeof FEEDBACK_AREAS)[number];

/**
 * Who the feedback window says it goes to.
 *
 * A person, not "us": people were texting the founder rather than using the form, and a
 * message to someone you know is the thing they were already doing. One constant so the
 * panel, the thank-you and the replies all name the same person.
 */
export const FEEDBACK_RECIPIENT = "Jason";

/**
 * What kind of remark it is. Orthogonal to the area — what happened vs. where.
 *
 * The form no longer asks for it; `src/lib/feedback-triage.ts` reads it from the words.
 */
export const FEEDBACK_CATEGORIES = ["bug", "idea", "confusing", "praise"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/** How much it matters, as the triage pass reads it. */
export const FEEDBACK_SEVERITIES = ["low", "medium", "high"] as const;
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITIES)[number];

/**
 * What the triage pass (`src/lib/feedback-triage.ts`) concluded about one report.
 *
 * Here rather than in the triage module because the schema types the `feedback.triage`
 * column with it and the console renders it, and this file is the one both sides can import.
 */
export type FeedbackTriage = {
  /** One line, for the Slack DM and the console's list. */
  summary: string;
  severity: FeedbackSeverity;
  /** An earlier, still-open report this one repeats, if the model saw one. */
  duplicateOf: string | null;
};

/**
 * One-tap starts for the operator's reply, in the order they're offered. Each drops into the
 * composer to be edited, never sent as-is, so they can stay short and generic.
 */
export const QUICK_ANSWERS: ReadonlyArray<{ label: string; text: string }> = [
  { label: "Fixed", text: "Thanks for flagging this — it's fixed now. Give it another try and tell me if anything's still off." },
  { label: "On the list", text: "Love this idea — it's on the list. I'll message you here when it ships." },
  { label: "Need detail", text: "Thanks! Could you tell me a bit more — what were you trying to do, and what did you expect to happen?" },
  { label: "Screenshot?", text: "Could you send a screenshot of what you're seeing? It'll help me track this down quickly." },
  { label: "Can't reproduce", text: "I can't reproduce this yet. Which browser and device are you on, and does it happen every time?" },
  { label: "Not planned", text: "Thanks for the suggestion. It's not something I'm planning right now, because " },
  { label: "Thank you", text: "Thank you — this genuinely made my day." },
];

/** Bonus AI credits the operator can thank someone with, per report. */
export const THANKS_CREDIT_OPTIONS = [25, 50, 100] as const;
export type ThanksCredits = (typeof THANKS_CREDIT_OPTIONS)[number];

/** One chat message, either side. Long enough for a real answer, short of an essay. */
export const MAX_THREAD_MESSAGE = 2000;

/** How often an open conversation checks for new messages, both sides. */
export const THREAD_POLL_MS = 4000;

/** Before, the error, after. A fourth shot has never told anyone anything new. */
export const MAX_SCREENSHOTS = 3;

/** Per shot, measured on the DECODED bytes — not on the base64 string. */
export const MAX_SCREENSHOT_BYTES = 500_000;

/**
 * Ceiling on one submission, so three maximal shots cannot land as one request.
 *
 * ~2 MB once base64 inflates it, which matters: Vercel's function request-body limit is
 * ~4.5 MB and `experimental.serverActions.bodySizeLimit` does NOT raise it. The 32 MB in
 * `next.config.ts` is a local-dev ceiling, not a platform one.
 */
export const MAX_SUBMISSION_BYTES = 1_500_000;

/** A caption for one screenshot, not an essay. */
export const MAX_SHOT_NOTE = 500;

/** Long enough to be a sentence, short enough not to be a document. */
export const MAX_FEEDBACK_TEXT = 4000;

/** Long enough for any real Orbit path, short enough that a URL cannot hide in one. */
export const MAX_PATH = 200;

/**
 * Which area a route belongs to, for prefilling the form.
 *
 * Longest-prefix wins, so `/contacts/new` resolves to `contacts` rather than to whatever
 * happens to sort first. A route nobody mapped is `other` rather than a guess — the person
 * can correct it in one tap, and a wrong prefill is worse than an honest blank.
 */
const ROUTE_AREAS: Array<[prefix: string, area: FeedbackArea]> = [
  ["/dashboard", "dashboard"],
  ["/contacts", "contacts"],
  ["/capture", "capture"],
  ["/meetings", "capture"],
  ["/imports", "import"],
  ["/reminders", "reminders"],
  ["/radar", "radar"],
  ["/chat", "chat"],
  ["/graph", "graph"],
  ["/outreach", "outreach"],
  ["/find", "outreach"],
  ["/recruiters", "outreach"],
  ["/knowledge", "knowledge"],
  ["/settings", "settings"],
  ["/onboarding", "onboarding"],
];

export function featureAreaForPath(pathname: string): FeedbackArea {
  let best: FeedbackArea = "other";
  let bestLength = 0;
  for (const [prefix, area] of ROUTE_AREAS) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
    if (prefix.length <= bestLength) continue;
    best = area;
    bestLength = prefix.length;
  }
  return best;
}

/** Human labels for the area picker, in the order the form offers them. */
export const AREA_LABELS: Record<FeedbackArea, string> = {
  dashboard: "Dashboard",
  contacts: "Contacts",
  capture: "Capture",
  import: "Imports",
  reminders: "Reminders",
  radar: "Radar",
  chat: "Chat",
  graph: "Graph",
  outreach: "Outreach",
  knowledge: "Knowledge",
  settings: "Settings",
  onboarding: "Onboarding",
  other: "Something else",
};

export const AREA_OPTIONS = FEEDBACK_AREAS.map((area) => ({
  value: area,
  label: AREA_LABELS[area],
}));

/** What the browser can say about where this was written. */
export type ClientFeedbackContext = {
  path: string;
  viewport: { w: number; h: number };
  devicePixelRatio: number;
  theme: "light" | "dark" | undefined;
  timeZone: string | undefined;
};

/**
 * Read at SUBMIT time, not when the panel opened: the panel is fixed and portalled, so it
 * survives navigation, and the route someone ended up on is the one worth recording.
 */
export function readClientContext(theme: string | undefined): ClientFeedbackContext {
  return {
    path: window.location.pathname + window.location.search,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio || 1,
    theme: theme === "dark" ? "dark" : theme === "light" ? "light" : undefined,
    timeZone: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return undefined;
      }
    })(),
  };
}

export type PanelBox = { left: number; top: number; width: number; height: number };

/**
 * Keep a dragged window within reach of the pointer.
 *
 * The header is the only handle, so a window dragged entirely off screen could never be
 * dragged back — the clamp exists to make that unreachable rather than merely unlikely.
 * `edge` is how much of the window must stay on screen in each direction.
 *
 * Takes the box measured at drag START plus the pointer delta, rather than the box now:
 * re-measuring on every pointermove forces layout, and the arithmetic is identical.
 */
export function clampPanelOffset(input: {
  start: PanelBox;
  startOffset: { x: number; y: number };
  delta: { x: number; y: number };
  viewport: { width: number; height: number };
  edge?: number;
}): { x: number; y: number } {
  const edge = input.edge ?? 48;
  const { start, startOffset, delta, viewport } = input;

  const wantLeft = start.left + delta.x;
  const wantTop = start.top + delta.y;

  // Horizontally the window may hang off either side, so long as `edge` of it remains.
  const left = Math.min(Math.max(wantLeft, edge - start.width), viewport.width - edge);
  // Vertically the TOP is what must stay reachable: the handle is the header, so a window
  // whose top edge is above the viewport has put its own handle out of reach.
  const top = Math.min(Math.max(wantTop, 0), viewport.height - edge);

  return {
    x: startOffset.x + (left - start.left),
    y: startOffset.y + (top - start.top),
  };
}
