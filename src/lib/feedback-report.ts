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
  "chat",
  "graph",
  "outreach",
  "knowledge",
  "settings",
  "onboarding",
  "other",
] as const;
export type FeedbackArea = (typeof FEEDBACK_AREAS)[number];

/** What kind of remark it is. Orthogonal to the area — what happened vs. where. */
export const FEEDBACK_CATEGORIES = ["bug", "idea", "confusing", "praise"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

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
  ["/imports", "import"],
  ["/reminders", "reminders"],
  ["/chat", "chat"],
  ["/graph", "graph"],
  ["/outreach", "outreach"],
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
