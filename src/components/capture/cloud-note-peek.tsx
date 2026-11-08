"use client";

import { formatDistanceToNow } from "date-fns";
import { ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { previewCloudNote } from "@/actions/cloud-notes";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { CloudProvider } from "@/lib/cloud-files";
import { cn } from "@/lib/utils";

export type PeekFile = {
  provider: CloudProvider;
  id: string;
  name: string;
  webUrl: string | null;
  modifiedTime: string | null;
  owner: string | null;
  done: boolean;
};

const OPEN_LABEL: Record<CloudProvider, string> = { google: "Open in Drive", microsoft: "Open in OneDrive" };

type Loaded = { key: string; text: string; truncated: boolean } | { key: string; error: string };

/**
 * A quick look at one doc before extracting it: its thumbnail and opening text. The text is
 * read when the panel opens and kept only while it's open.
 */
export function CloudNotePeek({
  className,
  file,
  thumbnail,
  working,
  onClose,
  onExtract,
}: {
  /** The drive's brand theme — the sheet portals out of the themed panel, so it needs its own. */
  className?: string;
  file: PeekFile | null;
  thumbnail: string | null | undefined;
  working: boolean;
  onClose: () => void;
  onExtract: (file: PeekFile) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = file ? `${file.provider}:${file.id}` : null;

  useEffect(() => {
    if (!file || !key) return;
    let live = true;
    void previewCloudNote({ provider: file.provider, file: { id: file.id, name: file.name } })
      .then((res) => {
        if (live) setLoaded(res.ok ? { key, ...res.value } : { key, error: res.error });
      })
      .catch(() => {
        if (live) setLoaded({ key, error: "Couldn’t open that doc — try again" });
      });
    return () => {
      live = false;
    };
  }, [file, key]);

  const current = loaded && loaded.key === key ? loaded : null;
  const meta = file
    ? [file.owner, file.modifiedTime ? `Edited ${formatDistanceToNow(new Date(file.modifiedTime), { addSuffix: true })}` : null]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <Sheet open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className={cn("sm:max-w-md", className)}>
        {file && (
          <>
            <SheetHeader className="pr-12">
              <SheetTitle className="truncate">{file.name}</SheetTitle>
              <SheetDescription>{meta || " "}</SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4">
              {thumbnail && (
                // eslint-disable-next-line @next/next/no-img-element -- a data: URL or a short-lived provider URL; next/image can't optimize either
                <img src={thumbnail} alt="" className="max-h-56 w-full rounded-lg border bg-white object-cover object-top" />
              )}
              {!current ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Opening the doc…
                </p>
              ) : "error" in current ? (
                <p className="text-sm text-muted-foreground">{current.error}</p>
              ) : current.text ? (
                <div className="space-y-2">
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">{current.text}</p>
                  {current.truncated && <p className="text-xs text-muted-foreground">Showing the start of the doc.</p>}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">This doc is empty.</p>
              )}
            </div>
            <SheetFooter className="flex-row justify-end">
              {file.webUrl && (
                <a href={file.webUrl} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "ghost" }))}>
                  <ExternalLink className="size-4" />
                  {OPEN_LABEL[file.provider]}
                </a>
              )}
              <Button type="button" disabled={file.done || working} onClick={() => onExtract(file)}>
                {working && <Loader2 className="size-4 animate-spin" />}
                {file.done ? "Already extracted" : "Extract"}
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
