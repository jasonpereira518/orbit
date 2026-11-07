"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { format } from "date-fns";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink } from "lucide-react";
import type { CaptureSourceKind } from "@/lib/note-batches";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { capturePhotoSrc } from "@/components/capture/capture-source-meta";
import { safeChatHref } from "@/lib/safe-links";
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

/**
 * Typed notes can carry markdown now (the notes box has shortcuts for it), so they render.
 * Not `ChatMarkdown`: that one rewrites model output ("a. - b" into a list) and expands chat
 * directives, which would tidy a person's own notes. Same type scale as the plain text it
 * replaces — headings are emphasis here, not a size jump inside a small card.
 */
const NOTES_MARKDOWN: Components = {
  // `pre-line` keeps a single Enter as a line break, as the plain text did; markdown alone
  // would run two jotted lines into one sentence.
  p: ({ children }) => <p className="mb-2 whitespace-pre-line last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0">{children}</ol>,
  h1: ({ children }) => <p className="mb-1 font-semibold">{children}</p>,
  h2: ({ children }) => <p className="mb-1 font-semibold">{children}</p>,
  h3: ({ children }) => <p className="mb-1 font-semibold">{children}</p>,
  // The card clips overflow, so a long fenced line scrolls instead of being cut off.
  pre: ({ children }) => <pre className="mb-2 overflow-x-auto last:mb-0">{children}</pre>,
  code: ({ children }) => <code className="rounded bg-muted px-1 text-[0.9em]">{children}</code>,
  // Notes are often pasted from mail or the web; a link goes through the same allowlist as
  // chat's and opens out of the app, or stays text.
  a: ({ href, children }) => {
    const safe = safeChatHref(href);
    if (!safe) return <span>{children}</span>;
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="text-primary underline underline-offset-2">
        {children}
      </a>
    );
  },
};
/** Pasted markdown could point an image at any host, fetched the moment it renders. */
const NO_IMAGES = ["img"];
const REMARK_PLUGINS = [remarkGfm];

/** False during SSR and the hydrating render, true afterwards. */
function useHydrated() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

/**
 * When a capture was saved, in the reader's own timezone. Nothing until hydrated: the
 * server does not know that timezone, and a server-rendered time would be wrong or mismatch.
 */
export function CapturedAt({ iso }: { iso: string }) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return <time dateTime={iso}>{format(new Date(iso), "EEE, MMM d, yyyy 'at' h:mm a")}</time>;
}

/**
 * The original a capture was made from: the photos, and the text Orbit read — typed,
 * transcribed from a voice note, or read out of the photos themselves.
 *
 * The rest of the results page is what Orbit *made* of the notes. This is the thing to
 * check it against, which is why it sits first and why read text is shown exactly as it was
 * parsed rather than tidied (typed notes render their own markdown — see `NOTES_MARKDOWN`).
 */
export function CaptureSourceCard({
  kinds,
  sourceText,
  photos,
}: {
  kinds: CaptureSourceKind[];
  sourceText: string;
  photos: CaptureSourcePhoto[];
}) {
  const [expanded, setExpanded] = useState(sourceText.length <= COLLAPSE_AT_CHARS);
  const [viewing, setViewing] = useState<number | null>(null);
  // Only typed notes are the person's own markdown. Everything else — photos, voice, imported
  // mail, files, calendar bodies — is shown verbatim: it is the thing to check Orbit's reading
  // against, and markdown would rewrite `> quotes`, `---` underlines and indents in it.
  const readText = !(kinds.length > 0 && kinds.every((k) => k === "text"));

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
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
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
          <h2 className="text-sm font-medium text-ink">
            {readText ? "The text Orbit read" : "Your notes"}
          </h2>
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
          {readText ? (
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-foreground">
              {sourceText}
            </p>
          ) : (
            <div className="text-sm leading-relaxed break-words text-foreground">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={NOTES_MARKDOWN} disallowedElements={NO_IMAGES}>
                {sourceText}
              </ReactMarkdown>
            </div>
          )}
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
              <div className="relative flex max-h-[75dvh] items-center justify-center overflow-hidden rounded-lg bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated API route. */}
                <img
                  key={current.id}
                  src={capturePhotoSrc(current.id)}
                  alt={current.fileName || `Photo ${viewing + 1} from this capture`}
                  width={current.width ?? undefined}
                  height={current.height ?? undefined}
                  className="max-h-[75dvh] w-auto max-w-full object-contain"
                />
                {photos.length > 1 && (
                  <>
                    <Button
                      variant="secondary"
                      size="icon-sm"
                      className="tap-target absolute top-1/2 left-2 -translate-y-1/2 rounded-full opacity-90"
                      onClick={() => step(-1)}
                      aria-label="Previous photo"
                    >
                      <ChevronLeft />
                    </Button>
                    <Button
                      variant="secondary"
                      size="icon-sm"
                      className="tap-target absolute top-1/2 right-2 -translate-y-1/2 rounded-full opacity-90"
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
    </section>
  );
}
