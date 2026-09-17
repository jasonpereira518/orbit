"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { format } from "date-fns";
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink } from "lucide-react";
import type { CaptureSourceKind } from "@/lib/note-batches";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { CAPTURE_SOURCE_META, capturePhotoSrc } from "@/components/capture/capture-source-meta";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export type CaptureSourcePhoto = {
  id: string;
  fileName: string | null;
  width: number | null;
  height: number | null;
};

/** Past this, the notes start collapsed — a long transcript would bury the results below. */
const COLLAPSE_AT_CHARS = 700;

/** False during SSR and the hydrating render, true afterwards. */
function useHydrated() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

/**
 * The original a capture was made from: the photos, and the text Orbit read — typed,
 * transcribed from a voice note, or read out of the photos themselves.
 *
 * The rest of the results page is what Orbit *made* of the notes. This is the thing to
 * check it against, which is why it sits first and why the text is shown exactly as it was
 * parsed rather than tidied.
 */
export function CaptureSourceCard({
  createdAt,
  kinds,
  sourceText,
  photos,
}: {
  createdAt: string;
  kinds: CaptureSourceKind[];
  sourceText: string;
  photos: CaptureSourcePhoto[];
}) {
  const hydrated = useHydrated();
  const [expanded, setExpanded] = useState(sourceText.length <= COLLAPSE_AT_CHARS);
  const [viewing, setViewing] = useState<number | null>(null);
  const created = new Date(createdAt);

  const step = useCallback(
    (delta: number) =>
      setViewing((i) => (i === null ? i : (i + delta + photos.length) % photos.length)),
    [photos.length]
  );

  async function copyNotes() {
    try {
      await navigator.clipboard.writeText(sourceText);
      toast.success("Notes copied");
    } catch {
      toast.error("Couldn’t copy — select the text instead?");
    }
  }

  const current = viewing === null ? null : photos[viewing] ?? null;

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="space-y-1">
        <CardTitle as="h2">What you captured</CardTitle>
        <p className="text-xs text-muted-foreground">
          {/* Local time only once hydrated — see the history list for why. */}
          {hydrated && (
            <>
              <time dateTime={createdAt}>{format(created, "EEE, MMM d, yyyy 'at' h:mm a")}</time>
              {" · "}
            </>
          )}
          {kinds.map((k) => CAPTURE_SOURCE_META[k].label).join(" + ")}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {photos.length > 0 && (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label="Photos">
            {photos.map((photo, index) => (
              <li key={photo.id}>
                <button
                  type="button"
                  onClick={() => setViewing(index)}
                  className="group relative block aspect-square w-full overflow-hidden rounded-xl border border-border/60 bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  aria-label={`Open photo ${index + 1}${photo.fileName ? ` (${photo.fileName})` : ""}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- served by an
                      auth-gated API route, not a remote origin next/image can optimise. */}
                  <img
                    src={capturePhotoSrc(photo.id)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    // Contain, not cover: these are pictures of writing, and a crop that
                    // cuts the first word off every line makes them unrecognisable.
                    className="size-full object-contain transition-transform duration-base group-hover:scale-[1.03]"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">
              {photos.length > 0 || kinds.includes("voice")
                ? "The text Orbit read"
                : "Your notes"}
            </p>
            <Button variant="ghost" size="sm" onClick={copyNotes}>
              <Copy className="size-3.5" aria-hidden />
              Copy
            </Button>
          </div>
          <div
            className={cn(
              "relative overflow-hidden rounded-xl border border-border/60 bg-muted/30 px-3 py-2",
              !expanded && "max-h-56"
            )}
          >
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-foreground">
              {sourceText}
            </p>
            {!expanded && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent" />
            )}
          </div>
          {sourceText.length > COLLAPSE_AT_CHARS && (
            <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Show less" : "Show all"}
            </Button>
          )}
        </div>
      </CardContent>

      <Dialog open={current !== null} onOpenChange={(open) => { if (!open) setViewing(null); }}>
        <DialogContent
          className="gap-3 p-3 sm:max-w-3xl"
          onKeyDown={(e) => {
            if (photos.length < 2) return;
            if (e.key === "ArrowRight") step(1);
            if (e.key === "ArrowLeft") step(-1);
          }}
        >
          {current && viewing !== null && (
            <>
              <DialogTitle className="pr-10 text-sm">
                {current.fileName || `Photo ${viewing + 1}`}
                {photos.length > 1 && (
                  <span className="ml-2 font-normal text-muted-foreground">
                    {viewing + 1} of {photos.length}
                  </span>
                )}
              </DialogTitle>
              <div className="relative flex max-h-[75vh] items-center justify-center overflow-hidden rounded-lg bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated API route. */}
                <img
                  key={current.id}
                  src={capturePhotoSrc(current.id)}
                  alt={current.fileName || `Photo ${viewing + 1} from this capture`}
                  width={current.width ?? undefined}
                  height={current.height ?? undefined}
                  className="max-h-[75vh] w-auto max-w-full object-contain"
                />
                {photos.length > 1 && (
                  <>
                    <Button
                      variant="secondary"
                      size="icon-sm"
                      className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full opacity-90"
                      onClick={() => step(-1)}
                      aria-label="Previous photo"
                    >
                      <ChevronLeft />
                    </Button>
                    <Button
                      variant="secondary"
                      size="icon-sm"
                      className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full opacity-90"
                      onClick={() => step(1)}
                      aria-label="Next photo"
                    >
                      <ChevronRight />
                    </Button>
                  </>
                )}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <a
                  href={capturePhotoSrc(current.id)}
                  target="_blank"
                  rel="noopener"
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  Open full size
                </a>
                <a
                  href={capturePhotoSrc(current.id, { download: true })}
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                >
                  <Download className="size-3.5" aria-hidden />
                  Download
                </a>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
