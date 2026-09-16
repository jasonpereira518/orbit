"use client";

import dynamic from "next/dynamic";

const InteractionDetailSheet = dynamic(
  () =>
    import("@/components/contacts/interaction-detail-sheet").then((m) => ({
      default: m.InteractionDetailSheet,
    })),
  { ssr: false, loading: () => null }
);

export function InteractionDetailSheetLazy({
  interactionId,
  canReorder,
  onReorder,
  canStep,
  onStep,
  onOpenChange,
}: {
  interactionId: string | null;
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
      canReorder={canReorder}
      onReorder={onReorder}
      canStep={canStep}
      onStep={onStep}
      onOpenChange={onOpenChange}
    />
  );
}
