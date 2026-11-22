/**
 * How far a Radar run is, for "Refresh now". Pure (no db), so a smoke can pin it under plain Node.
 *
 * A run moves through these stages in order. A stage a run skips (no AI key, a cached rerank, a
 * plan without explanations) is never entered, so the next stage's mark jumps the bar past it.
 * Labels are written here, server-side, and say only what the run is doing; the weights are
 * estimates from each stage's typical cost, to be tuned against real runs.
 */
export const RUN_STAGES = [
  { key: "read", label: "Reading your network and email", weight: 25 },
  { key: "projects", label: "Checking your active projects", weight: 5 },
  { key: "connect", label: "Linking your notes to people you know", weight: 10 },
  { key: "people", label: "Finding who needs you", weight: 5 },
  { key: "score", label: "Scoring and checking proof", weight: 5 },
  { key: "editor", label: "Editing your plan with AI", weight: 20 },
  { key: "save", label: "Saving your plan", weight: 5 },
  { key: "autopilot", label: "Running autopilot", weight: 3 },
  { key: "drafts", label: "Writing drafts", weight: 20 },
  { key: "wrap", label: "Wrapping up", weight: 2 },
] as const;

export type RunStageKey = (typeof RUN_STAGES)[number]["key"];

/** 0-99 while a stage is under way (100 is only ever written when the run finishes). */
export function progressAt(stage: RunStageKey, done?: number, total?: number): number {
  let before = 0;
  for (const s of RUN_STAGES) {
    if (s.key === stage) {
      const share = total && total > 0 ? Math.min(1, Math.max(0, (done ?? 0) / total)) : 0;
      return Math.min(99, Math.round(before + s.weight * share));
    }
    before += s.weight;
  }
  return 0;
}

export function stageLabel(stage: RunStageKey): string {
  return RUN_STAGES.find((s) => s.key === stage)!.label;
}

/** "3 of 5" for a counted stage; null when the stage has no count. */
export function detailFor(done?: number, total?: number): string | null {
  return total && total > 0 ? `${Math.min(done ?? 0, total)} of ${total}` : null;
}
