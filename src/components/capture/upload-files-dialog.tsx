"use client";

/**
 * The pop-up behind "Upload notes / media".
 *
 * Opening the system file picker straight from the button gave no room to change your mind: a
 * second batch meant starting over, and a drag needed the card's edge to aim at. This stages
 * files first — drop them here, or browse — lists each one with a way to take it back out, and
 * reads nothing until Extract people is pressed. Extract hands the staged files up as one set,
 * so the host runs them through exactly what a drop onto the card does.
 *
 * Mounted content, not mounted state: the body is inside `DialogContent`, which Base UI
 * unmounts once closed, so the list starts empty each time without a reset effect.
 */
import { useRef, useState } from "react";
import { File as FileIcon, FileAudio, FileText, Image as ImageIcon, Loader2, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CAPTURE_FILE_ACCEPT } from "@/lib/capture/ingest-client";
import { isIgnorableFile } from "@/lib/capture/file-drop";
import { MAX_STAGED_FILES } from "@/lib/capture/bins";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Same bytes under the same name and date is the same file, whichever way it arrived. */
const keyOf = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

function iconFor(file: File) {
  const name = file.name.toLowerCase();
  if (file.type.startsWith("image/") || /\.(png|jpe?g|heic|heif|webp|gif)$/.test(name)) {
    return { Icon: ImageIcon, tone: "bg-sky-500/15 text-sky-700 dark:text-sky-300" };
  }
  if (file.type.startsWith("audio/") || /\.(mp3|m4a|wav|ogg|webm|aac)$/.test(name)) {
    return { Icon: FileAudio, tone: "bg-violet-500/15 text-violet-700 dark:text-violet-300" };
  }
  if (file.type === "application/pdf" || /\.(pdf|txt|md|docx?|rtf|eml|ics)$/.test(name)) {
    return { Icon: FileText, tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300" };
  }
  return { Icon: FileIcon, tone: "bg-muted text-muted-foreground" };
}

export function UploadFilesDialog({
  open,
  onOpenChange,
  onExtract,
  busy = false,
  canExtract = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The staged files, in the order they were added. The host closes nothing; this does. */
  onExtract: (files: File[]) => void;
  busy?: boolean;
  /** False when nothing can be read right now (no AI key): the button says so instead of failing. */
  canExtract?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <UploadBody
          busy={busy}
          canExtract={canExtract}
          onCancel={() => onOpenChange(false)}
          onExtract={(files) => {
            onOpenChange(false);
            onExtract(files);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function UploadBody({
  busy,
  canExtract,
  onCancel,
  onExtract,
}: {
  busy: boolean;
  canExtract: boolean;
  onCancel: () => void;
  onExtract: (files: File[]) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function add(incoming: File[]) {
    const kept = incoming.filter((f) => !isIgnorableFile(f.name));
    if (!kept.length) return;
    setFiles((prev) => {
      const seen = new Set(prev.map(keyOf));
      const fresh = kept.filter((f) => {
        const k = keyOf(f);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const room = Math.max(0, MAX_STAGED_FILES - prev.length);
      if (fresh.length > room) {
        toast.error(`Up to ${MAX_STAGED_FILES} files at a time — send the rest in a second batch`);
      }
      return [...prev, ...fresh.slice(0, room)];
    });
  }

  // The dialog is portalled but React events still bubble to the capture card's own drop
  // zone; without stopping them a drop here would be taken twice.
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      e.stopPropagation();
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setOver(false);
      add(Array.from(e.dataTransfer.files ?? []));
    },
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Upload notes or media</DialogTitle>
        <DialogDescription>
          Voice memos, photos of handwritten notes, PDFs, calendar invites and email forwards.
          Add as many as you like, then extract the people from all of them.
        </DialogDescription>
      </DialogHeader>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={CAPTURE_FILE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          add(picked);
        }}
      />

      <div
        {...dropProps}
        className={cn(
          "flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors",
          over ? "border-import-scan bg-import-scan/5" : "border-border/70 bg-muted/20"
        )}
      >
        <span className="flex size-10 items-center justify-center rounded-full bg-import-scan/10 text-import-scan">
          <UploadCloud className="size-5" aria-hidden />
        </span>
        <p className="text-sm font-medium text-ink">Drag and drop files here</p>
        <p className="text-xs text-muted-foreground">or</p>
        <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
          Browse files
        </Button>
      </div>

      {files.length > 0 && (
        <ul
          aria-label="Files to extract"
          className="max-h-60 space-y-1.5 overflow-y-auto pr-0.5"
        >
          {files.map((file) => {
            const { Icon, tone } = iconFor(file);
            return (
              <li
                key={keyOf(file)}
                className="flex items-center gap-3 rounded-lg border border-border/60 bg-card px-3 py-2"
              >
                <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-md", tone)}>
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{file.name}</span>
                  <span className="text-xs text-muted-foreground">{sizeLabel(file.size)}</span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setFiles((prev) => prev.filter((f) => f !== file))}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!canExtract && (
        <p className="text-xs text-muted-foreground">
          Extracting needs an AI provider — connect one in Settings and this button turns on.
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!files.length || busy || !canExtract}
          onClick={() => onExtract(files)}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {files.length > 1 ? `Extract people (${files.length})` : "Extract people"}
        </Button>
      </DialogFooter>
    </>
  );
}
