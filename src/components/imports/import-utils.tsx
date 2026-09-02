"use client";

import { type ReactNode, useRef } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEtaCountdown } from "@/lib/use-eta-countdown";
import { MESSAGES_ENTRY, readCsvFromArchive } from "@/lib/csv-archive";

export type ImportProgressState = {
  done: number;
  total: number;
  label: string;
  /** Epoch ms when the import started — used for ETA. */
  startedAt: number;
  /**
   * Records actually written so far, when that differs from `done`. `done` counts source
   * rows consumed — including duplicates and skipped rows — so it moves faster than the
   * number of contacts (or, for calendar, meetings) a user actually ends up with. Omit for
   * import kinds that can't report it incrementally.
   */
  imported?: number;
  /** Caption for `imported`, e.g. "contacts imported" or "meetings logged". */
  importedLabel?: string;
};

export async function readCsvOrZipMessages(file: File): Promise<{
  text: string;
  fileName: string;
}> {
  return readCsvFromArchive(file, {
    entryPattern: MESSAGES_ENTRY,
    fallbackName: "messages.csv",
    missingMessage: "No messages.csv found in ZIP. Export Messages from LinkedIn.",
  });
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

/**
 * The section shown while an import is running.
 *
 * Two numbers, because they answer different questions and users ask both. `imported` is
 * what they got — records actually written. `done`/`total` is how far along the source file
 * is, and it moves faster: a duplicate or skipped row advances the file without adding a
 * record. Showing only the row counter is what made a finished import look like it had lost
 * people. `imported` is optional — calendar's one-time upload doesn't create contacts at all,
 * and older callers may not have a live count to report — so the section still degrades
 * gracefully to just the row counter when it's absent.
 *
 * The countdown comes from `useEtaCountdown`, shared with the bottom-right job widget so
 * there is exactly one ETA algorithm in the codebase and it is guaranteed to never tick up.
 */
export function ImportProgress({
  done,
  total,
  label,
  startedAt,
  imported,
  importedLabel,
  onCancel,
  cancelling = false,
}: ImportProgressState & {
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const eta = useEtaCountdown({
    active: !cancelling && done > 0 && done < total,
    done,
    total,
    startedAt,
  });

  const countdown = cancelling
    ? "Stopping…"
    : done === 0
      ? "Estimating…"
      : (eta ?? "Estimating…");

  return (
    <section
      className="space-y-4 rounded-2xl border border-border/70 bg-card p-5"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          <h3 className="truncate text-sm font-medium text-primary">
            {cancelling ? "Stopping import…" : "Import in progress"}
          </h3>
        </div>
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-mr-1 -mt-1 shrink-0 text-muted-foreground hover:text-foreground"
            disabled={cancelling}
            onClick={onCancel}
            aria-label="Stop import"
            title="Stop import"
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        {imported != null ? (
          <div>
            <p className="text-2xl font-medium tabular-nums text-primary">
              {imported.toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground">
              {importedLabel ?? (imported === 1 ? "contact imported" : "contacts imported")}
            </p>
          </div>
        ) : (
          <p className="text-sm font-medium">
            {cancelling ? "Stopping import…" : "Importing…"} {done} of {total} {label}
          </p>
        )}
        <div className="text-right">
          {imported != null ? (
            <p className="text-sm tabular-nums text-muted-foreground">
              {done.toLocaleString()} of {total.toLocaleString()} {label}
            </p>
          ) : null}
          <p className="text-xs tabular-nums text-muted-foreground">
            {pct}% · {countdown}
          </p>
        </div>
      </div>

      <div
        className="h-1.5 overflow-hidden rounded-full bg-border/80"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-slow ease-house"
          style={{ width: `${pct}%` }}
        />
      </div>
    </section>
  );
}

/** Dismissible, non-blocking warning banner for CSV parse issues (skipped rows, encoding, etc.). */
export function ImportWarningBanner({
  warnings,
  onDismiss,
}: {
  warnings: string[];
  onDismiss?: () => void;
}) {
  if (!warnings.length) return null;

  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <ul className="min-w-0 flex-1 space-y-1">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
      {onDismiss ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-amber-700 hover:text-amber-900 dark:text-amber-400"
          onClick={onDismiss}
          aria-label="Dismiss warning"
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

