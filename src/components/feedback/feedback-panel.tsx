"use client";

import {
  ArrowLeft,
  Bug,
  Camera,
  Compass,
  FileUp,
  Heart,
  HelpCircle,
  ImagePlus,
  Lightbulb,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Sparkles,
  SquarePen,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getMyFeedbackThread, listMyFeedbackAction, submitFeedback } from "@/actions/feedback";
import { FeedbackChat, type ChatDraft } from "@/components/feedback/feedback-chat";
import { FeedbackList } from "@/components/feedback/feedback-list";
import { ThreadAvatar } from "@/components/feedback/feedback-thread-view";
import type { DraftShot } from "@/components/feedback/feedback-widget";
import { SendButton } from "@/components/feedback/send-button";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { APP_NAV, APP_NAV_SETTINGS } from "@/components/layout/app-nav";
import { Textarea } from "@/components/ui/textarea";
import {
  AREA_LABELS,
  AREA_OPTIONS,
  FEEDBACK_AREAS,
  threadMeta,
  FEEDBACK_CATEGORIES,
  FEEDBACK_RECIPIENT,
  MAX_FEEDBACK_SUBJECT,
  MAX_FEEDBACK_TEXT,
  MAX_SCREENSHOTS,
  featureAreaForPath,
  readClientContext,
  type FeedbackArea,
  type FeedbackCategory,
} from "@/lib/feedback-report";
import type { FeedbackPanelTarget } from "@/lib/feedback-events";
import type { FeedbackThread, MyFeedbackRow } from "@/lib/feedback-thread";
import type { DockLayout } from "@/lib/feedback-dock";
import { cn } from "@/lib/utils";
import { blobToDataUrl } from "@/lib/screenshot-capture";
import { toast } from "@/lib/toast";

/**
 * Each kind's icon and colour. Quiet until picked: a neutral outline with only the icon in
 * colour, so the row reads as an optional hint rather than four buttons to press. The picked
 * one fills with its soft tint — a broken thing red, an idea gold, confusion violet, praise
 * green. Opacity on semantic colours, never fixed hex, so dark mode holds up.
 */
const KIND_STYLE: Record<FeedbackCategory, { icon: typeof Bug; ink: string; on: string }> = {
  bug: { icon: Bug, ink: "text-destructive", on: "border-destructive/40 bg-destructive/10 text-destructive" },
  idea: { icon: Lightbulb, ink: "text-gold-ink", on: "border-gold/50 bg-gold/15 text-gold-ink" },
  confusing: { icon: HelpCircle, ink: "text-violet-600 dark:text-violet-300", on: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  praise: { icon: Heart, ink: "text-emerald-600 dark:text-emerald-300", on: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
};

/**
 * Each area's icon: the one the sidebar shows for that page, so "About: Contacts" looks like
 * the place it names. Areas with no sidebar entry get their own.
 */
const AREA_ICON: Record<FeedbackArea, LucideIcon> = Object.fromEntries(
  FEEDBACK_AREAS.map((area) => [
    area,
    [...APP_NAV, APP_NAV_SETTINGS].find((item) => item.href === `/${area}`)?.icon ??
      { import: FileUp, onboarding: Compass }[area as string] ??
      MoreHorizontal,
  ])
) as Record<FeedbackArea, LucideIcon>;

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
  lastThreadId,
  chat,
  category,
  onCategoryChange,
  message,
  onMessageChange,
  subject,
  onSubjectChange,
  area,
  onAreaChange,
  shots,
  canCapture,
  onAddScreenshot,
  onAddImageFiles,
  onRemoveShot,
  onEditShot,
  onClose,
  initialCaret,
  onCaretChange,
  onClosed,
  onSent,
  layout,
  viewingAsUser,
  focusToken,
}: {
  /**
   * Driven, not hardcoded. The window has to stay mounted through its own exit transition
   * or there is no exit transition — see `onClosed`.
   */
  open: boolean;
  /** Phone sheet, floating overlay, or docked column — and how wide. See `dockLayoutFor`. */
  layout: DockLayout;
  /** The preview banner pushes the right-edge rail down; the overlay starts below it. */
  viewingAsUser: boolean;
  /** Bumped when a door is pressed while the panel is already open: take focus back in. */
  focusToken: number;
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
  /** The conversation last opened, for the inbox ⇄ conversation toggle. Null until one is. */
  lastThreadId: string | null;
  /** The reply draft for the open conversation, owned by the widget (see `ChatDraft`). */
  chat: ChatDraft;
  /** The kind they picked, or null to let triage read it from the words. */
  category: FeedbackCategory | null;
  onCategoryChange: (next: FeedbackCategory | null) => void;
  message: string;
  onMessageChange: (value: string) => void;
  /** The subject line. Required to send; owned by the widget like the message. */
  subject: string;
  onSubjectChange: (value: string) => void;
  /** `null` = follow the current page. Owned by the widget so it survives a dismissal. */
  area: FeedbackArea | null;
  onAreaChange: (next: FeedbackArea) => void;
  shots: DraftShot[];
  canCapture: boolean;
  onAddScreenshot: () => void;
  /** Pasted, dropped or picked images — the way in where screen capture doesn't exist. */
  onAddImageFiles: (files: File[]) => void;
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
  const hasDraft = message.trim().length > 0 || subject.trim().length > 0 || shots.length > 0;

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
  // Both are needed to send: a new message starts with a subject line.
  const hasMessage = message.trim().length > 0 && subject.trim().length > 0;
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

  const asideRef = useRef<HTMLElement>(null);
  /**
   * Move focus into the panel when it opens and whenever a door is pressed again. It is not a
   * modal and does not trap focus; this is only the hand-off, so a keyboard user lands in the
   * form (or on the region, for the inbox and a conversation) instead of staying behind on
   * the page. Skipped when focus is already inside — the autofocused subject field and the
   * restored caret get there first and must not be undone.
   */
  useEffect(() => {
    if (!sheetOpen) return;
    const frame = requestAnimationFrame(() => {
      const aside = asideRef.current;
      if (!aside || aside.contains(document.activeElement)) return;
      const field = aside.querySelector<HTMLElement>("textarea, input:not([type=file])");
      (field ?? aside).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [sheetOpen, focusToken]);


  /**
   * Whether the window has ever actually been open.
   *
   * Guards the transition-end handler: a close reported before the panel has ever opened
   * (the deliberate closed first frame above) would unmount it again straight away.
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
  /**
   * Once per opening: a plain press of the button lands on a new message — the fast path —
   * unless a reply or a thank-you is waiting, when it lands on the conversations instead so
   * that is the first thing seen. Never moves someone who already started writing.
   */
  const routed = useRef(false);
  const draftRef = useRef(false);
  const viewRef = useRef(target.view);
  useEffect(() => {
    draftRef.current = message.trim().length > 0 || subject.trim().length > 0 || shots.length > 0;
    viewRef.current = target.view;
  });
  useEffect(() => {
    if (!open) routed.current = false;
  }, [open]);
  useEffect(() => {
    if (!open || target.view === "thread") return;
    let live = true;
    listMyFeedbackAction()
      .then((rows) => {
        if (!live) return;
        setMine(rows);
        if (!routed.current) {
          routed.current = true;
          const waiting = rows.some((r) => r.unread || r.giftWaiting);
          if (waiting && viewRef.current === "compose" && !draftRef.current) onTargetChange({ view: "list" });
        }
      })
      .catch(() => live && setMine((prev) => prev ?? []));
    return () => {
      live = false;
    };
  }, [open, target.view, onTargetChange]);

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
        subject,
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

  // Overlay width: start below the bell and the feedback button instead of over them. Docked,
  // the page has moved out of the way and the panel can take the full height.
  const overlayTop = viewingAsUser ? "9.25rem" : "8rem";

  return (
    <aside
      ref={asideRef}
      id="feedback-dock"
      data-slot="feedback-dock"
      data-state={sheetOpen ? "open" : "closed"}
      data-mode={layout.mode}
      // A labelled complementary region, deliberately not a dialog: the page beside it stays
      // usable, nothing is inert, and it only closes from its own control (or Esc, below).
      aria-label="Feedback"
      tabIndex={-1}
      // Not tabbable or readable while it is sliding away or waiting for its first frame
      // to open — it is off to the right, so a stray Tab would land on nothing visible.
      inert={!open}
      style={
        layout.panelPx === null
          ? undefined
          : {
              width: layout.panelPx,
              ...(layout.mode === "overlay" ? { top: overlayTop } : null),
            }
      }
      className={cn(
        // z-45: over the page and the mobile nav (z-40), under every modal Sheet and Dialog
        // (z-50) — the notifications window opens over it, the command palette stays centred
        // over everything.
        "fixed z-[45] flex flex-col gap-0 overflow-hidden border bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg outline-none",
        // A phone has no room to share: the whole screen. From md it floats on the same 12px
        // frame as the sidebar, so the page and the panel read as two cards.
        "inset-x-0 top-0 h-dvh rounded-none border-0 md:inset-x-auto md:right-4 md:top-3 md:bottom-3 md:h-auto md:rounded-3xl md:border",
        "transition-[transform,opacity] duration-slow ease-house",
        "data-[state=closed]:translate-x-[calc(100%+1rem)] data-[state=closed]:opacity-0"
      )}
      onKeyDown={(e) => {
        // Esc closes only from inside: it is the page's too, and someone pressing it in the
        // page beside an open dock is not asking to lose their place here. A popup this
        // panel opened (the area picker) is portalled out of it and answers its own Esc.
        if (e.key !== "Escape" || e.defaultPrevented) return;
        if (!e.currentTarget.contains(e.target as Node)) return;
        e.preventDefault();
        // While the question is up, Escape answers IT rather than closing the window behind
        // it — otherwise you could not say "no" with the key you reach for first.
        if (confirming) setConfirming(false);
        else requestClose(false);
      }}
      onTransitionEnd={(e) => {
        // The slide-out has finished. Filtered to this element's own transform: opacity ends
        // at the same moment, and hover transitions on the buttons inside bubble up.
        if (e.target !== e.currentTarget || e.propertyName !== "transform") return;
        if (!open && hasEntered.current) onClosed();
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        // The one way out besides Cancel. It sits over the headers, which leave `pr-12`.
        className="absolute right-3 top-3 z-[2]"
        aria-label="Close feedback"
        onClick={() => requestClose(false)}
      >
        <X />
      </Button>
        {/* Back and forth between the inbox and the conversation you were in, from any screen.
            Only once there is a conversation to go back to. */}
        {lastThreadId && (
          <div
            role="tablist"
            aria-label="Feedback"
            className="flex shrink-0 gap-1 border-b border-border/60 px-5 py-2 pr-12"
          >
            {(
              [
                { key: "list", label: "Inbox", active: target.view === "list" },
                {
                  key: "thread",
                  label:
                    mine?.find((r) => r.id === lastThreadId)?.subject ||
                    mine?.find((r) => r.id === lastThreadId)?.excerpt ||
                    "Conversation",
                  active: target.view === "thread" && target.id === lastThreadId,
                },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={tab.active}
                onClick={() =>
                  onTargetChange(tab.key === "list" ? { view: "list" } : { view: "thread", id: lastThreadId })
                }
                className={cn(
                  "min-w-0 max-w-[60%] truncate rounded-full px-3 py-1 text-xs transition-colors",
                  tab.active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {tab.key === "list" && (mine?.some((r) => r.unread || r.giftWaiting) ?? false) ? "Inbox •" : tab.label}
              </button>
            ))}
          </div>
        )}
        {target.view === "list" ? (
          <>
            <PanelHeader>
              <ThreadAvatar label={FEEDBACK_RECIPIENT} size={36} />
              <div className="min-w-0 flex-1">
                <PanelTitle className="text-base font-medium">{FEEDBACK_RECIPIENT}</PanelTitle>
                <PanelDescription className="text-xs">Replies within a day</PanelDescription>
              </div>
              <Button size="sm" variant="outline" onClick={() => onTargetChange({ view: "compose" })}>
                <SquarePen className="size-3.5" aria-hidden />
                New
              </Button>
            </PanelHeader>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {mine === null ? (
                <p className="px-5 py-4 text-sm text-muted-foreground">Loading…</p>
              ) : mine.length === 0 ? (
                <div className="grid gap-3 px-5 py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    No conversations yet. Anything you send {FEEDBACK_RECIPIENT} lands here, with his replies.
                  </p>
                  <Button className="mx-auto" onClick={() => onTargetChange({ view: "compose" })}>
                    Message {FEEDBACK_RECIPIENT}
                  </Button>
                </div>
              ) : (
                <FeedbackList rows={mine} onOpen={(id) => onTargetChange({ view: "thread", id })} />
              )}
            </div>
          </>
        ) : target.view === "thread" ? (
          <PanelThread
            id={target.id}
            onBack={() => onTargetChange({ view: "list" })}
            // Only on a phone, where the panel IS the screen and a link would otherwise
            // change a page nobody can see. Anywhere else, following a link leaves it open.
            onNavigate={layout.mode === "phone" ? () => requestClose(false) : undefined}
            draft={chat}
          />
        ) : (
        <>
        <PanelHeader>
          {(mine?.length ?? 0) > 0 && (
            <button
              type="button"
              aria-label="Back to your conversations"
              onClick={() => onTargetChange({ view: "list" })}
              className="-ml-1 rounded-md p-1 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-4" aria-hidden />
            </button>
          )}
          <ThreadAvatar label={FEEDBACK_RECIPIENT} size={36} />
          <div className="min-w-0 flex-1">
            <PanelTitle className="text-base font-medium">Hey, it&apos;s {FEEDBACK_RECIPIENT}</PanelTitle>
            <PanelDescription className="text-xs">What&apos;s on your mind? I read every one.</PanelDescription>
          </div>
        </PanelHeader>
        <div
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4"
          // Drop an image anywhere on the form to attach it.
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
            if (files.length === 0) return;
            e.preventDefault();
            onAddImageFiles(files);
          }}
        >
        {/* The four kinds, all optional. They wrap: in the 22rem dock the fourth chip used to sit
            off the edge of a sideways scroll with nothing to say it was there. */}
        <div
          className="flex shrink-0 flex-wrap gap-1"
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
                "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-1 text-xs transition-colors",
                category === value
                  ? KIND_STYLE[value].on
                  : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground"
              )}
            >
              {(() => {
                const Icon = KIND_STYLE[value].icon;
                return <Icon className={cn("size-3.5", category !== value && KIND_STYLE[value].ink)} aria-hidden />;
              })()}
              {CATEGORY_LABELS[value]}
            </button>
          ))}
        </div>

        {/* The subject line, required — like an email, so both sides can find the
            conversation again by what it was about. Enter moves on to the message. */}
        <div className="relative shrink-0">
        <Pencil className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={subject}
          maxLength={MAX_FEEDBACK_SUBJECT}
          required
          autoFocus={subject.trim().length === 0}
          aria-label="Subject"
          placeholder="Give it a title"
          className="h-10 pl-9"
          onChange={(e) => onSubjectChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            textareaRef.current?.focus();
          }}
        />
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
        <div className="relative grid min-h-20 flex-1 grid-rows-[1fr_auto] gap-1.5">
          <MessageCircle className="pointer-events-none absolute left-3 top-2.5 z-[1] size-4 text-muted-foreground" aria-hidden />
          <Textarea
            ref={attachTextarea}
            // The subject comes first; the message box takes focus once it has one.
            autoFocus={subject.trim().length > 0}
            // Fills whatever the block has, large or small: the parent is a grid whose auto
            // row stretches. `field-sizing-content` on the primitive still expands it as you
            // type.
            //
            // `min-h-0` is load-bearing — a grid item's automatic minimum size would
            // otherwise stop it shrinking with its parent, which is the whole bug above.
            className="h-full min-h-0 resize-none pl-9"
            value={message}
            maxLength={MAX_FEEDBACK_TEXT}
            placeholder="Tell me what happened…"
            onChange={(e) => onMessageChange(e.target.value)}
            // ⌘V a screenshot straight into the message.
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
              if (files.length === 0) return;
              e.preventDefault();
              onAddImageFiles(files);
            }}
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
              onValueChange={(v) => onAreaChange((v || "other"))}
              // Without `items`, `SelectValue` renders the raw stored value — the trigger
              // would read "dashboard" rather than "Dashboard".
              items={AREA_OPTIONS}
            >
              <SelectTrigger
                aria-label={`Which part of Orbit: ${AREA_LABELS[effectiveArea]}`}
                className="h-7 w-auto gap-1 rounded-full px-2.5 text-xs text-muted-foreground"
              >
                {(() => {
                  const Icon = AREA_ICON[effectiveArea];
                  return <Icon className="size-3.5" aria-hidden />;
                })()}
                <SelectValue />
              </SelectTrigger>
              {/* `alignItemWithTrigger={false}` drops the list below the trigger instead of
                  over it, which also gives back the open/close animation that
                  `data-[align-trigger=true]:animate-none` in `ui/select.tsx` turns off. */}
              <SelectContent alignItemWithTrigger={false} className="p-1">
                {AREA_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value} className="py-1.5 pl-2">
                    {(() => {
                      const Icon = AREA_ICON[option.value];
                      return <Icon className="size-3.5 text-muted-foreground" aria-hidden />;
                    })()}
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
          {/* Attach: screenshot (where screen capture works) and upload, as small chips —
              the picture is the most useful part of a report, but it's an extra, not a field. */}
          {usedShots === 0 && (
            <div className="flex flex-wrap gap-2">
              {canCapture && (
                <button
                  type="button"
                  onClick={() => {
                    rememberCaret();
                    onAddScreenshot();
                  }}
                  title="Drag a box around the problem. It attaches when you let go."
                  className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs transition-colors hover:bg-muted"
                >
                  <Camera className="size-3.5" aria-hidden />
                  Screenshot
                </button>
              )}
              <ImagePicker label="Upload" prominent={false} onFiles={onAddImageFiles} />
            </div>
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

          {/* An image from the device: the only way in on phones and Safari (no screen
              capture there), and handy everywhere for a screenshot already taken. Paste and
              drag-and-drop land in the same place. */}
          {usedShots > 0 && usedShots < MAX_SCREENSHOTS && (
            <ImagePicker
              label={canCapture ? "or upload an image" : "Add a photo or screenshot"}
              prominent={!canCapture && usedShots === 0}
              onFiles={onAddImageFiles}
            />
          )}
          {usedShots > 0 && (
            <p className="text-xs text-muted-foreground">
              {usedShots} of {MAX_SCREENSHOTS} attached
              {usedShots < MAX_SCREENSHOTS ? " — tap one to add a note." : "."}
            </p>
          )}
        </div>

        <p className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full bg-gold/15 px-3 py-1 text-xs text-gold-ink">
          <Sparkles className="size-3.5" aria-hidden />
          Useful reports can earn bonus AI credits
        </p>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
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
            label={`Send to ${FEEDBACK_RECIPIENT}`}
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
    </aside>
  );
}

/** A file button for images; `prominent` makes it the main way in (no screen capture). */
function ImagePicker({
  label,
  prominent,
  onFiles,
}: {
  label: string;
  prominent: boolean;
  onFiles: (files: File[]) => void;
}) {
  return (
    <label
      className={cn(
        "cursor-pointer",
        prominent
          ? "flex items-center gap-3 rounded-lg border border-dashed border-border px-4 py-3 text-sm font-medium hover:bg-muted"
          : "inline-flex w-fit items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs transition-colors hover:bg-muted"
      )}
    >
      <ImagePlus className={prominent ? "size-5 shrink-0" : "size-3.5"} aria-hidden />
      {label}
      <input
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </label>
  );
}

/** A screen's top bar: room on the right for the sheet's own close button. */
function PanelHeader({ children }: { children: React.ReactNode }) {
  return (
    <header className="flex shrink-0 flex-row items-center gap-3 border-b border-border/60 px-5 py-3 pr-12">
      {children}
    </header>
  );
}

function PanelTitle({ className, children }: { className?: string; children: React.ReactNode }) {
  return <h2 className={cn("font-heading text-base font-medium text-foreground", className)}>{children}</h2>;
}

function PanelDescription({ className, children }: { className?: string; children: React.ReactNode }) {
  return <p className={cn("text-sm text-muted-foreground", className)}>{children}</p>;
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
  draft,
}: {
  id: string;
  onBack: () => void;
  onNavigate?: () => void;
  draft: ChatDraft;
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
    <>
      <PanelHeader>
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to your conversations"
          className="-ml-1 rounded-md p-1 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <PanelTitle className="truncate text-base font-medium">
            {thread?.report.subject || thread?.report.text?.split("\n")[0] || "Conversation"}
          </PanelTitle>
          <PanelDescription className="truncate text-xs">
            {thread ? threadMeta(thread) : `With ${FEEDBACK_RECIPIENT}`}
          </PanelDescription>
        </div>
      </PanelHeader>
      {thread === undefined ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">Loading…</p>
      ) : thread === null ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">That conversation isn’t available.</p>
      ) : (
        <FeedbackChat key={thread.id} initial={thread} onNavigate={onNavigate} draft={draft} />
      )}
    </>
  );
}
