"use client";

/**
 * "From Google Drive" on the capture page: pick Docs or Slides decks, and each becomes its
 * own capture job in this upload's queue.
 *
 * The flow up to the Picker is /imports' (`import-hub.tsx`), kept in step on purpose:
 * readiness is asked on hover/focus so the press can open Google's token window at once —
 * browsers only allow a popup close to the gesture, and a server round trip after the click
 * spends it. What differs is after the pick: /imports saves docs without review, capture
 * reads each into a job you review, via `queueDriveCapture`.
 *
 * Docs go a few at a time, like the notes fan-out, so each parse gets its own request.
 */
import { useRef, useState } from "react";
import { HardDrive, Loader2 } from "lucide-react";
import { queueDriveCapture } from "@/actions/capture-drive";
import { checkDriveReadiness } from "@/actions/drive";
import { startGmailOAuth } from "@/actions/gmail";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { IMPORT_COPY } from "@/lib/imports/import-copy";
import { openDrivePicker, requestPickerToken, warmDrivePicker } from "@/lib/imports/google-picker";
import type { PickedDriveFile } from "@/lib/imports/drive-triage";
import { toast } from "@/lib/toast";

export type DriveCaptureConfig = {
  apiKey: string | null;
  appId: string | null;
  /** The server's `GOOGLE_CLIENT_ID` — the Picker token must come from the same client. */
  clientId: string | null;
};

const READINESS_FRESH_MS = 60_000;
const CONCURRENCY = 2;

type Readiness = Awaited<ReturnType<typeof checkDriveReadiness>>;

function newBatchId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Null when Drive is not configured or the plan has no sync — the button simply isn't there. */
export function DriveCaptureButton({
  drive,
  canUseSync,
  disabled = false,
  onQueued,
  size = "sm",
}: {
  drive: DriveCaptureConfig | null | undefined;
  canUseSync: boolean;
  disabled?: boolean;
  /** The jobs this pick created, once every doc has settled. */
  onQueued: (jobIds: string[]) => void;
  size?: "sm" | "default";
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const readinessRef = useRef<{ at: number; promise: Promise<Readiness> } | null>(null);

  if (!drive?.apiKey || !drive.appId || !drive.clientId || !canUseSync) return null;
  const config = { apiKey: drive.apiKey, appId: drive.appId, clientId: drive.clientId };

  function warm() {
    warmDrivePicker();
    const cached = readinessRef.current;
    if (cached && Date.now() - cached.at < READINESS_FRESH_MS) return;
    const promise = checkDriveReadiness();
    promise.catch(() => {
      if (readinessRef.current?.promise === promise) readinessRef.current = null;
    });
    readinessRef.current = { at: Date.now(), promise };
  }

  async function pick(): Promise<PickedDriveFile[]> {
    const cached = readinessRef.current;
    readinessRef.current = null;
    const ready =
      cached && Date.now() - cached.at < READINESS_FRESH_MS ? await cached.promise : await checkDriveReadiness();
    if (!ready.ok) {
      if (ready.reason === "needs_consent" || ready.reason === "needs_reconnect" || ready.reason === "not_connected") {
        const { url } = await startGmailOAuth({ purpose: "drive", returnTo: "/capture" });
        window.location.assign(url);
        return [];
      }
      toast.error(ready.error ?? IMPORT_COPY.driveUnavailable);
      return [];
    }
    // Browser-only, drive.file-only, never sent to Orbit or kept past this call.
    const accessToken = await requestPickerToken({ clientId: config.clientId, loginHint: null });
    if (!accessToken) return []; // closed Google's window: a cancel
    return openDrivePicker({ accessToken, apiKey: config.apiKey, appId: config.appId });
  }

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await pick();
      if (!picked.length) return;

      const batchGroupId = newBatchId();
      const jobIds: string[] = [];
      const duplicates: string[] = [];
      const failures: string[] = [];
      let next = 0;
      let done = 0;
      setProgress({ done: 0, total: picked.length });

      const worker = async () => {
        while (next < picked.length) {
          const file = picked[next++]!;
          try {
            const res = await queueDriveCapture({ file, batchGroupId });
            if (!res.ok) failures.push(`${file.name}: ${res.error}`);
            else if (res.value.status === "duplicate") duplicates.push(file.name);
            else jobIds.push(res.value.jobId);
          } catch (err) {
            failures.push(`${file.name}: ${friendlyError(err, "couldn’t be read")}`);
          }
          done += 1;
          setProgress({ done, total: picked.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, picked.length) }, worker));

      if (jobIds.length) {
        toast.success(
          jobIds.length === 1 ? "Reading 1 doc from Drive" : `Reading ${jobIds.length} docs from Drive`,
          duplicates.length ? { description: `${duplicates.length} already captured, so skipped` } : undefined
        );
        onQueued(jobIds);
      } else if (duplicates.length) {
        toast.info(
          duplicates.length === 1
            ? `“${duplicates[0]}” was already captured`
            : `Those ${duplicates.length} docs were already captured`
        );
      }
      if (failures.length) {
        toast.error(failures.length === 1 ? failures[0]! : `${failures.length} docs couldn’t be read`, {
          description: failures.length > 1 ? failures.slice(0, 3).join(" · ") : undefined,
        });
      }
    } catch (err) {
      toast.error(friendlyError(err, IMPORT_COPY.driveUnavailable));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      disabled={disabled || busy}
      onPointerEnter={warm}
      onFocus={warm}
      onClick={() => void run()}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <HardDrive className="size-4" />}
      {progress ? `Reading ${progress.done}/${progress.total}…` : "From Google Drive"}
    </Button>
  );
}
