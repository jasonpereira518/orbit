"use client";

import { AiKeyPanel } from "@/components/settings/ai-key-panel";

export function WizardAiKey({
  onVerified,
  onSkip,
}: {
  onVerified: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        So Orbit can draft follow-ups and answer questions about the people
        you just added.
      </p>
      <AiKeyPanel variant="wizard" onVerified={onVerified} onSkip={onSkip} />
    </div>
  );
}
