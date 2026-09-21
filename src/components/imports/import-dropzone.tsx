"use client";

import { useRef, type ReactNode } from "react";
import { FolderOpen, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IMPORT_COPY } from "@/lib/imports/import-copy";
import { pathFromRelative, type DroppedFile } from "@/lib/capture/file-drop";
import { cn } from "@/lib/utils";

/**
 * The page's visible promise that dropping works.
 *
 * A window-level drop handler is invisible, and an affordance nobody can see is one nobody
 * uses — so this is deliberately the tallest thing above the fold. The two buttons are the
 * keyboard and "I don't drag files" path to the same place, not a fallback: `webkitdirectory`
 * is the only way to pick a folder at all.
 */
export function ImportDropzone({
  onFiles,
  busy = false,
  disabled = false,
  extraAction,
}: {
  onFiles: (files: DroppedFile[]) => void;
  busy?: boolean;
  disabled?: boolean;
  /** A third button alongside "Choose files" / "Choose a folder" — currently just Drive. */
  extraAction?: ReactNode;
}) {
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  function handle(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    onFiles(
      files.map((file) => ({
        file,
        path: pathFromRelative(
          (file as File & { webkitRelativePath?: string }).webkitRelativePath ??
            "",
          file.name,
        ),
      })),
    );
  }

  return (
    <section
      // A convenience target for pointers, not a control: the two buttons inside are the
      // accessible way in, and they stay the only tab stops. Giving this a role and a
      // tabindex would add a third stop that does exactly what the first one already does.
      onClick={() => {
        if (disabled || busy) return;
        filesInput.current?.click();
      }}
      className={cn(
        "rounded-2xl border-2 border-dashed border-border bg-card/40 px-6 py-10 text-center",
        "transition-colors",
        disabled || busy
          ? "opacity-60"
          : "cursor-pointer hover:border-primary/40 hover:bg-card/70",
      )}
    >
      <div className="mx-auto flex max-w-md flex-col items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          {busy ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Upload className="size-5" />
          )}
        </span>
        <h2 className="text-base font-medium">{IMPORT_COPY.dropTitle}</h2>
        <p className="text-sm text-muted-foreground">{IMPORT_COPY.dropBody}</p>

        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={disabled || busy}
            onClick={(e) => {
              e.stopPropagation();
              filesInput.current?.click();
            }}
          >
            Choose files
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || busy}
            onClick={(e) => {
              e.stopPropagation();
              folderInput.current?.click();
            }}
          >
            <FolderOpen className="size-4" />
            Choose a folder
          </Button>
          {extraAction}
        </div>
      </div>

      {/* Both reset their value on change, so picking the same file twice still fires. */}
      <input
        ref={filesInput}
        type="file"
        multiple
        className="sr-only"
        accept=".csv,.zip,.ics,.ical,.vcf,.vcard,text/csv,text/calendar,application/zip"
        onChange={(e) => {
          handle(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        className="sr-only"
        // Not in React's HTMLInputElement types; both spellings are needed for coverage.
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(e) => {
          handle(e.target.files);
          e.target.value = "";
        }}
      />
    </section>
  );
}
