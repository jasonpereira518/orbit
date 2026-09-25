"use client";

import { type ReactNode, useRef } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UserFacingError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useEtaCountdown } from "@/lib/use-eta-countdown";

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

/** Which member of a LinkedIn archive a card wants out of it. */
export type LinkedInArchiveMember = "connections" | "messages";

const ARCHIVE_MEMBERS: Record<
  LinkedInArchiveMember,
  { pattern: RegExp; fallbackName: string; missing: string }
> = {
  connections: {
    pattern: /connections\.csv$/i,
    fallbackName: "Connections.csv",
    missing:
      "No Connections.csv in that ZIP — download Connections from LinkedIn\u2019s data export and upload that",
  },
  messages: {
    pattern: /messages\.csv$/i,
    fallbackName: "messages.csv",
    missing:
      "No messages.csv in that ZIP — download Messages from LinkedIn\u2019s data export and upload that",
  },
};

/**
 * Read a LinkedIn export, whether the person kept the CSV or handed us the whole archive.
 *
 * The export arrives as a ZIP of dozens of files and the guide has always told people they can
 * upload it whole, so refusing one on the connections card was a promise the product was not
 * keeping. Both cards come through here; the queue does not, because detection already had to
 * decompress a ZIP to identify it and carries the text it found.
 */
export async function readLinkedInArchive(
  file: File,
  member: LinkedInArchiveMember,
): Promise<{ text: string; fileName: string }> {
  const lower = file.name.toLowerCase();
  if (!lower.endsWith(".zip")) {
    return { text: await file.text(), fileName: file.name };
  }

  const { pattern, fallbackName, missing } = ARCHIVE_MEMBERS[member];
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entry =
    zip.file(pattern)[0] ||
    Object.values(zip.files).find((f) => !f.dir && pattern.test(f.name));
  if (!entry) {
    // Thrown in the browser, so it survives — but a plain Error still reaches the toast
    // as the generic fallback, which is why this is a `UserFacingError`.
    throw new UserFacingError(missing);
  }
  const text = await entry.async("string");
  return { text, fileName: entry.name.split("/").pop() || fallbackName };
}

/** The messages card's long-standing name for the above. Kept so its call sites are unchanged. */
export async function readCsvOrZipMessages(file: File): Promise<{
  text: string;
  fileName: string;
}> {
  return readLinkedInArchive(file, "messages");
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
  step,
}: ImportProgressState & {
  onCancel?: () => void;
  cancelling?: boolean;
  /**
   * Which step of a multi-file drop this is. Optional, so the five existing call sites —
   * including the Settings dialog's — are unchanged.
   */
  step?: { index: number; total: number };
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
          <div className="min-w-0">
            {step && step.total > 1 ? (
              <p className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
                Step {step.index} of {step.total}
              </p>
            ) : null}
            <h3 className="truncate text-sm font-medium text-primary">
              {cancelling ? "Stopping import…" : "Import in progress"}
            </h3>
          </div>
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
              {importedLabel ??
                (imported === 1 ? "contact imported" : "contacts imported")}
            </p>
          </div>
        ) : (
          <p className="text-sm font-medium">
            {cancelling ? "Stopping import…" : "Importing…"} {done} of {total}{" "}
            {label}
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

/**
 * A connected-account import card (Google, Outlook) before its connection status is known.
 *
 * Same frame as the loaded card — the section, its padding, the title row with the status
 * line under it and one button beside them — so the real card replaces it without moving.
 * The title is real text, since it never depends on the status; only what does is
 * placeholder. Keeps the card's `id`, so a link to its anchor still lands on it.
 */
export function ConnectedImportSkeleton({ id, title }: { id: string; title: string }) {
  return (
    <section
      id={id}
      aria-busy="true"
      className="space-y-4 rounded-2xl border border-border/70 bg-card p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-ink">{title}</h2>
          {/* The status line: `mt-1`, one `text-sm` line (20px). */}
          <div className="mt-1 flex h-5 items-center">
            <Skeleton className="h-3.5 w-64 max-w-[60vw]" />
          </div>
          <span className="sr-only">Checking the connection…</span>
        </div>
        <Skeleton className="h-8 w-36 rounded-lg" />
      </div>
    </section>
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
