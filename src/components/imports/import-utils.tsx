"use client";

import { type ReactNode, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ImportProgressState = {
  done: number;
  total: number;
  label: string;
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

export function ImportProgress({ done, total, label }: ImportProgressState) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/40 px-4 py-3"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium">
          Importing… {done} of {total} {label}
        </p>
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

export function useBatchedImport() {
  const [importProgress, setImportProgress] =
    useState<ImportProgressState | null>(null);

  async function runBatchedImport<T>(
    ids: string[],
    label: string,
    runChunk: (
      chunk: string[],
      opts: { importId?: string; finalize: boolean }
    ) => Promise<T & { importId: string }>
  ) {
    const total = ids.length;
    setImportProgress({ done: 0, total, label });
    let importId: string | undefined;
    let last: (T & { importId: string }) | null = null;

    try {
      for (let i = 0; i < ids.length; i += IMPORT_BATCH_SIZE) {
        const chunk = ids.slice(i, i + IMPORT_BATCH_SIZE);
        const finalize = i + IMPORT_BATCH_SIZE >= ids.length;
        last = await runChunk(chunk, { importId, finalize });
        importId = last.importId;
        setImportProgress({
          done: Math.min(i + chunk.length, total),
          total,
          label,
        });
        // Yield so React can paint progress (including after returning to a tab).
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 0);
        });
      }
      return last!;
    } finally {
      setImportProgress(null);
    }
  }

  return { importProgress, setImportProgress, runBatchedImport };
}
