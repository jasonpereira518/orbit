"use client";

import { useMemo, useState, useTransition } from "react";
import { Copy, ExternalLink, Send, X } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  bulkSendOutreach,
  markMessageAction,
  previewBulkSendQuality,
  updateProspectSelection,
} from "@/actions/outreach";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  buildLinkedInUrl,
  buildMailtoUrl,
  buildSmsUrl,
  canAutoSend,
  canOpenInApp,
} from "@/lib/outreach-channels";
import type { OutreachChannel } from "@/lib/outreach-types";
import { DangerSendDialog } from "@/components/outreach/danger-send-dialog";
import { UserFacingError, friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

type Row = {
  prospectId: string;
  prospectName?: string;
  messageId: string;
  channel: OutreachChannel;
  subject: string | null;
  body: string;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
};

/**
 * Select-all and the bulk actions for a selection — the same shape as the reminders
 * queue's bar: a tri-state checkbox, a count, the actions, and "clear" on the right. It
 * reserves its height whether or not anything is selected, so the first row does not
 * jump down as someone reaches for the second checkbox.
 */
export function BulkActionBar({
  campaignId,
  rows,
  selectedProspectIds,
  onUpdated,
}: {
  campaignId: string;
  rows: Row[];
  selectedProspectIds: string[];
  onUpdated?: () => void;
}) {
  const [pending, start] = useTransition();
  const [dangerOpen, setDangerOpen] = useState(false);
  const [qualityNote, setQualityNote] = useState<string | null>(null);
  const [ignoreWarnings, setIgnoreWarnings] = useState(false);

  const activeRows = useMemo(
    () => rows.filter((r) => selectedProspectIds.includes(r.prospectId)),
    [rows, selectedProspectIds]
  );

  const sendable = activeRows.filter((r) => canAutoSend(r.channel, r));
  const selecting = activeRows.length > 0;
  const allSelected = rows.length > 0 && activeRows.length === rows.length;

  function refresh() {
    onUpdated?.();
  }

  function setSelection(prospectIds: string[], status: "selected" | "suggested") {
    start(async () => {
      try {
        await updateProspectSelection({ campaignId, prospectIds, status });
        refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  }

  function handleToggleAll() {
    if (allSelected) setSelection(rows.map((r) => r.prospectId), "suggested");
    else setSelection(rows.map((r) => r.prospectId), "selected");
  }

  function handleClear() {
    setSelection(activeRows.map((r) => r.prospectId), "suggested");
  }

  function handleCopyAll() {
    const text = activeRows
      .map((r) => {
        const header =
          r.channel === "email" && r.subject
            ? `Subject: ${r.subject}\n`
            : "";
        return `--- ${r.prospectName || r.prospectId} ---\n${header}${r.body}`;
      })
      .join("\n\n");
    navigator.clipboard.writeText(text);
    start(async () => {
      try {
        for (const row of activeRows) {
          await markMessageAction({ messageId: row.messageId, status: "copied" });
        }
        toast.success(`Copied ${activeRows.length} drafts`);
        refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  }

  function handleOpenAll() {
    for (const row of activeRows) {
      if (!canOpenInApp(row.channel, row)) continue;
      if (row.channel === "email" && row.email) {
        window.open(
          buildMailtoUrl({ email: row.email, subject: row.subject, body: row.body }),
          "_blank"
        );
      } else if (row.channel === "sms" && row.phone) {
        window.open(buildSmsUrl({ phone: row.phone, body: row.body }), "_blank");
      } else if (row.channel === "linkedin" && row.linkedinUrl) {
        window.open(buildLinkedInUrl(row.linkedinUrl), "_blank");
      }
    }
    start(async () => {
      try {
        for (const row of activeRows) {
          if (canOpenInApp(row.channel, row)) {
            await markMessageAction({ messageId: row.messageId, status: "opened" });
          }
        }
        toast.success(`Opened ${activeRows.length} apps`);
        refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  }

  function openSendDialog() {
    start(async () => {
      try {
        const quality = await previewBulkSendQuality({
          campaignId,
          messageIds: sendable.map((r) => r.messageId),
        });
        if (quality.blocking.length) {
          toast.error(quality.blocking[0].message);
          return;
        }
        if (quality.warnings.length) {
          setQualityNote(
            `${quality.warnings.length} quality warning${
              quality.warnings.length === 1 ? "" : "s"
            }: ${quality.warnings[0].message}`
          );
          setIgnoreWarnings(true);
        } else {
          setQualityNote(null);
          setIgnoreWarnings(true);
        }
        setDangerOpen(true);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t check those drafts — try again?"));
      }
    });
  }

  /**
   * Awaited by the confirm dialog: it closes on success and shows a thrown message inline.
   * A send that is waiting on the person (a new quality warning) throws too, so the dialog
   * stays open with the warning for them to confirm again.
   */
  async function sendSelected() {
    const result = await bulkSendOutreach({
      campaignId,
      messageIds: sendable.map((r) => r.messageId),
      ignoreWarnings: ignoreWarnings || !qualityNote,
    });
    if (result.status === "blocked") throw new UserFacingError(result.reason);
    if (result.status === "needs_confirmation") {
      setQualityNote(`Quality warning: ${result.warning}`);
      setIgnoreWarnings(true);
      throw new UserFacingError("Check the warning, then confirm the send again");
    }
    const { sent, failed } = result;
    if (sent === 0 && failed > 0) {
      throw new UserFacingError("None of those sent — try again?");
    }
    if (failed > 0) {
      toast.success(`Sent ${sent} — ${failed} didn’t go through`);
    } else {
      toast.success(`Sent ${sent} ${sent === 1 ? "message" : "messages"}`);
    }
    refresh();
  }

  if (!rows.length) return null;

  return (
    <>
      <div className="flex min-h-10 flex-wrap items-center gap-1 rounded-xl border border-border-subtle bg-card px-3">
        <div className="flex h-6 w-4 items-center">
          <Checkbox
            checked={allSelected}
            indeterminate={selecting && !allSelected}
            disabled={pending}
            onCheckedChange={handleToggleAll}
            aria-label={allSelected ? "Deselect all" : "Select all drafts"}
          />
        </div>
        {selecting ? (
          <>
            <span
              className="ml-2 mr-1 shrink-0 whitespace-nowrap text-xs font-medium tabular-nums text-foreground"
              aria-live="polite"
            >
              {activeRows.length} selected
            </span>
            <Button size="sm" variant="ghost" onClick={handleCopyAll} disabled={pending}>
              <Copy className="size-3.5" />
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={handleOpenAll} disabled={pending}>
              <ExternalLink className="size-3.5" />
              Open
            </Button>
            {sendable.length > 0 && (
              <Button size="sm" variant="destructive" onClick={openSendDialog} disabled={pending}>
                <Send className="size-3.5" />
                Send {sendable.length}
              </Button>
            )}
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear selection"
              title="Clear selection"
              onClick={handleClear}
              disabled={pending}
            >
              <X className="size-3.5" />
            </Button>
          </>
        ) : (
          <div className="ml-2 flex min-w-0 flex-1 items-center text-xs text-muted-foreground">
            {rows.length} draft{rows.length === 1 ? "" : "s"} — select rows to copy, open or send
            them together
          </div>
        )}
      </div>

      <DangerSendDialog
        open={dangerOpen}
        onOpenChange={setDangerOpen}
        recipientCount={sendable.length}
        channel="email/SMS"
        onConfirm={sendSelected}
      >
        {qualityNote && (
          <p role="status" className="text-xs text-warning">
            {qualityNote}
          </p>
        )}
      </DangerSendDialog>
    </>
  );
}
