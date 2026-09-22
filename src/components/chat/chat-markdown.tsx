"use client";

import { Children, Fragment, memo, useMemo, type ReactNode } from "react";
import Link from "next/link";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { SourceChip } from "@/components/chat/source-chip";
import type { EvidenceSource } from "@/lib/chat-evidence";
import { cn } from "@/lib/utils";

/** Soften common model output where list items are jammed onto one line. */
function normalizeChatMarkdown(text: string) {
  return text
    .replace(/(\S)\s+(\d+)\.\s+(\*\*|__)/g, "$1\n\n$2. $3")
    .replace(/(\S)\s+[-*]\s+(\*\*|__)/g, "$1\n\n- $2")
    .replace(/([.:;!?])\s+(\d+)\.\s+/g, "$1\n\n$2. ")
    .replace(/([.:;!?])\s+[-*]\s+/g, "$1\n\n- ");
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

/** Which number a citation's numbered chip shows, and the message its snippet is fetched from. */
type EvidenceContext = {
  messageId: string;
  /** `[eN]`'s underlying id → the number the chip shows, by order of first appearance. */
  numberOf: Map<string, number>;
};

const MARKER_SPLIT = /(\[e\d+\])/;
const MARKER = /^\[e(\d+)\]$/;

/**
 * `linkNames`'s citation twin: turns a `[eN]` marker into a numbered `SourceChip`, leaving
 * every other node untouched. Composed with `linkNames` rather than folded into it — a
 * marker can never collide with a linked name (the alphabets don't overlap), so splitting on
 * each in its own pass is simpler than one combined regex would be, and this pass is the one
 * that is skipped entirely when an answer carries no citations.
 */
function linkEvidence(children: ReactNode, matcher: NameMatcher | null, evidence: EvidenceContext | null): ReactNode {
  if (!evidence) return linkNames(children, matcher);
  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;
    const parts = child.split(MARKER_SPLIT);
    if (parts.length === 1) return linkNames(child, matcher);
    return parts.map((part, i) => {
      const m = MARKER.exec(part);
      if (!m) {
        // Fragment, not a bare array entry: `linkNames` can itself return an array (a part
        // with a linked name inside it), which React cannot flatten one level deeper without a key.
        return <Fragment key={i}>{linkNames(part, matcher)}</Fragment>;
      }
      const id = `e${m[1]}`;
      const number = evidence.numberOf.get(id);
      // Every marker in the persisted text resolved server-side (`stripUnresolvedMarkers`);
      // one that doesn't here can only be a message rendered before that guard existed.
      if (number === undefined) return null;
      return <SourceChip key={i} messageId={evidence.messageId} id={id} number={number} />;
    });
  });
}

function buildComponents(matcher: NameMatcher | null, evidence: EvidenceContext | null): Components {
  return {
    p: ({ children }) => <p className="mb-2 last:mb-0">{linkEvidence(children, matcher, evidence)}</p>,
    strong: ({ children }) => (
      <strong className="font-semibold text-foreground">{linkEvidence(children, matcher, evidence)}</strong>
    ),
    em: ({ children }) => <em className="italic">{linkEvidence(children, matcher, evidence)}</em>,
    ul: ({ children }) => (
      <ul className="mb-2 list-disc space-y-1 pl-4 last:mb-0">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="mb-2 list-decimal space-y-1 pl-4 last:mb-0">{children}</ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{linkEvidence(children, matcher, evidence)}</li>,
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

/** The no-people, no-citations set is shared, so the common case never rebuilds it. */
const PLAIN_COMPONENTS = buildComponents(null, null);

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  className,
  people,
  messageId,
  evidence,
}: {
  children: string;
  className?: string;
  /** People this answer is grounded in; their names become links. */
  people?: readonly ChatPerson[];
  /** Required alongside `evidence` — the row `SourceChip` fetches a clicked snippet from. */
  messageId?: string;
  /** This answer's citations, keyed by `[eN]` id — see `@/lib/chat-evidence`. */
  evidence?: Readonly<Record<string, EvidenceSource>>;
}) {
  // Keyed on the names and hrefs, not the array's identity: the caller builds a fresh array
  // each render, and rebuilding the components would remount every rendered node.
  // JSON is an unambiguous encoding of the pairs with no special characters to get mangled;
  // a control-character separator here was written to disk as real NUL bytes.
  const key = people ? JSON.stringify(people.map((p) => [p.name, p.href])) : "";
  // Numbered by first appearance IN THE TEXT, not by the underlying id — the model's ids are
  // minted in prompt order (every contact's timeline before the first word of prose), so
  // "cited first" and "id order" usually disagree, and 1, 2, 3 reading naturally is the point.
  const evidenceKey = evidence ? Object.keys(evidence).sort().join(",") : "";
  const evidenceContext = useMemo<EvidenceContext | null>(() => {
    if (!evidence || !messageId) return null;
    const numberOf = new Map<string, number>();
    let n = 0;
    for (const m of children.matchAll(/\[e(\d+)\]/g)) {
      const id = `e${m[1]}`;
      if (!(id in evidence) || numberOf.has(id)) continue;
      numberOf.set(id, (n += 1));
    }
    return numberOf.size ? { messageId, numberOf } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `evidenceKey` stands in for `evidence`; `children` drives the order.
  }, [children, messageId, evidenceKey]);
  const components = useMemo(
    () =>
      people?.length || evidenceContext
        ? buildComponents(people?.length ? buildNameMatcher(people) : null, evidenceContext)
        : PLAIN_COMPONENTS,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key`/`evidenceContext` stand in for `people`/`evidence`.
    [key, evidenceContext]
  );

  return (
    <div className={cn("chat-markdown", className)}>
      <ReactMarkdown components={components}>
        {normalizeChatMarkdown(children)}
      </ReactMarkdown>
    </div>
  );
});
