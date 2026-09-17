"use client";

/**
 * The sorting step between dropping a folder and reading it.
 *
 * Every dropped file lands in the tray across the top. Bins sit below, and each bin becomes
 * ONE note — one capture job, one summary, one entry on a timeline. Three photos of the same
 * whiteboard go in one bin; twenty standup notes are twenty bins, or twenty files left loose
 * in the tray, which amounts to the same thing.
 *
 * ## Dragging is not the only way
 *
 * Tiles use HTML5 drag and drop, which does not exist on touch and is awkward from a
 * keyboard. So every tile also carries a "Move to" menu, and the selection has a bulk one.
 * The drag is the fast path, not the only path — a phone would otherwise be able to open
 * this dialog and do nothing in it.
 *
 * ## Selection before drag
 *
 * `dataTransfer.getData` is unreadable during `dragover` by design, so the payload cannot be
 * inspected while deciding whether to highlight a target. The ids therefore travel in a ref
 * and the `dataTransfer` carries only a marker, which is what lets a bin light up correctly
 * for a five-file drag.
 *
 * The state model and its one invariant — every file in exactly one place — live in
 * `src/lib/capture/bins.ts`. Nothing here reaches into the arrays directly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderPlus, Layers, Scissors, Trash2, X } from "lucide-react";
import {
  MAX_STAGED_FILES,
  addBin,
  combineAll,
  emptyState,
  fileById,
  invariantBroken,
  moveFiles,
  oversizedUploads,
  planUploads,
  removeBin,
  removeFile,
  renameBin,
  separateTray,
  setBinAnchor,
  stageFiles,
  type PlannedUpload,
  type SorterState,
  type StagedFile,
} from "@/lib/capture/bins";
import { anchorForFile } from "@/lib/capture/file-date";
import {
  buildPreviews,
  revokePreview,
  type FilePreview,
} from "@/lib/capture/file-preview";
import { CAPTURE_MAX_UPLOAD_BYTES, formatUploadSize } from "@/lib/capture-limits";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** The marker on the drag. The ids themselves ride in a ref — see the header. */
const DRAG_MIME = "application/x-orbit-staged-files";

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A bin's opening name and date, from the file that starts it. Pure — no refs, no state. */
function seedFromFile(file: StagedFile) {
  const guess = anchorForFile({ name: file.name, lastModified: file.lastModified });
  // The extension is noise in a bin title; the stem is usually what the meeting was called.
  const stem = file.name.replace(/\.[^.]+$/, "").trim();
  return { name: stem || file.name, anchorIso: guess.iso };
}

/**
 * Mounted only while it is open, which is what lets the teardown below be an unmount
 * cleanup: unmounting discards the state, so there is nothing to reset and no `setState` in
 * an effect to cascade a render off.
 */
export function NotesSorterDialog({
  incoming,
  onCancel,
  onConfirm,
}: {
  /** Files from the drop, with the folder each came from. Re-staged when this changes. */
  incoming: { file: File; path: string }[];
  onCancel: () => void;
  /** The sorted plan, plus a way back from a staged id to its bytes. */
  onConfirm: (plans: PlannedUpload[], resolve: (fileId: string) => File | undefined) => void;
}) {
  const [state, setState] = useState<SorterState>(emptyState);
  const [previews, setPreviews] = useState<Record<string, FilePreview>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState(0);

  /** The bytes, kept out of state for the reason the fan-out keeps them out: a re-render
   *  that retains forty photos is a re-render that costs forty photos. */
  const filesRef = useRef(new Map<string, File>());
  const dragIdsRef = useRef<string[]>([]);
  /**
   * The previews as of the last commit, so the teardown below can revoke them without
   * depending on `previews` — a cleanup that re-ran on every new thumbnail would revoke the
   * batch it had just been handed. Synced in an effect rather than during render, which is
   * both the lint rule and the honest description of when it is true.
   */
  const previewsRef = useRef<Record<string, FilePreview>>({});
  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);

  // Stage whatever was dropped, and start building previews for it.
  useEffect(() => {
    if (!incoming.length) return;
    const staged: StagedFile[] = incoming.map(({ file, path }) => {
      const id = newId();
      filesRef.current.set(id, file);
      return {
        id,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        path,
      };
    });

    // Staged into a fresh state, not merged into the previous one: this component is
    // mounted once per drop and unmounted when it closes, so there is no previous one. Doing
    // it outside a state updater matters — an updater that called `setRejected` would be a
    // side effect in a function React is free to run twice.
    const out = stageFiles(emptyState(), staged);
    setState(out.state);
    setRejected(out.rejected);

    const signal = { aborted: false };
    void buildPreviews(
      out.state.files.map((f) => ({ id: f.id, file: filesRef.current.get(f.id)! })),
      (id, preview) => setPreviews((prev) => ({ ...prev, [id]: preview })),
      signal
    );
    return () => {
      signal.aborted = true;
    };
  }, [incoming]);

  // Let go of every object URL on the way out. An object URL that is not revoked holds its
  // blob for the life of the document, and forty of them is forty thumbnails of somebody's
  // meeting notes kept alive by nothing.
  useEffect(() => {
    return () => {
      for (const preview of Object.values(previewsRef.current)) revokePreview(preview);
    };
  }, []);

  const plans = useMemo(() => planUploads(state, seedFromFile), [state]);
  const oversized = useMemo(
    () => oversizedUploads(plans, CAPTURE_MAX_UPLOAD_BYTES),
    [plans]
  );

  const apply = useCallback((next: SorterState) => {
    // The invariant is cheap to check and expensive to violate: a file in no place is a
    // meeting somebody thinks they uploaded. In development this is the failure being loud
    // rather than the drop being quietly one file short.
    if (process.env.NODE_ENV !== "production") {
      const broken = invariantBroken(next);
      if (broken) console.error(`[notes sorter] ${broken}`);
    }
    setState(next);
  }, []);

  const moveSelection = useCallback(
    (ids: readonly string[], toBinId: string | null) => {
      apply(moveFiles(state, ids, toBinId));
      setSelected(new Set());
    },
    [apply, state]
  );

  function onTileClick(e: React.MouseEvent, fileId: string) {
    const additive = e.metaKey || e.ctrlKey || e.shiftKey;
    setSelected((prev) => {
      if (!additive) return prev.has(fileId) && prev.size === 1 ? new Set() : new Set([fileId]);
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  function onDragStart(e: React.DragEvent, fileId: string) {
    // Dragging an unselected tile drags just that one, and makes it the selection — the
    // alternative silently carries along a selection the person has visually moved on from.
    const ids = selected.has(fileId) ? [...selected] : [fileId];
    if (!selected.has(fileId)) setSelected(new Set([fileId]));
    dragIdsRef.current = ids;
    e.dataTransfer.setData(DRAG_MIME, ids.join(","));
    e.dataTransfer.effectAllowed = "move";
  }

  /**
   * One pair of handlers for every zone, with the destination read off the element.
   *
   * Building a closure per bin during render would allocate a fresh pair for every bin on
   * every keystroke in a bin's title — and it would put a ref read inside a function that is
   * called while rendering, which is exactly the shape that becomes a staleness bug the day
   * somebody memoises the row.
   *
   * `data-bin-id` absent means the tray. Absence rather than `""` so the two cannot be
   * confused by an attribute that happens to be empty.
   */
  const onZoneDragOver = useCallback((e: React.DragEvent) => {
    if (!dragIdsRef.current.length) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onZoneDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const ids = dragIdsRef.current;
      dragIdsRef.current = [];
      if (ids.length) moveSelection(ids, e.currentTarget.getAttribute("data-bin-id"));
    },
    [moveSelection]
  );

  const binCount = plans.length;
  const canRead = binCount > 0 && oversized.length === 0;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="max-h-[90vh] w-full max-w-4xl grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {state.files.length} {state.files.length === 1 ? "file" : "files"} to sort
          </DialogTitle>
          <DialogDescription>
            Each bin becomes one note — one summary, one date, one entry on the timeline. Put
            photos of the same whiteboard together; leave anything separate in the tray and it
            becomes its own note.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          {rejected > 0 && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-foreground">
              That folder held more than {MAX_STAGED_FILES} files. The first{" "}
              {MAX_STAGED_FILES} are here — sort these, then drop the rest.
            </p>
          )}

          {/* ── The tray ─────────────────────────────────────────────────────────── */}
          <section
            aria-label="Unsorted files"
            className={cn(
              "rounded-xl border border-dashed border-border/70 bg-muted/20 p-3",
              "transition-colors"
            )}
            onDragOver={onZoneDragOver}
            onDrop={onZoneDrop}
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-foreground">
                Unsorted
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {state.trayIds.length}
                </span>
              </h3>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!state.trayIds.length}
                  onClick={() => {
                    apply(separateTray(state, newId, seedFromFile));
                    setSelected(new Set());
                  }}
                >
                  <Scissors className="size-3.5" />
                  Each its own note
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={state.files.length < 2}
                  onClick={() => {
                    apply(combineAll(state, newId, seedFromFile));
                    setSelected(new Set());
                  }}
                >
                  <Layers className="size-3.5" />
                  All one note
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => apply(addBin(state, newId()))}
                >
                  <FolderPlus className="size-3.5" />
                  New bin
                </Button>
              </div>
            </div>

            {state.trayIds.length === 0 ? (
              <p className="px-1 py-3 text-xs text-muted-foreground">
                Everything is sorted. Drag a file back here to take it out of its bin.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {state.trayIds.map((id) => (
                  <FileTile
                    key={id}
                    file={fileById(state, id)!}
                    preview={previews[id]}
                    selected={selected.has(id)}
                    bins={state.bins}
                    currentBinId={null}
                    onClick={(e) => onTileClick(e, id)}
                    onDragStart={(e) => onDragStart(e, id)}
                    onMove={(binId) => moveSelection(selected.has(id) ? [...selected] : [id], binId)}
                    onRemove={() => apply(removeFile(state, id))}
                  />
                ))}
              </ul>
            )}

            {selected.size > 1 && (
              <p className="mt-2 px-1 text-xs text-muted-foreground">
                {selected.size} selected — drag any one of them to move all, or use Move to on
                a tile.
              </p>
            )}
          </section>

          {/* ── The bins ─────────────────────────────────────────────────────────── */}
          <div className="grid gap-3 sm:grid-cols-2">
            {state.bins.map((bin) => {
              const plan = plans.find((p) => p.binId === bin.id);
              const tooBig = oversized.some((o) => o.binId === bin.id);
              return (
                <section
                  key={bin.id}
                  aria-label={`Bin: ${bin.name}`}
                  data-bin-id={bin.id}
                  onDragOver={onZoneDragOver}
                  onDrop={onZoneDrop}
                  className={cn(
                    "space-y-2 rounded-xl border p-3 transition-colors",
                    tooBig ? "border-destructive/50 bg-destructive/[0.04]" : "border-border/70 bg-card"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={bin.name}
                      aria-label="Note title"
                      className="h-8 flex-1"
                      onChange={(e) => apply(renameBin(state, bin.id, e.target.value))}
                    />
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove bin ${bin.name}`}
                      onClick={() => apply(removeBin(state, bin.id))}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="date"
                      aria-label={`Date for ${bin.name}`}
                      className="h-8 w-[9.5rem]"
                      value={bin.anchorIso ?? ""}
                      onChange={(e) =>
                        apply(setBinAnchor(state, bin.id, e.target.value || null))
                      }
                    />
                    <span className="text-xs text-muted-foreground">
                      {bin.fileIds.length} {bin.fileIds.length === 1 ? "file" : "files"}
                      {plan ? ` · ${sizeLabel(plan.bytes)}` : ""}
                    </span>
                  </div>

                  {bin.fileIds.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border/60 px-2 py-4 text-center text-xs text-muted-foreground">
                      Drop files here
                    </p>
                  ) : (
                    <ul className="flex flex-wrap gap-2">
                      {bin.fileIds.map((id) => (
                        <FileTile
                          key={id}
                          file={fileById(state, id)!}
                          preview={previews[id]}
                          selected={selected.has(id)}
                          bins={state.bins}
                          currentBinId={bin.id}
                          onClick={(e) => onTileClick(e, id)}
                          onDragStart={(e) => onDragStart(e, id)}
                          onMove={(binId) =>
                            moveSelection(selected.has(id) ? [...selected] : [id], binId)
                          }
                          onRemove={() => apply(removeFile(state, id))}
                        />
                      ))}
                    </ul>
                  )}

                  {tooBig && (
                    <p className="text-xs text-destructive">
                      Over {formatUploadSize(CAPTURE_MAX_UPLOAD_BYTES)} — one note goes up in
                      one request, so take a file out of this bin.
                    </p>
                  )}
                </section>
              );
            })}
          </div>
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {binCount} {binCount === 1 ? "note" : "notes"} will be read
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!canRead}
              onClick={() => onConfirm(plans, (id) => filesRef.current.get(id))}
            >
              Read {binCount} {binCount === 1 ? "note" : "notes"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FileTile({
  file,
  preview,
  selected,
  bins,
  currentBinId,
  onClick,
  onDragStart,
  onMove,
  onRemove,
}: {
  file: StagedFile;
  preview: FilePreview | undefined;
  selected: boolean;
  bins: { id: string; name: string }[];
  currentBinId: string | null;
  onClick: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onMove: (binId: string | null) => void;
  onRemove: () => void;
}) {
  return (
    <li
      className={cn(
        "group relative w-[8.5rem] overflow-hidden rounded-lg border bg-card transition-colors",
        selected ? "border-primary ring-2 ring-primary/30" : "border-border/60"
      )}
    >
      <button
        type="button"
        draggable
        onDragStart={onDragStart}
        onClick={onClick}
        aria-pressed={selected}
        className="block w-full cursor-grab text-left active:cursor-grabbing"
      >
        <span className="flex h-20 w-full items-center justify-center overflow-hidden bg-muted/40">
          {preview?.kind === "image" ? (
            // A blob URL of bytes that never leave the browser; next/image cannot optimise
            // what it cannot fetch.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview.url} alt="" className="size-full object-cover" />
          ) : preview?.kind === "text" ? (
            <span className="line-clamp-4 px-1.5 py-1 text-[10px] leading-snug text-muted-foreground">
              {preview.snippet}
            </span>
          ) : (
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
              {preview?.kind === "label" ? preview.label : "…"}
            </span>
          )}
        </span>
        <span className="block px-1.5 py-1">
          <span className="block truncate text-[11px] text-foreground">{file.name}</span>
          <span className="block truncate text-[10px] text-muted-foreground">
            {file.path ? `${file.path} · ` : ""}
            {sizeLabel(file.size)}
          </span>
        </span>
      </button>

      {/* The path that is not a drag. HTML5 drag and drop does not exist on touch, so
          without this a phone can open the dialog and change nothing in it. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          type="button"
          aria-label={`Move ${file.name}`}
          className="absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 transition-opacity outline-none hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
        >
          <span aria-hidden>⋯</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[11rem]">
          <DropdownMenuLabel>Move to</DropdownMenuLabel>
          {currentBinId !== null && (
            <DropdownMenuItem onClick={() => onMove(null)}>Unsorted</DropdownMenuItem>
          )}
          {bins
            .filter((b) => b.id !== currentBinId)
            .map((b) => (
              <DropdownMenuItem key={b.id} onClick={() => onMove(b.id)}>
                {b.name.trim() || "Untitled note"}
              </DropdownMenuItem>
            ))}
          {bins.filter((b) => b.id !== currentBinId).length === 0 && currentBinId === null && (
            <DropdownMenuItem disabled>No bins yet</DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onRemove}>
            <X className="size-3.5" />
            Remove from this drop
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
