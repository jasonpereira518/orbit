"use client";

import { BulkNotesPanel } from "@/components/chat/bulk-notes-panel";

export function CaptureStep({
  hasApiKey,
  onSaved,
}: {
  hasApiKey: boolean;
  onSaved: (count: number) => void;
}) {
  return (
    <BulkNotesPanel
      compact
      hasApiKey={hasApiKey}
      onSaved={(res) => onSaved(res.created + res.updated)}
    />
  );
}
