"use client";

import { Children, memo, useMemo, type ReactNode } from "react";
import Link from "next/link";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/** Soften common model output where list items are jammed onto one line. */
function normalizeProse(text: string) {
  return text
    .replace(/(\S)\s+(\d+)\.\s+(\*\*|__)/g, "$1\n\n$2. $3")
    .replace(/(\S)\s+[-*]\s+(\*\*|__)/g, "$1\n\n- $2")
    .replace(/([.:;!?])\s+(\d+)\.\s+/g, "$1\n\n$2. ")
    .replace(/([.:;!?])\s+[-*]\s+/g, "$1\n\n- ");
}

/**
 * Runs of table rows — consecutive lines that start with `|`.
 *
 * The list-fixing regexes above look for "a sentence, then `1.` or `- `" anywhere in the text,
 * which is exactly what a table cell like "Q1. **Plan**" or "Met - follow up" looks like. Left to
 * them, a cell is split onto its own paragraph and the table stops being one. So table blocks are
 * carved out first and passed through untouched. The capture group makes `split` keep them, at
 * the odd indices.
 */
const TABLE_BLOCK = /((?:^[ \t]*\|[^\n]*(?:\n|$))+)/m;

function normalizeChatMarkdown(text: string) {
  return text
    .split(TABLE_BLOCK)
    .map((part, i) => (i % 2 === 1 ? part : normalizeProse(part)))
    .join("");
}

/** A person the answer may name, and where their page is. */
export type ChatPerson = { name: string; href: string };

type NameMatcher = { re: RegExp; hrefByName: Map<string, string> };

/**
 * Turn a list of known people into one matcher, or null when there is nothing to link.
 *
 * Only EXACT names from the answer's own grounding (the recommendations and the contacts
 * retrieval returned) are ever linked — never a guess. A single common first name would
 * light up unrelated words, so a name has to be a full name (contains a space) or long
 * enough to be unmistakable. Longest first, so "Ada Lovelace-King" wins over "Ada Lovelace".
 */
function buildNameMatcher(people: readonly ChatPerson[]): NameMatcher | null {
  const hrefByName = new Map<string, string>();
  for (const person of people) {
    const name = person.name.trim();
    if (name.length < 5 && !name.includes(" ")) continue;
    if (!hrefByName.has(name)) hrefByName.set(name, person.href);
  }
  if (hrefByName.size === 0) return null;
  const alternation = [...hrefByName.keys()]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  // Lookarounds rather than `\b`: a name can end in punctuation or contain accents, which
  // `\b` treats as a boundary in the wrong places. The capture group makes `split` keep the
  // matches, at the odd indices.
  return {
    re: new RegExp(`(?<![\\p{L}\\p{N}])(${alternation})(?![\\p{L}\\p{N}])`, "u"),
    hrefByName,
  };
}

/** Wrap known names inside plain-string children; leave every other node untouched. */
function linkNames(children: ReactNode, matcher: NameMatcher | null): ReactNode {
  if (!matcher) return children;
  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;
    const parts = child.split(matcher.re);
    if (parts.length === 1) return child;
    return parts.map((part, i) => {
      if (i % 2 === 0) return part;
      const href = matcher.hrefByName.get(part);
      if (!href) return part;
      return (
        <Link
          key={`${i}-${part}`}
          href={href}
          className="underline decoration-muted-foreground/60 decoration-dotted underline-offset-4 transition-colors hover:text-primary hover:decoration-primary"
        >
          {part}
        </Link>
      );
    });
  });
}

function buildComponents(matcher: NameMatcher | null): Components {
  return {
    p: ({ children }) => <p className="mb-2 last:mb-0">{linkNames(children, matcher)}</p>,
    strong: ({ children }) => (
      <strong className="font-semibold text-foreground">{linkNames(children, matcher)}</strong>
    ),
    em: ({ children }) => <em className="italic">{linkNames(children, matcher)}</em>,
    ul: ({ children }) => (
      <ul className="mb-2 list-disc space-y-1 pl-4 last:mb-0">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="mb-2 list-decimal space-y-1 pl-4 last:mb-0">{children}</ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{linkNames(children, matcher)}</li>,
    // GitHub-style tables (remark-gfm). The wrapper is what scrolls: a wide table must scroll
    // sideways inside the answer rather than stretch the whole chat column, which on a phone is
    // the difference between a readable answer and a page that scrolls in two directions.
    table: ({ children }) => (
      <div className="mb-2 max-w-full overflow-x-auto rounded-lg border border-border/60 last:mb-0">
        <table className="min-w-full border-collapse text-left text-xs">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
    tr: ({ children }) => <tr className="border-b border-border/50 last:border-b-0">{children}</tr>,
    th: ({ children }) => (
      <th className="whitespace-nowrap px-2.5 py-1.5 font-medium text-foreground">{children}</th>
    ),
    td: ({ children }) => (
      <td className="px-2.5 py-1.5 align-top">{linkNames(children, matcher)}</td>
    ),
    del: ({ children }) => <del className="text-muted-foreground line-through">{children}</del>,
    // A task list's checkbox is a picture of state, not a control: the answer is read-only.
    input: ({ checked }) => (
      <input type="checkbox" checked={Boolean(checked)} disabled readOnly className="mr-1.5 align-middle" />
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-primary underline underline-offset-2"
      >
        {children}
      </a>
    ),
    code: ({ children }) => (
      <code className="rounded bg-muted px-1 py-0.5 text-[0.9em]">{children}</code>
    ),
    pre: ({ children }) => (
      <pre className="mb-2 overflow-x-auto rounded-lg bg-muted/80 p-2.5 text-xs last:mb-0">
        {children}
      </pre>
    ),
    h1: ({ children }) => (
      <h1 className="mb-2 text-base font-semibold last:mb-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-2 text-sm font-semibold last:mb-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-1.5 text-sm font-semibold last:mb-0">{children}</h3>
    ),
  };
}

const REMARK_PLUGINS = [remarkGfm];

/** The no-people set is shared, so the common case never rebuilds it. */
const PLAIN_COMPONENTS = buildComponents(null);

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  className,
  people,
}: {
  children: string;
  className?: string;
  /** People this answer is grounded in; their names become links. */
  people?: readonly ChatPerson[];
}) {
  // Keyed on the names and hrefs, not the array's identity: the caller builds a fresh array
  // each render, and rebuilding the components would remount every rendered node.
  // JSON is an unambiguous encoding of the pairs with no special characters to get mangled;
  // a control-character separator here was written to disk as real NUL bytes.
  const key = people ? JSON.stringify(people.map((p) => [p.name, p.href])) : "";
  const components = useMemo(
    () => (people && people.length ? buildComponents(buildNameMatcher(people)) : PLAIN_COMPONENTS),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands in for `people`.
    [key]
  );

  return (
    <div className={cn("chat-markdown", className)}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {normalizeChatMarkdown(children)}
      </ReactMarkdown>
    </div>
  );
});
