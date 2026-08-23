/** Clearance for the fixed pill header (margin + bar height + breathing room). */
export const LANDING_HEADER_SCROLL_OFFSET = 96;

/** Anchor targets for the sticky header section nav (matches scroll targets on the page). */
export const LANDING_SECTIONS = [
  { id: "groups", label: "Warm paths" },
  { id: "reminders", label: "Follow-ups" },
  { id: "how", label: "How it works" },
  { id: "features", label: "Features" },
  { id: "cta", label: "Get started" },
] as const;
