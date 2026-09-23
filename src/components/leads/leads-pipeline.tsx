"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { LeadStatus } from "@/db/schema";
import type { Pipeline, PipelineRow } from "@/lib/leads/pipeline";
import type { Warmth } from "@/lib/leads/warm-path";
import { cn } from "@/lib/utils";
import { LEAD_STATUS_LABEL } from "./labels";
import { LeadDetailSheet } from "./lead-detail-sheet";
import { PathSummary } from "./path-summary";
import { WARMTH_LABEL, WarmthChip } from "./warmth-chip";

type StatusTab = "open" | "converted" | "dismissed" | "all";

const STATUS_TABS: { key: StatusTab; label: string; matches: (status: LeadStatus) => boolean }[] = [
  { key: "open", label: "Open", matches: (s) => s === "open" || s === "intro_requested" },
  { key: "converted", label: "In contacts", matches: (s) => s === "converted" },
  { key: "dismissed", label: "Dismissed", matches: (s) => s === "dismissed" },
  { key: "all", label: "All", matches: () => true },
];

const WARMTH_FILTERS: (Warmth | "all")[] = ["all", "hot", "warm", "cool", "cold"];

const TEAM_NOTE: Record<Pipeline["team"], string> = {
  ok: "Ranked by who on your team knows them.",
  no_team: "Join your team to rank these by who knows them.",
  not_sharing: "Share your network to rank these by who knows them.",
};

const warmthOf = (row: PipelineRow): Warmth => row.path?.warmth ?? "cold";

/**
 * The saved leads, already ranked by the server (hottest first). Filters are client-side over
 * one list of at most `PIPELINE_LIMIT` rows (src/lib/leads/store.ts); the sheet re-finds its
 * row by id on every render, so a refresh after an action shows the updated lead.
 */
export function LeadsPipeline({ pipeline }: { pipeline: Pipeline }) {
  const [tab, setTab] = useState<StatusTab>("open");
  const [warmth, setWarmth] = useState<Warmth | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const activeTab = STATUS_TABS.find((t) => t.key === tab) ?? STATUS_TABS[0];
  // The warmth filter buttons only render when the team is "ok" (below); once the team is
  // gone, a lingering non-"all" warmth choice must not keep hiding every row with no way in
  // the UI to clear it.
  const effectiveWarmth = pipeline.team === "ok" ? warmth : "all";
  const visible = pipeline.rows.filter(
    (row) => activeTab.matches(row.lead.status) && (effectiveWarmth === "all" || warmthOf(row) === effectiveWarmth)
  );
  const selected = selectedId ? (pipeline.rows.find((row) => row.lead.id === selectedId) ?? null) : null;

  return (
    <section className="space-y-3" aria-labelledby="leads-pipeline-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="leads-pipeline-title" className="font-medium text-ink">
            Your leads
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{TEAM_NOTE[pipeline.team]}</p>
        </div>
        <div role="group" aria-label="Filter by status" className="flex rounded-lg border border-border/70 bg-card p-0.5 text-sm">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-pressed={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-md px-2.5 py-1 transition-colors duration-fast",
                tab === t.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}{" "}
              <span className="tabular-nums opacity-70">
                {pipeline.rows.filter((row) => t.matches(row.lead.status)).length}
              </span>
            </button>
          ))}
        </div>
      </div>

      {pipeline.team === "ok" && pipeline.rows.length > 0 && (
        <div role="group" aria-label="Filter by warmth" className="flex flex-wrap gap-1.5">
          {WARMTH_FILTERS.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={warmth === w}
              onClick={() => setWarmth(w)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs transition-colors duration-fast",
                warmth === w
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/70 text-muted-foreground hover:text-foreground"
              )}
            >
              {w === "all" ? "Any path" : WARMTH_LABEL[w]}
            </button>
          ))}
        </div>
      )}

      {pipeline.rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-card px-5 py-12 text-center">
          <p className="font-medium text-ink">No leads yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Find a path above or search Apollo below, then save the people you want to reach.
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-card px-5 py-10 text-center text-sm text-muted-foreground">
          Nothing here with these filters.
        </div>
      ) : (
        <ul className="divide-y divide-border/60 rounded-2xl border border-border/70 bg-card">
          {visible.map((row) => (
            <li key={row.lead.id}>
              <button
                type="button"
                onClick={() => setSelectedId(row.lead.id)}
                className="flex w-full flex-wrap items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors duration-fast hover:bg-muted/40"
              >
                {/* A button's content model is phrasing content only — span, not div/p. */}
                <span className="block min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{row.lead.displayName}</span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {[row.lead.title, row.lead.companyName].filter(Boolean).join(" · ") || "No title or company yet"}
                  </span>
                  {row.path && <PathSummary path={row.path} companyName={row.lead.companyName} compact />}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {row.lead.status !== "open" && (
                    <Badge variant="outline" className="text-[10px]">
                      {LEAD_STATUS_LABEL[row.lead.status]}
                    </Badge>
                  )}
                  {row.lead.source === "apollo" && (
                    <Badge variant="secondary" className="text-[10px]">
                      Apollo
                    </Badge>
                  )}
                  {row.path ? <WarmthChip warmth={row.path.warmth} /> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <LeadDetailSheet row={selected} onClose={() => setSelectedId(null)} />
    </section>
  );
}
