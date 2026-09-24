"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  BookUser,
  Calendar as CalendarIcon,
  CalendarPlus,
  Contact,
  FileSpreadsheet,
  HardDrive,
  Loader2,
  MessageSquare,
} from "lucide-react";
import {
  ImportHistory,
  type ImportHistoryHandle,
} from "@/components/imports/import-history";
import { ImportDropOverlay } from "@/components/imports/import-drop-overlay";
import { ImportDropzone } from "@/components/imports/import-dropzone";
import { ImportFinishCard } from "@/components/imports/import-finish-card";
import { ImportQueueCard } from "@/components/imports/import-queue-card";
import { DriveImportCard } from "@/components/imports/drive-import-card";
import { ImportSourceRow } from "@/components/imports/import-source-row";
import { CalendarConnectionsCard } from "@/components/imports/calendar-connections-card";
import { ImportProgress } from "@/components/imports/import-utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LockedFeature } from "@/components/locked-feature";
import {
  cancelImportJob,
  isQueuedImportJob,
  useImportJob,
  type ImportJobKind,
} from "@/lib/import-job-runner";
import {
  useWindowFileDrop,
  useWindowFilePaste,
} from "@/lib/use-window-file-drop";
import { detectImportFiles } from "@/lib/imports/detect-import-file";
import { stageDrop, useImportQueue } from "@/lib/imports/use-import-queue";
import { IMPORT_COPY } from "@/lib/imports/import-copy";
import {
  openDrivePicker,
  requestPickerToken,
  warmDrivePicker,
} from "@/lib/imports/google-picker";
import type { PickedDriveFile } from "@/lib/imports/drive-triage";
import { checkDriveReadiness } from "@/actions/drive";
import { startGmailOAuth } from "@/actions/gmail";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { MAX_CONTACTS_FILE_BYTES } from "@/lib/contacts-file";
import { MAX_DROP_DEPTH } from "@/lib/capture/file-drop";
import {
  calendarSources,
  type ProviderCalendarInput,
} from "@/lib/imports/calendar-sources";
import { useRefreshOnVisible } from "@/lib/use-refresh-on-visible";
import type { DroppedFile } from "@/lib/capture/file-drop";
import type { ImportHistoryItem, LatestFinishedImport } from "@/actions/imports";

export type DriveImportInput = {
  apiKey: string | null;
  appId: string | null;
  /** The server's `GOOGLE_CLIENT_ID` — the browser's Picker token must come from it. */
  clientId: string | null;
};

type DriveReadiness = Awaited<ReturnType<typeof checkDriveReadiness>>;
/** A readiness answer fetched on hover is trusted for this long when the press comes. */
const READINESS_FRESH_MS = 60_000;

/**
 * Everything on /imports.
 *
 * The tabs are gone. They asked a person to decide which of three drawers their file belonged
 * in before they could do anything, and file detection now answers that question better than
 * they could — so the page is organised the way someone actually thinks about it: the people
 * they know, and the meetings they had, each with a file route and a connect route.
 *
 * A LinkedIn archive folder is dozens of files, so the drop cap is raised well above the
 * capture tray's; the queue surfaces `truncated` when even that is not enough.
 */
const IMPORT_DROP_LIMITS = { maxFiles: 200, maxDepth: MAX_DROP_DEPTH };

/**
 * Which finishes this browser has already been shown and told to put away.
 *
 * Per-device rather than per-account on purpose: dismissing the card is "I have read this",
 * not a fact about the import, and it must not cost a write or a round trip. Every read and
 * write is wrapped — a private window, a full quota or a blocked origin all throw here — and
 * absent means "show it", so the failure mode is a card that comes back rather than a finish
 * nobody ever sees.
 */
const FINISH_DISMISSED_KEY = "orbit.imports.finishDismissed";
const MAX_REMEMBERED_DISMISSALS = 20;

function readDismissedFinishes(): string[] {
  try {
    const raw = window.localStorage.getItem(FINISH_DISMISSED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function writeDismissedFinishes(ids: string[]) {
  try {
    window.localStorage.setItem(FINISH_DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // Nothing to do, and nothing worth saying: the card reappears next visit.
  }
}

/**
 * Read through `useSyncExternalStore` rather than an effect, so the value has one owner and
 * the server render has an honest answer. `null` is that answer: "this render does not know
 * yet", which is what the server and the hydrating client both get. The card therefore never
 * appears in the server's HTML only to be yanked away a frame later — it arrives once,
 * already correct, with its own entrance to cover the wait.
 */
let dismissedFinishes: string[] | null = null;
const dismissedListeners = new Set<() => void>();

function subscribeDismissedFinishes(listener: () => void) {
  dismissedListeners.add(listener);
  return () => {
    dismissedListeners.delete(listener);
  };
}

function dismissedFinishesSnapshot(): string[] {
  // Cached: `getSnapshot` must return the same reference until something changes, or React
  // re-renders for ever.
  if (dismissedFinishes === null) dismissedFinishes = readDismissedFinishes();
  return dismissedFinishes;
}

/** Nothing is known during a server render or the hydration that matches it. */
function noDismissedFinishesYet(): null {
  return null;
}

function dismissFinish(importIds: string[]) {
  const next = [...dismissedFinishesSnapshot(), ...importIds].slice(
    -MAX_REMEMBERED_DISMISSALS,
  );
  dismissedFinishes = next;
  writeDismissedFinishes(next);
  for (const listener of dismissedListeners) listener();
}

type CalendarSub = {
  id: string;
  label: string | null;
  icsUrl: string;
  selfEmail: string | null;
  enabled: number;
  lastSyncedAt: Date | string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  lastSyncStats: {
    scanned?: number;
    matched?: number;
    created?: number;
    updated?: number;
    contactsCreated?: number;
  } | null;
};

const PanelSkeleton = () => (
  <div className="space-y-3 rounded-xl border border-border/60 p-4">
    <Skeleton className="h-5 w-40" />
    <Skeleton className="h-24 w-full" />
    <Skeleton className="h-9 w-32" />
  </div>
);

const LinkedInConnectionsImport = dynamic(
  () =>
    import("@/components/imports/linkedin-connections-import").then((m) => ({
      default: m.LinkedInConnectionsImport,
    })),
  { loading: () => <PanelSkeleton /> },
);
const ContactsFileImport = dynamic(
  () =>
    import("@/components/imports/contacts-file-import").then((m) => ({
      default: m.ContactsFileImport,
    })),
  { loading: () => <PanelSkeleton /> },
);
const GoogleContactsImport = dynamic(
  () =>
    import("@/components/imports/google-contacts-import").then((m) => ({
      default: m.GoogleContactsImport,
    })),
  { loading: () => <PanelSkeleton /> },
);
const OutlookContactsImport = dynamic(
  () =>
    import("@/components/imports/outlook-contacts-import").then((m) => ({
      default: m.OutlookContactsImport,
    })),
  { loading: () => <PanelSkeleton /> },
);
const LinkedInMessagesImport = dynamic(
  () =>
    import("@/components/imports/linkedin-messages-import").then((m) => ({
      default: m.LinkedInMessagesImport,
    })),
  { loading: () => <PanelSkeleton /> },
);
const CalendarImportSection = dynamic(
  () =>
    import("@/components/imports/calendar-import-section").then((m) => ({
      default: m.CalendarImportSection,
    })),
  { loading: () => <PanelSkeleton /> },
);

type RowId =
  | "import-panel-connections"
  | "import-panel-messages"
  | "import-contacts-file"
  | "import-google-contacts"
  | "import-outlook-contacts"
  | "import-panel-calendar"
  | "import-calendar-file";

/**
 * Which row owns each linkable anchor. Keep in step with the `id`s below and the `cta.href`
 * values in `src/lib/account-alerts.ts` — a hash that is not in here simply will not open its
 * row, silently. `scripts/smoke-account-alerts.ts` asserts one of them as a literal string.
 */
const ROW_FOR_ANCHOR: Record<string, RowId | undefined> = {
  "import-panel-connections": "import-panel-connections",
  "import-contacts-file": "import-contacts-file",
  "import-google-contacts": "import-google-contacts",
  "import-outlook-contacts": "import-outlook-contacts",
  "import-panel-messages": "import-panel-messages",
  "import-panel-calendar": "import-panel-calendar",
};

/**
 * Which row a running job belongs to, so returning mid-import lands on it.
 *
 * `drive_docs` has no row here yet — its own Picker card is a later addition — so it
 * resolves to `null` rather than a made-up row id.
 */
function rowForImportJobKind(kind: ImportJobKind): RowId | null {
  switch (kind) {
    case "connections":
      return "import-panel-connections";
    case "messages":
      return "import-panel-messages";
    case "contacts_file":
      return "import-contacts-file";
    case "google_contacts":
      return "import-google-contacts";
    case "outlook_contacts":
      return "import-outlook-contacts";
    case "calendar":
      return "import-calendar-file";
    case "drive_docs":
      return null;
  }
}

const CONNECTIONS_ACCENT = "bg-import-connections/10 text-import-connections";
const MESSAGES_ACCENT = "bg-import-messages/10 text-import-messages";
const CALENDAR_ACCENT = "bg-import-calendar/10 text-import-calendar";

export function ImportHub({
  history,
  calendarSubscriptions = [],
  canUseSync = true,
  google,
  outlook,
  drive,
  latestFinish,
}: {
  history: ImportHistoryItem[];
  calendarSubscriptions?: CalendarSub[];
  /**
   * Continuous calendar sync is paid. A one-time calendar FILE is not: it only logs meetings
   * onto people already in the network and never creates anyone, so it is a safe taste.
   */
  canUseSync?: boolean;
  google?: ProviderCalendarInput | null;
  outlook?: ProviderCalendarInput | null;
  drive?: DriveImportInput;
  /** The most recent completed import, drawn as the done card when nothing is running. */
  latestFinish?: LatestFinishedImport | null;
}) {
  const job = useImportJob();
  const queue = useImportQueue();
  const [open, setOpen] = useState<RowId | null>(null);
  const [drivePicks, setDrivePicks] = useState<PickedDriveFile[] | null>(null);
  // Covers the whole click→token→Picker round trip: a slow token fetch or a Picker that
  // takes a moment to load would otherwise leave the button clickable again mid-flight.
  const [drivePickerBusy, setDrivePickerBusy] = useState(false);
  useRefreshOnVisible();

  // The Drive card takes the queue card's slot, so it must never open over a queue that is
  // still running or showing results — the queue would vanish mid-import.
  const queueBusy = queue.items.length > 0;
  const driveConfigured = Boolean(drive?.apiKey && drive.appId && drive.clientId);
  // Asked on hover/focus so the press can open Google's token window straight away: browsers
  // only allow a popup close to the gesture, and a server round trip after the click spends it.
  const readinessRef = useRef<{ at: number; promise: Promise<DriveReadiness> } | null>(null);

  function warmDrive() {
    if (!driveConfigured || !canUseSync) return;
    warmDrivePicker();
    const cached = readinessRef.current;
    if (cached && Date.now() - cached.at < READINESS_FRESH_MS) return;
    const promise = checkDriveReadiness();
    promise.catch(() => {
      if (readinessRef.current?.promise === promise) readinessRef.current = null;
    });
    readinessRef.current = { at: Date.now(), promise };
  }

  async function pickFromDrive() {
    if (!drive?.apiKey || !drive.appId || !drive.clientId || drivePickerBusy || queueBusy) return;
    setDrivePickerBusy(true);
    try {
      const cached = readinessRef.current;
      readinessRef.current = null;
      const ready =
        cached && Date.now() - cached.at < READINESS_FRESH_MS
          ? await cached.promise
          : await checkDriveReadiness();
      if (!ready.ok) {
        if (
          ready.reason === "needs_consent" ||
          ready.reason === "needs_reconnect" ||
          ready.reason === "not_connected"
        ) {
          try {
            const { url } = await startGmailOAuth({ purpose: "drive", returnTo: "/imports" });
            window.location.assign(url);
          } catch (err) {
            toast.error(friendlyError(err, IMPORT_COPY.driveUnavailable));
          }
          return;
        }
        toast.error(ready.error ?? IMPORT_COPY.driveUnavailable);
        return;
      }
      try {
        // Browser-only, drive.file-only, never sent to Orbit or kept past this call.
        const accessToken = await requestPickerToken({
          clientId: drive.clientId,
          loginHint: google?.emailAddress ?? null,
        });
        if (!accessToken) return; // closed Google's window: a cancel
        const picked = await openDrivePicker({
          accessToken,
          apiKey: drive.apiKey,
          appId: drive.appId,
        });
        if (picked.length) setDrivePicks(picked);
      } catch (err) {
        toast.error(friendlyError(err, IMPORT_COPY.driveUnavailable));
      }
    } catch (err) {
      toast.error(friendlyError(err, IMPORT_COPY.driveUnavailable));
    } finally {
      setDrivePickerBusy(false);
    }
  }

  const dismissed = useSyncExternalStore(
    subscribeDismissedFinishes,
    dismissedFinishesSnapshot,
    noDismissedFinishesYet,
  );
  const historyRef = useRef<ImportHistoryHandle>(null);
  const router = useRouter();

  /**
   * Re-read the page after an undo. Held here rather than inside the undo button so that the
   * button, the done card and the history list all stay renderable outside an app router —
   * two of them are rendered exactly that way by the pure smokes.
   */
  const refreshAfterUndo = useCallback(() => router.refresh(), [router]);

  const handleFiles = useCallback(async (files: DroppedFile[]) => {
    const result = await detectImportFiles(files, {
      maxBytes: MAX_CONTACTS_FILE_BYTES,
    });
    await stageDrop(result);
  }, []);

  const { active, reading } = useWindowFileDrop({
    onFiles: (result) => {
      void handleFiles(result.files);
    },
    limits: IMPORT_DROP_LIMITS,
  });
  useWindowFilePaste({
    onFiles: (files) => {
      void handleFiles(files.map((file) => ({ file, path: "" })));
    },
  });

  // Returning mid-import opens the row that owns the job — but never for a queued step, which
  // the queue card is already reporting in one place.
  useEffect(() => {
    if (job?.status !== "running") return;
    if (isQueuedImportJob(job.id)) return;
    setOpen(rowForImportJobKind(job.kind));
  }, [job]);

  // An account alert can link straight at a row. Opened synchronously in the handler rather
  // than a tick later: `SectionFlash` only retries for two seconds while its target is still
  // off-screen, so a row that mounted its panel late would miss the glow entirely.
  //
  // `hashchange` as well as mount, because the notifications panel is reachable FROM this
  // page — clicking "Reconnect Gmail" changes the hash without remounting anything.
  useEffect(() => {
    function openRowForHash() {
      const target = ROW_FOR_ANCHOR[window.location.hash.slice(1)];
      if (target) setOpen(target);
    }
    openRowForHash();
    window.addEventListener("hashchange", openRowForHash);
    return () => window.removeEventListener("hashchange", openRowForHash);
  }, []);

  const runningProgress =
    job?.status === "running" && job.progress ? job.progress : null;
  // The queue card draws its own progress; two would be the same bar twice.
  const showStandaloneProgress =
    runningProgress && job && !isQueuedImportJob(job.id);

  const sources = calendarSources(
    [google, outlook].filter((p): p is ProviderCalendarInput => Boolean(p)),
    calendarSubscriptions,
  );
  const syncingCount = sources.filter(
    (s) => s.state === "on" || s.state === "syncing",
  ).length;
  const needsAttention = sources.some(
    (s) => s.state === "needs_reconnect" || s.state === "trouble",
  );

  /**
   * The finish worth showing: one exists, it hasn't been undone, and this browser hasn't put
   * it away.
   *
   * The queue guard is deliberately the queue card's OWN "render nothing" condition, not
   * `!queue.items.length`. With only that, a drop of files nothing recognises — which stages
   * zero items but some `ignored` — passed here AND inside the queue card, and the same card
   * was drawn twice. While any drop is in play the queue card owns this space, finished or
   * not; this is only the card a person comes back to.
   *
   * A Drive pick takes the same slot, so the finish steps aside while its card is open rather
   * than sitting under a list of documents it has nothing to do with.
   */
  const finishToShow =
    dismissed &&
    latestFinish &&
    !latestFinish.undoneAt &&
    !queue.items.length &&
    !queue.ignored.length &&
    !drivePicks &&
    !latestFinish.importIds.some((id) => dismissed.includes(id))
      ? latestFinish
      : null;

  const row = (id: RowId) => ({
    id,
    open: open === id,
    onOpenChange: (next: boolean) => setOpen(next ? id : null),
  });

  return (
    <div className="space-y-8">
      <ImportDropOverlay active={active} />

      <ImportDropzone
        onFiles={(files) => void handleFiles(files)}
        busy={reading}
        extraAction={
          driveConfigured ? (
            <Button
              type="button"
              variant="outline"
              disabled={!canUseSync || drivePickerBusy || queueBusy}
              title={
                !canUseSync
                  ? IMPORT_COPY.drivePaywalled
                  : queueBusy
                    ? IMPORT_COPY.driveWaitForQueue
                    : undefined
              }
              onPointerEnter={warmDrive}
              onFocus={warmDrive}
              onClick={(e) => {
                e.stopPropagation();
                if (!canUseSync || queueBusy) return;
                void pickFromDrive();
              }}
            >
              {drivePickerBusy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <HardDrive className="size-4" />
              )}
              Choose from Google Drive
            </Button>
          ) : undefined
        }
      />

      {showStandaloneProgress ? (
        <ImportProgress
          {...runningProgress}
          step={job?.step}
          cancelling={Boolean(job?.cancelling)}
          onCancel={cancelImportJob}
        />
      ) : null}

      {drivePicks ? (
        <DriveImportCard files={drivePicks} onDone={() => setDrivePicks(null)} />
      ) : (
        <ImportQueueCard
          onFinishDismiss={dismissFinish}
          onShowFinishDetail={(importId) => historyRef.current?.open(importId)}
          onFinishUndone={refreshAfterUndo}
        />
      )}

      {/*
        The finish the server knows about, for the visit that comes after the import — a
        refresh, or coming back to the page. While the client queue still has the run in it,
        the queue card owns the same card, so only one of the two is ever on screen.
      */}
      {finishToShow ? (
        <ImportFinishCard
          summary={finishToShow}
          arrival="settled"
          avatars={finishToShow.avatars}
          onDismiss={() => dismissFinish(finishToShow.importIds)}
          onShowDetail={() =>
            historyRef.current?.open(finishToShow.importIds[0])
          }
          onUndone={refreshAfterUndo}
        />
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Your people
        </h2>
        <ul className="space-y-2">
          <ImportSourceRow
            {...row("import-panel-connections")}
            icon={FileSpreadsheet}
            accent={CONNECTIONS_ACCENT}
            title="LinkedIn connections"
            status="Upload Connections.csv, or your whole export ZIP"
          >
            <LinkedInConnectionsImport />
          </ImportSourceRow>

          <ImportSourceRow
            {...row("import-panel-messages")}
            icon={MessageSquare}
            accent={MESSAGES_ACCENT}
            title="LinkedIn messages"
            status="Who you actually talk to, from the same export"
          >
            <LinkedInMessagesImport />
          </ImportSourceRow>

          <ImportSourceRow
            {...row("import-contacts-file")}
            icon={BookUser}
            accent={CONNECTIONS_ACCENT}
            title="A contacts file"
            status="From your phone, Google, Outlook or anywhere else"
          >
            <ContactsFileImport />
          </ImportSourceRow>

          <ImportSourceRow
            {...row("import-google-contacts")}
            icon={Contact}
            accent={CONNECTIONS_ACCENT}
            title="Google Contacts"
            status={
              google?.connected
                ? `Connected as ${google.emailAddress}`
                : "Not connected"
            }
          >
            <GoogleContactsImport />
          </ImportSourceRow>

          <ImportSourceRow
            {...row("import-outlook-contacts")}
            icon={Contact}
            accent={CONNECTIONS_ACCENT}
            title="Outlook Contacts"
            status={
              outlook?.connected
                ? `Connected as ${outlook.emailAddress}`
                : "Not connected"
            }
          >
            <OutlookContactsImport />
          </ImportSourceRow>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Your meetings
        </h2>
        <ul className="space-y-2">
          <ImportSourceRow
            {...row("import-panel-calendar")}
            icon={CalendarIcon}
            accent={CALENDAR_ACCENT}
            title="Calendars that keep syncing"
            status={
              needsAttention
                ? "One of your calendars needs you"
                : syncingCount
                  ? `${syncingCount} syncing`
                  : "Nothing syncing yet"
            }
          >
            {canUseSync ? (
              <CalendarConnectionsCard
                sources={sources}
                googleConfigured={Boolean(google?.configured)}
                outlookConfigured={Boolean(outlook?.configured)}
                onAddLink={() => setOpen("import-calendar-file")}
              />
            ) : (
              <LockedFeature
                title="Calendar sync"
                description="Point Orbit at your calendar and it turns meetings into logged interactions, so your follow-ups stay current without any typing."
                highlights={[
                  "Connect Google or Outlook, or paste a calendar link",
                  "Networking meetings become logged interactions",
                  "New people from invites land in your contacts",
                  "Follow-up reminders created automatically",
                ]}
                note="Uploading a calendar file, and every LinkedIn import, stay free on every plan."
              />
            )}
          </ImportSourceRow>

          <ImportSourceRow
            {...row("import-calendar-file")}
            icon={CalendarPlus}
            accent={CALENDAR_ACCENT}
            title="A calendar file, or a link"
            status="Logs meetings onto people you already know"
          >
            <CalendarImportSection
              calendarSubscriptions={calendarSubscriptions}
            />
          </ImportSourceRow>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Past imports
        </h2>
        {/* Target for the "import didn't finish" alerts. */}
        <div id="import-history" className="scroll-mt-8">
          <ImportHistory
            history={history}
            onUndone={refreshAfterUndo}
            ref={historyRef}
          />
        </div>
      </section>

      {queue.truncated ? (
        <p className="text-xs text-muted-foreground">{IMPORT_COPY.truncated}</p>
      ) : null}
    </div>
  );
}
