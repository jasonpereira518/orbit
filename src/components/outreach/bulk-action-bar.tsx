"use client";

import { useMemo, useState, useTransition } from "react";
import { Copy, ExternalLink, Send } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  bulkSendOutreach,
  markMessageAction,
  previewBulkSendQuality,
  updateProspectSelection,
} from "@/actions/outreach";
import { Button } from "@/components/ui/button";
import {
  buildLinkedInUrl,
  buildMailtoUrl,
  buildSmsUrl,
  canAutoSend,
  canOpenInApp,
} from "@/lib/outreach-channels";
import type { OutreachChannel } from "@/lib/outreach-types";
import { DangerSendDialog } from "@/components/outreach/danger-send-dialog";

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

  function refresh() {
    onUpdated?.();
  }

  function handleSelectAll() {
    start(async () => {
      await updateProspectSelection({
        campaignId,
        prospectIds: rows.map((r) => r.prospectId),
        status: "selected",
      });
      refresh();
    });
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
      for (const row of activeRows) {
        await markMessageAction({ messageId: row.messageId, status: "copied" });
      }
      toast.success(`Copied ${activeRows.length} drafts`);
      refresh();
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
      for (const row of activeRows) {
        if (canOpenInApp(row.channel, row)) {
          await markMessageAction({ messageId: row.messageId, status: "opened" });
        }
      }
      toast.success(`Opened ${activeRows.length} apps`);
      refresh();
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
        toast.error(err instanceof Error ? err.message : "Quality check failed");
      }
    });
  }

  function handleBulkSend() {
    start(async () => {
      try {
        const result = await bulkSendOutreach({
          campaignId,
          messageIds: sendable.map((r) => r.messageId),
          ignoreWarnings: ignoreWarnings || !qualityNote,
        });
        toast.success(`Sent ${result.sent}, failed ${result.failed}`);
        setDangerOpen(false);
        refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Bulk send failed";
        if (message.startsWith("Quality warnings:")) {
          setQualityNote(message);
          setIgnoreWarnings(true);
          toast.error("Review warnings, then confirm send again");
          return;
        }
        toast.error(message);
      }
    });
  }

  if (!rows.length) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-muted/30 p-3">
        <span className="text-sm text-muted-foreground">
          {selectedProspectIds.length} selected — review & personalize before sending
        </span>
        <Button size="sm" variant="outline" onClick={handleSelectAll} disabled={pending}>
          Select all
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCopyAll}
          disabled={pending || !activeRows.length}
        >
          <Copy className="mr-1 h-3.5 w-3.5" />
          Copy selected
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleOpenAll}
          disabled={pending || !activeRows.length}
        >
          <ExternalLink className="mr-1 h-3.5 w-3.5" />
          Open selected
        </Button>
        {sendable.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="border-destructive text-destructive hover:bg-destructive/10"
            onClick={openSendDialog}
            disabled={pending}
          >
            <Send className="mr-1 h-3.5 w-3.5" />
            Send selected ({sendable.length})
          </Button>
        )}
      </div>

      <DangerSendDialog
        open={dangerOpen}
        onOpenChange={setDangerOpen}
        recipientCount={sendable.length}
        channel="email/SMS"
        onConfirm={handleBulkSend}
        pending={pending}
      />
      {dangerOpen && qualityNote && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{qualityNote}</p>
      )}
    </div>
  );
}
