"use client";

import dynamic from "next/dynamic";

const LogInteractionSheet = dynamic(
  () =>
    import("@/components/contacts/log-interaction-sheet").then((m) => ({
      default: m.LogInteractionSheet,
    })),
  { ssr: false, loading: () => null }
);

export function LogInteractionSheetLazy({
  contactId,
  contactName,
  hasApiKey,
  open,
  onOpenChange,
}: {
  contactId: string;
  contactName: string;
  hasApiKey: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <LogInteractionSheet
      contactId={contactId}
      contactName={contactName}
      hasApiKey={hasApiKey}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}
