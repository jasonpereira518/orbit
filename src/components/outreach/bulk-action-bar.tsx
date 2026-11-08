"use client";

import { useMemo, useState, useTransition } from "react";
import { Copy, ExternalLink, Send } from "lucide-react";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
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
import { MailMergeDialog } from "@/components/outreach/mail-merge-dialog";
import { LinkedInBrowserUseDialog } from "@/components/outreach/linkedin-browser-use-dialog";
import type { ProspectRow } from "@/components/outreach/prospect-table";
import { friendlyError } from "@/lib/errors";
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
      try {
        await updateProspectSelection({
          campaignId,
          prospectIds: rows.map((r) => r.prospectId),
          status: "selected",
        });
        refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
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
    start(async () => {
      if (!(await copyText(text))) {
        toast.error(TOAST_COPY.copyFailed);
        return;
      }
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

  function handleBulkSend() {
    start(async () => {
      try {
        const result = await bulkSendOutreach({
          campaignId,
          messageIds: sendable.map((r) => r.messageId),
          ignoreWarnings: ignoreWarnings || !qualityNote,
        });
        if (result.status === "blocked") {
          toast.error(result.reason);
          return;
        }
        if (result.status === "needs_confirmation") {
          setQualityNote(`Quality warning: ${result.warning}`);
          setIgnoreWarnings(true);
          // Not a failure — the send is waiting on the person. A quiet message, so it
          // is not red and is not filed under Missed as though something broke.
          toast.message("Check the warning, then confirm the send again");
          return;
        }
        const { sent, failed } = result;
        if (sent === 0 && failed > 0) {
          toast.error(`None of those sent — try again?`);
        } else if (failed > 0) {
          toast.success(`Sent ${sent} — ${failed} didn’t go through`);
        } else {
          toast.success(`Sent ${sent} ${sent === 1 ? "message" : "messages"}`);
        }
        setDangerOpen(false);
        refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.sendFailed));
      }
    });
  }

  if (!rows.length) return null;

  const selectedProspectRows: ProspectRow[] = activeRows.map((r) => ({
    id: r.prospectId,
    fullName: r.prospectName || "Prospect",
    title: null,
    company: null,
    email: r.email,
    phone: r.phone,
    linkedinUrl: r.linkedinUrl,
    status: "selected",
    contactId: null,
    message: {
      id: r.messageId,
      channel: r.channel,
      subject: r.subject,
      body: r.body,
      status: "draft",
    },
  }));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card p-2.5 shadow-xs">
        <span className="text-xs text-muted-foreground mr-1 font-medium">
          {selectedProspectIds.length} selected
        </span>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleSelectAll} disabled={pending}>
          Select all
        </Button>
        <MailMergeDialog
          campaignId={campaignId}
          selectedProspects={selectedProspectRows}
          onSent={refresh}
        />
        <LinkedInBrowserUseDialog
          campaignId={campaignId}
          selectedProspectIds={selectedProspectIds}
          disabled={pending}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={handleCopyAll}
          disabled={pending || !activeRows.length}
        >
          <Copy className="mr-1 h-3.5 w-3.5" />
          Copy
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={handleOpenAll}
          disabled={pending || !activeRows.length}
        >
          <ExternalLink className="mr-1 h-3.5 w-3.5" />
          Open apps
        </Button>
        {sendable.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={openSendDialog}
            disabled={pending}
          >
            <Send className="mr-1 h-3.5 w-3.5" />
            Quick send ({sendable.length})
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
        <p className="text-xs text-amber-700 dark:text-warning">{qualityNote}</p>
      )}
    </div>
  );
}
