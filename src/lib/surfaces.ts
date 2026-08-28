import { SETTINGS_SECTIONS } from "@/components/settings/sections";

/**
 * The catalogue of things an operator can hide from every user at once.
 *
 * PURE ON PURPOSE — no database import, directly or transitively. The sidebar and the
 * mobile nav are client components and read this list to decide what to render; a client
 * component that imports anything reaching `@/db` fails the build with a `node:fs`
 * chunking error that names neither file. `src/lib/surface-visibility.ts` is the server
 * half that reads which of these are actually hidden, exactly as `plan-limits.ts` (pure)
 * and `entitlements.ts` (server) already split the paywall.
 *
 * Hiding is presentation plus enforcement, never deletion: no row is touched when a
 * surface goes dark, and unhiding restores it as it was.
 */

export type SurfaceKind = "page" | "dashboard" | "settings";

export type Surface = {
  /** Stable storage key. Never rename one — the flag rows are keyed on it. */
  key: string;
  kind: SurfaceKind;
  label: string;
  /** One line, shown under the toggle in the admin console. */
  description: string;
  /** Pages only: the route this surface owns. */
  href?: string;
  /** Settings sections only: the anchor id in `SETTINGS_SECTIONS`. */
  settingsId?: string;
  /**
   * Cannot be hidden, and the toggle renders disabled with `reason` beside it.
   *
   * Two kinds of surface earn this: redirect targets (hiding them strands users
   * mid-navigation with nowhere to land) and the account escape hatches — nobody may be
   * locked out of their own billing or their own data export.
   */
  alwaysVisible?: true;
  reason?: string;
};

const PAGES: Surface[] = [
  {
    key: "page.dashboard",
    kind: "page",
    label: "Dashboard",
    description: "The home screen after sign-in.",
    href: "/dashboard",
    alwaysVisible: true,
    reason: "Onboarding and the app shell both redirect here.",
  },
  {
    key: "page.contacts",
    kind: "page",
    label: "Contacts",
    description: "The contact list and every contact detail page.",
    href: "/contacts",
  },
  {
    key: "page.capture",
    kind: "page",
    label: "Capture",
    description: "Log an interaction. Also hides the sidebar's Log interaction button.",
    href: "/capture",
  },
  {
    key: "page.imports",
    kind: "page",
    label: "Imports",
    description: "LinkedIn, Google, and Outlook import hub.",
    href: "/imports",
  },
  {
    key: "page.reminders",
    kind: "page",
    label: "Reminders",
    description: "Reminder lists and due follow-ups.",
    href: "/reminders",
  },
  {
    key: "page.chat",
    kind: "page",
    label: "Chat",
    description: "Ask about your network. Also hides the floating ask bar.",
    href: "/chat",
  },
  {
    key: "page.graph",
    kind: "page",
    label: "Constellation",
    description: "The network graph.",
    href: "/graph",
  },
  {
    key: "page.outreach",
    kind: "page",
    label: "Outreach",
    description: "Campaigns, prospects, and sent messages.",
    href: "/outreach",
  },
  {
    key: "page.knowledge",
    kind: "page",
    label: "Knowledge",
    description: "Saved notes and knowledge entries.",
    href: "/knowledge",
  },
  {
    // No nav entry of its own — reached from Contacts, which is why `isNavActive` treats
    // the two as one tab. Hideable independently of Contacts all the same.
    key: "page.recruiters",
    kind: "page",
    label: "Recruiters",
    description: "Recruiter tracking, reached from Contacts.",
    href: "/recruiters",
  },
  {
    key: "page.settings",
    kind: "page",
    label: "Settings",
    description: "The settings page itself. Hide individual sections below instead.",
    href: "/settings",
    alwaysVisible: true,
    reason: "Holds the plan, account, and data-export controls.",
  },
];

const DASHBOARD_CARDS: Surface[] = [
  {
    key: "dashboard.stats",
    kind: "dashboard",
    label: "Stats row",
    description: "Contact and interaction counters across the top.",
  },
  {
    key: "dashboard.charts",
    kind: "dashboard",
    label: "Charts",
    description: "Network depth chart and the constellation preview.",
  },
  {
    key: "dashboard.suggested-outreach",
    kind: "dashboard",
    label: "Suggested outreach",
    description: "AI-suggested people to reach out to.",
  },
  {
    key: "dashboard.outreach-performance",
    kind: "dashboard",
    label: "Outreach performance",
    description: "Reply rates and top campaigns.",
  },
  {
    key: "dashboard.reminders",
    kind: "dashboard",
    label: "Reminders and follow-ups",
    description: "What is due, and drafted follow-ups.",
  },
  {
    key: "dashboard.recently-updated",
    kind: "dashboard",
    label: "Recently updated",
    description: "Contacts touched most recently.",
  },
  {
    key: "dashboard.tail",
    kind: "dashboard",
    label: "Goals, network stats, and plan",
    description: "The block at the foot of the dashboard.",
  },
];

/**
 * Built from `SETTINGS_SECTIONS` rather than retyped, so a section added to the settings
 * page cannot silently become unhideable — it appears in the admin console the same day.
 */
const SETTINGS_LOCKED: Record<string, string> = {
  "settings-profile": "Nobody may be locked out of their own account details.",
  "settings-plan": "Nobody may be locked out of their own billing.",
  "settings-data": "Nobody may be locked out of exporting or deleting their data.",
};

const SETTINGS: Surface[] = SETTINGS_SECTIONS.map((section) => {
  const reason = SETTINGS_LOCKED[section.id];
  return {
    key: `settings.${section.id.replace(/^settings-/, "")}`,
    kind: "settings" as const,
    label: section.label,
    description: `The ${section.label} card on the settings page.`,
    settingsId: section.id,
    ...(reason ? { alwaysVisible: true as const, reason } : {}),
  };
});

export const SURFACES: Surface[] = [...PAGES, ...DASHBOARD_CARDS, ...SETTINGS];

const BY_KEY = new Map(SURFACES.map((s) => [s.key, s]));

export function getSurface(key: string): Surface | undefined {
  return BY_KEY.get(key);
}

export function surfacesOfKind(kind: SurfaceKind): Surface[] {
  return SURFACES.filter((s) => s.kind === kind);
}

export function isAlwaysVisible(key: string): boolean {
  return BY_KEY.get(key)?.alwaysVisible === true;
}

const BY_HREF = new Map(
  PAGES.filter((s) => s.href).map((s) => [s.href as string, s.key])
);

/**
 * Nav href → surface key, for the client nav components.
 *
 * Exact match only, unlike `surfaceForPathname`: nav items are declared with the exact
 * hrefs in this registry, so a miss means the two lists have drifted and the item should
 * be left visible rather than guessed at.
 */
export function surfaceKeyForHref(href: string): string | null {
  return BY_HREF.get(href) ?? null;
}

/** True when `href` points at a surface hidden from this viewer. */
export function isHrefHidden(href: string, hidden: ReadonlySet<string>): boolean {
  const key = surfaceKeyForHref(href);
  return key !== null && hidden.has(key);
}

/** Settings anchor id → surface key, for filtering the settings page and its rail. */
export function surfaceKeyForSettingsId(settingsId: string): string {
  return `settings.${settingsId.replace(/^settings-/, "")}`;
}

/**
 * Which page surface owns a request path, or null for a path no surface claims
 * (`/onboarding`, `/suspended`).
 *
 * Deliberately NOT `isNavActive` in `app-nav.ts`, despite the resemblance. That function
 * answers "which tab looks selected", which is why it folds `/recruiters` into Contacts —
 * one highlighted tab, not two. This one answers "which flag governs this request", and
 * folding the two together here would make Recruiters unhideable while Contacts is
 * visible. The longest matching prefix wins so `/contacts/new` resolves to Contacts.
 */
export function surfaceForPathname(pathname: string): Surface | null {
  let best: Surface | null = null;
  for (const surface of PAGES) {
    const href = surface.href;
    if (!href) continue;
    if (pathname !== href && !pathname.startsWith(`${href}/`)) continue;
    if (!best || href.length > (best.href?.length ?? 0)) best = surface;
  }
  return best;
}
