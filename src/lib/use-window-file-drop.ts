"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_DROP_LIMITS,
  entriesFromDataTransfer,
  readDroppedEntries,
  type DropLimits,
  type DropReadResult,
} from "@/lib/capture/file-drop";

/**
 * Accept a file dropped anywhere on the page, not just on a target.
 *
 * `useScanDropZone` already covers the element-scoped case, and it does the right thing there:
 * it decides it has been left using `currentTarget.contains(relatedTarget)`. That test has no
 * meaning at window scope — there is no element to be inside of — so this counts `dragenter`
 * against `dragleave` instead, which is the only way to know a drag has really gone away while
 * it crosses the boundary of every child element on the way.
 *
 * ## Why this preventDefaults so aggressively
 *
 * A drop that lands on a region with no handler makes the browser navigate the tab to the
 * file. On this page that would throw away a half-finished review to show someone raw CSV. So
 * `dragover` and `drop` are cancelled for the whole window while the hook is mounted, even for
 * drags this hook then ignores. That is the actual cost of "drop anywhere", and it is why the
 * hook is mounted by `/imports` alone rather than by the app shell.
 *
 * ## The watchdog
 *
 * The counter is correct but not sufficient. When a drag ends over browser chrome — the tab
 * strip, another window, the desktop — some browsers never deliver the final `dragleave`, and
 * the count never returns to zero. Left there, the overlay covers the page forever and the only
 * way out is a reload. `dragover` fires continuously while a drag is live, so its absence is a
 * reliable "the drag is gone" signal, and the watchdog clears on that.
 */

/** How long without a `dragover` before we conclude the drag is gone. */
const DRAG_STALE_MS = 300;
const WATCHDOG_INTERVAL_MS = 150;

export type WindowFileDropOptions = {
  /** Stop accepting drops without unmounting — the page is busy, or the feature is locked. */
  disabled?: boolean;
  onFiles: (result: DropReadResult) => void;
  limits?: DropLimits;
};

export type WindowFileDropState = {
  /** A drag carrying files is over the page. */
  active: boolean;
  /** A drop landed and its tree is still being read. */
  reading: boolean;
};

function carriesFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  return Array.from(transfer.types ?? []).includes("Files");
}

export function useWindowFileDrop({
  disabled = false,
  onFiles,
  limits = DEFAULT_DROP_LIMITS,
}: WindowFileDropOptions): WindowFileDropState {
  const [active, setActive] = useState(false);
  const [reading, setReading] = useState(false);

  const depth = useRef(0);
  const lastDragOverAt = useRef(0);
  // Kept in a ref so the listeners can stay registered for the life of the page: re-registering
  // window listeners on every render would drop a drag that is already in flight.
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const limitsRef = useRef(limits);
  limitsRef.current = limits;

  const reset = useCallback(() => {
    depth.current = 0;
    setActive(false);
  }, []);

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth.current += 1;
      lastDragOverAt.current = Date.now();
      if (!disabledRef.current) setActive(true);
    };

    const onDragOver = (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      // Unconditional, even when disabled: the alternative is the browser navigating away.
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = disabledRef.current ? "none" : "copy";
      }
      lastDragOverAt.current = Date.now();
    };

    const onDragLeave = (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };

    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      reset();
      if (disabledRef.current) return;

      // Both reads happen before the first await. A `DataTransfer` is emptied the moment the
      // handler returns, so reading it afterwards finds nothing at all.
      const transfer = e.dataTransfer;
      const entries = transfer ? entriesFromDataTransfer(transfer) : [];
      const fallback = Array.from(transfer?.files ?? []);
      const activeLimits = limitsRef.current;

      setReading(true);
      void readDroppedEntries(entries, fallback, activeLimits)
        .then((result) => onFilesRef.current(result))
        .catch(() => onFilesRef.current({ files: [], truncated: false }))
        .finally(() => setReading(false));
    };

    const onDragEnd = () => reset();

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", onDragEnd);

    const watchdog = window.setInterval(() => {
      if (depth.current === 0) return;
      if (Date.now() - lastDragOverAt.current > DRAG_STALE_MS) reset();
    }, WATCHDOG_INTERVAL_MS);

    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", onDragEnd);
      window.clearInterval(watchdog);
    };
  }, [reset]);

  return { active: active && !disabled, reading };
}

/**
 * Accept files pasted onto the page — copy a file in Finder, paste here.
 *
 * Split from the drag hook because it shares none of its state machine, and because a page may
 * reasonably want one without the other.
 */
export function useWindowFilePaste({
  disabled = false,
  onFiles,
}: {
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}): void {
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (disabledRef.current) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      onFilesRef.current(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
}
