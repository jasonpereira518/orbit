"use client";

import dynamic from "next/dynamic";

/**
 * Start fetching the sheet's code before it is opened — on hover or focus of whatever opens
 * it — so the first open does not sit on an empty frame while the chunk downloads. Safe to
 * call any number of times: the module loads once, and `dynamic()` below resolves to the same
 * module. A failed preload is swallowed; opening the sheet retries the import as it always did.
 *
 * The path is written out twice on purpose: Next matches a `dynamic()` call to its chunk by
 * the literal `import()` inside it, so that one cannot be factored out into a shared loader.
 */
export function preloadFollowUpDraftSheet() {
  void import("@/components/follow-up/follow-up-draft-sheet").catch(() => {});
}

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
