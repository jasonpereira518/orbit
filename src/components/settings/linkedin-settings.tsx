"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  Bell,
  BriefcaseBusiness,
  MessageSquare,
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
import { useRouter } from "next/navigation";
import { AccountPageShell, FeatureRow, whenLine, type HeaderStatus } from "@/components/settings/account-page";
import { SegmentedControl } from "@/components/settings/account-rows";
import { PROVIDER_THEMES } from "@/components/settings/provider-themes";
import type { AccountStatus } from "@/lib/integration-status";
import { IMPORT_HISTORY_LIMIT, ImportHistoryRow } from "@/components/settings/import-history-row";
import { LinkedInMark } from "@/components/settings/provider-marks";
import { LinkedInConnectionsImport } from "@/components/imports/linkedin-connections-import";
import { LinkedInMessagesImport } from "@/components/imports/linkedin-messages-import";
import { LinkedInExportGuide } from "@/components/imports/linkedin-export-guide";
import { ImportQueueCard } from "@/components/imports/import-queue-card";
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
import { LINKEDIN_UPLOAD_IMPORT_TYPES } from "@/lib/import-adapters/linkedin-import-types";
import { LINKEDIN_REFRESH_INTERVAL_OPTIONS } from "@/lib/linkedin-export";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

const NO_CONTROL = { kind: "none" } as const;
const noop = () => {};

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
  const router = useRouter();

  const load = useCallback(() => {
    getLinkedInPanel().then(
      (p) => {
        setPanel(p);
        setFailed(false);
      },
      () => setFailed(true),
    );
    listImports({
      limit: IMPORT_HISTORY_LIMIT,
      importTypes: [...LINKEDIN_UPLOAD_IMPORT_TYPES],
    }).then(setHistory, () => setHistory([]));
  }, []);
  useEffect(load, [load]);

  // A finished run (here, on Capture's Imports tab, or from a row below) changes every count on the page.
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

  /** The whole export, the same way Capture's Imports tab takes it: detect, then stage for review. */
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

  const imported = panel?.lastImportAt != null;
  // LinkedIn has no sign-in to lose: once the panel is read, the account is simply there.
  const account: AccountStatus | null = panel ? { state: "connected", email: null, capabilities: {} } : null;

  return (
    <>
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
      <AccountPageShell
        name="LinkedIn"
        mark={<LinkedInMark className="size-6" />}
        theme={theme}
        account={account}
        loading={!panel && !failed}
        failed={failed}
        onRetry={load}
        onConnect={() => fileInput.current?.click()}
        status={panel ? importStatusLine(panel) : undefined}
        primaryAction={{
          label: scanning ? "Reading…" : imported ? "Upload new export" : "Upload export",
          icon: <Upload aria-hidden />,
          disabled: scanning || pending,
          onClick: () => fileInput.current?.click(),
        }}
        menuItems={[
          {
            label: "I’ve requested my export",
            onSelect: () =>
              run(markLinkedInExportRequested, "Couldn’t save that — try again?", "We’ll remind you when it should be ready"),
          },
          { label: "Open Imports in Capture", onSelect: () => router.push("/capture?mode=imports") },
        ]}
      >
        {panel ? (
          <>
            {queue.items.length ? (
              <li className="pb-3">
                <ImportQueueCard onFinishUndone={load} />
              </li>
            ) : null}
            <FeatureRow
              icon={<Users className="size-4" />}
              tone={theme.tone}
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
              {open === "connections" ? (
                <LinkedInConnectionsImport bare />
              ) : (
                <div className="text-xs">
                  <LinkedInExportGuide variant="connections" />
                </div>
              )}
            </FeatureRow>
            <FeatureRow
              icon={<MessageSquare className="size-4" />}
              tone={theme.tone}
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
              tone={theme.tone}
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
              tone={theme.tone}
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
              tone={theme.tone}
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
                tone={theme.tone}
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
            <ImportHistoryRow history={history} source="LinkedIn" tone={theme.tone} onUndone={load} />
          </>
        ) : null}
      </AccountPageShell>
    </>
  );
}

const theme = PROVIDER_THEMES.linkedin;

function importStatusLine(panel: LinkedInPanel): HeaderStatus {
  if (!panel.lastImportAt) return { state: "off", detail: "Not imported yet" };
  if (panel.refreshLevel) return { state: "partial", detail: `Due for a refresh · last upload ${whenLine(panel.lastImportAt)}` };
  return { state: "on", detail: `Imported ${whenLine(panel.lastImportAt)}` };
}

/** The reminder cadence. null (never chosen) reads as the default, monthly. */
function IntervalPicker({
  value,
  disabled,
  onChange,
}: {
  value: number | null;
  disabled: boolean;
  onChange: (days: number) => void;
}) {
  return (
    <SegmentedControl
      label="Refresh reminder"
      options={LINKEDIN_REFRESH_INTERVAL_OPTIONS.map((days) => ({ value: days, label: INTERVAL_LABEL[days] }))}
      value={value ?? 30}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

function countLine(n: number, one: string, many: string, lastAt: Date | null) {
  if (!lastAt && !n) return "Not imported yet";
  const count = `${n.toLocaleString()} ${n === 1 ? one : many}`;
  return lastAt
    ? `${count} · updated ${whenLine(lastAt)}`
    : count;
}
