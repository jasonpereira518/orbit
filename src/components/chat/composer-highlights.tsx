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
import { COMPOSER_TEXT_BOX } from "@/components/chat/composer-mirror";
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

export function ComposerHighlights({
  value,
  names,
  textareaRef,
}: {
  /** The whole field value, so wrapping matches the textarea exactly. */
  value: string;
  /** Attached people's display names. Only these are painted — see `findMentions`. */
  names: readonly string[];
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
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
  if (!mentions.length) return null;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  mentions.forEach((m, i) => {
    if (m.start > cursor) parts.push(value.slice(cursor, m.start));
    parts.push(
      <span key={`${m.start}-${i}`} className={MENTION_MARK}>
        {value.slice(m.start, m.end)}
      </span>,
    );
    cursor = m.end;
  });
  parts.push(value.slice(cursor));

  return (
    <div
      ref={layerRef}
      aria-hidden
      data-slot="composer-highlights"
      className={cn(
        "pointer-events-none absolute inset-0 z-0 overflow-hidden border-0",
        COMPOSER_TEXT_BOX,
        "whitespace-pre-wrap break-words",
        // The glyphs are the textarea's job; this layer contributes only the marks. Drawing
        // them here as well would double-strike every character against the real text.
        "text-transparent",
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
