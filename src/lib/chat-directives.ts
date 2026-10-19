/**
 * Typed blocks inside a chat answer, as one-line directives in the streamed markdown:
 *
 *   ::people[<contact id>,<contact id>]   — people worth acting on, rendered as cards
 *   ::list[r1]                             — a complete roster, rendered as a table
 *
 * The model only chooses WHERE a block goes and WHICH ids it holds; everything the block
 * shows comes from data the server retrieved (`ChatBlocks`, sent before the answer), so a
 * block cannot carry an invented person or number. An id the server never offered is
 * dropped (`stripInvalidDirectives`), and a directive left with nothing is removed.
 *
 * Pure — no React, no DB — so the route, the renderer and the smoke share one parser.
 */

export type ChatBlockPerson = { name: string; subtitle: string | null };

export type ChatBlockList = {
  label: string;
  total: number;
  truncated: boolean;
  people: Array<{ id: string; name: string; title: string | null }>;
};

/** What the directives can point at, keyed the way the prompt showed them. */
export type ChatBlocks = {
  people: Record<string, ChatBlockPerson>;
  lists: Record<string, ChatBlockList>;
};

export type AnswerSegment =
  | { kind: "text"; text: string }
  | { kind: "people"; ids: string[] }
  | { kind: "list"; key: string };

/** At most this many cards in one people block; more is a list, not a shortlist. */
export const MAX_PEOPLE_PER_BLOCK = 6;

const DIRECTIVE = /^[ \t]*::(people|list)\[([^\]\n]*)\][ \t]*$/;

function idsOf(raw: string): string[] {
  return [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
}

/**
 * What can be shown of `text` right now, while it may still be arriving: a last line that
 * could still become a directive (`::peo…`) and a citation cut mid-marker (`[e1`) are held
 * back until the next chunk settles them, so neither flashes on screen as raw text.
 */
export function settledText(text: string): string {
  let out = text;
  const lastLine = out.slice(out.lastIndexOf("\n") + 1);
  if (/^[ \t]*:/.test(lastLine)) out = out.slice(0, out.length - lastLine.length);
  return out.replace(/\[(e\d*)?$/, "");
}

/** The answer as prose runs and blocks, in order. Directives inside a code fence stay text. */
export function splitDirectives(text: string, options: { streaming?: boolean } = {}): AnswerSegment[] {
  const source = options.streaming ? settledText(text) : text;
  const segments: AnswerSegment[] = [];
  let buffer: string[] = [];
  let fenced = false;
  const flush = () => {
    const joined = buffer.join("\n");
    if (joined.trim()) segments.push({ kind: "text", text: joined });
    buffer = [];
  };
  for (const line of source.split("\n")) {
    if (/^[ \t]*```/.test(line)) fenced = !fenced;
    const m = fenced ? null : DIRECTIVE.exec(line);
    if (!m) {
      buffer.push(line);
      continue;
    }
    flush();
    if (m[1] === "people") {
      const ids = idsOf(m[2]);
      if (ids.length) segments.push({ kind: "people", ids });
    } else {
      const key = m[2].trim();
      if (key) segments.push({ kind: "list", key });
    }
  }
  flush();
  return segments;
}

/**
 * Directives rewritten to only what the server offered: unknown ids dropped, a people block
 * capped at `MAX_PEOPLE_PER_BLOCK`, and a directive left empty removed with its line. The
 * stored answer goes through this, so a reload never shows a block pointing at nothing.
 */
export function stripInvalidDirectives(
  text: string,
  known: { people: ReadonlySet<string>; lists: ReadonlySet<string> }
): { text: string; removed: number } {
  let removed = 0;
  let fenced = false;
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (/^[ \t]*```/.test(line)) fenced = !fenced;
    const m = fenced ? null : DIRECTIVE.exec(line);
    if (!m) {
      lines.push(line);
      continue;
    }
    if (m[1] === "people") {
      const all = idsOf(m[2]);
      const kept = all.filter((id) => known.people.has(id)).slice(0, MAX_PEOPLE_PER_BLOCK);
      removed += all.length - kept.length;
      if (kept.length) lines.push(`::people[${kept.join(",")}]`);
    } else {
      const key = m[2].trim();
      if (known.lists.has(key)) lines.push(`::list[${key}]`);
      else removed += 1;
    }
  }
  return { text: lines.join("\n"), removed };
}

/** Every contact id in the answer's people blocks, in order of first appearance. */
export function peopleIdsIn(text: string): string[] {
  const out = new Set<string>();
  for (const segment of splitDirectives(text)) {
    if (segment.kind === "people") for (const id of segment.ids) out.add(id);
  }
  return [...out];
}

function cell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function linkText(value: string): string {
  return cell(value).replace(/[[\]]/g, "\\$&");
}

/**
 * A list block as markdown: a count line, then one row per person linking to their page.
 * The live answer renders a list through this, and the stored answer has it expanded in
 * place, so a reloaded thread shows exactly what streamed — with no block data to keep.
 */
export function listToMarkdown(list: ChatBlockList): string {
  const count = `**${list.total.toLocaleString("en-US")} ${list.total === 1 ? "person" : "people"}** · ${cell(list.label)}`;
  const rows = list.people.map((p) => `| [${linkText(p.name)}](/contacts/${p.id}) | ${p.title ? cell(p.title) : ""} |`);
  const more = list.truncated ? `\n\n_Showing ${list.people.length} of ${list.total.toLocaleString("en-US")}._` : "";
  return `${count}\n\n| Name | Details |\n| --- | --- |\n${rows.join("\n")}${more}`;
}

/** The answer with every list directive replaced by its table — what gets stored. */
export function expandLists(text: string, lists: Readonly<Record<string, ChatBlockList>>): string {
  return splitDirectives(text)
    .map((segment) =>
      segment.kind === "text"
        ? segment.text.replace(/^\n+|\n+$/g, "")
        : segment.kind === "people"
          ? `::people[${segment.ids.join(",")}]`
          : lists[segment.key]
            ? listToMarkdown(lists[segment.key])
            : ""
    )
    .filter(Boolean)
    .join("\n\n");
}

/** The answer as plain markdown, for copying: people blocks become a list of names. */
export function directivesAsText(
  text: string,
  names: (id: string) => string | undefined,
  lists: Readonly<Record<string, ChatBlockList>> = {}
): string {
  return splitDirectives(text)
    .map((segment) =>
      segment.kind === "text"
        ? segment.text.replace(/^\n+|\n+$/g, "")
        : segment.kind === "people"
          ? segment.ids
              .map(names)
              .filter((n): n is string => Boolean(n))
              .map((n) => `- ${n}`)
              .join("\n")
          : lists[segment.key]
            ? listToMarkdown(lists[segment.key])
            : ""
    )
    .filter(Boolean)
    .join("\n\n");
}
