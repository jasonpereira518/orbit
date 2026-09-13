"use client";

/**
 * A sent question, with its `@Name` mentions still marked green.
 *
 * The mark has to survive the send or the green reads as a composer decoration rather than
 * what it means: those people's records were put in front of the model.
 */

import { findMentions } from "@/lib/chat-mentions";
import { cn } from "@/lib/utils";

export function MentionText({
  text,
  names,
  className,
}: {
  text: string;
  /**
   * Who was actually attached, when that is known.
   *
   * Known for anything sent in this session. A thread loaded back from the database has
   * only the text — the attachment list is not persisted — so this is undefined there and
   * `findMentions` falls back to its shape heuristic. The cost of that fallback is at most
   * one word too much green on `@Marcus Webb Who else`; it can never mark the wrong person,
   * because nothing downstream reads these spans.
   */
  names?: readonly string[];
  className?: string;
}) {
  const mentions = findMentions(text, names);
  if (!mentions.length) return <span className={className}>{text}</span>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  mentions.forEach((m, i) => {
    if (m.start > cursor) parts.push(text.slice(cursor, m.start));
    parts.push(
      <span
        key={`${m.start}-${i}`}
        // Solid, where the composer's mark is a tint. The bubble is `bg-primary`, and
        // primary flips from dark teal in light mode to light blue in dark — a translucent
        // green over either one mostly just desaturates, and inheriting the bubble's own
        // text colour left the mark near-invisible on the light-blue variant. A solid light
        // chip with dark green text is legible on both without a per-theme rule.
        className="rounded-[4px] bg-emerald-200 px-[3px] py-[1px] font-medium text-emerald-900"
      >
        {text.slice(m.start, m.end)}
      </span>,
    );
    cursor = m.end;
  });
  parts.push(text.slice(cursor));

  return <span className={cn(className)}>{parts}</span>;
}
