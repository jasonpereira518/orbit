"use client";

import { MessageSquarePlus } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { OPEN_FEEDBACK_EVENT } from "@/lib/feedback-events";
import { MAX_SCREENSHOTS, MAX_SCREENSHOT_BYTES, MAX_SUBMISSION_BYTES } from "@/lib/feedback-report";
import { toast } from "@/lib/toast";
import {
  CaptureError,
  captureOneFrame,
  canCaptureScreen,
  cropDownscaleEncode,
  releaseFrame,
  type CapturedFrame,
  type CropRect,
  type NormalizedRect,
} from "@/lib/screenshot-capture";

const FeedbackPanel = dynamic(
  () => import("@/components/feedback/feedback-panel").then((m) => ({ default: m.FeedbackPanel })),
  { ssr: false, loading: () => null }
);
const ScreenshotCaptureOverlay = dynamic(
  () =>
    import("@/components/feedback/screenshot-capture-overlay").then((m) => ({
      default: m.ScreenshotCaptureOverlay,
    })),
  { ssr: false, loading: () => null }
);
const ScreenshotAnnotator = dynamic(
  () =>
    import("@/components/feedback/screenshot-annotator").then((m) => ({
      default: m.ScreenshotAnnotator,
    })),
  { ssr: false, loading: () => null }
);

export type DraftShot = {
  id: string;
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
  bytes: number;
  note: string;
  redactions: NormalizedRect[];
};

type Phase = "closed" | "composing" | "capturing" | "selecting" | "annotating";

/**
 * The feedback button, and every piece of state behind it.
 *
 * ALL draft state lives here rather than in `FeedbackPanel`, because the panel has to
 * unmount during capture — `getDisplayMedia` photographs the composited output, so any of
 * our own chrome still on screen ends up in the picture. Keeping the message a level up is
 * what makes "cancel the picker" cost nothing.
 */
export function FeedbackWidget({ viewingAsUser = false }: { viewingAsUser?: boolean }) {
  const [phase, setPhase] = useState<Phase>("closed");
  const [message, setMessage] = useState("");
  const [shots, setShots] = useState<DraftShot[]>([]);
  const [frame, setFrame] = useState<CapturedFrame | null>(null);
  const [pendingShot, setPendingShot] = useState<DraftShot | null>(null);
  // Lazy initialiser rather than an effect: this component is only ever mounted client-side
  // (`ssr: false`), so `window` is there on the first render and there is no flash of a
  // wrongly-hidden button.
  const [captureSupported, setCaptureSupported] = useState(canCaptureScreen);

  // The mobile "More" sheet and Settings → Help open the same panel rather than mounting
  // their own — mirrors OPEN_ASK_BAR_EVENT.
  useEffect(() => {
    const open = () => setPhase((p) => (p === "closed" ? "composing" : p));
    window.addEventListener(OPEN_FEEDBACK_EVENT, open);
    return () => window.removeEventListener(OPEN_FEEDBACK_EVENT, open);
  }, []);

  // Object URLs outlive their component unless revoked, and a screenshot is not small.
  // Read through a ref so the cleanup sees the final list without re-running on every
  // attachment; per-shot revocation on removal is handled in `removeShot`.
  const shotsRef = useRef<DraftShot[]>([]);
  useEffect(() => {
    shotsRef.current = shots;
  }, [shots]);
  useEffect(() => {
    return () => {
      for (const shot of shotsRef.current) URL.revokeObjectURL(shot.previewUrl);
    };
  }, []);

  const reset = useCallback(() => {
    for (const shot of shots) URL.revokeObjectURL(shot.previewUrl);
    setShots([]);
    setMessage("");
    setPhase("closed");
  }, [shots]);

  const addScreenshot = useCallback(async () => {
    if (shots.length >= MAX_SCREENSHOTS) return;

    // flushSync, not a plain setState: this handler awaits below, so React's end-of-event
    // flush would land AFTER the browser has already composited the frame with our panel
    // still in it.
    flushSync(() => setPhase("capturing"));
    // Two frames, so the unmount is actually painted before the capture prompt appears.
    // Well inside getDisplayMedia's ~5s transient-activation window.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    try {
      const captured = await captureOneFrame();
      setFrame(captured);
      setPhase("selecting");
    } catch (err) {
      setPhase("composing");
      if (!(err instanceof CaptureError)) {
        toast.error("Couldn't capture the screen. You can still send your note.");
        return;
      }
      switch (err.reason) {
        case "cancelled":
          // Deliberately silent. This is almost always "clicked Cancel in the picker", and
          // a toast for a deliberate cancel is noise.
          break;
        case "no-source":
          toast.error("No screen or window was available to capture.");
          break;
        case "unsupported":
          setCaptureSupported(false);
          toast.error("This browser can't capture the screen. You can still send your note.");
          break;
        default:
          toast.error("Couldn't capture the screen. You can still send your note.");
      }
    }
  }, [shots.length]);

  const onCropChosen = useCallback(
    async (crop: CropRect) => {
      if (!frame) return;
      try {
        const encoded = await cropDownscaleEncode(frame, crop, [], MAX_SCREENSHOT_BYTES);
        const used = shots.reduce((sum, s) => sum + s.bytes, 0);
        if (used + encoded.bytes > MAX_SUBMISSION_BYTES) {
          toast.error("That screenshot would push the attachments over the limit. Remove one first.");
          setPhase("composing");
          return;
        }
        setPendingShot({
          id: crypto.randomUUID(),
          blob: encoded.blob,
          previewUrl: URL.createObjectURL(encoded.blob),
          width: encoded.width,
          height: encoded.height,
          bytes: encoded.bytes,
          note: "",
          redactions: [],
        });
        setPhase("annotating");
      } catch {
        toast.error("That screenshot was too large to attach. Try selecting a smaller area.");
        setPhase("composing");
      } finally {
        releaseFrame(frame);
        setFrame(null);
      }
    },
    [frame, shots]
  );

  /**
   * Re-encode with the redactions painted in, so the bytes that leave the browser have
   * never contained what was hidden. Painting them only on the preview would ship the
   * original underneath.
   */
  const attachPendingShot = useCallback(async () => {
    if (!pendingShot) return;
    let final = pendingShot;
    if (pendingShot.redactions.length > 0) {
      try {
        const bitmap = await createImageBitmap(pendingShot.blob);
        const redacted = await cropDownscaleEncode(
          { source: bitmap, width: bitmap.width, height: bitmap.height, previewUrl: "" },
          { x: 0, y: 0, w: bitmap.width, h: bitmap.height },
          pendingShot.redactions,
          MAX_SCREENSHOT_BYTES
        );
        bitmap.close();
        URL.revokeObjectURL(pendingShot.previewUrl);
        final = {
          ...pendingShot,
          blob: redacted.blob,
          previewUrl: URL.createObjectURL(redacted.blob),
          bytes: redacted.bytes,
          width: redacted.width,
          height: redacted.height,
        };
      } catch {
        // Never attach a shot whose redactions could not be burned in — that would send
        // exactly the pixels the person asked to hide.
        toast.error("Couldn't apply the hidden areas, so that screenshot wasn't attached.");
        URL.revokeObjectURL(pendingShot.previewUrl);
        setPendingShot(null);
        setPhase("composing");
        return;
      }
    }
    setShots((prev) => [...prev, final]);
    setPendingShot(null);
    setPhase("composing");
  }, [pendingShot]);

  const discardPendingShot = useCallback(() => {
    if (pendingShot) URL.revokeObjectURL(pendingShot.previewUrl);
    setPendingShot(null);
    setPhase("composing");
  }, [pendingShot]);

  const removeShot = useCallback((id: string) => {
    setShots((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((s) => s.id !== id);
    });
  }, []);

  return (
    <>
      {/* Hidden entirely while capturing or selecting: it would otherwise be in the
          photograph, and there is no way to exclude it afterwards. */}
      {phase !== "capturing" && phase !== "selecting" && (
        <div
          className={cn(
            // Directly under the notifications bell, matching its conditional offset in
            // `app-shell.tsx`. No mobile button: capture is desktop-only, and the bottom
            // edge already carries the nav pill and the ask bar.
            "fixed right-5 z-30 hidden md:right-8 md:block",
            viewingAsUser ? "top-[5.5rem]" : "top-[4.25rem] md:top-[4.75rem]"
          )}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Send feedback"
                  aria-haspopup="dialog"
                  aria-expanded={phase !== "closed"}
                  className="size-10 rounded-full border-border/70 bg-background/90 shadow-md backdrop-blur-md hover:bg-background"
                  onClick={() => setPhase("composing")}
                >
                  <MessageSquarePlus className="h-4 w-4" />
                </Button>
              }
            />
            <TooltipContent side="left">Send feedback</TooltipContent>
          </Tooltip>
        </div>
      )}

      {phase === "composing" && (
        <FeedbackPanel
          message={message}
          onMessageChange={setMessage}
          shots={shots}
          canCapture={captureSupported}
          onAddScreenshot={addScreenshot}
          onRemoveShot={removeShot}
          onClose={() => setPhase("closed")}
          onSent={reset}
        />
      )}

      {phase === "selecting" && frame && (
        <ScreenshotCaptureOverlay
          frame={frame}
          onCancel={() => {
            releaseFrame(frame);
            setFrame(null);
            setPhase("composing");
          }}
          onConfirm={onCropChosen}
        />
      )}

      {phase === "annotating" && pendingShot && (
        <ScreenshotAnnotator
          previewUrl={pendingShot.previewUrl}
          note={pendingShot.note}
          redactions={pendingShot.redactions}
          onChange={(next) => setPendingShot((prev) => (prev ? { ...prev, ...next } : prev))}
          onDone={attachPendingShot}
          onCancel={discardPendingShot}
        />
      )}
    </>
  );
}
