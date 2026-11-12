"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import {
  setFeedbackPanelState,
  setFeedbackWidgetMounted,
  subscribeFeedbackOpen,
  takeFeedbackOpenRequest,
} from "@/lib/feedback-events";
import type { FeedbackPanelTarget } from "@/lib/feedback-events";
import { useCornerShift, useDockWidth } from "@/lib/corner-clearance";
import {
  DOCK_SESSION_KEY,
  dockLayoutFor,
  parseDockSession,
  serializeDockSession,
  type DockLayout,
} from "@/lib/feedback-dock";
import {
  MAX_SCREENSHOTS,
  MAX_SCREENSHOT_BYTES,
  MAX_SUBMISSION_BYTES,
  FEEDBACK_RECIPIENT,
  type FeedbackArea,
  type FeedbackCategory,
} from "@/lib/feedback-report";
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
 * `sent` is the same species, at the other end: the window is held OPEN, deliberately, so
 * the Send button can finish its gesture before anything moves. It has to be a phase and
 * not a timer hung off the close, because `open={false}` is itself what starts the
 * collapse — the hold can only happen while `open` is still true.
 *
 * `capturing` deliberately has no such courtesy: the panel must be gone from the composited
 * frame BEFORE the screen is photographed, so that transition is instant by design.
 */
type Phase =
  | "closed"
  | "composing"
  | "sent"
  | "closing"
  | "capturing"
  | "selecting"
  | "annotating";

/**
 * How long the window waits, after a successful send, before it starts collapsing.
 *
 * Covers the whole of the Send button's gesture in `send-button.tsx` — contract, draw,
 * then a beat held still so the eye registers it. Change one, check the other. The 0.32s
 * collapse then runs on top, so the window is gone about a second after the send lands.
 */
const SENT_HOLD_MS = 640;

/** Which of the three shapes the viewport allows, kept current through resizes and rotation. */
function useDockLayout(): DockLayout {
  // The width is the snapshot, so the object is only rebuilt when it changes.
  const width = useSyncExternalStore(
    (onChange) => {
      window.addEventListener("resize", onChange);
      return () => window.removeEventListener("resize", onChange);
    },
    () => window.innerWidth,
    () => 1440
  );
  return dockLayoutFor(width);
}

/** sessionStorage can throw (privacy modes, disabled storage); the dock then just forgets. */
function readDockSession() {
  try {
    return parseDockSession(window.sessionStorage.getItem(DOCK_SESSION_KEY));
  } catch {
    return null;
  }
}

/**
 * The feedback button, and every piece of state behind it.
 *
 * ALL draft state lives here rather than in `FeedbackPanel`, because the panel has to
 * unmount during capture — `getDisplayMedia` photographs the composited output, so any of
 * our own chrome still on screen ends up in the picture. Keeping the message a level up is
 * what makes "cancel the picker" cost nothing.
 */
export function FeedbackWidget({ viewingAsUser = false }: { viewingAsUser?: boolean }) {
  // Was it open when this tab last looked? A reload (or a client navigation that remounts the
  // layout) puts the panel back on the view it was on. Only the view, never the draft.
  const [restored] = useState(readDockSession);
  const [phase, setPhase] = useState<Phase>(restored ? "composing" : "closed");
  const layout = useDockLayout();
  /** Pressing a door while the panel is already open takes focus back into it. */
  const [focusToken, setFocusToken] = useState(0);
  /** The control that opened the panel, so closing it hands focus back there. */
  const openerRef = useRef<HTMLElement | null>(null);
  const [message, setMessage] = useState("");
  /** The subject line a new message starts with — required, and part of the draft. */
  const [subject, setSubject] = useState("");
  const [shots, setShots] = useState<DraftShot[]>([]);
  /**
   * The reply being written in an open conversation, and the screenshots going with it. Up
   * here for the same reason as the new message's draft: the panel unmounts while a
   * screenshot is taken, and the words and pictures must be waiting when it comes back.
   */
  const [chatBody, setChatBody] = useState("");
  const [chatShots, setChatShots] = useState<DraftShot[]>([]);
  /** Which draft the screenshot being taken goes to. */
  const captureTarget = useRef<"compose" | "chat">("compose");
  const [frame, setFrame] = useState<CapturedFrame | null>(null);
  /**
   * The already-attached shot whose note is open for editing, if any. Screenshots attach on
   * release now, so the annotator is a second look rather than a gate on the way in.
   */
  const [editingShotId, setEditingShotId] = useState<string | null>(null);
  /**
   * Which view the side panel shows: the message form, your past feedback, or one
   * conversation. Up here so it survives the panel unmounting for a screenshot.
   */
  const [target, setTarget] = useState<FeedbackPanelTarget>(restored ?? { view: "compose" });
  /**
   * The conversation last opened, for the toggle at the top of the panel that flips between
   * the inbox and it. A ref as well, so a view change can tell whether this is a DIFFERENT
   * conversation — whose reply draft must not follow you into it.
   */
  const restoredThread = restored?.view === "thread" ? restored.id : null;
  const [lastThreadId, setLastThreadId] = useState<string | null>(restoredThread);
  const lastThreadRef = useRef<string | null>(restoredThread);
  /** The open-request listener subscribes once; it reads the latest `changeTarget` here. */
  const changeTargetRef = useRef<(next: FeedbackPanelTarget) => void>(() => {});
  /** Whether the new-message draft has anything in it — a prefill never overwrites words. */
  const draftHasWords = useRef(false);
  /**
   * The kind, if they picked one. Optional: left blank, the triage pass reads it from the
   * words (`src/lib/feedback-triage.ts` only fills a kind that is still empty).
   */
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  /**
   * Whether this close is following a successful send.
   *
   * Not derivable from `phase`, which is the point: `closing` is reached from Cancel and
   * from Escape as well as from a send, and the Send button has to keep showing its check
   * for the whole collapse. Tying the button to the `sent` phase alone popped it back to a
   * pill the instant the window started moving, blinking the check out from under the
   * person who had just earned it.
   *
   * It carries no timer — the hold is the phase's job — so it cannot drift out of step
   * with the state machine the way a second source of truth normally would.
   */
  const [sentBeat, setSentBeat] = useState(false);
  /**
   * The rest of the draft, up here for the same reason the message is: the panel unmounts
   * whenever the window closes, so anything it owns dies with it.
   *
   * There is no "kind" here any more. The form used to open on four kind chips, which made
   * it read as a ticket to fill in; the triage pass (`src/lib/feedback-triage.ts`) now works
   * the kind out from the words.
   *
   * `null` means "whatever page you are on", resolved by the panel at render time.
   *
   * Storing the resolved value would freeze the area at the page the draft was started on.
   * This way an untouched area follows you around the app, and one you actually chose is
   * kept until the draft is dropped.
   */
  const [area, setArea] = useState<FeedbackArea | null>(null);
  /**
   * Where the caret sat in the message box when the panel last went away.
   *
   * Part of the draft: reopening to find the cursor jumped to the far end of a paragraph
   * you were editing in the middle of is a small thing that undoes the point of keeping
   * the draft at all. The panel hands this up on every route that unmounts it — closing,
   * and attaching a screenshot — and reads it back once on mount.
   */
  const [caret, setCaret] = useState<{ start: number; end: number } | null>(null);
  /**
   * Whether the close under way should take the draft with it.
   *
   * Set only by Cancel and by a successful send. Dismissing the window — Escape, the
   * backdrop, the X — leaves it false, and the words and screenshots survive to be found
   * again on the next open.
   */
  const discardRef = useRef(false);
  /**
   * The same flag, for `endSession` to read.
   *
   * `endSession` is a `useCallback([])` and would close over `sentBeat` as it was on mount.
   * Same stale-closure reason as `shotsRef` and `phaseRef`.
   */
  const sentBeatRef = useRef(false);
  // Lazy initialiser rather than an effect: this component is only ever mounted client-side
  // (`ssr: false`), so `window` is there on the first render and there is no flash of a
  // wrongly-hidden button.
  const [captureSupported, setCaptureSupported] = useState(canCaptureScreen);

  // Object URLs outlive their component unless revoked, and a screenshot is not small.
  // Read through a ref so the cleanup sees the final list without re-running on every
  // attachment; per-shot revocation on removal is handled in `removeShot`.
  const shotsRef = useRef<DraftShot[]>([]);
  useEffect(() => {
    shotsRef.current = [...shots, ...chatShots];
  }, [shots, chatShots]);
  // The same for a full-screen capture still waiting on its crop, should the widget
  // unmount mid-selection.
  const frameRef = useRef<CapturedFrame | null>(null);
  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);
  useEffect(() => {
    return () => {
      for (const shot of shotsRef.current) URL.revokeObjectURL(shot.previewUrl);
      if (frameRef.current) releaseFrame(frameRef.current);
    };
  }, []);

  /**
   * The live phase, for the handlers that cannot see it.
   *
   * The open-request effect subscribes once and would otherwise close over the phase as it
   * was on mount. Same reason `shotsRef` exists above.
   */
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  /**
   * The collapse has finished and nothing is on screen.
   *
   * The draft is dropped here ONLY if it was sent or explicitly cancelled. Closing the
   * window any other way — Escape, the backdrop, the X — keeps it: half a paragraph and
   * two screenshots is real work, and losing it to a stray click outside a floating panel
   * is what stops someone reporting anything a second time.
   */
  const endSession = useCallback(() => {
    const wasSent = sentBeatRef.current;
    const discarded = discardRef.current;
    sentBeatRef.current = false;
    discardRef.current = false;

    // The thank-you lands here rather than at the moment the server answers, so it appears
    // as the window finishes leaving instead of underneath a window that is still on
    // screen. The button's check is the acknowledgement while the panel is still up; this
    // is what remains once it has gone, and it is also how the success reaches a screen
    // reader, through sonner's live region.
    if (wasSent) toast.success(`Sent to ${FEEDBACK_RECIPIENT} — replies show up in your notifications`);

    setSentBeat(false);
    setPhase("closed");

    if (!wasSent && !discarded) return;

    for (const shot of shotsRef.current) URL.revokeObjectURL(shot.previewUrl);
    setShots([]);
    setMessage("");
    setSubject("");
    setArea(null);
    setCategory(null);
    setCaret(null);
  }, []);

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
      // A docked panel has no anchor to sit under; only the view matters. A plain press of
      // the button opens the form; the bell and "Your feedback" open a conversation.
      const next = requested.target ?? { view: "compose" };
      // Remember where focus was so closing can return it — unless it is already inside the
      // panel (a door pressed from within), which would hand back a control about to vanish.
      const active = document.activeElement;
      if (
        phaseRef.current === "closed" &&
        active instanceof HTMLElement &&
        active !== document.body
      ) {
        openerRef.current = active;
      }
      setFocusToken((n) => n + 1);
      changeTargetRef.current(next);
      // "Tell Jason" from an error: start the message with what went wrong — but only into
      // an empty draft, never over words someone already wrote.
      if (next.view === "compose" && next.prefill && !draftHasWords.current) {
        if (next.prefill.subject) setSubject(next.prefill.subject);
        if (next.prefill.text) setMessage(next.prefill.text);
        if (next.prefill.category) setCategory(next.prefill.category);
      }
      // From `sent`, hand back a BLANK form. The message and screenshots are still in
      // state — `endSession` only runs at the end of the collapse — so reopening without
      // this would return a draft the person has already sent. Both setStates batch into
      // one render, so the panel never unmounts and the entrance does not replay.
      if (phaseRef.current === "sent") endSession();
      // From `closing` too: catching the window on its way out should bring it back rather
      // than doing nothing.
      setPhase((p) =>
        p === "closed" || p === "closing" || p === "sent" ? "composing" : p
      );
    };
    consume();
    return subscribeFeedbackOpen(consume);
  }, [endSession]);

  /**
   * Publish what the triggers render against.
   *
   * `closing` reports closed so the button starts fading back at the close REQUEST, which
   * is when the bell starts too. `sent` reports OPEN, because it is: a dialog is still on
   * screen and `aria-expanded` would be lying if it flipped while the window is sitting
   * there. `capturing`/`selecting` report `capturing`, which removes the triggers from the
   * tree entirely rather than fading them — a faded button is still in the photograph.
   */
  useEffect(() => {
    setFeedbackPanelState(
      phase === "composing" || phase === "sent"
        ? "open"
        : phase === "capturing" || phase === "selecting"
          ? "capturing"
          : "closed"
    );
  }, [phase]);

  useEffect(() => () => setFeedbackPanelState("closed"), []);

  /**
   * The room this panel takes, claimed for as long as it is a thing the person is working
   * in — INCLUDING while the screen is being captured, when the panel itself is unmounted.
   * Letting the page grow back for the length of a screenshot would mean the picture shows
   * a layout the person was not looking at, and the page would jump twice. `closing` lets go
   * at the close request, so the page widens as the panel slides away.
   */
  const holding = phase !== "closed" && phase !== "closing";
  useDockWidth(layout.squeezePx, holding && layout.squeezePx > 0);
  // The toast column and job stack, by the same measure `PANEL_CORNER_SHIFT_PX` gives the
  // notifications window. The larger of the two wins if both are open.
  useCornerShift(layout.shiftPx, holding && layout.shiftPx > 0);

  // Remember the view across a reload in this tab. The key is gone as soon as the close is
  // requested, so a panel someone closed does not come back.
  useEffect(() => {
    try {
      if (holding) {
        window.sessionStorage.setItem(
          DOCK_SESSION_KEY,
          serializeDockSession(
            target.view === "thread" ? { view: "thread", id: target.id } : { view: target.view }
          )
        );
      } else {
        window.sessionStorage.removeItem(DOCK_SESSION_KEY);
      }
    } catch {
      // Storage unavailable: the dock simply forgets across a reload.
    }
  }, [holding, target]);

  // Tell "Tell Jason" buttons elsewhere on the page that there is a widget to open.
  useEffect(() => {
    setFeedbackWidgetMounted(true);
    return () => setFeedbackWidgetMounted(false);
  }, []);

  useEffect(() => {
    draftHasWords.current = message.trim().length > 0 || subject.trim().length > 0;
  }, [message, subject]);

  /**
   * The send landed. Hold the window open for the button's gesture, then collapse.
   *
   * Conditional on `composing`, and not merely for tidiness: a submission with screenshots
   * runs 1.5-4s, and the panel can be dismissed while it is still in flight. The promise
   * then resolves into a widget that has already reached `closed`, and an unconditional
   * `setPhase` would mount the panel again — a window reappearing, mid-gesture, for a form
   * the person dismissed seconds ago.
   */
  const finish = useCallback(() => {
    if (phaseRef.current !== "composing") return;
    sentBeatRef.current = true;
    setSentBeat(true);
    setPhase("sent");
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
    // Comfortably past the 320ms slide; a reduced-motion person has no slide to wait for.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(endSession, reduced ? 80 : 900);
    return () => clearTimeout(timer);
  }, [phase, endSession]);

  /**
   * The hold, before the collapse.
   *
   * Cleanup is the cancellation: anything that leaves `sent` early — Esc, Cancel, the
   * backdrop, or a reopen — clears this timer without a line of its own, which is the
   * reason this is a phase rather than a timer paired with a boolean.
   */
  useEffect(() => {
    if (phase !== "sent") return;
    const timer = setTimeout(() => setPhase("closing"), SENT_HOLD_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  const addScreenshot = useCallback(async (target: "compose" | "chat" = "compose") => {
    if ((target === "chat" ? chatShots : shots).length >= MAX_SCREENSHOTS) return;
    captureTarget.current = target;

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
        toast.error("Couldn’t capture the screen — you can still send your note");
        return;
      }
      switch (err.reason) {
        case "cancelled":
          // Deliberately silent. This is almost always "clicked Cancel in the picker", and
          // a toast for a deliberate cancel is noise.
          break;
        case "no-source":
          toast.error("There was no screen or window to capture");
          break;
        case "unsupported":
          setCaptureSupported(false);
          toast.error("This browser can’t capture the screen — you can still send your note");
          break;
        default:
          toast.error("Couldn’t capture the screen — you can still send your note");
      }
    }
  }, [shots, chatShots]);

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
      const forChat = captureTarget.current === "chat";
      const list = forChat ? chatShots : shots;
      const setList = forChat ? setChatShots : setShots;
      try {
        const encoded = await cropDownscaleEncode(frame, crop, [], MAX_SCREENSHOT_BYTES);
        const used = list.reduce((sum, s) => sum + s.bytes, 0);
        if (used + encoded.bytes > MAX_SUBMISSION_BYTES) {
          toast.error("That screenshot would go over the attachment limit — remove one first");
          setPhase("composing");
          return;
        }
        setList((prev) => [
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
        toast.error("That screenshot is too large — try selecting a smaller area");
        setPhase("composing");
      } finally {
        releaseFrame(frame);
        setFrame(null);
      }
    },
    [frame, shots, chatShots]
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
      // A full-resolution decode, often GPU-backed: closed on failure too, not left to GC.
      let redacted: Awaited<ReturnType<typeof cropDownscaleEncode>>;
      try {
        redacted = await cropDownscaleEncode(
          { source: bitmap, width: bitmap.width, height: bitmap.height, previewUrl: "" },
          { x: 0, y: 0, w: bitmap.width, h: bitmap.height },
          shot.redactions,
          MAX_SCREENSHOT_BYTES
        );
      } finally {
        bitmap.close();
      }
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
      toast.error("Couldn’t hide those areas, so that screenshot was removed");
      URL.revokeObjectURL(shot.previewUrl);
      setShots((prev) => prev.filter((s) => s.id !== shot.id));
    } finally {
      setEditingShotId(null);
      setPhase("composing");
    }
  }, [shots, editingShotId]);

  /**
   * Attach images that didn't come from screen capture — pasted (⌘V), dropped, or picked from
   * the file chooser. The only way in on phones and Safari, which have no screen capture.
   * Same encode as a capture (`cropDownscaleEncode`), so size and format rules don't fork.
   */
  const latestLists = useRef({ compose: [] as DraftShot[], chat: [] as DraftShot[] });
  useEffect(() => {
    latestLists.current = { compose: shots, chat: chatShots };
  }, [shots, chatShots]);
  const addImageFiles = useCallback(async (files: File[], target: "compose" | "chat") => {
    const setList = target === "chat" ? setChatShots : setShots;
    for (const file of files.filter((f) => f.type.startsWith("image/"))) {
      const list = latestLists.current[target];
      if (list.length >= MAX_SCREENSHOTS) {
        toast.error(`Up to ${MAX_SCREENSHOTS} screenshots per message`, { report: false });
        return;
      }
      try {
        const bitmap = await createImageBitmap(file);
        let encoded: Awaited<ReturnType<typeof cropDownscaleEncode>>;
        try {
          encoded = await cropDownscaleEncode(
            { source: bitmap, width: bitmap.width, height: bitmap.height, previewUrl: "" },
            { x: 0, y: 0, w: bitmap.width, h: bitmap.height },
            [],
            MAX_SCREENSHOT_BYTES
          );
        } finally {
          bitmap.close();
        }
        const used = list.reduce((sum, s) => sum + s.bytes, 0);
        if (used + encoded.bytes > MAX_SUBMISSION_BYTES) {
          toast.error("That image would go over the attachment limit — remove one first", { report: false });
          return;
        }
        const shot: DraftShot = {
          id: crypto.randomUUID(),
          blob: encoded.blob,
          previewUrl: URL.createObjectURL(encoded.blob),
          width: encoded.width,
          height: encoded.height,
          bytes: encoded.bytes,
          note: "",
          redactions: [],
        };
        latestLists.current = { ...latestLists.current, [target]: [...list, shot] };
        setList((prev) => [...prev, shot]);
      } catch {
        toast.error("Couldn’t read that image — try a PNG or JPEG", { report: false });
      }
    }
  }, []);

  const removeChatShot = useCallback((id: string) => {
    setChatShots((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((s) => s.id !== id);
    });
  }, []);

  /** A conversation reply went out: its draft is spent. */
  const clearChatDraft = useCallback(() => {
    setChatShots((prev) => {
      for (const s of prev) URL.revokeObjectURL(s.previewUrl);
      return [];
    });
    setChatBody("");
  }, []);

  /** Move the panel; opening a different conversation drops the last one's unsent reply. */
  const changeTarget = useCallback(
    (next: FeedbackPanelTarget) => {
      setTarget(next);
      if (next.view !== "thread") return;
      if (lastThreadRef.current !== next.id) {
        if (lastThreadRef.current !== null) clearChatDraft();
        lastThreadRef.current = next.id;
        setLastThreadId(next.id);
      }
    },
    [clearChatDraft]
  );
  useEffect(() => {
    changeTargetRef.current = changeTarget;
  }, [changeTarget]);

  const removeShot = useCallback((id: string) => {
    setShots((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((s) => s.id !== id);
    });
  }, []);

  return (
    <>
      {/* The desktop rail button is the rail copy in `(app)/layout.tsx` so it renders with the
          page; the mobile copy lives in `AppShell`'s header. Both reach this widget through
          `src/lib/feedback-events.ts`. */}

      {(phase === "composing" || phase === "sent" || phase === "closing") && (
        <FeedbackPanel
          // Still OPEN through `sent`: `open={false}` is what makes Base UI apply
          // `data-ending-style` and start the collapse, so the hold has to happen on this
          // side of it.
          open={phase === "composing" || phase === "sent"}
          layout={layout}
          viewingAsUser={viewingAsUser}
          focusToken={focusToken}
          sent={sentBeat}
          target={target}
          onTargetChange={changeTarget}
          lastThreadId={lastThreadId}
          category={category}
          onCategoryChange={setCategory}
          message={message}
          onMessageChange={setMessage}
          subject={subject}
          onSubjectChange={setSubject}
          shots={shots}
          canCapture={captureSupported}
          onAddScreenshot={() => addScreenshot("compose")}
          onAddImageFiles={(files) => void addImageFiles(files, "compose")}
          chat={{
            body: chatBody,
            onBodyChange: setChatBody,
            shots: chatShots,
            canCapture: captureSupported,
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the callback is async by design; failures are handled inside it
            onAddScreenshot: () => addScreenshot("chat"),
            onAddImageFiles: (files) => void addImageFiles(files, "chat"),
            onRemoveShot: removeChatShot,
            onSent: clearChatDraft,
          }}
          onRemoveShot={removeShot}
          onEditShot={(id) => {
            setEditingShotId(id);
            setPhase("annotating");
          }}
          area={area}
          onAreaChange={setArea}
          // `discard` separates "I am done with this" from "get this out of my way". Only
          // the former takes the draft with it; see `endSession`.
          initialCaret={caret}
          onCaretChange={setCaret}
          onClose={(discard) => {
            discardRef.current = discard;
            // Hand focus back at the request, while the control still exists: the panel goes
            // inert for the slide-out, and focus on an inert node falls to the body.
            // After a reload there is no remembered opener: fall back to the visible button.
            const opener =
              openerRef.current ??
              Array.from(document.querySelectorAll<HTMLElement>('[aria-controls="feedback-dock"]')).find(
                (el) => el.offsetParent !== null
              );
            openerRef.current = null;
            // Next frame: the trigger is hidden while the panel is open and only becomes
            // focusable once this close has re-rendered it visible.
            // It takes a render or two, so try until focus lands (it cannot take it while
            // `visibility: hidden`), for at most half a second.
            let tries = 0;
            const refocus = () => {
              if (!opener?.isConnected) return;
              opener.focus({ preventScroll: true });
              if (document.activeElement !== opener && ++tries < 10) setTimeout(refocus, 50);
            };
            requestAnimationFrame(refocus);
            setPhase("closing");
          }}
          onClosed={endSession}
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
