import { VOICE_PAGES, type VoicePage } from "@/lib/voice/policy";
import { TOUR_ANCHORS, TOUR_ANCHOR_ATTR, TOUR_ANCHOR_LABELS, type TourAnchorId } from "@/lib/tour/tour-anchors";

/**
 * What Cosmo knows about the screen: which page, which record, and which labelled controls are
 * on show. Never the page's text or a screenshot — those can hold anything a record says, so
 * they would be an injection path and a privacy leak. Labels come from TOUR_ANCHOR_LABELS.
 * Client-safe; `readScreen` alone touches the DOM.
 */
export type ScreenSnapshot = { page: VoicePage | null; id: string | null; targets: TourAnchorId[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TARGETS = 20;

/** The voice page and record id a URL path shows, if it is one Cosmo can open. */
export function pageForPath(pathname: string): { page: VoicePage | null; id: string | null } {
  const path = pathname.replace(/\/+$/, "") || "/";
  for (const [page, pattern] of Object.entries(VOICE_PAGES) as Array<[VoicePage, string]>) {
    if (!pattern.includes(":id")) {
      if (path === pattern) return { page, id: null };
      continue;
    }
    const [base] = pattern.split("/:id");
    const rest = path.startsWith(`${base}/`) ? path.slice(base.length + 1) : "";
    if (UUID.test(rest)) return { page, id: rest };
  }
  return { page: null, id: null };
}

/**
 * One line for the model, from whatever the browser sent: only a known page, a real id and
 * registered controls survive. Null when there is nothing trustworthy to say.
 */
export function describeScreen(screen: unknown): string | null {
  if (!screen || typeof screen !== "object") return null;
  const { page, id, targets } = screen as Record<string, unknown>;
  if (typeof page !== "string" || !Object.hasOwn(VOICE_PAGES, page)) return null;
  const record = typeof id === "string" && UUID.test(id) ? ` (id ${id})` : "";
  const known = new Set<TourAnchorId>();
  if (Array.isArray(targets))
    for (const target of targets)
      if (typeof target === "string" && Object.hasOwn(TOUR_ANCHORS, target) && known.size < MAX_TARGETS)
        known.add(target as TourAnchorId);
  const visible = [...known].map((target) => TOUR_ANCHOR_LABELS[target]);
  return `The user is on the ${page.replace("_", " ")} page${record}.${visible.length ? ` On screen: ${visible.join(", ")}.` : ""}`;
}

/** The screen right now: the URL, and the registered controls that are actually visible. */
export function readScreen(): ScreenSnapshot {
  const { page, id } = pageForPath(window.location.pathname);
  const targets = new Set<TourAnchorId>();
  for (const el of document.querySelectorAll<HTMLElement>(`[${TOUR_ANCHOR_ATTR}]`)) {
    const target = el.getAttribute(TOUR_ANCHOR_ATTR);
    const shown = typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0;
    if (shown && target && Object.hasOwn(TOUR_ANCHORS, target)) targets.add(target as TourAnchorId);
  }
  return { page, id, targets: [...targets].slice(0, MAX_TARGETS) };
}
