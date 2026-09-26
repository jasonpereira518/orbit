"use client";

import dynamic from "next/dynamic";
import type { InteractionPreview } from "@/components/contacts/interaction-detail-sheet";

const loadSheet = () => import("@/components/contacts/interaction-detail-sheet");

const InteractionDetailSheet = dynamic(
  () => loadSheet().then((m) => ({ default: m.InteractionDetailSheet })),
  { ssr: false, loading: () => null }
);

/**
 * Fetch the sheet's code ahead of the click — on row hover/focus and when the timeline is
 * idle — so opening it never waits on a chunk with nothing on screen.
 */
export function preloadInteractionDetailSheet() {
  void loadSheet().catch(() => {});
}

export function InteractionDetailSheetLazy({
  interactionId,
  preview,
  canReorder,
  onReorder,
  canStep,
  onStep,
  onOpenChange,
}: {
  interactionId: string | null;
  /** What the timeline row already knows, for the header while the detail loads. */
  preview?: InteractionPreview | null;
  canReorder: { up: boolean; down: boolean };
  onReorder: (direction: -1 | 1) => void;
  /** Whether a newer/older interaction exists to step to. */
  canStep: { newer: boolean; older: boolean };
  /** -1 steps to the newer interaction, 1 to the older — matching the timeline's order. */
  onStep: (direction: -1 | 1) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <InteractionDetailSheet
      interactionId={interactionId}
      preview={preview}
      canReorder={canReorder}
      onReorder={onReorder}
      canStep={canStep}
      onStep={onStep}
      onOpenChange={onOpenChange}
    />
  );
}
