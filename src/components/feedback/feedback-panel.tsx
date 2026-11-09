"use client";

import { ArrowLeft, Camera, X } from "lucide-react";
import { useTheme } from "next-themes";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getMyFeedbackThread, listMyFeedbackAction, submitFeedback } from "@/actions/feedback";
import { FeedbackChat } from "@/components/feedback/feedback-chat";
import { FeedbackList } from "@/components/feedback/feedback-list";
import type { DraftShot } from "@/components/feedback/feedback-widget";
import { SendButton } from "@/components/feedback/send-button";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AREA_LABELS,
  AREA_OPTIONS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_RECIPIENT,
  MAX_FEEDBACK_TEXT,
  MAX_SCREENSHOTS,
  featureAreaForPath,
  readClientContext,
  type FeedbackArea,
  type FeedbackCategory,
} from "@/lib/feedback-report";
import type { FeedbackPanelTarget } from "@/lib/feedback-events";
import type { FeedbackThread, MyFeedbackRow } from "@/lib/feedback-thread";
import { useCornerShift } from "@/lib/corner-clearance";
import { PANEL_CORNER_SHIFT_PX } from "@/lib/floating-panel";
import { cn } from "@/lib/utils";
import { blobToDataUrl } from "@/lib/screenshot-capture";
import { toast } from "@/lib/toast";

/** The four kinds, worded the way someone would say them. One line, all optional. */
const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug: "Something's broken",
  idea: "I have an idea",
  confusing: "This confused me",
  praise: "This worked well",
};

export function FeedbackPanel({
  open,
  sent,
  target,
  onTargetChange,
  category,
  onCategoryChange,
  message,
  onMessageChange,
  area,
  onAreaChange,
  shots,
  canCapture,
  onAddScreenshot,
  onRemoveShot,
  onEditShot,
  onClose,
  initialCaret,
  onCaretChange,
  onClosed,
  onSent,
}: {
  /**
   * Driven, not hardcoded. The window has to stay mounted through its own exit transition
   * or there is no exit transition — see `onClosed`.
   */
  open: boolean;
  /**
   * The send landed and the window is being held open for the Send button's gesture.
   *
   * Owned by the widget's `sent` phase rather than by this component: the hold has to
   * outlive a re-render here and, more to the point, only the widget can keep the panel
   * mounted. This component reads it and never sets it.
   */
  sent: boolean;
  /** Which view is showing — the form, your past feedback, or one conversation. */
  target: FeedbackPanelTarget;
  onTargetChange: (next: FeedbackPanelTarget) => void;
  /** The kind they picked, or null to let triage read it from the words. */
  category: FeedbackCategory | null;
  onCategoryChange: (next: FeedbackCategory | null) => void;
  message: string;
  onMessageChange: (value: string) => void;
  /** `null` = follow the current page. Owned by the widget so it survives a dismissal. */
  area: FeedbackArea | null;
  onAreaChange: (next: FeedbackArea) => void;
  shots: DraftShot[];
  canCapture: boolean;
  onAddScreenshot: () => void;
  onRemoveShot: (id: string) => void;
  onEditShot: (id: string) => void;
  /**
   * Asked to close. The window then plays its collapse; it is still mounted.
   *
   * `discard` is true only when the person chose to throw the draft away — the Cancel
   * button, or a send that has already succeeded. Every other route out of this window is a
   * dismissal, and the draft is kept for the next time it opens.
   */
  onClose: (discard: boolean) => void;
  /** Where the caret was when the window last closed, so it can be put back. */
  initialCaret: { start: number; end: number } | null;
  onCaretChange: (caret: { start: number; end: number }) => void;
  /** The collapse has finished and nothing is on screen — safe to unmount and reset. */
  onClosed: () => void;
  onSent: () => void;
}) {
  const pathname = usePathname();
  const { resolvedTheme } = useTheme();
  /**
   * A null `area` means the draft has never had one chosen, so it follows the page you are
   * actually on — resolved here, at render, rather than frozen into the draft when it was
   * started. Choosing one pins it until the draft is dropped.
   */
  const effectiveArea = area ?? featureAreaForPath(pathname ?? "/");
  const [sending, setSending] = useState(false);
  /**
   * The discard question, asked inside the window rather than by the browser.
   *
   * `window.confirm` was doing this, and it was the wrong instrument twice over: it is a
   * different visual world dropped on top of a glass panel, and it blocks the main thread,
   * which froze the Send button's gesture mid-draw when it fired during the success beat.
   */
  const [confirming, setConfirming] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** Something worth asking about before it is thrown away. */
  const hasDraft = message.trim().length > 0 || shots.length > 0;

  /** Whether this opening has already had its caret put back. Once per open, at most. */
  const caretRestored = useRef(false);

  /**
   * Put the caret back where it was — from the ref callback, not an effect.
   *
   * No effect is early enough. This component deliberately mounts CLOSED for one frame so
   * Base UI has a false->true to animate (see `entered` below), and Base UI does not render
   * the popup's contents until after the commit that opens it — so even an effect keyed on
   * `sheetOpen` runs while this ref is still null, restores nothing, and never fires again.
   * A ref callback runs exactly when the node exists, which is the moment we need.
   *
   * Focusing here rather than leaving it to `autoFocus` also settles the ordering: by the
   * time React applies `autoFocus` the field is already focused, so that call cannot move
   * the caret back to the start.
   */
  const attachTextarea = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      if (!node || caretRestored.current || !initialCaret) return;
      caretRestored.current = true;
      node.focus();
      const end = Math.min(initialCaret.end, node.value.length);
      node.setSelectionRange(Math.min(initialCaret.start, end), end);
    },
    [initialCaret]
  );

  /**
   * Hand the caret up before this component stops existing.
   *
   * Called on the way out of every route that unmounts the panel, including attaching a
   * screenshot — which tears the window down mid-sentence and would otherwise lose the
   * position exactly when someone is most likely to be mid-thought.
   */
  const rememberCaret = useCallback(() => {
    const field = textareaRef.current;
    if (!field) return;
    onCaretChange({ start: field.selectionStart, end: field.selectionEnd });
  }, [onCaretChange]);

  /** Every exit runs through here, so the caret is never lost on one of them. */
  const requestClose = useCallback(
    (discard: boolean) => {
      rememberCaret();
      onClose(discard);
    },
    [rememberCaret, onClose]
  );

  const remaining = MAX_FEEDBACK_TEXT - message.length;
  /** Something to send. Kept apart from `canSend` so the button can stay lit while busy. */
  const hasMessage = message.trim().length > 0;
  // `!sent` matters: `setSending(false)` runs in a `finally`, AFTER `onSent()` has already
  // started the hold, so without it Send would re-arm for the whole gesture.
  const canSend = hasMessage && !sending && !sent;

  const usedShots = useMemo(() => shots.length, [shots]);

  /**
   * Mount closed, then open on the next frame.
   *
   * Base UI plays the enter transition on a false -> true change of `open`. This panel is
   * mounted at the moment it is wanted, so passing `open` straight through meant the sheet
   * came into existence ALREADY open — nothing to transition from, no `data-starting-style`,
   * and the `scale-[0.28]` in sheet.tsx never ran. The notifications window does not have
   * this problem because it is mounted for the life of the page and only toggles.
   *
   * `requestAnimationFrame` and not a 0ms timeout: the closed state has to be painted
   * before the open state is applied, or the browser coalesces the two and there is still
   * nothing to animate. The timer is a backstop for a frame that never arrives.
   */
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!open || entered) return;
    const frame = requestAnimationFrame(() => setEntered(true));
    const backstop = setTimeout(() => setEntered(true), 120);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(backstop);
    };
  }, [open, entered]);

  // Derived rather than a second piece of state that has to be reset: `entered` only ever
  // goes true, and the close is driven by `open` going false. A fresh mount starts the
  // sequence over, which is exactly what reopening should do.
  const sheetOpen = open && entered;

  // Toasts (this panel's own error toasts included) and the job stack slide to the
  // window's left while it is open, instead of landing on the Send row. Keyed to `open`,
  // not mount: the panel stays mounted through its exit transition.
  useCornerShift(PANEL_CORNER_SHIFT_PX, open);


  /**
   * Whether the window has ever actually been open.
   *
   * Guards `onOpenChangeComplete`: the deliberate closed first frame above would otherwise
   * report a completed close the instant the panel mounted, and unmount it again.
   */
  const hasEntered = useRef(false);
  useEffect(() => {
    if (sheetOpen) hasEntered.current = true;
  }, [sheetOpen]);

  /**
   * Their past feedback, for the "Your feedback" tab and its unread count. Read when the
   * panel opens and again whenever that tab is shown, so a reply that arrived meanwhile shows.
   */
  const [mine, setMine] = useState<MyFeedbackRow[] | null>(null);
  useEffect(() => {
    if (!open || target.view === "thread") return;
    let live = true;
    listMyFeedbackAction()
      .then((rows) => live && setMine(rows))
      .catch(() => live && setMine((prev) => prev ?? []));
    return () => {
      live = false;
    };
  }, [open, target.view]);
  const unread = mine?.filter((r) => r.unread).length ?? 0;

  async function send() {
    if (!canSend) return;
    setSending(true);
    try {
      // Encoded to base64 here, once, rather than held that way — base64 costs 4/3 of the
      // bytes in the JS heap for as long as the panel is open, for no benefit.
      const screenshots = await Promise.all(
        shots.map(async (shot) => ({
          dataUrl: await blobToDataUrl(shot.blob),
          note: shot.note || undefined,
          width: shot.width,
          height: shot.height,
        }))
      );

      const client = readClientContext(resolvedTheme);
      const result = await submitFeedback({
        text: message,
        area: effectiveArea,
        category: category ?? undefined,
        path: client.path,
        viewport: client.viewport,
        devicePixelRatio: client.devicePixelRatio,
        theme: client.theme,
        timeZone: client.timeZone,
        screenshots,
      });

      if (!result.ok) {
        // The panel stays open and nothing is cleared: whatever went wrong, the words are
        // still the person's and they should not have to retype them.
        toast.error(result.message);
        return;
      }
      // No toast here. The thank-you is raised by the widget once the window has finished
      // collapsing, so the two do not talk over each other — see `clearDraft`.
      onSent();
    } catch {
      toast.error("That didn’t send — try again in a moment");
    } finally {
      setSending(false);
    }
  }

  return (
    <Sheet
      open={sheetOpen}
      // Escape, the backdrop and the X. None of them destroy anything any more — the draft
      // is waiting when the window reopens — so none of them ask. The confirm that used to
      // live here was the right question when this threw the words away, and is now just an
      // obstacle between someone and the thing they were trying to look at.
      onOpenChange={(next) => {
        if (next) return;
        // While the question is up, Escape and a press outside answer IT rather than
        // closing the window behind it. Anything else would leave you unable to say "no"
        // with the key you reach for first.
        if (confirming) {
          setConfirming(false);
          return;
        }
        requestClose(false);
      }}
      // Fires when the open/close transition has actually finished. Unmounting on the
      // close REQUEST instead — which is what happened before — tore the window out of the
      // tree mid-frame, so it vanished rather than collapsing: Base UI never got to apply
      // `data-ending-style`, and the scale-back-to-0.28 never ran.
      onOpenChangeComplete={(nowOpen) => {
        if (!nowOpen && hasEntered.current) onClosed();
      }}
    >
      <SheetContent
        // Docked to the right edge and full height: a place to read past conversations as
        // well as write a new one, which a small floating window never was.
        side="right"
        // The sheet's own surface, like the other right-side panels. Not `.liquid-glass`: that
        // class pins the element to `position: relative`, which un-docks a fixed sheet.
        // `sm:max-w-[34rem]` so the four kinds fit on one line beside the message box.
        className="gap-5 overflow-y-auto p-6 data-[side=right]:sm:max-w-[34rem]"
        // Lighter than the shared default: the page behind stays legible.
        overlayClassName="bg-black/5 supports-backdrop-filter:backdrop-blur-[1.5px]"
        showCloseButton
      >
        <SheetHeader className="shrink-0 gap-3 p-0 pr-8">
          <SheetTitle className="font-[family-name:var(--font-display)] text-lg">
            {target.view === "compose"
              ? `Message ${FEEDBACK_RECIPIENT}`
              : target.view === "thread"
                ? `Conversation with ${FEEDBACK_RECIPIENT}`
                : "Your feedback"}
          </SheetTitle>
          <SheetDescription className={target.view === "compose" ? undefined : "sr-only"}>
            I read every one. Useful reports can earn bonus AI credits.
          </SheetDescription>
          <div className="flex gap-1 rounded-full bg-muted/60 p-1 text-sm" role="tablist" aria-label="Feedback">
            {(
              [
                { view: "compose", label: `Message ${FEEDBACK_RECIPIENT}` },
                { view: "list", label: "Your feedback" },
              ] as const
            ).map((tab) => {
              const active = tab.view === "compose" ? target.view === "compose" : target.view !== "compose";
              return (
                <button
                  key={tab.view}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => onTargetChange({ view: tab.view })}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 transition-colors",
                    active ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {tab.label}
                  {tab.view === "list" && unread > 0 && (
                    <span className="rounded-full bg-primary px-1.5 text-[0.65rem] font-medium text-primary-foreground">
                      {unread} new
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </SheetHeader>

        {target.view === "list" ? (
          mine === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : mine.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing yet. Anything you send {FEEDBACK_RECIPIENT} shows up here, with his replies.
            </p>
          ) : (
            <FeedbackList rows={mine} onOpen={(id) => onTargetChange({ view: "thread", id })} />
          )
        ) : target.view === "thread" ? (
          <PanelThread
            id={target.id}
            onBack={() => onTargetChange({ view: "list" })}
            onNavigate={() => requestClose(false)}
          />
        ) : (
        <>
        {/* The four kinds, on one line, all optional. Scrolls sideways on a narrow phone
            rather than wrapping into a block that reads as a form to fill in. */}
        <div
          className="-mx-1 flex shrink-0 flex-nowrap gap-1.5 overflow-x-auto px-1 pb-0.5"
          role="group"
          aria-label="Kind of feedback (optional)"
        >
          {FEEDBACK_CATEGORIES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={category === value}
              onClick={() => onCategoryChange(category === value ? null : value)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs transition-colors",
                category === value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border/70 text-muted-foreground hover:border-primary/40 hover:text-foreground"
              )}
            >
              {CATEGORY_LABELS[value]}
            </button>
          ))}
        </div>


        {/* The one block that gives, so that everything else always fits on screen.
 *
 * `flex-1` — grow AND shrink — with a `min-h-24` floor rather than the removed floor this
 * had. Every other block is `shrink-0` and sized by its content, so when the window is
 * short this is the only thing that can yield, and the panel gets shorter instead of
 * needing to be scrolled.
 *
 * The floor has to live HERE and not on the textarea. It was `min-h-0` on the block with
 * `min-h-40` on the field, which meant the block shrank and the field refused to follow:
 * the textarea spilled out of its own parent and the screenshot button rendered inside it.
 * At the real anchor (`top: 72`) on a 700px window the block collapsed to 68px around a
 * 160px field — a 60px overlap. Margin could never fix that, because the sibling was
 * positioned from the shrunken block: the measured gap was right while the boxes overlapped
 * on screen.
 *
 * With the floor on the block and none on the field, the field is exactly as tall as its
 * parent at every size. It cannot spill, and there is nothing to scroll.
 *
 * The floor is 80px: the field's two lines plus the 28px area tag that now sits inside this
 * block. It was 48px when the kind chips and the area field sat ABOVE the message; taking
 * those out gave back ~130px, so the tag fits inside the old budget with room to spare and
 * everything still fits with a shot attached on a ~600px window. The sheet keeps
 * `overflow-y-auto` as a last resort below that, so nothing is ever unreachable, but it is
 * not the normal path.
 *
 * `grid-rows-[1fr_auto]`: the field takes the slack and the tag row stays its own height.
 * Two auto rows would stretch equally and float the tag halfway down an empty box. */}
        <div className="grid min-h-20 flex-1 grid-rows-[1fr_auto] gap-1.5">
          <Textarea
            ref={attachTextarea}
            autoFocus
            // Fills whatever the block has, large or small: the parent is a grid whose auto
            // row stretches. `field-sizing-content` on the primitive still expands it as you
            // type.
            //
            // `min-h-0` is load-bearing — a grid item's automatic minimum size would
            // otherwise stop it shrinking with its parent, which is the whole bug above.
            className="h-full min-h-0 resize-none"
            value={message}
            maxLength={MAX_FEEDBACK_TEXT}
            placeholder="What’s on your mind? A bug, an idea, something confusing…"
            onChange={(e) => onMessageChange(e.target.value)}
            // Enter sends, the way a message does — that is the habit this window is
            // competing with. Shift+Enter is the new line.
            //
            // Fine pointers only: on a phone the return key is how you write a second
            // line, and the Send button is right there. Never mid-composition either — an
            // IME uses Enter to commit the candidate, and sending half a word is worse
            // than not sending.
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              if (!window.matchMedia("(pointer: fine)").matches) return;
              e.preventDefault();
              void send();
            }}
          />
          {/* Which part of Orbit, as a tag under the message rather than a field above it.
              It is filled in from the page, so nobody has to answer it; it is still one tap
              to correct. Orbit's own dropdown rather than a bare `<select>`, whose popup is
              drawn by the OS and looks like nothing else in the app. */}
          <div className="flex items-center justify-between gap-2">
            <Select
              value={effectiveArea}
              onValueChange={(v) => onAreaChange((v || "other") as FeedbackArea)}
              // Without `items`, `SelectValue` renders the raw stored value — the trigger
              // would read "dashboard" rather than "Dashboard".
              items={AREA_OPTIONS}
            >
              <SelectTrigger
                aria-label={`Which part of Orbit: ${AREA_LABELS[effectiveArea]}`}
                className="h-7 w-auto gap-1 rounded-full px-2.5 text-xs text-muted-foreground"
              >
                <span aria-hidden>About:</span>
                <SelectValue />
              </SelectTrigger>
              {/* `alignItemWithTrigger={false}` drops the list below the trigger instead of
                  over it, which also gives back the open/close animation that
                  `data-[align-trigger=true]:animate-none` in `ui/select.tsx` turns off. */}
              <SelectContent alignItemWithTrigger={false} className="p-1">
                {AREA_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value} className="py-1.5 pl-2">
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {remaining < 400 && (
              <p className="text-xs text-muted-foreground">{remaining} left</p>
            )}
          </div>
        </div>

        {/* A little clear of the message box above it. Both are large bordered surfaces, so
            the panel's own 20px rhythm reads tighter between them than it does under a
            text label. 28px — the full 32 this had read as a gulf. */}
        <div className="mt-2 grid shrink-0 gap-2">
          {/* Two sizes, and the difference is what keeps the Send button on screen.
   *
   * Empty, this is the primary way to attach one: full width, its own label, and an
   * explanation of the gesture, because a screenshot is the most useful thing in the whole
   * submission and it used to be a 72px dashed tile that read as an afterthought.
   *
   * Once a shot is attached that explanation has done its job, and 112px of teaching copy
   * is 112px the form no longer has. Everything in this panel is `shrink-0` except the
   * message box, so the thumbnail row and its counter came straight out of the message
   * box's height until it hit its floor — and then out of the footer, which is how the
   * Send button ended up below the bottom of the window. Collapsing the button to a single
   * row gives back more than the thumbnails cost, so the total goes DOWN. */}
          {canCapture && usedShots === 0 && (
            <Button
              type="button"
              variant="outline"
              // `whitespace-normal` undoes `buttonVariants`' nowrap, which would otherwise
              // clip the second line against the sheet's 24rem max width.
              className="h-auto w-full justify-start gap-3 whitespace-normal border-dashed px-4 py-3 text-left"
              onClick={() => {
                rememberCaret();
                onAddScreenshot();
              }}
            >
              <Camera className="size-5 shrink-0" />
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">Add a screenshot</span>
                <span className="text-xs font-normal leading-snug text-muted-foreground">
                  Drag a box around the problem. It attaches when you let go.
                </span>
              </span>
            </Button>
          )}

          {/* The add control joins this row rather than sitting above it, which is what
              keeps the Send button on screen.
              
              Everything in this panel is `shrink-0` except the message box, so the
              thumbnails come straight out of the message box's height — and once it hits
              its floor, out of the footer. The teaching button above stayed at its full
              112px after you had already used it, so attaching one screenshot cost ~96px
              and pushed Send off the bottom of a laptop window. As a tile inside a row that
              already exists it costs nothing at all: one shot now occupies exactly the same
              height as three. */}
          <div className="flex flex-wrap items-center gap-2">
            {shots.map((shot, index) => (
              <div key={shot.id} className="group relative">
                {/* The annotator moved behind this: shots attach on release now, so adding a
                    note is an optional second step rather than a gate on the way in. */}
                <button
                  type="button"
                  onClick={() => onEditShot(shot.id)}
                  aria-label={`Add a note to screenshot ${index + 1}`}
                  className="block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: of
                      the user's own screen, never a remote origin. */}
                  <img
                    src={shot.previewUrl}
                    alt={shot.note || `Screenshot ${index + 1}`}
                    className="h-16 w-24 rounded-md border border-border object-cover"
                  />
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove screenshot ${index + 1}`}
                  // Focus-within as well as hover: a hover-only control does not exist for
                  // anyone using a keyboard.
                  className="absolute -right-1.5 -top-1.5 size-5 rounded-full bg-background pointer-fine:opacity-0 shadow group-hover:opacity-100 group-focus-within:opacity-100"
                  onClick={() => onRemoveShot(shot.id)}
                >
                  <X className="size-3" />
                </Button>
                {shot.note && (
                  <span className="mt-1 block max-w-24 truncate text-[0.65rem] text-muted-foreground">
                    {shot.note}
                  </span>
                )}
              </div>
            ))}

            {canCapture && usedShots > 0 && usedShots < MAX_SCREENSHOTS && (
              <button
                type="button"
                onClick={() => {
                  rememberCaret();
                  onAddScreenshot();
                }}
                aria-label="Add another screenshot"
                // Matches a thumbnail's box exactly, so the row stays on one line and the
                // tile reads as the empty slot next to the ones already filled.
                className="flex h-16 w-24 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <Camera className="size-4" />
              </button>
            )}
          </div>

          {!canCapture ? (
            // Never render a button that can only fail: getDisplayMedia does not exist on
            // iOS in any browser, and is absent or inert on Android.
            <p className="text-xs text-muted-foreground">
              Screenshots aren&apos;t available in this browser — describe what you saw and
              we&apos;ll find it.
            </p>
          ) : (
            usedShots > 0 && (
              <p className="text-xs text-muted-foreground">
                {usedShots} of {MAX_SCREENSHOTS} attached
                {usedShots < MAX_SCREENSHOTS ? " — tap one to add a note." : "."}
              </p>
            )
          )}
        </div>

        <div className="mt-auto flex shrink-0 justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            // The one exit that does throw the draft away, so the one that still asks —
            // and only when there is something to lose. `hasDraft` counts screenshots as
            // well as words: a shot is a deliberate act and takes longer to make than a
            // sentence, so losing one silently is worse, not better.
            onClick={() => {
              if (!sent && hasDraft) {
                setConfirming(true);
                return;
              }
              requestClose(true);
            }}
          >
            Cancel
          </Button>
          {/* `disabled` is only ever about having something to send. While the request is
              in flight the button stays lit and runs its sweep; `SendButton` blocks the
              clicks, and `send()` re-checks `canSend` regardless. */}
          <SendButton
            sending={sending}
            sent={sent}
            disabled={!hasMessage}
            onClick={send}
          />
        </div>
        {confirming && (
          <div
            // Covers the whole panel, corners included (`inset-0`, inherited radius).
            data-slot="feedback-discard"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="feedback-discard-title"
            className="absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-popover/85 p-6 supports-backdrop-filter:backdrop-blur-[2px]"
          >
            <div className="w-full max-w-[17rem] rounded-2xl border border-border/70 bg-popover p-4 text-center shadow-lg">
              <p
                id="feedback-discard-title"
                className="font-[family-name:var(--font-display)] text-base text-ink"
              >
                Discard your feedback?
              </p>
              <p className="mt-1 text-xs leading-snug text-muted-foreground">
                {describeDraft(message, shots.length)}{" "}
                This can&apos;t be undone.
              </p>
              <div className="mt-4 flex justify-center gap-2">
                {/* The safe answer takes the focus, so Enter keeps the draft rather than
                    destroying it. */}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  autoFocus
                  onClick={() => setConfirming(false)}
                >
                  Keep editing
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setConfirming(false);
                    requestClose(true);
                  }}
                >
                  Discard
                </Button>
              </div>
            </div>
          </div>
        )}
        </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Names what is actually about to be lost, rather than asking in the abstract. */
function describeDraft(message: string, shots: number): string {
  const hasText = message.trim().length > 0;
  const pictures = `${shots} screenshot${shots === 1 ? "" : "s"}`;
  if (hasText && shots > 0) return `Your message and ${pictures} will be deleted.`;
  if (shots > 0) return `Your ${pictures} will be deleted.`;
  return "Your message will be deleted.";
}

/**
 * One conversation inside the panel. Reading it marks it read (the action does), and
 * `FeedbackChat` keeps it live and asks the bell to re-read.
 */
function PanelThread({
  id,
  onBack,
  onNavigate,
}: {
  id: string;
  onBack: () => void;
  onNavigate: () => void;
}) {
  const [thread, setThread] = useState<FeedbackThread | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getMyFeedbackThread(id)
      .then((t) => live && setThread(t))
      .catch(() => live && setThread(null));
    return () => {
      live = false;
    };
  }, [id]);

  return (
    <div className="grid gap-3">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Your feedback
      </button>
      {thread === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : thread === null ? (
        <p className="text-sm text-muted-foreground">That conversation isn’t available.</p>
      ) : (
        <FeedbackChat key={thread.id} initial={thread} onNavigate={onNavigate} />
      )}
    </div>
  );
}
