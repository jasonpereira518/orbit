import { TOUR_ANCHORS, TOUR_ANCHOR_ACTIONS, TOUR_ANCHOR_LABELS, type TourAnchorId } from "@/lib/tour/tour-anchors";
import { planPointing, type PointStep } from "./pointing";
import type { VoicePage } from "@/lib/voice/policy";

/**
 * Cosmo driving the screen: `click` and `type_into`. The rules live here, in app code, never in
 * the model: only Orbit's registered controls (ids, never a selector or page text), only the
 * ones marked for that action in TOUR_ANCHOR_ACTIONS, never one that saves, sends, deletes or
 * accepts (those Cosmo points at and you click), a cap per call, and nothing at all once a
 * lookup in the call looked like an injection. Pure (scripts/smoke-cosmo-actions.ts); the
 * browser side that actually presses and types is in voice-engine.tsx.
 */
export const MAX_ACTIONS_PER_CALL = 30;
export const MAX_TYPED_CHARS = 2000;

export type ActionKind = "click" | "type";
export type ActionCounts = { click: number; type: number };

export function planAction(
  kind: ActionKind,
  target: unknown,
  screen: { page: VoicePage | null; targets: readonly TourAnchorId[] },
  used: ActionCounts,
  tainted: boolean,
): { steps: PointStep[] } | { error: string } {
  if (tainted)
    return { error: "Clicking and typing are off for the rest of this call (a lookup returned text that looked like instructions). Point instead." };
  if (used[kind] >= MAX_ACTIONS_PER_CALL)
    return { error: `That's the most ${kind === "click" ? "clicks" : "typing"} Cosmo does in one call. Point instead.` };
  if (typeof target !== "string" || !Object.hasOwn(TOUR_ANCHORS, target))
    return { error: `Unknown control "${String(target).slice(0, 60)}". Use an id from the control list or the screen.` };
  const id = target as TourAnchorId;
  const label = TOUR_ANCHOR_LABELS[id];
  const action = TOUR_ANCHOR_ACTIONS[id];
  if (action === "confirm")
    return { error: `The ${label} saves or sends, so the user presses it: point_at it and tell them to click when it looks right.` };
  if (action === "view") return { error: `The ${label} isn't something to press. Point at it instead.` };
  if (action !== kind)
    return { error: kind === "click" ? `The ${label} is a text field: use type_into.` : `The ${label} isn't a text field: use click.` };
  return planPointing([id], screen);
}

/** What Cosmo may type: plain text, no control characters, capped. */
export function cleanTyped(text: unknown): { text: string } | { error: string } {
  if (typeof text !== "string" || !text.trim()) return { error: "type_into needs the text to type." };
  const plain = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (plain.length > MAX_TYPED_CHARS) return { error: `That's too long to type (${MAX_TYPED_CHARS} characters at most).` };
  return { text: plain };
}

/**
 * The controls Cosmo can press or fill, for the prompt: ids only, by action (their labels are
 * already in the pointing list, and the prompt has a hard size budget).
 */
export function actionsCatalog(): { click: string; type: string } {
  const ids = Object.keys(TOUR_ANCHORS) as TourAnchorId[];
  const list = (kind: ActionKind) => ids.filter((id) => TOUR_ANCHOR_ACTIONS[id] === kind).join(", ");
  return { click: list("click"), type: list("type") };
}
