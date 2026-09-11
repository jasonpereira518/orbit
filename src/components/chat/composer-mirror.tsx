"use client";

/**
 * The ghosted interim text behind the composer.
 *
 * A `<textarea>` cannot style a substring, so the words the recogniser has not committed
 * yet are drawn by a mirror layer sitting exactly behind a transparent-text field. That
 * technique has real failure modes — an invisible selection, IME preedit that never
 * reaches `.value`, iOS predictive text — so the caller mounts this only while all of
 * them are provably absent, and drops back to the plain field otherwise. Both layers are
 * pixel-identical by construction, so the swap is invisible.
 *
 * Kept in its own file so it can be removed without unpicking anything else.
 */

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * The box model every layer stacked on the composer field must share.
 *
 * Three layers now sit in that one box — the field itself, the green mention highlights
 * behind it, and the dictation ghost in front — and a single character of padding
 * disagreement offsets one from the others and wraps a line early. That has already
 * happened twice, both times because a padding change landed on one layer and not the
 * rest, so the value lives here and every layer spreads it.
 */
export const COMPOSER_TEXT_BOX = "px-1.5 py-2 text-base md:text-sm";

/** Coarse pointers mean predictive text and `text-size-adjust`: the mirror cannot win. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return coarse;
}

export function ComposerMirror({
  value,
  interimStart,
  interimEnd,
  textareaRef,
}: {
  /** The whole field value, so wrapping matches the textarea exactly. */
  value: string;
  interimStart: number;
  interimEnd: number;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);

  // The field scrolls once it hits its max height; the mirror has to follow.
  useEffect(() => {
    const ta = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return;
    const sync = () => {
      mirror.scrollTop = ta.scrollTop;
      mirror.scrollLeft = ta.scrollLeft;
    };
    sync();
    ta.addEventListener("scroll", sync);
    return () => ta.removeEventListener("scroll", sync);
  }, [textareaRef, value]);

  const start = Math.max(0, Math.min(interimStart, value.length));
  const end = Math.max(start, Math.min(interimEnd, value.length));

  return (
    <div
      ref={mirrorRef}
      aria-hidden
      data-slot="composer-mirror"
      // The box model has to match the field's exactly or every line wraps a character
      // early. Kept in step with the textarea's own classes in chat-panel.tsx — inside the
      // composer pill the field is bare, so there is no border to mirror any more.
      className={cn(
        // z-[2]: above both the field and the mention marks. See the layer ladder in
        // `composer-highlights.tsx`.
        "pointer-events-none absolute inset-0 z-[2] overflow-hidden border-0",
        COMPOSER_TEXT_BOX,
        "whitespace-pre-wrap break-words",
      )}
      style={{
        // Matches the gutter the caller reserves on the field while dictating, so a
        // scrollbar appearing cannot narrow one layer and not the other.
        scrollbarGutter: "stable",
        WebkitTextSizeAdjust: "100%",
      }}
    >
      <span className="text-foreground">{value.slice(0, start)}</span>
      <span className="text-muted-foreground">{value.slice(start, end)}</span>
      <span className="text-foreground">{value.slice(end)}</span>
      {/* A trailing newline is not laid out; without this the last line can be clipped. */}
      {"\n"}
    </div>
  );
}
