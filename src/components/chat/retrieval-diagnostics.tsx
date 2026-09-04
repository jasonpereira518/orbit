"use client";

import { useState } from "react";
import { ChevronDown, FlaskConical } from "lucide-react";
import type { ChatDiagnostics } from "@/lib/chat-diagnostics";
import { cn } from "@/lib/utils";

/**
 * Why the model was shown these people and not others.
 *
 * Rendered only when the server attached a trace, which it does only for a testing account —
 * this component carries no gate of its own, and a non-beta answer simply has no
 * `diagnostics` field to render. Collapsed by default: it explains an answer rather than
 * being one, and an open drawer under every reply would bury the thing the user asked for.
 */
export function RetrievalDiagnostics({ data }: { data: ChatDiagnostics }) {
  const [open, setOpen] = useState(false);

  const armLabel: Record<string, string> = {
    fts: "text",
    trigram: "fuzzy",
    semantic: "meaning",
  };

  return (
    <div className="rounded-xl border border-accent/40 bg-accent/[0.04] text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:text-foreground"
      >
        <FlaskConical className="size-3.5 shrink-0 text-accent-foreground" />
        <span className="font-medium">Retrieval</span>
        <span className="tabular-nums">
          {data.candidateCount} candidates → {data.finalCount} used · {data.totalMs}ms
        </span>
        <ChevronDown
          className={cn("ml-auto size-3.5 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="space-y-3 border-t border-accent/30 px-3 py-3">
          <div>
            <p className="font-medium text-foreground">Stages</p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {data.stages.map((stage) => (
                <li key={stage.name} className="flex justify-between gap-4">
                  <span>{stage.name}</span>
                  <span className="tabular-nums">{stage.ms}ms</span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="font-medium text-foreground">Query</p>
            <p className="mt-1 text-muted-foreground">
              Semantic arm{" "}
              <span className={data.embedded ? "text-foreground" : "text-destructive"}>
                {data.embedded ? "on" : "off (no embedding)"}
              </span>
              {data.parsed.semanticQuery && (
                <>
                  {" · rewritten to "}
                  <span className="text-foreground">
                    &ldquo;{data.parsed.semanticQuery}&rdquo;
                  </span>
                </>
              )}
            </p>
            {data.parsed.filters.length > 0 && (
              <p className="mt-1 text-muted-foreground">
                Filters:{" "}
                {data.parsed.filters.map((f) => (
                  <span key={f.key} className="mr-2 text-foreground">
                    {f.key}={f.value}
                  </span>
                ))}
              </p>
            )}
            {data.parsed.expansionTerms.length > 0 && (
              <p className="mt-1 text-muted-foreground">
                Expanded with:{" "}
                <span className="text-foreground">
                  {data.parsed.expansionTerms.join(", ")}
                </span>
              </p>
            )}
          </div>

          <div>
            <p className="font-medium text-foreground">Rerank</p>
            <p className="mt-1 text-muted-foreground">
              {data.rerank.outcome === "skipped"
                ? `Skipped — the pool was already at or under ${data.constants.finalContactCount}.`
                : data.rerank.outcome === "fallback"
                  ? "Failed or timed out; fell back to fusion order."
                  : data.rerank.outcome === "starved"
                    ? `Scored ${data.rerank.scored}, but too few cleared the threshold — kept the top few by the model's order.`
                    : `Scored ${data.rerank.scored} candidates and kept the best ${data.finalCount}.`}
            </p>
          </div>

          <div>
            <p className="font-medium text-foreground">
              Contacts given to the model ({data.contacts.length})
            </p>
            <div className="mt-1 overflow-x-auto">
              <table className="w-full min-w-[26rem] text-left text-muted-foreground">
                <thead>
                  <tr className="border-b border-border/50">
                    <th className="py-1 pr-2 font-normal">Name</th>
                    <th className="py-1 pr-2 font-normal">Matched</th>
                    <th className="py-1 pr-2 text-right font-normal">Fusion</th>
                    <th className="py-1 pr-2 text-right font-normal">Rerank</th>
                    <th className="py-1 text-right font-normal">Relevance</th>
                  </tr>
                </thead>
                <tbody>
                  {data.contacts.map((c) => (
                    <tr key={c.id} className="border-b border-border/30 last:border-0">
                      <td className="py-1 pr-2">
                        <span className="text-foreground">{c.fullName}</span>
                        {!c.filterMatched && (
                          <span
                            className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground"
                            title="Pulled in by the recall guard despite not matching the filters"
                          >
                            guard
                          </span>
                        )}
                      </td>
                      <td className="py-1 pr-2">
                        {c.matchedArms.map((a) => armLabel[a] ?? a).join(", ") || "—"}
                      </td>
                      <td className="py-1 pr-2 text-right tabular-nums">
                        {c.rrfScore.toFixed(4)}
                      </td>
                      <td className="py-1 pr-2 text-right tabular-nums">
                        {c.rerankScore == null ? "—" : c.rerankScore}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {c.relevance.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
