"use client";

import { BulkNotesPanel } from "@/components/chat/bulk-notes-panel";

export function WizardCapture({
  hasApiKey,
  onKeyVerified,
  onSaved,
}: {
  hasApiKey: boolean;
  onKeyVerified?: () => void;
  onSaved: (count: number) => void;
}) {
  return (
    <BulkNotesPanel
      compact
      hasApiKey={hasApiKey}
      onApiKeyVerified={onKeyVerified}
      onSaved={(res) => onSaved(res.created + res.updated)}
    />
  );
}
