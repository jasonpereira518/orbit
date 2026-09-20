"use client";

import dynamic from "next/dynamic";
import type { AiAccessDenial } from "@/lib/managed-ai-policy";

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
  aiReason = null,
  open,
  onOpenChange,
}: {
  contactId: string;
  contactName: string;
  hasApiKey: boolean;
  aiReason?: AiAccessDenial | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <LogInteractionSheet
      contactId={contactId}
      contactName={contactName}
      hasApiKey={hasApiKey}
      aiReason={aiReason}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}
