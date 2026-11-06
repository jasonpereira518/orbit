"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Bell,
  BriefcaseBusiness,
  History,
  MessageSquare,
  MoreHorizontal,
  Newspaper,
  Upload,
  UserRound,
  Users,
} from "lucide-react";
import {
  getLinkedInPanel,
  setLinkedInRefreshInterval,
  type LinkedInPanel,
} from "@/actions/linkedin-settings";
import { listImports, type ImportHistoryItem } from "@/actions/imports";
import { markLinkedInExportRequested } from "@/actions/linkedin-export";
import { saveWorkHistoryAutoEnabled } from "@/actions/settings";
import { setRadarCaptureLinkedin } from "@/actions/radar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { FeatureRow } from "@/components/settings/account-page";
import { LinkedInMark } from "@/components/settings/provider-marks";
import { LinkedInConnectionsImport } from "@/components/imports/linkedin-connections-import";
import { LinkedInMessagesImport } from "@/components/imports/linkedin-messages-import";
import { LinkedInExportGuide } from "@/components/imports/linkedin-export-guide";
import { ImportQueueCard } from "@/components/imports/import-queue-card";
import { ImportUndoButton } from "@/components/imports/import-finish-card";
import {
  detectImportFiles,
  LINKEDIN_PRIVATE,
} from "@/lib/imports/detect-import-file";
import { maxImportBytesFor } from "@/lib/imports/import-constants";
import { acceptsNewDrop } from "@/lib/imports/import-queue";
import {
  getImportQueueState,
  stageDrop,
  useImportQueue,
} from "@/lib/imports/use-import-queue";
import { IMPORT_COPY } from "@/lib/imports/import-copy";
import { importSourceLabel } from "@/lib/imports/import-sources";
import { summarizeImport } from "@/lib/imports/import-summary";
import { importUndoable, withinUndoWindow } from "@/lib/imports/import-finish";
import { LINKEDIN_UPLOAD_IMPORT_TYPES } from "@/lib/import-adapters/linkedin-import-types";
import { LINKEDIN_REFRESH_INTERVAL_OPTIONS } from "@/lib/linkedin-export";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * LinkedIn's blue, scoped to this page: every Button, switch, checkbox and focus ring below
 * reads `--primary`/`--ring`, so redefining them here themes the page without touching a
 * component. #0A66C2 is LinkedIn's brand blue; #70B5F9 is the blue LinkedIn itself uses on
 * dark surfaces, where #0A66C2 is too dark to read.
 */
const LINKEDIN_THEME =
  "[--primary:#0A66C2] [--primary-foreground:#ffffff] [--ring:#0A66C2] dark:[--primary:#70B5F9] dark:[--primary-foreground:#04121b] dark:[--ring:#70B5F9]";

const NO_CONTROL = { kind: "none" } as const;
const noop = () => {};
const FIRST_IMPORTS = 5;
const HISTORY_LIMIT = 20;

const INTERVAL_LABEL: Record<number, string> = {
  0: "Off",
  30: "Monthly",
  60: "Every 2 months",
  90: "Every 3 months",
};

/**
 * LinkedIn, drawn like the other account pages (`account-page.tsx`, `granola-settings.tsx`):
 * the account stated once at the top, then a row per thing Orbit does with it. LinkedIn has no
 * API Orbit can sync from, so "connected" means "an export was uploaded", and the header's one
 * action is uploading the next one.
 */
export function LinkedInSettings() {
  const [panel, setPanel] = useState<LinkedInPanel | null>(null);
  const [failed, setFailed] = useState(false);
  const [history, setHistory] = useState<ImportHistoryItem[] | null>(null);
  const [pending, start] = useTransition();
  const [scanning, setScanning] = useState(false);
  const [open, setOpen] = useState<"connections" | "messages" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const queue = useImportQueue();

  const load = useCallback(() => {
    getLinkedInPanel().then(
      (p) => {
        setPanel(p);
        setFailed(false);
      },
      () => setFailed(true),
    );
    listImports({
      limit: HISTORY_LIMIT,
      importTypes: [...LINKEDIN_UPLOAD_IMPORT_TYPES],
    }).then(setHistory, () => setHistory([]));
  }, []);
  useEffect(load, [load]);

  // A finished run (here, on /imports, or from a row below) changes every count on the page.
  const phase = queue.phase;
  useEffect(() => {
    if (phase === "done") load();
  }, [phase, load]);

  const run = (fn: () => Promise<unknown>, fallback: string, done?: string) =>
    start(async () => {
      try {
        await fn();
        if (done) toast.success(done);
        load();
      } catch (err) {
        toast.error(friendlyError(err, fallback));
      }
    });

  /** The whole export, the same way /imports takes it: detect, then stage for review. */
  const uploadExport = async (file: File) => {
    if (!acceptsNewDrop(getImportQueueState().phase)) {
      toast.message(IMPORT_COPY.queueBusy);
      return;
    }
    setScanning(true);
    try {
      const result = await detectImportFiles([{ file, path: "" }], {
        maxBytes: maxImportBytesFor,
      });
      const kept = result.exportFiles.length;
      const privateFiles = result.ignored.filter(
        (d) => d.reason === LINKEDIN_PRIVATE,
      ).length;
      if (!result.staged.length && !kept) {
        toast.error(
          "That doesn’t look like a LinkedIn export — upload the ZIP LinkedIn emailed you",
        );
        return;
      }
      if (kept) {
        toast.info(
          `Orbit will keep ${kept} files from your LinkedIn export${
            privateFiles
              ? ` — ${privateFiles} private ${privateFiles === 1 ? "file stays" : "files stay"} on your device`
              : ""
          }`,
        );
      }
      await stageDrop(result);
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t read that file — try again?"));
    } finally {
      setScanning(false);
    }
  };

  if (failed && !panel) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Couldn’t load your LinkedIn settings.
        </p>
        <Button variant="outline" size="sm" onClick={load}>
          Try again
        </Button>
      </div>
    );
  }
  if (!panel) return <PageSkeleton />;

  const imported = panel.lastImportAt !== null;

  return (
    <div className={cn("space-y-4", LINKEDIN_THEME)}>
      {/* Wraps on a phone: the actions drop to their own line rather than squeezing the
          status into three. */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-primary/[0.07] p-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-background shadow-sm">
          <LinkedInMark className="size-7" />
        </span>
        <div className="min-w-0 flex-1 basis-44">
          <p className="text-sm font-medium text-ink">LinkedIn</p>
          <ImportStatus panel={panel} />
          <div className="mt-0.5 text-xs">
            <LinkedInExportGuide variant="connections" />
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            disabled={scanning || pending}
            onClick={() => fileInput.current?.click()}
          >
            <Upload aria-hidden />
            {scanning
              ? "Reading…"
              : imported
                ? "Upload new export"
                : "Upload export"}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void uploadExport(file);
            }}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="LinkedIn options"
                  className="tap-target relative"
                >
                  <MoreHorizontal aria-hidden />
                </Button>
              }
            />
            <DropdownMenuContent
              align="end"
              className={cn("w-auto min-w-48", LINKEDIN_THEME)}
            >
              <DropdownMenuItem
                onClick={() =>
                  run(
                    markLinkedInExportRequested,
                    "Couldn’t save that — try again?",
                    "We’ll remind you when it should be ready",
                  )
                }
              >
                I’ve requested my export
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/imports" />}>
                Open Imports page
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {queue.items.length ? <ImportQueueCard onFinishUndone={load} /> : null}

      <ul className="-mt-1">
        <FeatureRow
          icon={<Users className="size-4" />}
          title="Connections"
          description={countLine(
            panel.connections.people,
            "person",
            "people",
            panel.connections.lastAt,
          )}
          control={{
            kind: "action",
            label:
              open === "connections"
                ? "Close"
                : panel.connections.lastAt
                  ? "Update"
                  : "Import",
          }}
          onAction={() =>
            setOpen((o) => (o === "connections" ? null : "connections"))
          }
        >
          {open === "connections" ? <LinkedInConnectionsImport bare /> : null}
        </FeatureRow>
        <FeatureRow
          icon={<MessageSquare className="size-4" />}
          title="Messages"
          description={countLine(
            panel.messages.people,
            "person messaged",
            "people messaged",
            panel.messages.lastAt,
          )}
          control={{
            kind: "action",
            label:
              open === "messages"
                ? "Close"
                : panel.messages.lastAt
                  ? "Update"
                  : "Import",
          }}
          onAction={() =>
            setOpen((o) => (o === "messages" ? null : "messages"))
          }
        >
          {open === "messages" ? <LinkedInMessagesImport bare /> : null}
        </FeatureRow>
        <FeatureRow
          icon={<UserRound className="size-4" />}
          title="About you"
          description={
            panel.aboutYou ? (
              <>
                {[panel.aboutYou.role, panel.aboutYou.headline]
                  .filter(Boolean)
                  .join(" · ") || "Imported"}
                {panel.aboutYou.skills
                  ? ` · ${panel.aboutYou.skills} skills`
                  : ""}
                {" · "}
                <Link
                  href="/settings"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Edit on your profile
                </Link>
              </>
            ) : (
              "Your headline, roles and skills come in with your export, so drafts and matches know what you do."
            )
          }
          control={
            panel.aboutYou
              ? NO_CONTROL
              : { kind: "action", label: "Upload export" }
          }
          onAction={() => fileInput.current?.click()}
        />
        <FeatureRow
          icon={<Bell className="size-4" />}
          title="Refresh reminder"
          description="An export is a snapshot. Orbit nudges you to upload a fresh one so new connections come in."
          control={NO_CONTROL}
          onAction={noop}
        >
          <IntervalPicker
            value={panel.intervalDays}
            disabled={pending}
            onChange={(days) =>
              run(
                () => setLinkedInRefreshInterval(days),
                "Couldn’t save the reminder — try again?",
                days
                  ? `Reminder set: ${INTERVAL_LABEL[days].toLowerCase()}`
                  : "Refresh reminder off",
              )
            }
          />
        </FeatureRow>
        <FeatureRow
          icon={<BriefcaseBusiness className="size-4" />}
          title="Keep work history current"
          description="Looks up people’s current roles in the background, so a job change doesn’t slip past you."
          control={{ kind: "switch", on: panel.workHistoryAuto }}
          disabled={pending}
          onAction={() =>
            run(
              () => saveWorkHistoryAutoEnabled(!panel.workHistoryAuto),
              "Couldn’t save that — try again?",
            )
          }
        />
        {panel.savePosts !== null ? (
          <FeatureRow
            icon={<Newspaper className="size-4" />}
            title="Save LinkedIn posts"
            description="The Orbit extension saves posts by people you know as Radar activity."
            control={{ kind: "switch", on: panel.savePosts }}
            disabled={pending}
            onAction={() =>
              run(
                () => setRadarCaptureLinkedin(!panel.savePosts),
                "Couldn’t save that — try again?",
              )
            }
          />
        ) : null}
        <HistoryRow history={history} onUndone={load} />
      </ul>
    </div>
  );
}

function ImportStatus({ panel }: { panel: LinkedInPanel }) {
  const [tone, text] = !panel.lastImportAt
    ? (["bg-muted-foreground/40", "Not imported yet"] as const)
    : panel.refreshLevel
      ? ([
          "bg-warning",
          `Due for a refresh · last upload ${formatDistanceToNow(panel.lastImportAt, { addSuffix: true })}`,
        ] as const)
      : ([
          "bg-primary",
          `Imported ${formatDistanceToNow(panel.lastImportAt, { addSuffix: true })}`,
        ] as const);
  return (
    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", tone)}
      />
      {text}
    </p>
  );
}

/** The reminder cadence as a segmented control. null (never chosen) reads as the default, monthly. */
function IntervalPicker({
  value,
  disabled,
  onChange,
}: {
  value: number | null;
  disabled: boolean;
  onChange: (days: number) => void;
}) {
  const current = value ?? 30;
  return (
    <div
      role="radiogroup"
      aria-label="Refresh reminder"
      className="inline-flex flex-wrap gap-1 rounded-xl bg-muted/60 p-1"
    >
      {LINKEDIN_REFRESH_INTERVAL_OPTIONS.map((days) => (
        <button
          key={days}
          type="button"
          role="radio"
          aria-checked={current === days}
          disabled={disabled}
          onClick={() => current !== days && onChange(days)}
          className={cn(
            "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors duration-fast ease-house outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
            current === days
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {INTERVAL_LABEL[days]}
        </button>
      ))}
    </div>
  );
}

function HistoryRow({
  history,
  onUndone,
}: {
  history: ImportHistoryItem[] | null;
  onUndone: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const items = history
    ? showAll
      ? history
      : history.slice(0, FIRST_IMPORTS)
    : [];
  return (
    <FeatureRow
      icon={<History className="size-4" />}
      title="Import history"
      description={
        history === null
          ? "Loading…"
          : history.length
            ? `${history.length === HISTORY_LIMIT ? `Last ${HISTORY_LIMIT}` : history.length} LinkedIn ${history.length === 1 ? "upload" : "uploads"}`
            : "Nothing uploaded yet."
      }
      control={NO_CONTROL}
      onAction={noop}
    >
      {items.length ? (
        <>
          <ul className="divide-y divide-border/60">
            {items.map((item) => {
              const chips = summarizeImport(item);
              const undoable =
                !item.stats?.undoneAt &&
                (item.contactsCreated ?? 0) > 0 &&
                importUndoable(item.importType) &&
                withinUndoWindow(new Date(item.createdAt));
              return (
                <li
                  key={item.id}
                  className="flex items-start gap-3 py-2.5 first:pt-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">
                      {importSourceLabel(item.importType)}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {new Date(item.createdAt).toLocaleDateString(
                          undefined,
                          { month: "short", day: "numeric", year: "numeric" },
                        )}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {item.stats?.undoneAt
                        ? "Undone"
                        : item.status !== "completed"
                          ? item.status === "failed"
                            ? "Didn’t finish"
                            : "In progress"
                          : chips.map((c) => c.label).join(" · ") ||
                            "Nothing new"}
                    </p>
                  </div>
                  {undoable ? (
                    <ImportUndoButton
                      importIds={[item.id]}
                      size="xs"
                      onUndone={onUndone}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
          {history && history.length > FIRST_IMPORTS ? (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2"
              onClick={() => setShowAll((s) => !s)}
            >
              {showAll ? "Show fewer" : `Show all ${history.length}`}
            </Button>
          ) : null}
        </>
      ) : null}
    </FeatureRow>
  );
}

function countLine(n: number, one: string, many: string, lastAt: Date | null) {
  if (!lastAt && !n) return "Not imported yet";
  const count = `${n.toLocaleString()} ${n === 1 ? one : many}`;
  return lastAt
    ? `${count} · updated ${formatDistanceToNow(lastAt, { addSuffix: true })}`
    : count;
}

function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading LinkedIn">
      <Skeleton className="h-[4.5rem] w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}
