"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Table,
} from "lucide-react";
import {
  copyNotionTable,
  downloadCampaignCsv,
  openGoogleSheetsWithData,
} from "@/lib/campaign-export";
import type { ProspectRow } from "@/components/outreach/prospect-table";

export function CampaignExportDialog({
  open,
  onOpenChange,
  campaignName,
  prospects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignName: string;
  prospects: ProspectRow[];
}) {
  const [copiedNotion, setCopiedNotion] = useState(false);
  const [copiedSheets, setCopiedSheets] = useState(false);

  const count = prospects.length;

  async function handleDownloadCsv() {
    downloadCampaignCsv(campaignName, prospects);
    onOpenChange(false);
  }

  async function handleGoogleSheets() {
    const ok = await openGoogleSheetsWithData(campaignName, prospects);
    if (ok) {
      setCopiedSheets(true);
      setTimeout(() => setCopiedSheets(false), 3000);
    }
  }

  async function handleNotionCopy() {
    const ok = await copyNotionTable(prospects);
    if (ok) {
      setCopiedNotion(true);
      setTimeout(() => setCopiedNotion(false), 3000);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl rounded-3xl p-6 sm:p-7">
        <DialogHeader className="space-y-1">
          <div className="flex items-center gap-2">
            <DialogTitle className="text-xl font-[family-name:var(--font-display)] text-ink">
              Export Campaign Prospects
            </DialogTitle>
            <Badge variant="outline" className="rounded-full text-xs">
              {count} {count === 1 ? "prospect" : "prospects"}
            </Badge>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            Export {campaignName} prospects and outreach drafts to your preferred tool.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-3">
          {/* CSV Download Card */}
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/80 bg-card p-4 transition-colors hover:border-primary/40 hover:shadow-xs">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <FileSpreadsheet className="h-5 w-5" />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-ink">Download CSV</h4>
                <p className="text-xs text-muted-foreground">
                  Complete spreadsheet file with contact details, drafts, match scores, and news hooks.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              onClick={handleDownloadCsv}
              disabled={count === 0}
              className="rounded-full gap-1.5 text-xs shrink-0"
            >
              <Download className="h-3.5 w-3.5" />
              Download .csv
            </Button>
          </div>

          {/* Google Sheets Card */}
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/80 bg-card p-4 transition-colors hover:border-primary/40 hover:shadow-xs">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <Table className="h-5 w-5" />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-ink">Google Sheets</h4>
                <p className="text-xs text-muted-foreground">
                  Copies formatted rows to clipboard and opens a fresh sheet at sheets.new.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleGoogleSheets}
              disabled={count === 0}
              className="rounded-full gap-1.5 text-xs shrink-0"
            >
              {copiedSheets ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                  Copied!
                </>
              ) : (
                <>
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open Sheets
                </>
              )}
            </Button>
          </div>

          {/* Notion Card */}
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/80 bg-card p-4 transition-colors hover:border-primary/40 hover:shadow-xs">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-foreground/5 text-foreground">
                <FileText className="h-5 w-5" />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-ink">Notion Database Table</h4>
                <p className="text-xs text-muted-foreground">
                  Copies a Markdown table. In Notion, paste (Cmd+V) on any blank line to create a database.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleNotionCopy}
              disabled={count === 0}
              className="rounded-full gap-1.5 text-xs shrink-0"
            >
              {copiedNotion ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                  Copied Table!
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy for Notion
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Quick Sample Preview */}
        {prospects.length > 0 && (
          <div className="rounded-2xl border border-border/60 bg-muted/30 p-3 text-xs">
            <span className="font-medium text-muted-foreground">Preview includes:</span>
            <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-ink">
              <span className="rounded-md bg-card px-2 py-0.5 border border-border/40">Name & Title</span>
              <span className="rounded-md bg-card px-2 py-0.5 border border-border/40">Company & Location</span>
              <span className="rounded-md bg-card px-2 py-0.5 border border-border/40">Email & LinkedIn</span>
              <span className="rounded-md bg-card px-2 py-0.5 border border-border/40">Match Score %</span>
              <span className="rounded-md bg-card px-2 py-0.5 border border-border/40">Alumni / Education</span>
              <span className="rounded-md bg-card px-2 py-0.5 border border-border/40">News Catalysts</span>
              <span className="rounded-md bg-card px-2 py-0.5 border border-border/40">Draft Intros</span>
            </div>
          </div>
        )}

        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="rounded-full text-xs"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
