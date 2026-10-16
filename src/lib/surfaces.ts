import { SETTINGS_SECTIONS } from "@/components/settings/sections";
import { PLANS, PLAN_SHORT_LABELS, type Plan, type PurchasablePlan } from "@/lib/plans/plan-config";

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

export type SurfaceKind = "page" | "dashboard" | "settings" | "widget" | "feature";

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
  /**
   * Pages and features: not released yet. On a page, ordinary users get the coming-soon screen
   * in place of the route (and every route under it) and the nav item carries a "Soon" tag. A
   * feature has no screen of its own, so it is simply hidden: every entry point disappears and
   * its server actions refuse.
   *
   * This is the DEFAULT. An operator can mark any releasable page coming soon, or release one
   * of these, from /admin/product; that override is stored as a flag row and wins over this
   * line in both directions (see `effectiveComingSoonKeys`).
   */
  comingSoon?: true;
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
    // Ships dark again: released in #380, put back the same day. The page, the nightly
    // pass's spend, the Monday email and the dashboard briefing all follow the effective
    // coming-soon set. An admin previews it from /admin/product, where a `live:page.radar`
    // override releases it without a deploy; releasing in code is deleting the line below.
    key: "page.radar",
    kind: "page",
    label: "Radar",
    description: "Who to reach out to this week, and why, rebuilt every night.",
    href: "/radar",
    comingSoon: true,
  },
  {
    key: "page.events",
    kind: "page",
    label: "Events",
    description: "Events you attended, their attendee lists, and who you spoke to.",
    href: "/events",
    comingSoon: true,
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
    key: "page.meetings",
    kind: "page",
    label: "Meetings",
    description: "Past recorded meetings, searchable.",
    href: "/meetings",
  },
  {
    // Ships dark. Brief someone who is not in the network yet, from a web search on the
    // account's own AI key (`src/lib/web-research.ts`); briefs are kept 14 days, and only
    // the people a user saves become contacts.
    key: "page.find",
    kind: "page",
    label: "Find people",
    description: "Research anyone outside your network before you reach out or meet.",
    href: "/find",
    comingSoon: true,
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
    comingSoon: true,
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

/**
 * Ambient controls that belong to no single page.
 *
 * `widget.feedback` is the only member so far. Deliberately NOT `alwaysVisible`, unlike the
 * billing and export escape hatches: those exist so nobody can be locked out of their own
 * account, whereas feedback is a channel Orbit offers and may reasonably want to close —
 * during a migration, or while nobody is reading the console.
 */
const WIDGETS: Surface[] = [
  {
    key: "widget.feedback",
    kind: "widget",
    label: "Feedback",
    description:
      "The \u201cSend feedback\u201d button, its form, and the entries it writes to /admin/feedback.",
  },
];

/**
 * Capabilities that live inside other pages rather than being pages themselves. Hiding one
 * removes every entry point to it and makes its server actions refuse (`requireUserForSurface`).
 */
export const COMPOSE_SURFACE_KEY = "feature.compose";
export const OUTLOOK_SEND_SURFACE_KEY = "feature.outlook-send";
export const REPLY_INBOX_SURFACE_KEY = "feature.reply-inbox";
/** The key the chat-imports feature (WhatsApp / iMessage exports) gates on. */
export const CHAT_IMPORTS_SURFACE_KEY = "feature.chat-imports";
/** Cloud notes: watch Drive/OneDrive for meeting notes, and the /capture Drive & OneDrive tab. */
export const CLOUD_NOTES_SURFACE_KEY = "feature.cloud-notes";
const FEATURES: Surface[] = [
  {
    key: COMPOSE_SURFACE_KEY,
    kind: "feature",
    label: "Compose email",
    description: "Write and send email to anyone from a contact's page or ⌘K, from your own mailbox.",
    comingSoon: true,
  },
  {
    key: OUTLOOK_SEND_SURFACE_KEY,
    kind: "feature",
    label: "Send from Outlook",
    description: "Send Orbit email from a connected Outlook or Microsoft 365 mailbox (Mail.Send).",
    // Until the privacy page discloses Mail.Send (direct-email P3, Task 8).
    comingSoon: true,
  },
  {
    key: REPLY_INBOX_SURFACE_KEY,
    kind: "feature",
    label: "Reply to inbox threads",
    description: "Compose can reply to the latest email with a contact found in your mailbox (Gmail read / Mail.Read).",
    // Until the privacy page discloses this use of the read scopes (direct-email P5).
    comingSoon: true,
  },
  {
    key: CHAT_IMPORTS_SURFACE_KEY,
    kind: "feature",
    label: "Chat imports (WhatsApp, iMessage)",
    description:
      "Upload WhatsApp and iMessage exports for relationship analysis. Hidden until the privacy policy discloses chat content.",
    comingSoon: true,
  },
  {
    key: CLOUD_NOTES_SURFACE_KEY,
    kind: "feature",
    label: "Cloud notes (Drive & OneDrive)",
    description:
      "Finds meeting notes in Google Drive or OneDrive, offers to extract them, and adds the Drive & OneDrive tab on Capture.",
    // Google's drive.readonly is restricted: until CASA passes only consent-screen test users can grant it.
    comingSoon: true,
  },
];

const SETTINGS: Surface[] = SETTINGS_SECTIONS.map((section) => {
  const reason = SETTINGS_LOCKED[section.id];
  return {
    key: `settings.${section.id.replace(/^settings-/, "")}`,
    kind: "settings" as const,
    label: section.label,
    description:
      section.group === "integrations"
        ? `The ${section.label} tab in Settings → Integrations.`
        : `The ${section.label} section on the settings page.`,
    settingsId: section.id,
    ...(reason ? { alwaysVisible: true as const, reason } : {}),
  };
});

export const SURFACES: Surface[] = [...PAGES, ...DASHBOARD_CARDS, ...WIDGETS, ...FEATURES, ...SETTINGS];

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

/**
 * The plan a coming-soon surface will unlock on, said on its screen and in the nav tooltip.
 * Every one is Pro today (Jason, Oct 2026). Only Outreach is gated in code so far — Radar and
 * Events need a `FeatureKey` + `requireEntitlement` before they ship, or this copy over-promises.
 */
export const COMING_SOON_UNLOCK_PLAN: PurchasablePlan = "orbit";

/** Page and feature surfaces that ship as announced-but-not-released, before any operator override. */
export const DEFAULT_COMING_SOON_KEYS: ReadonlySet<string> = new Set(
  SURFACES.filter((s) => s.comingSoon).map((s) => s.key)
);

/**
 * Operator overrides of the default, stored as extra rows in `app_surface_flags` so no
 * schema change is needed: `soon:<key>` marks a page coming soon, `live:<key>` releases one
 * the code ships as coming soon. Absent both, the code default stands.
 */
export const SOON_FLAG_PREFIX = "soon:";
export const LIVE_FLAG_PREFIX = "live:";

/** Whether a page can be marked coming soon at all — never the escape-hatch pages. */
export function canMarkComingSoon(key: string): boolean {
  const surface = BY_KEY.get(key);
  return surface?.kind === "page" && surface.alwaysVisible !== true;
}

/** The default set with the operator's override rows applied. Pure; the server reads the rows. */
export function effectiveComingSoonKeys(flagRows: Iterable<string>): Set<string> {
  const keys = new Set(DEFAULT_COMING_SOON_KEYS);
  const rows = [...flagRows];
  for (const row of rows) {
    if (row.startsWith(SOON_FLAG_PREFIX)) {
      const key = row.slice(SOON_FLAG_PREFIX.length);
      if (canMarkComingSoon(key)) keys.add(key);
    }
  }
  for (const row of rows) {
    if (row.startsWith(LIVE_FLAG_PREFIX)) keys.delete(row.slice(LIVE_FLAG_PREFIX.length));
  }
  return keys;
}

/**
 * The operator's sidebar order, stored as ONE more row in `app_surface_flags`:
 * `order:page.a,page.b,...`. Like the coming-soon overrides, this avoids a schema change.
 */
export const ORDER_FLAG_PREFIX = "order:";

/**
 * Tier rules: `tiers:<pageKey>:<plan,plan>` — the plans allowed to open that page. No row
 * means every plan may. One more row shape in `app_surface_flags`, like the overrides above,
 * so limiting a page to some tiers needs no schema change.
 */
export const TIERS_FLAG_PREFIX = "tiers:";

/** Pages an operator may limit to some tiers: the same set that can be marked coming soon. */
export const canTierLock = canMarkComingSoon;

/** `tiers:` rows → page key → allowed plans. Pure; ignores malformed or unknown rows. */
export function parseTierRules(flagRows: Iterable<string>): Map<string, Plan[]> {
  const rules = new Map<string, Plan[]>();
  for (const row of flagRows) {
    if (!row.startsWith(TIERS_FLAG_PREFIX)) continue;
    const rest = row.slice(TIERS_FLAG_PREFIX.length);
    const split = rest.lastIndexOf(":");
    if (split === -1) continue;
    const key = rest.slice(0, split);
    const listed = rest.slice(split + 1).split(",");
    const plans = PLANS.filter((p) => listed.includes(p));
    if (canTierLock(key) && plans.length > 0) rules.set(key, plans);
  }
  return rules;
}

/**
 * The pages `plan` may not open under `rules`, each with the plans that may. What the nav
 * locks and the gates refuse for one viewer.
 */
export function tierLockedFor(
  rules: ReadonlyMap<string, readonly Plan[]>,
  plan: Plan
): Map<string, Plan[]> {
  const locked = new Map<string, Plan[]>();
  for (const [key, plans] of rules) if (!plans.includes(plan)) locked.set(key, [...plans]);
  return locked;
}

/** The plan a tier-limited page's nav tag names: the cheapest paid plan that opens it. */
export function tierTagPlan(plans: readonly Plan[]): Plan {
  return plans.find((p) => p !== "free") ?? plans[0];
}

/** "Radar — Max and Lifetime only", the tag's tooltip. */
export function tierTagTitle(label: string, plans: readonly Plan[]): string {
  return `${label} — ${plans.map((p) => PLAN_SHORT_LABELS[p]).join(" and ")} only`;
}

/**
 * `items` sorted by the operator's order (surface keys). Items the order does not mention —
 * a nav entry added after the operator last saved — keep their default relative order after
 * the listed ones. Stable, so an empty order returns the code's own order.
 */
export function orderNavItems<T extends { href: string }>(
  items: readonly T[],
  order: readonly string[]
): T[] {
  const rank = (item: T) => {
    const key = surfaceKeyForHref(item.href);
    const i = key === null ? -1 : order.indexOf(key);
    return i === -1 ? order.length : i;
  };
  return items
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.item);
}

/**
 * Surfaces elsewhere in the app that only make sense once a coming-soon page is released.
 * They are hidden from exactly the viewers who get the coming-soon screen, so nothing
 * points at a page that is closed.
 */
export const COMING_SOON_COMPANIONS: Readonly<Record<string, readonly string[]>> = {
  "page.outreach": ["dashboard.outreach-performance", "settings.outreach"],
  [COMPOSE_SURFACE_KEY]: ["settings.email"],
};

/** True when `href` is a page in `soon` (the effective set; defaults to the code defaults). */
export function isHrefComingSoon(
  href: string,
  soon: ReadonlySet<string> = DEFAULT_COMING_SOON_KEYS
): boolean {
  const key = surfaceKeyForHref(href);
  return key !== null && soon.has(key);
}

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

/** The key the feedback widget and its three entry points all gate on. */
export const FEEDBACK_SURFACE_KEY = "widget.feedback";
