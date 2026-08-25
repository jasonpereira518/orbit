"use client";

import { RotateCw, XCircle, PlugZap, CalendarOff } from "lucide-react";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import {
  cancelImportAction,
  disconnectIntegrationAction,
  retryImportAction,
  setCalendarFeedEnabledAction,
} from "@/actions/admin";
import { cn } from "@/lib/utils";

/**
 * The per-row repair buttons on `/admin/health`.
 *
 * Each one sits next to the thing it fixes, because the alternative — read the health list,
 * open the inspector, find the row again — is how a triage screen turns into a list nobody
 * acts on.
 */

const ROW_BUTTON =
  "inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground";

export function RetryImportButton({
  targetUserId,
  importId,
  fileName,
}: {
  targetUserId: string;
  importId: string;
  fileName: string | null;
}) {
  return (
    <ConfirmActionDialog
      trigger={
        <button type="button" className={ROW_BUTTON}>
          <RotateCw className="size-3" aria-hidden />
          Retry
        </button>
      }
      title="Retry this import?"
      description={`Re-runs ${fileName ?? "the job"} from where it stopped. Rows already imported are not duplicated — the processor re-reads row status rather than starting over.`}
      confirmLabel="Retry import"
      onConfirm={(reason) =>
        retryImportAction({ targetUserId, importId, reason })
      }
    />
  );
}

export function CancelImportButton({
  targetUserId,
  importId,
}: {
  targetUserId: string;
  importId: string;
}) {
  return (
    <ConfirmActionDialog
      trigger={
        <button type="button" className={ROW_BUTTON}>
          <XCircle className="size-3" aria-hidden />
          Cancel
        </button>
      }
      title="Cancel this import?"
      description="Marks the job cancelled so the user can start a clean one. Contacts already created are kept."
      confirmLabel="Cancel import"
      onConfirm={(reason) =>
        cancelImportAction({ targetUserId, importId, reason })
      }
    />
  );
}

export function DisconnectIntegrationButton({
  targetUserId,
  provider,
}: {
  targetUserId: string;
  provider: "gmail" | "outlook";
}) {
  const label = provider === "gmail" ? "Gmail" : "Outlook";
  return (
    <ConfirmActionDialog
      trigger={
        <button type="button" className={cn(ROW_BUTTON, "hover:text-destructive")}>
          <PlugZap className="size-3" aria-hidden />
          Disconnect
        </button>
      }
      title={`Disconnect ${label}?`}
      description={`Deletes the stored connection so the user can reconnect cleanly. Their ${label} data is untouched, and nothing already imported is removed. They will need to reconnect from Settings themselves.`}
      confirmLabel={`Disconnect ${label}`}
      danger
      onConfirm={(reason) =>
        disconnectIntegrationAction({ targetUserId, provider, reason })
      }
    />
  );
}

export function DisableCalendarFeedButton({
  targetUserId,
  subscriptionId,
  enabled,
  label,
}: {
  targetUserId: string;
  subscriptionId: string;
  enabled: boolean;
  label: string | null;
}) {
  return (
    <ConfirmActionDialog
      trigger={
        <button type="button" className={ROW_BUTTON}>
          <CalendarOff className="size-3" aria-hidden />
          {enabled ? "Disable" : "Enable"}
        </button>
      }
      title={`${enabled ? "Disable" : "Enable"} ${label ?? "this feed"}?`}
      description={
        enabled
          ? "Stops Orbit polling a feed that errors on every sync. The URL is kept, so re-enabling is one click once the user fixes it."
          : "Resumes polling this feed."
      }
      confirmLabel={enabled ? "Disable feed" : "Enable feed"}
      onConfirm={(reason) =>
        setCalendarFeedEnabledAction({
          targetUserId,
          subscriptionId,
          enabled: !enabled,
          reason,
        })
      }
    />
  );
}
