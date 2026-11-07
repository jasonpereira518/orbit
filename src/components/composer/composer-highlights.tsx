"use client";

/**
 * The green marks behind `@Name` in the composer.
 *
 * A `<textarea>` cannot style a substring, so the highlight is a second layer laid out
 * identically underneath. Unlike the dictation ghost (`composer-mirror.tsx`) this one sits
 * BEHIND the field and paints nothing but background: the real text stays in the textarea,
 * fully opaque, with its own caret, selection and IME. That is what makes it safe to leave
 * mounted all the time — the mirror's failure modes are all consequences of hiding the
 * field's own glyphs, and this layer never does that.
 *
 * "Behind" is the `z-0`/`z-[1]`/`z-[2]` ladder across the three layers, not DOM order: a
 * positioned box paints above a static sibling however early it appears, so being written
 * first bought nothing and the tint was landing on top of the glyphs.
 */

import { useEffect, useRef } from "react";

import { findMentions } from "@/lib/chat-mentions";
import { COMPOSER_TEXT_BOX } from "@/components/composer/composer-mirror";
import { segmentMarks, tokenizeMarkdown, type MarkKind } from "@/components/composer/markdown-shortcuts";
import { cn } from "@/lib/utils";

/**
 * The mark itself.
 *
 * Horizontal padding is cancelled by an equal negative margin so the run occupies exactly
 * the width of its glyphs and cannot re-wrap the layer independently of the field. Vertical
 * padding needs no such treatment: on an inline box it does not affect the line box.
 */
const MENTION_MARK =
  "rounded-[4px] bg-emerald-500/18 px-[2px] py-[2px] mx-[-2px] dark:bg-emerald-400/20";

/**
 * Live markdown, painted only while this layer draws the glyphs (`markdown`). Every style
 * here must leave each glyph's advance width alone — the caret is the textarea's, laid out
 * on the textarea's own glyphs, so a wider letter here walks the visible text away from it:
 *
 *   bold / heading — faux bold: a hairline `text-shadow` either side, never `font-weight`.
 *   italic — `font-style: italic` over Outfit, which ships no italic face, so the browser
 *     synthesises an oblique: a skew of the same glyphs at the same advances.
 *   code — a background tint, no padding and no monospace.
 */
// ponytail: italic stays width-safe only while no italic Outfit is loaded (layout.tsx loads
// the upright alone). Load one and the advances change; drop `italic` here if that happens.
const MARK_CLASS: Record<MarkKind | "mention", string> = {
  marker: "text-muted-foreground",
  bold: "[text-shadow:0.35px_0_0_currentColor,-0.35px_0_0_currentColor]",
  heading: "[text-shadow:0.35px_0_0_currentColor,-0.35px_0_0_currentColor]",
  italic: "italic",
  code: "rounded-[3px] bg-muted",
  mention: MENTION_MARK,
};

export function ComposerHighlights({
  value,
  names,
  textareaRef,
  boxClassName = COMPOSER_TEXT_BOX,
  markdown = false,
}: {
  /** The whole field value, so wrapping matches the textarea exactly. */
  value: string;
  /** Attached people's display names. Only these are painted — see `findMentions`. */
  names: readonly string[];
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /**
   * The padding and type scale of the field this sits behind. A prop rather than a
   * constant because the two composers are not the same shape: chat's field is bare inside
   * a pill, and the notes box is an ordinary bordered `Textarea` with its own padding. The
   * layers still have to agree — a single character of disagreement wraps one line early —
   * so whoever owns the field owns this too, and `MentionComposer` passes the same string
   * to both.
   */
  boxClassName?: string;
  /**
   * Draw the glyphs here, styled as markdown, instead of leaving them to the field — the
   * caller makes the field's own text transparent while this is on. The mirror technique,
   * with the mirror's preconditions (no IME composition, fine pointer): see
   * `composer-mirror.tsx`. `MentionComposer` decides; off, this layer is marks only.
   */
  markdown?: boolean;
}) {
  const layerRef = useRef<HTMLDivElement>(null);

  // The field scrolls once it hits its max height; the marks have to travel with it.
  useEffect(() => {
    const ta = textareaRef.current;
    const layer = layerRef.current;
    if (!ta || !layer) return;
    const sync = () => {
      layer.scrollTop = ta.scrollTop;
      layer.scrollLeft = ta.scrollLeft;
    };
    sync();
    ta.addEventListener("scroll", sync);
    return () => ta.removeEventListener("scroll", sync);
  }, [textareaRef, value]);

  const mentions = findMentions(value, names);
  if (!mentions.length && !markdown) return null;

  const ranges = [
    ...(markdown ? tokenizeMarkdown(value) : []),
    ...mentions.map((m) => ({ start: m.start, end: m.end, kind: "mention" as const })),
  ];
  const parts = segmentMarks(value.length, ranges).map((seg) => {
    const text = value.slice(seg.start, seg.end);
    if (!seg.kinds.length) return text;
    return (
      <span key={seg.start} className={cn(seg.kinds.map((k) => MARK_CLASS[k]))}>
        {text}
      </span>
    );
  });

  return (
    <div
      ref={layerRef}
      aria-hidden
      // Same direction as the textarea (`dir="auto"` in the primitive) resolves to, or the
      // marks of a right-to-left question would sit under the wrong words.
      dir="auto"
      data-slot="composer-highlights"
      className={cn(
        "pointer-events-none absolute inset-0 z-0 overflow-hidden border-0",
        boxClassName,
        "whitespace-pre-wrap break-words",
        // Normally the glyphs are the textarea's job and this layer contributes only the
        // marks: drawing them here as well would double-strike every character. Live
        // markdown flips that — the field goes transparent and the glyphs are drawn here.
        markdown ? "text-foreground" : "text-transparent",
      )}
      style={{
        scrollbarGutter: "stable",
        WebkitTextSizeAdjust: "100%",
      }}
    >
      {parts}
      {/* A trailing newline is not laid out; without this the last line can be clipped. */}
      {"\n"}
    </div>
  );
}
