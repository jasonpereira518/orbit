import { VOICE_PAGES, type VoicePage } from "@/lib/voice/policy";
import { TOUR_ANCHORS, TOUR_ANCHOR_LABELS, tourAnchorSelector, type TourAnchorId } from "@/lib/tour/tour-anchors";

/**
 * The page each pointable control lives on. Null when a plain visit won't show it (a record's
 * page, Capture's Imports tab): Cosmo must open that first. Typed against the registry, so a new
 * anchor without an entry is a compile error.
 */
export const ANCHOR_PAGES: Record<TourAnchorId, VoicePage | null> = {
  "dashboard.stats": "dashboard",
  "contacts.search": "contacts",
  "contacts.row": "contacts",
  "contact.log-interaction": null,
  "capture.notes": "capture",
  "capture.extract": "capture",
  "capture.keep": "capture",
  "reminders.row-done": "reminders",
  "reminders.rail-today": "reminders",
  "chat.suggestions": "chat",
  "chat.composer": "chat",
  "graph.stage": "constellation",
  "graph.show-all": "constellation",
  "imports.connections": null,
  "imports.dropzone": null,
  "reminders.new": "reminders",
  "contacts.add": "contacts",
  "compose.email": null,
};

const PAGE_NAMES: Partial<Record<VoicePage, string>> = { constellation: "Constellation", find_people: "Find people" };
const pageName = (page: VoicePage) => PAGE_NAMES[page] ?? page[0].toUpperCase() + page.slice(1);

/** One step of a pointing walk: go there (a nav link), or press this. */
export type PointStep =
  | { kind: "nav"; page: VoicePage; selector: string; label: string }
  | { kind: "target"; id: TourAnchorId; selector: string; label: string };

export const MAX_POINT_TARGETS = 4;

/**
 * The steps to point at `targets` from the current screen. Ids only (never a selector the model
 * wrote); unknown ones are refused, as is a control that needs a record or tab open first.
 */
export function planPointing(
  targets: unknown,
  screen: { page: VoicePage | null; targets: readonly TourAnchorId[] },
): { steps: PointStep[] } | { error: string } {
  if (!Array.isArray(targets) || targets.length === 0) return { error: "Give point_at one to four control ids." };
  if (targets.length > MAX_POINT_TARGETS) return { error: `Point at ${MAX_POINT_TARGETS} controls at most.` };
  const steps: PointStep[] = [];
  let page = screen.page;
  for (const target of targets) {
    if (typeof target !== "string" || !Object.hasOwn(TOUR_ANCHORS, target))
      return { error: `Unknown control "${String(target).slice(0, 60)}". Use an id from the list or the screen.` };
    const id = target as TourAnchorId;
    const label = TOUR_ANCHOR_LABELS[id];
    const home = ANCHOR_PAGES[id];
    const onScreen = page === screen.page && screen.targets.includes(id);
    if (!onScreen && home !== page) {
      if (home === null)
        return { error: `The ${label} is only on a page you have to open first (open_page with the record or tab). Then point.` };
      const href = VOICE_PAGES[home];
      steps.push({
        kind: "nav",
        page: home,
        selector: `[data-app-sidebar] a[href="${href}"], nav a[href="${href}"]`,
        label: `${pageName(home)} in the menu`,
      });
      page = home;
    }
    steps.push({ kind: "target", id, selector: tourAnchorSelector(id), label });
  }
  return { steps };
}

/** The pointable controls, for the prompt: `id (label)`. */
export function pointingCatalog(): string {
  return (Object.keys(TOUR_ANCHORS) as TourAnchorId[]).map((id) => `${id} (${TOUR_ANCHOR_LABELS[id]})`).join(", ");
}
