/**
 * Radar's focus mode shortcuts: what a key means, and when a key must be left alone. Pure,
 * so `scripts/smoke-radar-score.ts` pins it without a browser; the listener is
 * `components/radar/use-radar-keys.ts`.
 *
 * The same guard as the reminders queue (`triage-keys.ts`): single letters would fire while
 * someone types, so every editable target, any open dialog or menu, and every modified key
 * is refused.
 */
import type { TriageKeyInput } from "@/lib/triage-keys";

export type RadarKeyCommand = "next" | "prev" | "schedule" | "draft" | "dismiss" | "snooze";

const KEYMAP: Record<string, RadarKeyCommand> = {
  j: "next",
  ArrowRight: "next",
  k: "prev",
  ArrowLeft: "prev",
  s: "schedule",
  d: "draft",
  x: "dismiss",
  z: "snooze",
};

/** For the hint line under the card, in reading order. */
export const RADAR_SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["j", "k"], label: "next / previous" },
  { keys: ["s"], label: "follow up in a week" },
  { keys: ["d"], label: "draft" },
  { keys: ["z"], label: "snooze a week" },
  { keys: ["x"], label: "dismiss" },
];

export function radarKeyFor(input: TriageKeyInput): RadarKeyCommand | null {
  if (input.metaKey || input.ctrlKey || input.altKey) return null;
  if (input.overlayOpen) return null;
  const tag = input.targetTag;
  if (input.targetEditable || tag === "input" || tag === "textarea" || tag === "select") return null;
  return KEYMAP[input.key] ?? null;
}
