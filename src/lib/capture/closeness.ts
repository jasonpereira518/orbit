/**
 * The 1–5 closeness vocabulary, in one place.
 *
 * The review card's segmented control, the edit dialog, and BOTH people-pass prompts in
 * `src/lib/ai.ts` read from this table, so the words the model is asked to score against
 * are the words the person then sees on the card. Before this file the legend lived only
 * inside the prompt strings and the UI showed a bare number input.
 *
 * Pure: no DB, no React — importable from client components and prompt builders alike.
 */
export type ClosenessLevel = 1 | 2 | 3 | 4 | 5;

export const CLOSENESS_LEVELS: ReadonlyArray<{
  value: ClosenessLevel;
  /** Short label for the card's segmented control. */
  label: string;
  /** The prompt legend wording — kept terse because it is repeated in two prompts. */
  legend: string;
}> = [
  { value: 1, label: "Barely know", legend: "barely know" },
  { value: 2, label: "Met once", legend: "met once" },
  { value: 3, label: "Real conversation", legend: "real conversation" },
  { value: 4, label: "Strong", legend: "strong" },
  { value: 5, label: "Mentor / advocate", legend: "mentor/advocate" },
];

/** `1=barely know, 2=met once, …` — the exact legend both prompts carry. */
export function closenessLegend(): string {
  return CLOSENESS_LEVELS.map((l) => `${l.value}=${l.legend}`).join(", ");
}

export function clampCloseness(value: number | null | undefined, fallback: ClosenessLevel = 2): ClosenessLevel {
  if (value == null || Number.isNaN(value)) return fallback;
  const n = Math.round(value);
  if (n < 1) return 1;
  if (n > 5) return 5;
  return n as ClosenessLevel;
}

export function closenessLabel(value: number | null | undefined): string {
  const level = clampCloseness(value);
  return CLOSENESS_LEVELS.find((l) => l.value === level)?.label ?? "";
}
