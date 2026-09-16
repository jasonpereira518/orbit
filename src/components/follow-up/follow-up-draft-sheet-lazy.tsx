"use client";

import dynamic from "next/dynamic";

const FollowUpDraftSheet = dynamic(
  () =>
    import("@/components/follow-up/follow-up-draft-sheet").then((m) => ({
      default: m.FollowUpDraftSheet,
    })),
  { ssr: false, loading: () => null }
);

export function FollowUpDraftSheetLazy({
  open,
  onOpenChange,
  contactId,
  contactName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  contactName: string;
}) {
  return (
    <FollowUpDraftSheet
      open={open}
      onOpenChange={onOpenChange}
      contactId={contactId}
      contactName={contactName}
    />
  );
}
