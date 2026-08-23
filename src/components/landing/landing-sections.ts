/** Clearance for the fixed pill header (margin + bar height + breathing room). */
export const LANDING_HEADER_SCROLL_OFFSET = 96;

/** Anchor targets for the sticky header section nav (matches scroll targets on the page). */
export const LANDING_SECTIONS = [
  { id: "landing-groups", label: "Constellation" },
  { id: "landing-reminders", label: "Follow-ups" },
  { id: "landing-how", label: "How it works" },
  { id: "landing-features", label: "Features" },
  { id: "landing-cta", label: "Get started" },
] as const;
