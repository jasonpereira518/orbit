"use client";

/**
 * A textarea that understands `@Name`.
 *
 * Lifted out of `chat-panel.tsx`, where all of it — the type-ahead, the green marks behind
 * the glyphs, the ARIA combobox wiring, the keydown routing and the atomic `@Name` delete —
 * was tangled up with dictation, threads and the send pill. The notes box needs the same
 * behaviour and none of the rest.
 *
 * What stays with the caller, deliberately:
 *
 *   THE VALUE. `onValueChange` is the single funnel for every edit this component makes,
 *   whether typed or spliced. Chat's dictation keeps an anchor into the text and has to see
 *   each change to slide it; one funnel means it cannot be shown some of them.
 *
 *   THE PICKS. They are the caller's state because the caller is what saves them — chat
 *   sends them as model context, capture writes them to `capture_jobs.mention_picks`. This
 *   component only adds to the list; `activePicks` decides which of them still count, and
 *   the text is what it asks.
 *
 *   THE CHROME. The two surfaces are not the same shape — chat's field is bare inside a
 *   pill with buttons either side, and the notes box is an ordinary bordered box — so the
 *   classes come in rather than being baked here.
 *
 * The menu is rendered as a SIBLING of the field box rather than inside it. It is
 * absolutely positioned, so it hangs from whichever positioned ancestor the CALLER provides
 * — which is what lets chat keep anchoring it above the whole composer area, at the pill's
 * full width, while a notes box anchors it to the field itself.
 */

import {
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { ComposerHighlights } from "@/components/composer/composer-highlights";
import {
  MentionAutocomplete,
  type MentionMenuPlacement,
  type MentionOption,
} from "@/components/composer/mention-autocomplete";
import { useMentionAutocomplete } from "@/components/composer/use-mention-autocomplete";
import { Textarea } from "@/components/ui/textarea";
import {
  mentionAfterCaret,
  mentionBeforeCaret,
  mentionDeletionRange,
  snapCaretOutOfMention,
} from "@/lib/chat-mentions";
import {
  activePicks,
  addMentionPick,
  pickNames,
  type MentionPick,
} from "@/lib/mentions/mention-picks";
import { cn } from "@/lib/utils";

/**
 * The box model of an unstyled `components/ui/textarea.tsx`.
 *
 * Every layer stacked on the field has to share it or the marks drift off the glyphs, so it
 * is quoted here rather than inherited: the primitive's padding is buried in one long class
 * string, and a change there has to be answered here. Chat passes `COMPOSER_TEXT_BOX`
 * instead, because its field is bare inside the pill.
 */
export const DEFAULT_FIELD_BOX = "px-2.5 py-2 text-base md:text-sm";

/**
 * The bordered-box look, moved OFF the field and onto the wrapper.
 *
 * The marks sit behind the field, so anything opaque on the field itself paints over them —
 * and `components/ui/textarea.tsx` carries `dark:bg-input/30`, which is exactly enough to
 * wash the green out in dark mode. Chat solved this by making the pill own the chrome; this
 * is the same trick for an ordinary-looking box.
 */
export const FIELD_SHELL =
  "rounded-lg border border-input bg-transparent transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30";
/** The other half of `FIELD_SHELL`: the field gives up its own border, background and ring. */
export const FIELD_BARE =
  "rounded-none border-0 bg-transparent shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent";

export type MentionComposerHandle = {
  /**
   * Splice text in at the caret, as a user edit.
   *
   * For a menu that lives outside the field and therefore cannot reach the splice — chat's
   * `+`. Goes through the same path as an accepted `@` row, so an in-flight dictation sees
   * it the same way.
   */
  insertAtCaret: (text: string) => void;
};

type FieldProps = Omit<
  React.ComponentProps<"textarea">,
  | "value"
  | "defaultValue"
  | "onChange"
  | "onKeyDown"
  | "onSelect"
  | "onCompositionStart"
  | "onCompositionEnd"
  | "ref"
  | "className"
  | "role"
  | "aria-autocomplete"
  | "aria-expanded"
  | "aria-controls"
  | "aria-activedescendant"
>;

export function MentionComposer({
  value,
  onValueChange,
  picks,
  onPicksChange,
  textareaRef,
  handleRef,
  events = false,
  menuPlacement = "above",
  menuEnabled = true,
  boxClassName = DEFAULT_FIELD_BOX,
  className,
  textareaClassName,
  onKeyDown,
  onBlur,
  onSelectionCollapsedChange,
  onCompositionChange,
  children,
  ...field
}: {
  value: string;
  /** Every edit this component makes, typed or spliced. See the header. */
  onValueChange: (next: string) => void;
  picks: readonly MentionPick[];
  onPicksChange: (next: MentionPick[]) => void;
  /** Owned by the caller: chat reads the live `.value` and caret from it while dictating. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  handleRef?: RefObject<MentionComposerHandle | null>;
  /** Offer past conversations alongside people. Chat only — see `useMentionAutocomplete`. */
  events?: boolean;
  /** Which side of the anchor the menu opens on. See `MentionAutocomplete`. */
  menuPlacement?: MentionMenuPlacement;
  /** The caller's own reasons to keep the menu shut (busy, dictating, loading). */
  menuEnabled?: boolean;
  /** Padding and type scale, shared with the highlight layer. */
  boxClassName?: string;
  /** The field box. Made `relative` regardless — the marks are `absolute inset-0` of it. */
  className?: string;
  textareaClassName?: string;
  /** Keys the mention machinery did not claim. Send, recall, Escape — the caller's own. */
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: (e: FocusEvent<HTMLTextAreaElement>) => void;
  /** For chat's dictation ghost, which may not be shown over a selection. */
  onSelectionCollapsedChange?: (collapsed: boolean) => void;
  /** Same: mid-IME the field's `.value` is not what the user sees. */
  onCompositionChange?: (composing: boolean) => void;
  /** Extra layers inside the field box, above the field. Chat's dictation mirror. */
  children?: ReactNode;
} & FieldProps) {
  // Owned here rather than passed in: a composition is the field's own event, and every
  // consumer wants the same answer from it — no snapping, no menu. Callers that need to
  // know as well (the dictation ghost) get told.
  const [composing, setComposing] = useState(false);
  const mention = useMentionAutocomplete(menuEnabled && !composing, { events });
  const listboxId = useId();
  const optionId = useCallback(
    (index: number) => `${listboxId}-${index}`,
    [listboxId],
  );

  /**
   * Where the caret was last time, so a snap out of a mention knows which way it was going.
   * Without the direction, arrowing left out of a token bounces off its own trailing edge
   * and the caret looks stuck.
   */
  const lastCaretRef = useRef<number | null>(null);
  /** Where to put the caret after a splice re-renders the field and parks it at the end. */
  const pendingCaretRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === null) return;
    pendingCaretRef.current = null;
    textareaRef.current?.setSelectionRange(caret, caret);
  });

  /**
   * The text decides who is picked, not the other way round.
   *
   * `picks` is only a registry of what has been chosen; this is the live set, re-derived
   * from the box on every render — so deleting `@Marcus Webb` un-picks Marcus with nothing
   * watching for it, however the deletion happened. Only these are painted: the mark means
   * "this is a real person", not "@".
   */
  const names = useMemo(() => pickNames(activePicks(value, picks)), [value, picks]);

  const splice = useCallback(
    (from: number, to: number, text: string) => {
      const el = textareaRef.current;
      const current = el?.value ?? value;
      // Padding is for inserting; a deletion passes "" and must not gain a space for it.
      const pad = text.length > 0;
      const needsLeading = pad && from > 0 && !/\s$/.test(current.slice(0, from));
      const needsTrailing = pad && !/^\s/.test(current.slice(to));
      const insert = `${needsLeading ? " " : ""}${text}${needsTrailing ? " " : ""}`;
      pendingCaretRef.current = from + insert.length;
      onValueChange(current.slice(0, from) + insert + current.slice(to));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [onValueChange, textareaRef, value],
  );

  const insertAtCaret = useCallback(
    (text: string) => {
      const el = textareaRef.current;
      const current = el?.value ?? value;
      const from = el?.selectionStart ?? current.length;
      const to = el?.selectionEnd ?? from;
      splice(from, to, text);
    },
    [splice, textareaRef, value],
  );

  useImperativeHandle(handleRef, () => ({ insertAtCaret }), [insertAtCaret]);

  /**
   * Take a row from the menu, replacing the half-typed token rather than the caret.
   *
   * Both kinds mint a token; an event just wraps it in a sentence, which is what makes a
   * picked meeting as well-grounded as a picked person — the same pick, the same green
   * mark, the same atomic delete. Either way the `@` and everything typed after it goes:
   * the fragment was scaffolding, not text the user meant.
   */
  const acceptMention = useCallback(
    (option: MentionOption) => {
      const el = textareaRef.current;
      if (!el || mention.start === null) return;
      const to = el.selectionStart ?? el.value.length;
      const { picks: next, token } = addMentionPick(
        picks,
        option.contactId,
        option.nameCandidates,
      );
      onPicksChange(next);
      const text =
        option.kind === "person" ? token : `${option.before}${token}${option.after}`;
      splice(mention.start, to, text);
      // Dismiss rather than reset: the completed token still parses as a query, so a plain
      // reset would reopen the menu on the name that was just accepted.
      mention.dismiss();
    },
    [mention, picks, onPicksChange, splice, textareaRef],
  );

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    onValueChange(next);
    // The caret has already moved by the time this fires, so `selectionStart` is where the
    // user is — which is what decides whether they are inside an `@`. `onSelect` alone is
    // not enough: it does not fire for every keystroke.
    const caret = e.target.selectionStart ?? next.length;
    lastCaretRef.current = caret;
    mention.refresh(next, caret);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // First refusal, before the caller's Enter sends anything: while the type-ahead is up
    // those keys belong to it, and the caret never leaves the textarea to say so.
    if (mention.open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        mention.move(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const option = mention.active();
        if (option) {
          e.preventDefault();
          acceptMention(option);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        mention.dismiss();
        return;
      }
    }

    // A picked `@Name` reads as one object, so it deletes as one. Only when the caret is
    // flush against it and nothing is selected — a Backspace anywhere else is ordinary, and
    // a name nobody picked is just words.
    if (e.key === "Backspace" || e.key === "Delete") {
      const el = e.currentTarget;
      if (el.selectionStart === el.selectionEnd) {
        const caret = el.selectionStart;
        const whole =
          e.key === "Backspace"
            ? mentionBeforeCaret(el.value, caret, names)
            : mentionAfterCaret(el.value, caret, names);
        if (whole) {
          e.preventDefault();
          const { from, to } = mentionDeletionRange(el.value, whole);
          splice(from, to, "");
          return;
        }
      }
    }

    onKeyDown?.(e);
  }

  return (
    <>
      {mention.open && (
        <MentionAutocomplete
          options={mention.options}
          activeIndex={mention.activeIndex}
          loading={mention.loading}
          listboxId={listboxId}
          optionId={optionId}
          onPick={acceptMention}
          placement={menuPlacement}
        />
      )}
      <div className={cn("relative", className)}>
        {/* The marks. They show through because the field's own background is transparent —
            the wrapper owns it — and they stay behind the glyphs because of the z ladder in
            `composer-highlights.tsx`, not this DOM order. */}
        <ComposerHighlights
          value={value}
          names={names}
          textareaRef={textareaRef}
          boxClassName={boxClassName}
        />
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onSelect={(e) => {
            const el = e.currentTarget;
            const collapsed = el.selectionStart === el.selectionEnd;
            onSelectionCollapsedChange?.(collapsed);
            if (!collapsed) {
              lastCaretRef.current = null;
              mention.reset();
              return;
            }
            // The caret may not come to rest inside a token. Re-setting the range fires
            // `select` again, which terminates because an edge is a legal position and
            // snaps to null.
            const prev = lastCaretRef.current;
            const prefer =
              prev === null || prev === el.selectionStart
                ? "nearest"
                : el.selectionStart < prev
                  ? "left"
                  : "right";
            const snapped = composing
              ? null
              : snapCaretOutOfMention(el.value, el.selectionStart, prefer, names);
            const caret = snapped ?? el.selectionStart;
            if (snapped !== null) el.setSelectionRange(snapped, snapped);
            lastCaretRef.current = caret;
            // Arrowing into an existing `@Marcus` should offer it again.
            mention.refresh(el.value, caret);
          }}
          onCompositionStart={() => {
            setComposing(true);
            onCompositionChange?.(true);
          }}
          onCompositionEnd={() => {
            setComposing(false);
            onCompositionChange?.(false);
          }}
          onBlur={(e) => {
            mention.reset();
            onBlur?.(e);
          }}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={mention.open}
          aria-controls={mention.open ? listboxId : undefined}
          aria-activedescendant={mention.open ? optionId(mention.activeIndex) : undefined}
          className={cn(
            // `relative z-[1]` is load-bearing: it lifts the field above the marks, which
            // are positioned and would otherwise paint over the glyphs whatever the DOM
            // order says.
            "relative z-[1]",
            boxClassName,
            textareaClassName,
          )}
          {...field}
        />
        {children}
      </div>
    </>
  );
}
