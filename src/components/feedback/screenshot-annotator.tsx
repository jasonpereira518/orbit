"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDragRect } from "@/components/feedback/use-drag-rect";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { MAX_SHOT_NOTE } from "@/lib/feedback-report";
import type { NormalizedRect } from "@/lib/screenshot-capture";

/**
 * Say what an attached screenshot is about, and hide anything on it that shouldn't leave.
 *
 * Opened from the thumbnail, AFTER the shot is attached — releasing the drag attaches it,
 * so this is a second look rather than a gate on the way in. The
 * redaction tool is here because of what `src/lib/feedback.ts` says about this table: it is
 * "the one free-text column an operator can read without hesitation", precisely because a
 * user is writing about Orbit rather than about a third party. A screenshot of the contacts
 * list breaks exactly that property, and this restores it.
 *
 * One tool, and it paints an OPAQUE box rather than a blur: blur is expensive, partially
 * reversible, and dishonest about what it guarantees. No arrows, no text, no highlighter —
 * none of them would have earned their weight here.
 */
export function ScreenshotAnnotator({
  previewUrl,
  note,
  redactions,
  onChange,
  onDone,
  onRemove,
}: {
  previewUrl: string;
  note: string;
  redactions: NormalizedRect[];
  onChange: (next: { note: string; redactions: NormalizedRect[] }) => void;
  onDone: () => void;
  onRemove: () => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  /** Same reasoning as the capture overlay: measured into state, never read during render. */
  const [imgBox, setImgBox] = useState<DOMRect | null>(null);
  const [draft, setDraft] = useState(note);

  const measure = useCallback(() => {
    const box = imgRef.current?.getBoundingClientRect();
    if (box) setImgBox(box);
  }, []);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const commit = useCallback(
    (selection: { left: number; top: number; width: number; height: number }) => {
      const box = imgBox;
      if (!box || box.width === 0 || box.height === 0) return;
      // Normalised to 0–1 of the crop, so the box survives the downscale ladder and lands
      // in the right place whatever edge size the byte cap settles on.
      const next: NormalizedRect = {
        x: Math.max(0, (selection.left - box.left) / box.width),
        y: Math.max(0, (selection.top - box.top) / box.height),
        w: Math.min(1, selection.width / box.width),
        h: Math.min(1, selection.height / box.height),
      };
      onChange({ note: draft, redactions: [...redactions, next] });
    },
    [draft, redactions, onChange, imgBox]
  );

  const { rect, handlers } = useDragRect({ minSize: 8, onCommit: commit });

  const removeRedaction = (index: number) => {
    onChange({ note: draft, redactions: redactions.filter((_, i) => i !== index) });
  };

  return (
    <Dialog open modal onOpenChange={(open) => !open && onDone()}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>What should we look at here?</DialogTitle>
        </DialogHeader>

        <div
          className="relative select-none overflow-hidden rounded-md border border-border"
          style={{ cursor: "crosshair", touchAction: "none" }}
          {...handlers}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a blob: crop of the
              user's own screen; there is no remote origin for next/image to optimise. */}
          <img
            ref={imgRef}
            src={previewUrl}
            alt="Captured region"
            draggable={false}
            className="w-full"
            onLoad={measure}
          />
          {redactions.map((r, i) => (
            <div
              key={i}
              className="pointer-events-none absolute bg-[#111827]"
              style={{
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
              }}
            />
          ))}
          {rect && (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-primary"
              style={{
                left: rect.left - (imgBox?.left ?? 0),
                top: rect.top - (imgBox?.top ?? 0),
                width: rect.width,
                height: rect.height,
              }}
            />
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Drag over anything that shouldn&apos;t leave your account — a name, an email — and
          it&apos;s painted out before the image is sent.
        </p>

        {redactions.length > 0 && (
          // Listed as removable chips so undoing one does not require hunting for it with
          // a pointer.
          <ul className="flex flex-wrap gap-2">
            {redactions.map((_, i) => (
              <li key={i}>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => removeRedaction(i)}
                >
                  Hidden area {i + 1}
                  <X className="size-3" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <Textarea
          value={draft}
          maxLength={MAX_SHOT_NOTE}
          rows={3}
          placeholder="What's happening in this shot?"
          onChange={(e) => {
            setDraft(e.target.value);
            onChange({ note: e.target.value, redactions });
          }}
        />

        <DialogFooter>
          {/* The shot is already attached by the time this opens, so the destructive action
              is "remove it" and the neutral one is "done" — closing must not throw the
              screenshot away. */}
          <Button type="button" variant="ghost" onClick={onRemove}>
            Remove screenshot
          </Button>
          <Button type="button" onClick={onDone}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
