import { useState } from "react";
import { Check, Copy, Sparkles } from "lucide-react";
import type { ConversationStarter } from "@contract";
import { Button, Skeleton } from "./ui";

function StarterCard({ starter }: { starter: ConversationStarter }) {
  const [copied, setCopied] = useState(false);

  return (
    <li className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-3">
      {/* Rationale above the line, so the user can judge it before reading it. */}
      <p className="mb-1 text-[11px] text-[var(--muted-foreground)]">
        {starter.basis}
      </p>
      <p className="text-[13px] leading-snug text-[var(--foreground)]">
        {starter.text}
      </p>
      <div className="mt-2 flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(starter.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </li>
  );
}

export function StarterList({
  starters,
  loading,
  degraded,
}: {
  starters: ConversationStarter[];
  loading: boolean;
  degraded: boolean;
}) {
  if (starters.length === 0 && !loading) return null;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          Suggested next moves
        </h2>
        {loading ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--muted-foreground)]">
            <Sparkles size={11} className="animate-pulse" />
            thinking
          </span>
        ) : null}
      </div>

      <ul className="space-y-2">
        {starters.map((starter) => (
          <StarterCard key={starter.id} starter={starter} />
        ))}
        {loading && starters.length === 0 ? (
          <>
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </>
        ) : null}
      </ul>

      {degraded && !loading ? (
        <p className="mt-2 text-[11px] text-[var(--muted-foreground)]">
          Based on what Orbit already knows. Add an AI key in Settings for
          sharper suggestions.
        </p>
      ) : null}
    </div>
  );
}
