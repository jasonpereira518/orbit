/**
 * Markdown → one line of plain prose, for list rows that show a summary as text
 * (past meetings, recent captures). Not a parser: a regex pass over the markers a model
 * or Granola actually writes. Use react-markdown where formatting should render.
 */
export function stripMarkdown(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, " ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Metadata a note can open with ("Attendees: …"), which is not part of what was said. */
const META_LINE = /^\s*(?:meeting|when|date|time|attendees|participants|guests|location|organizer)\s*:/i;
/** A heading: `## …`, or a line that is nothing but bold (`**Overview**`). */
const HEADING_LINE = /^\s{0,3}(?:#{1,6}\s|\*\*[^*]+\*\*:?\s*$|__[^_]+__:?\s*$)/;

/**
 * A summary as a list row shows it: plain sentences. Headings and leading metadata lines are
 * dropped, markdown is stripped line by line, and each line ends as a sentence so bullets
 * do not run together. Cut at a word near `max`.
 */
export function listSummary(text: string | null | undefined, max = 300): string | null {
  if (!text) return null;
  const lines = text.replace(/```[\s\S]*?```/g, "\n").split("\n");
  while (lines.length && (!lines[0]!.trim() || META_LINE.test(lines[0]!))) lines.shift();
  const flat = lines
    .filter((l) => !HEADING_LINE.test(l))
    .map(stripMarkdown)
    .filter(Boolean)
    .map((l) => (/[.!?;:…]$/.test(l) ? l : `${l}.`))
    .join(" ");
  if (!flat) return null;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}
