"use client";

import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { cn } from "@/lib/utils";

/** Soften common model output where list items are jammed onto one line. */
function normalizeChatMarkdown(text: string) {
  return text
    .replace(/(\S)\s+(\d+)\.\s+(\*\*|__)/g, "$1\n\n$2. $3")
    .replace(/(\S)\s+[-*]\s+(\*\*|__)/g, "$1\n\n- $2")
    .replace(/([.:;!?])\s+(\d+)\.\s+/g, "$1\n\n$2. ")
    .replace(/([.:;!?])\s+[-*]\s+/g, "$1\n\n- ");
}

const components: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => (
    <ul className="mb-2 list-disc space-y-1 pl-4 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal space-y-1 pl-4 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
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

export function ChatMarkdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("chat-markdown", className)}>
      <ReactMarkdown components={components}>
        {normalizeChatMarkdown(children)}
      </ReactMarkdown>
    </div>
  );
}
