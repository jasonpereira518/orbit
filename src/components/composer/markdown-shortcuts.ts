/**
 * Markdown for a plain textarea: the edits behind the notes box's shortcuts and toolbar, and
 * the tokenizer its highlight layer paints from.
 *
 * DOM-free on purpose, so the pure smoke tier can run every transform without a browser. Each
 * edit is returned as ONE replacement (`from`..`to` becomes `insert`) plus the selection to
 * leave behind, rather than a whole new value: the caller applies it with
 * `execCommand("insertText")`, and a minimal replacement is what keeps native undo to one
 * step per shortcut.
 *
 * Not a markdown parser. It recognises what someone typing notes actually writes — bold,
 * italic, inline code, ATX headings, bullet and numbered lists — and nothing that needs block
 * context (fences, quotes, tables). The read side renders with react-markdown, which is the
 * real parser; this only has to agree with it on those few marks.
 */

export type TextEdit = {
  from: number;
  to: number;
  insert: string;
  selectionStart: number;
  selectionEnd: number;
};

/** `**` for bold. Italic uses `_`, not `*`, so a toggle never confuses one star of a bold. */
export type WrapMarker = "**" | "_";

/**
 * Bold or italicise the selection, or undo it when it is already wrapped.
 *
 * Unwrapping accepts the markers just OUTSIDE the selection (select the word, press Cmd+B
 * again) or as the selection's own ends (select `**word**`). With nothing selected an empty
 * pair goes in and the caret lands between them, ready to type.
 *
 * Whitespace at the selection's ends is left outside the markers: `**Sarah **` is not bold in
 * CommonMark, and a Windows double-click selects the trailing space.
 */
export function toggleWrap(
  value: string,
  start: number,
  end: number,
  marker: WrapMarker,
): TextEdit {
  while (start < end && /\s/.test(value[start])) start += 1;
  while (end > start && /\s/.test(value[end - 1])) end -= 1;
  const m = marker.length;
  const inner = value.slice(start, end);
  const isItalicStar = (at: number) => value[at] === "*" && value[at - 1] !== "*" && value[at + 1] !== "*";
  const outside =
    marker === "_"
      ? (value.slice(start - 1, start) === "_" && value.slice(end, end + 1) === "_") ||
        (start > 0 && isItalicStar(start - 1) && isItalicStar(end))
      : value.slice(start - m, start) === marker && value.slice(end, end + m) === marker;
  if (start >= m && outside) {
    return {
      from: start - m,
      to: end + m,
      insert: inner,
      selectionStart: start - m,
      selectionEnd: end - m,
    };
  }
  if (inner.length >= m * 2 && inner.startsWith(marker) && inner.endsWith(marker)) {
    const stripped = inner.slice(m, inner.length - m);
    return { from: start, to: end, insert: stripped, selectionStart: start, selectionEnd: start + stripped.length };
  }
  return {
    from: start,
    to: end,
    insert: `${marker}${inner}${marker}`,
    selectionStart: start + m,
    selectionEnd: end + m,
  };
}

/** `  - `, `* `, `3. `, `2) ` — indent, marker, the space after it. */
const LIST_ITEM = /^(\s*)([-*+]|(\d+)([.)]))(\s+)/;
const HEADING = /^(#{1,6})(\s+)/;

function lineStartOf(value: string, at: number) {
  // lastIndexOf clamps a negative fromIndex to 0, so at 0 it would find a leading "\n" and
  // answer 1 — past `at`, which hung the walk up from a list line under a blank first line.
  if (at <= 0) return 0;
  return value.lastIndexOf("\n", at - 1) + 1;
}

function lineEndOf(value: string, at: number) {
  const nl = value.indexOf("\n", at);
  return nl === -1 ? value.length : nl;
}

/** The whole lines a selection touches. A selection ending at a line's start leaves that line out. */
function selectedLines(value: string, start: number, end: number) {
  const from = lineStartOf(value, start);
  const lastAt = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const to = lineEndOf(value, Math.max(lastAt, from));
  return { from, to, lines: value.slice(from, to).split("\n") };
}

/**
 * Replace a block of lines and keep the selection on the same text.
 *
 * `shift(i)` is how far line `i`'s content moved, which is enough to carry a caret inside it.
 * A caret that was inside a removed prefix lands at the line's new start.
 */
function rewriteLines(
  value: string,
  start: number,
  end: number,
  rewrite: (line: string, index: number) => string,
): TextEdit | null {
  const { from, to, lines } = selectedLines(value, start, end);
  const next = lines.map(rewrite);
  const insert = next.join("\n");
  if (insert === value.slice(from, to)) return null;
  const mapPos = (pos: number) => {
    let lineFrom = from;
    let newLineFrom = from;
    for (let i = 0; i < lines.length; i += 1) {
      const lineTo = lineFrom + lines[i].length;
      if (pos <= lineTo || i === lines.length - 1) {
        const delta = next[i].length - lines[i].length;
        const offset = Math.max(0, pos - lineFrom + delta);
        return newLineFrom + Math.min(offset, next[i].length);
      }
      lineFrom = lineTo + 1;
      newLineFrom += next[i].length + 1;
    }
    return pos;
  };
  return { from, to, insert, selectionStart: mapPos(start), selectionEnd: mapPos(end) };
}

export type LineKind = "bullet" | "numbered" | "heading";

/**
 * The toolbar's list and heading buttons. Toggles: when every selected line already is that
 * kind, the prefix comes off; otherwise each line becomes that kind, replacing any other
 * list or heading prefix it had (a bullet turns into `1.`, not `1. - `). Numbering restarts
 * at 1 for the selection. Blank lines between are left blank and don't count, so a loose
 * list (`- a\n\n- b`) toggles off too.
 */
export function toggleLinePrefix(
  value: string,
  start: number,
  end: number,
  kind: LineKind,
): TextEdit | null {
  const { lines } = selectedLines(value, start, end);
  const isKind = (line: string) => {
    if (kind === "heading") return HEADING.test(line);
    const m = LIST_ITEM.exec(line);
    return !!m && (kind === "numbered") === (m[3] !== undefined);
  };
  const strip = (line: string) => line.replace(HEADING, "").replace(LIST_ITEM, "$1");
  // A caret on an empty line still gets its prefix; blanks are skipped only beside content.
  const skipBlank = lines.some((l) => l.trim());
  const allOn = lines.filter((l) => !skipBlank || l.trim()).every(isKind);
  let n = 0;
  return rewriteLines(value, start, end, (line) => {
    if (skipBlank && !line.trim()) return line;
    if (allOn) return kind === "heading" ? line.replace(HEADING, "") : line.replace(LIST_ITEM, "$1");
    const bare = strip(line);
    const indent = /^\s*/.exec(bare)![0];
    const text = bare.slice(indent.length);
    if (kind === "heading") return `# ${bare.trimStart()}`;
    n += 1;
    return `${indent}${kind === "bullet" ? "-" : `${n}.`} ${text}`;
  });
}

/**
 * Enter on a list line. Continues the list — the same marker, or the next number — and on an
 * item with nothing typed after its marker, ends the list instead by clearing that marker,
 * which is how every editor with lists lets you out. `null` means not a list line: let the
 * Enter through.
 */
export function continueList(value: string, caret: number): TextEdit | null {
  const from = lineStartOf(value, caret);
  const line = value.slice(from, lineEndOf(value, caret));
  const m = LIST_ITEM.exec(line);
  if (!m || caret - from < m[0].length) return null;
  if (!line.slice(m[0].length).trim()) {
    return { from, to: from + line.length, insert: "", selectionStart: from, selectionEnd: from };
  }
  const [, indent, bullet, num, delim] = m;
  const marker = num !== undefined ? `${Number(num) + 1}${delim}` : bullet;
  const insert = `\n${indent}${marker} `;
  return { from: caret, to: caret, insert, selectionStart: caret + insert.length, selectionEnd: caret + insert.length };
}

/** The list items above the line starting at `lineFrom`, nearest first. */
function* listItemsAbove(value: string, lineFrom: number) {
  for (let at = lineFrom; at > 0; ) {
    const prevFrom = lineStartOf(value, at - 1);
    const m = LIST_ITEM.exec(value.slice(prevFrom, at - 1));
    at = prevFrom;
    if (m) yield m;
  }
}

/**
 * Tab / Shift+Tab on list lines, every selected list line at once. Tab moves a line to the
 * content column of the item above it at the same depth — 3 spaces under `1. `, 2 under `- ` —
 * because CommonMark only nests a child that reaches that column. Shift+Tab moves it back to
 * its parent's indent. Lines that are not list items are left alone; `null` when nothing in the
 * selection is a list item, so Tab keeps moving focus out of the box everywhere else (a
 * keyboard trap otherwise).
 */
export function indentList(
  value: string,
  start: number,
  end: number,
  outdent: boolean,
): TextEdit | null {
  const { from, lines } = selectedLines(value, start, end);
  if (!lines.some((l) => LIST_ITEM.test(l))) return null;
  let lineFrom = from;
  return rewriteLines(value, start, end, (line) => {
    const at = lineFrom;
    lineFrom += line.length + 1;
    const m = LIST_ITEM.exec(line);
    if (!m) return line;
    const depth = m[1].length;
    if (line.startsWith("\t")) return outdent ? line.slice(1) : `\t${line}`;
    if (outdent) {
      if (depth === 0) return line;
      let parent = 0;
      for (const p of listItemsAbove(value, at)) {
        if (p[1].length < depth) {
          parent = p[1].length;
          break;
        }
      }
      return line.slice(depth - parent);
    }
    // No sibling above: the line's own marker width, which is what a later sibling will use.
    let width = m[0].length - depth;
    for (const p of listItemsAbove(value, at)) {
      if (p[1].length === depth) {
        width = p[0].length - depth;
        break;
      }
      if (p[1].length < depth) break;
    }
    return " ".repeat(width) + line;
  });
}

export type MarkKind = "marker" | "bold" | "italic" | "heading" | "code";
export type MarkRange = { start: number; end: number; kind: MarkKind };

const CODE = /`[^`\n]+`/g;
const BOLD = /\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/g;
const ITALIC_STAR = /(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![*\w])/g;
const ITALIC_UNDERSCORE = /(?<!\w)_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?!\w)/g;

/**
 * What the highlight layer paints, as character ranges over the value. Ranges may overlap (a
 * bold word inside a heading) — `segmentMarks` resolves that. Inline marks are looked for
 * after a line's heading or list prefix, and never inside a code span.
 */
export function tokenizeMarkdown(value: string): MarkRange[] {
  const out: MarkRange[] = [];
  let lineFrom = 0;
  for (const line of value.split("\n")) {
    let bodyFrom = 0;
    const h = HEADING.exec(line);
    const li = h ? null : LIST_ITEM.exec(line);
    if (h) {
      out.push({ start: lineFrom, end: lineFrom + h[1].length, kind: "marker" });
      out.push({ start: lineFrom + h[0].length, end: lineFrom + line.length, kind: "heading" });
      bodyFrom = h[0].length;
    } else if (li) {
      const at = lineFrom + li[1].length;
      out.push({ start: at, end: at + li[2].length, kind: "marker" });
      bodyFrom = li[0].length;
    }
    // Blank code spans out first so a `*` inside one cannot open an italic.
    let body = line.slice(bodyFrom);
    for (const c of body.matchAll(CODE)) {
      const at = lineFrom + bodyFrom + c.index;
      const len = c[0].length;
      out.push({ start: at, end: at + 1, kind: "marker" });
      out.push({ start: at + 1, end: at + len - 1, kind: "code" });
      out.push({ start: at + len - 1, end: at + len, kind: "marker" });
      body = body.slice(0, c.index) + " ".repeat(len) + body.slice(c.index + len);
    }
    const inline = (re: RegExp, kind: MarkKind, m: number) => {
      for (const x of body.matchAll(re)) {
        const at = lineFrom + bodyFrom + x.index;
        const len = x[0].length;
        out.push({ start: at, end: at + m, kind: "marker" });
        out.push({ start: at + m, end: at + len - m, kind });
        out.push({ start: at + len - m, end: at + len, kind: "marker" });
      }
    };
    inline(BOLD, "bold", 2);
    inline(ITALIC_STAR, "italic", 1);
    inline(ITALIC_UNDERSCORE, "italic", 1);
    lineFrom += line.length + 1;
  }
  return out;
}

export type Segment<K extends string> = { start: number; end: number; kinds: K[] };

/**
 * Cut `0..length` into runs at every range boundary, each run carrying the kinds of every
 * range covering it. This is how markdown marks and `@mention` marks compose: neither has to
 * know about the other, and a mention inside a bold phrase is simply a run with both kinds.
 * The runs always tile the whole value, so the layer's text is exactly the field's text.
 */
export function segmentMarks<K extends string>(
  length: number,
  ranges: readonly { start: number; end: number; kind: K }[],
): Segment<K>[] {
  const cuts = new Set<number>([0, length]);
  for (const r of ranges) {
    cuts.add(Math.max(0, Math.min(length, r.start)));
    cuts.add(Math.max(0, Math.min(length, r.end)));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment<K>[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    if (start === end) continue;
    const kinds = ranges.filter((r) => r.start <= start && r.end >= end).map((r) => r.kind);
    out.push({ start, end, kinds });
  }
  return out;
}
