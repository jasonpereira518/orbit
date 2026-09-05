"use client";

import { Camera, X } from "lucide-react";
import { useTheme } from "next-themes";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { submitFeedback } from "@/actions/feedback";
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
  AREA_OPTIONS,
  FEEDBACK_CATEGORIES,
  MAX_FEEDBACK_TEXT,
  MAX_SCREENSHOTS,
  clampPanelOffset,
  featureAreaForPath,
  readClientContext,
  type FeedbackArea,
  type FeedbackCategory,
} from "@/lib/feedback-report";
import type { PanelAnchor } from "@/lib/floating-panel";
import { blobToDataUrl } from "@/lib/screenshot-capture";
import { toast } from "@/lib/toast";

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug: "Something's broken",
  idea: "I have an idea",
  confusing: "This confused me",
  praise: "This worked well",
};

export function FeedbackPanel({
  open,
  sent,
  anchor,
  offset,
  onOffsetChange,
  message,
  onMessageChange,
  shots,
  canCapture,
  onAddScreenshot,
  onRemoveShot,
  onEditShot,
  onClose,
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
  /** Where the window sits and what it grows out of — see `anchorBelowTrigger`. */
  anchor: PanelAnchor;
  /**
   * How far the person has dragged the window from that anchor. Owned by the widget rather
   * than by this component, so it survives the panel unmounting for a screenshot — and is
   * cleared when the panel actually closes, which is what puts it back where it started.
   */
  offset: { x: number; y: number };
  onOffsetChange: (next: { x: number; y: number }) => void;
  message: string;
  onMessageChange: (value: string) => void;
  shots: DraftShot[];
  canCapture: boolean;
  onAddScreenshot: () => void;
  onRemoveShot: (id: string) => void;
  onEditShot: (id: string) => void;
  /** Asked to close. The window then plays its collapse; it is still mounted. */
  onClose: () => void;
  /** The collapse has finished and nothing is on screen — safe to unmount and reset. */
  onClosed: () => void;
  onSent: () => void;
}) {
  const pathname = usePathname();
  const { resolvedTheme } = useTheme();
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [area, setArea] = useState<FeedbackArea>(() => featureAreaForPath(pathname ?? "/"));
  const [sending, setSending] = useState(false);

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

  const panelRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * The pointer and panel positions at the moment the drag began.
   *
   * Measured once, so a move is arithmetic on numbers already in hand rather than a
   * `getBoundingClientRect()` per pointermove — that call forces layout, and it would run
   * far more often than the screen refreshes.
   */
  const dragFrom = useRef<{
    px: number;
    py: number;
    ox: number;
    oy: number;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  /** The live offset during a drag, which React does not see until the pointer is released. */
  const liveOffset = useRef(offset);

  function startDrag(e: React.PointerEvent) {
    if (e.button !== 0) return;
    // The window is on its way out; grabbing it now would only fight the collapse.
    if (sent) return;
    // The close button lives in this header, and the title is selectable text. Neither
    // should be a drag handle.
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.preventDefault();
    try {
      // Keeps the drag alive when the pointer outruns the header, which it will — the
      // handle is a strip and the window follows the cursor anywhere. Wrapped because it
      // throws for a pointer id the browser is not currently tracking, and losing capture
      // is a degraded drag rather than a reason not to start one.
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignored on purpose — see above.
    }
    liveOffset.current = offset;
    dragFrom.current = {
      px: e.clientX,
      py: e.clientY,
      ox: offset.x,
      oy: offset.y,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    setDragging(true);
  }

  /**
   * Move the window by writing the transform straight to the node.
   *
   * Deliberately NOT React state. The panel holds a textarea, a select and the screenshot
   * thumbnails, and re-rendering all of it on every pointermove is what made the drag feel
   * heavy. Setting `translate` touches no layout — the compositor takes it — so this stays
   * smooth however fast the pointer moves, and the state is reconciled once on release.
   *
   * It also drops the rAF this used to coalesce through: the browser already delivers
   * pointermove at most once per frame, and a style write is far cheaper than the render
   * the coalescing existed to avoid.
   */
  function moveDrag(e: React.PointerEvent) {
    const start = dragFrom.current;
    const node = panelRef.current;
    if (!start || !node) return;

    const next = clampPanelOffset({
      start: { left: start.left, top: start.top, width: start.width, height: start.height },
      startOffset: { x: start.ox, y: start.oy },
      delta: { x: e.clientX - start.px, y: e.clientY - start.py },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    liveOffset.current = next;
    node.style.translate = `${next.x}px ${next.y}px`;
  }

  function endDrag() {
    if (!dragFrom.current) return;
    dragFrom.current = null;
    setDragging(false);
    // Hand the final position to React so the style prop and the DOM agree. Re-rendering
    // writes the same `translate` that is already on the node, so nothing moves.
    onOffsetChange(liveOffset.current);
  }

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
        area,
        category,
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
      toast.error("Couldn't send that. Try again in a moment.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Sheet
      open={sheetOpen}
      onOpenChange={(next) => {
        if (next) return;
        // Never after a successful send. The draft is still in state until the collapse
        // ends, so without `!sent` pressing Escape on the success beat asks whether to
        // discard feedback that has already been sent — and `window.confirm` blocks the
        // main thread, freezing the button's gesture mid-draw.
        if (!sent && message.trim().length > 0 && !window.confirm("Discard your feedback?")) {
          return;
        }
        onClose();
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
        side="floating"
        // The notifications window's treatment, and for the same reasons documented on
        // `.liquid-glass-panel` in globals.css: it carries the radius, the lifted shadow,
        // and — the part that matters here — a full re-declaration of the transition with
        // an ease-OUT arriving and an ease-IN leaving. One curve in both directions is what
        // made closing feel like it stopped dead rather than being drawn back into the
        // button. `.liquid-glass` on its own would not match those selectors.
        className="liquid-glass liquid-glass-panel gap-5 overflow-y-auto p-6"
        // Lighter than the shared default, exactly as the notifications window does it: the
        // page behind stays legible instead of being dimmed to a modal.
        overlayClassName="bg-black/5 supports-backdrop-filter:backdrop-blur-[1.5px]"
        // `top` overrides the floating side's `inset-y-4` so the window opens BELOW the
        // trigger rail. The notifications window is full height and lands on top of its own
        // bell — it is pretending to BE that bell. This one shares the rail rather than
        // replacing it, so everything above it, the bell included, stays visible and usable.
        //
        // `transformOrigin` aims the panel's 0.28 scale at the button rather than at its
        // own centre, so it still reads as the button unfolding.
        // `translate` rather than `top`/`left`: the panel is positioned against the right
        // edge, so moving it by its inset would fight that anchoring. It also composites
        // without relayout, which is what keeps a drag smooth.
        //
        // The transition is suppressed WHILE dragging: `.liquid-glass-panel` transitions
        // `translate` over 0.32s, so without this the window would ease toward the cursor
        // a third of a second behind it.
        style={{
          transformOrigin: anchor.origin,
          top: anchor.top,
          translate: `${offset.x}px ${offset.y}px`,
          // `&& !sent`: a pointer still held on the header when the send lands would
          // otherwise leave `transition: none` in place and the collapse would jump rather
          // than travel.
          ...(dragging && !sent ? { transition: "none" } : {}),
        }}
        ref={panelRef}
        showCloseButton
      >
        {/* The header is the handle. Not the whole panel: a drag that starts anywhere
            would fight text selection in the message field and the screenshot thumbnails. */}
        <SheetHeader
          className="shrink-0 p-0 select-none"
          style={{ cursor: dragging ? "grabbing" : "grab", touchAction: "none" }}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <SheetTitle className="font-[family-name:var(--font-display)] text-lg">
            Tell us what happened
          </SheetTitle>
          <SheetDescription>
            It goes straight to whoever runs Orbit, with the page you&apos;re on attached.
          </SheetDescription>
        </SheetHeader>

        {/* A segmented row rather than a Select: four options, and a popup inside a
            floating sheet is a stacking-context fight nobody wins. */}
        {/* `shrink-0`, like every other block here: the sheet scrolls when it runs out of
            room, it does not compress its contents. See the note on the message block. */}
        <div className="flex shrink-0 flex-wrap gap-2" role="group" aria-label="Kind of feedback">
          {FEEDBACK_CATEGORIES.map((value) => (
            <Button
              key={value}
              type="button"
              size="xs"
              variant={category === value ? "default" : "outline"}
              aria-pressed={category === value}
              onClick={() => setCategory(value)}
            >
              {CATEGORY_LABELS[value]}
            </Button>
          ))}
        </div>

        <div className="grid shrink-0 gap-1.5">
          <span id="feedback-area-label" className="text-xs font-medium text-muted-foreground">
            Which part of Orbit?
          </span>
          {/* Orbit's own dropdown rather than a bare `<select>`, whose popup is drawn by the
              OS and looks like nothing else in the app. The popup portals out at z-50 and
              mounts after the sheet, so it paints above it. */}
          <Select
            value={area}
            onValueChange={(v) => setArea((v || "other") as FeedbackArea)}
            // Without `items`, `SelectValue` renders the raw stored value — the trigger
            // would read "dashboard" rather than "Dashboard".
            items={AREA_OPTIONS}
          >
            <SelectTrigger aria-labelledby="feedback-area-label" className="h-9 w-full">
              <SelectValue />
            </SelectTrigger>
            {/* `alignItemWithTrigger={false}` is the load-bearing half. The default
                positions the popup so the selected row sits over the trigger, which both
                covers the field you just pressed and — via
                `data-[align-trigger=true]:animate-none` in `ui/select.tsx` — turns the
                open and close animation off entirely. Opting out drops the list below the
                trigger and gives back the fade-and-zoom every other popup in the app has.

                `p-1` insets the rows from the popup's own rounded corners; without it the
                first and last row sit flush against the edge. */}
            <SelectContent alignItemWithTrigger={false} className="p-1">
              {AREA_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value} className="py-1.5 pl-2">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
 * The floor is 48px — about two lines. It was 64px, which was fine until a screenshot was
 * attached: the thumbnail row has to come out of this box, and on a short window the extra
 * 16px was the difference between the form fitting and the Send button being pushed off the
 * bottom. Low enough that everything still fits with a shot attached on a ~600px window,
 * which is a small laptop browser; high enough that the field never becomes a slot. The
 * sheet keeps `overflow-y-auto` as a last resort below that, so nothing is ever
 * unreachable, but it is not the normal path. */}
        <div className="grid min-h-12 flex-1 gap-1.5">
          <Textarea
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
            placeholder="What were you trying to do, and what happened instead?"
            onChange={(e) => onMessageChange(e.target.value)}
          />
          {remaining < 400 && (
            <p className="text-right text-xs text-muted-foreground">{remaining} left</p>
          )}
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
              onClick={onAddScreenshot}
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
                  className="absolute -right-1.5 -top-1.5 size-5 rounded-full bg-background opacity-0 shadow group-hover:opacity-100 group-focus-within:opacity-100"
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
                onClick={onAddScreenshot}
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
            onClick={() => {
              // Same guard as `onOpenChange` above, for the same reason.
              if (!sent && message.trim().length > 0 && !window.confirm("Discard your feedback?")) {
                return;
              }
              onClose();
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
      </SheetContent>
    </Sheet>
  );
}
