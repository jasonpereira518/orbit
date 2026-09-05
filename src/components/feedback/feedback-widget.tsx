"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { cn } from "@/lib/utils";
import {
  FEEDBACK_ANCHOR_FALLBACK,
  setFeedbackPanelState,
  subscribeFeedbackOpen,
  takeFeedbackOpenRequest,
} from "@/lib/feedback-events";
import type { PanelAnchor } from "@/lib/floating-panel";
import { FeedbackTrigger } from "@/components/feedback/feedback-trigger";
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

/**
 * `closing` exists so the window can play its own collapse.
 *
 * The panel used to be unmounted the moment close was requested, which tore it out of the
 * tree before Base UI could apply `data-ending-style` — so it vanished instead of scaling
 * back into the button. In `closing` it is still mounted with `open={false}`, and
 * `onOpenChangeComplete` moves it to `closed`.
 *
 * `capturing` deliberately has no such courtesy: the panel must be gone from the composited
 * frame BEFORE the screen is photographed, so that transition is instant by design.
 */
type Phase = "closed" | "composing" | "closing" | "capturing" | "selecting" | "annotating";

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
  /**
   * The already-attached shot whose note is open for editing, if any. Screenshots attach on
   * release now, so the annotator is a second look rather than a gate on the way in.
   */
  const [editingShotId, setEditingShotId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<PanelAnchor>(FEEDBACK_ANCHOR_FALLBACK);
  /**
   * How far the window has been dragged from its anchor.
   *
   * Lives here rather than in the panel so it survives the panel unmounting to take a
   * screenshot — coming back somewhere else after attaching one would be baffling. Cleared
   * on close, which is what makes the window reopen where it belongs.
   */
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Lazy initialiser rather than an effect: this component is only ever mounted client-side
  // (`ssr: false`), so `window` is there on the first render and there is no flash of a
  // wrongly-hidden button.
  const [captureSupported, setCaptureSupported] = useState(canCaptureScreen);

  /**
   * Drain open requests from the four doors.
   *
   * Runs once on mount as well as on every notification, because the widget is lazily
   * loaded — a press in the frames before its chunk lands queues a request that would
   * otherwise be dispatched into nothing.
   */
  useEffect(() => {
    const consume = () => {
      const requested = takeFeedbackOpenRequest();
      if (requested === null) return;
      setAnchor(requested);
      // From `closing` too: catching the window on its way out should bring it back rather
      // than doing nothing.
      setPhase((p) => (p === "closed" || p === "closing" ? "composing" : p));
    };
    consume();
    return subscribeFeedbackOpen(consume);
  }, []);

  /**
   * Publish what the triggers render against.
   *
   * `closing` reports closed so the button starts fading back at the close REQUEST, which
   * is when the bell starts too. `capturing`/`selecting` report `capturing`, which removes
   * the triggers from the tree entirely rather than fading them — a faded button is still
   * in the photograph.
   */
  useEffect(() => {
    setFeedbackPanelState(
      phase === "composing"
        ? "open"
        : phase === "capturing" || phase === "selecting"
          ? "capturing"
          : "closed"
    );
  }, [phase]);

  useEffect(() => () => setFeedbackPanelState("closed"), []);

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

  /** After a successful send: let the window collapse, then clear the draft behind it. */
  const finish = useCallback(() => {
    setPhase("closing");
  }, []);

  /** The collapse has finished. Nothing is on screen, so this is where state is dropped. */
  const clearDraft = useCallback(() => {
    for (const shot of shotsRef.current) URL.revokeObjectURL(shot.previewUrl);
    setShots([]);
    setMessage("");
    setOffset({ x: 0, y: 0 });
    setPhase("closed");
  }, []);

  /**
   * Backstop for the collapse.
   *
   * `onOpenChangeComplete` fires off `transitionend`, and a transition that never ends
   * never fires it — a tab backgrounded mid-close freezes it exactly there. Without this
   * the window would sit mounted at `open={false}`: invisible, but with the draft never
   * cleared and the trigger still believing it is open. Comfortably longer than the 0.32s
   * collapse, so in the normal case `onClosed` has already won and this only clears itself.
   */
  useEffect(() => {
    if (phase !== "closing") return;
    const timer = setTimeout(clearDraft, 900);
    return () => clearTimeout(timer);
  }, [phase, clearDraft]);

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

  /**
   * Encode the crop and attach it, straight away.
   *
   * Releasing the drag is the decision — there is no confirm step and no annotate step on
   * the way in. A note is still worth having, so the thumbnail opens the annotator
   * afterwards for anyone who wants to add one.
   */
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
        setShots((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            blob: encoded.blob,
            previewUrl: URL.createObjectURL(encoded.blob),
            width: encoded.width,
            height: encoded.height,
            bytes: encoded.bytes,
            note: "",
            redactions: [],
          },
        ]);
        setPhase("composing");
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

  const editingShot = shots.find((s) => s.id === editingShotId) ?? null;

  /**
   * Close the annotator, re-encoding with any redactions painted in.
   *
   * The burn-in is the whole point: painting the boxes only on the preview would ship the
   * original pixels underneath. If the re-encode fails, the shot is REMOVED rather than
   * kept — keeping it would send exactly what the person asked to hide.
   */
  const closeAnnotator = useCallback(async () => {
    const shot = shots.find((s) => s.id === editingShotId);
    if (!shot || shot.redactions.length === 0) {
      setEditingShotId(null);
      setPhase("composing");
      return;
    }
    try {
      const bitmap = await createImageBitmap(shot.blob);
      const redacted = await cropDownscaleEncode(
        { source: bitmap, width: bitmap.width, height: bitmap.height, previewUrl: "" },
        { x: 0, y: 0, w: bitmap.width, h: bitmap.height },
        shot.redactions,
        MAX_SCREENSHOT_BYTES
      );
      bitmap.close();
      URL.revokeObjectURL(shot.previewUrl);
      setShots((prev) =>
        prev.map((s) =>
          s.id === shot.id
            ? {
                ...s,
                blob: redacted.blob,
                previewUrl: URL.createObjectURL(redacted.blob),
                bytes: redacted.bytes,
                width: redacted.width,
                height: redacted.height,
                // Cleared because they are now part of the image itself; keeping them would
                // paint them a second time on the next edit.
                redactions: [],
              }
            : s
        )
      );
    } catch {
      toast.error("Couldn't apply the hidden areas, so that screenshot was removed.");
      URL.revokeObjectURL(shot.previewUrl);
      setShots((prev) => prev.filter((s) => s.id !== shot.id));
    } finally {
      setEditingShotId(null);
      setPhase("composing");
    }
  }, [shots, editingShotId]);

  const removeShot = useCallback((id: string) => {
    setShots((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((s) => s.id !== id);
    });
  }, []);

  return (
    <>
      {/* The desktop rail copy. `FeedbackTrigger` handles being absent during a capture
          and fading while the panel is open; this wrapper only owns where it sits.

          Directly under the notifications bell, matching its conditional offset in
          `app-shell.tsx`. The mobile copy cannot live here — this widget is a sibling of
          `AppShell` and cannot render into its header — so it is mounted there instead and
          talks to this one through `src/lib/feedback-events.ts`. */}
      <div
        className={cn(
          "fixed right-5 z-30 hidden md:right-8 md:block",
          viewingAsUser ? "top-[5.5rem]" : "top-[4.25rem] md:top-[4.75rem]"
        )}
      >
        <FeedbackTrigger tooltip />
      </div>

      {(phase === "composing" || phase === "closing") && (
        <FeedbackPanel
          open={phase === "composing"}
          anchor={anchor}
          offset={offset}
          onOffsetChange={setOffset}
          message={message}
          onMessageChange={setMessage}
          shots={shots}
          canCapture={captureSupported}
          onAddScreenshot={addScreenshot}
          onRemoveShot={removeShot}
          onEditShot={(id) => {
            setEditingShotId(id);
            setPhase("annotating");
          }}
          onClose={() => setPhase("closing")}
          onClosed={clearDraft}
          onSent={finish}
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

      {phase === "annotating" && editingShot && (
        <ScreenshotAnnotator
          previewUrl={editingShot.previewUrl}
          note={editingShot.note}
          redactions={editingShot.redactions}
          onChange={(next) =>
            setShots((prev) =>
              prev.map((s) => (s.id === editingShot.id ? { ...s, ...next } : s))
            )
          }
          onDone={closeAnnotator}
          onRemove={() => {
            removeShot(editingShot.id);
            setEditingShotId(null);
            setPhase("composing");
          }}
        />
      )}
    </>
  );
}
