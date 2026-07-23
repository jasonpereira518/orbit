"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ImportProgressState = {
  done: number;
  total: number;
  label: string;
  /** Epoch ms when the import started — used for ETA. */
  startedAt: number;
};

export const IMPORT_BATCH_SIZE = 8;
export const CALENDAR_BATCH_SIZE = 12;

export async function readCsvOrZipMessages(file: File): Promise<{
  text: string;
  fileName: string;
}> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".zip")) {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entry =
      zip.file(/messages\.csv$/i)[0] ||
      Object.values(zip.files).find(
        (f) => !f.dir && /messages\.csv$/i.test(f.name)
      );
    if (!entry) {
      throw new Error(
        "No messages.csv found in ZIP. Export Messages from LinkedIn."
      );
    }
    const text = await entry.async("string");
    return { text, fileName: entry.name.split("/").pop() || "messages.csv" };
  }
  return { text: await file.text(), fileName: file.name };
}

/** Styled file picker that matches Orbit buttons (hides native Choose File UI). */
export function ImportFilePicker({
  accept,
  disabled,
  fileName,
  onFile,
  emptyLabel = "No file chosen",
  buttonLabel = "Choose file",
  className,
}: {
  accept: string;
  disabled?: boolean;
  fileName?: string | null;
  onFile: (file: File) => void;
  emptyLabel?: string;
  buttonLabel?: string;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          onFile(file);
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {buttonLabel}
      </Button>
      <span
        className="min-w-0 truncate text-sm text-muted-foreground"
        title={fileName || undefined}
      >
        {fileName || emptyLabel}
      </span>
    </div>
  );
}

function formatEta(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.max(0, Math.ceil(seconds));
  if (whole <= 1) return "about 1s left";
  if (whole < 60) return `${whole}s left`;
  const minutes = Math.floor(whole / 60);
  const rem = whole % 60;
  if (minutes < 60) {
    return rem > 0 ? `${minutes}m ${rem}s left` : `${minutes}m left`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m left` : `${hours}h left`;
}

export function ImportProgress({
  done,
  total,
  label,
  startedAt,
  onCancel,
  cancelling = false,
}: ImportProgressState & {
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [etaEndAt, setEtaEndAt] = useState<number | null>(null);
  const rateEmaRef = useRef<number | null>(null);
  const lastDoneRef = useRef(0);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  // Tick often so the countdown updates smoothly between import batches.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  // New import run — reset ETA state.
  useEffect(() => {
    rateEmaRef.current = null;
    lastDoneRef.current = 0;
    setEtaEndAt(null);
  }, [startedAt]);

  // Recalibrate the finish deadline when more items complete.
  useEffect(() => {
    if (done <= 0 || done >= total) {
      if (done >= total) setEtaEndAt(null);
      return;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs < 500) return;

    const instantRate = done / elapsedMs; // items per ms
    if (instantRate <= 0) return;

    rateEmaRef.current =
      rateEmaRef.current == null
        ? instantRate
        : rateEmaRef.current * 0.55 + instantRate * 0.45;

    const remainingMs = (total - done) / rateEmaRef.current;

    setEtaEndAt((prev) => {
      if (prev == null) {
        lastDoneRef.current = done;
        return Date.now() + remainingMs;
      }
      // Same progress snapshot — keep counting down the existing deadline.
      if (lastDoneRef.current === done) return prev;

      // Progress advanced — blend so the displayed time doesn't jump.
      const oldRemaining = Math.max(0, prev - Date.now());
      const blended = oldRemaining * 0.4 + remainingMs * 0.6;
      lastDoneRef.current = done;
      return Date.now() + blended;
    });
  }, [done, total, startedAt]);

  const secondsLeft =
    etaEndAt != null ? Math.max(0, (etaEndAt - now) / 1000) : null;
  const etaLabel =
    cancelling
      ? "Stopping…"
      : done > 0 && done < total
        ? formatEta(secondsLeft) ?? (etaEndAt == null ? null : "a few seconds")
        : null;

  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/40 px-4 py-3"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="text-sm font-medium">
            {cancelling ? "Stopping import…" : "Importing…"} {done} of {total}{" "}
            {label}
          </p>
          {etaLabel ? (
            <p className="text-xs tabular-nums text-muted-foreground">
              {etaLabel}
            </p>
          ) : !cancelling && done === 0 ? (
            <p className="text-xs text-muted-foreground">Estimating…</p>
          ) : null}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-border/80">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {pct}%
      </span>
      {onCancel ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          disabled={cancelling}
          onClick={onCancel}
          aria-label="Stop import"
          title="Stop import"
        >
          <X className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}

export function BusyHint({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      <span>{children}</span>
    </div>
  );
}

