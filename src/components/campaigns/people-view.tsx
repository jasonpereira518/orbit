"use client";

import { useCallback, useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import {
  cancelRunAction,
  excludePeopleAction,
  getCreditsAction,
  getRunAction,
  listPeopleAction,
  researchPersonAction,
  resolveDuplicateAction,
  restorePeopleAction,
  selectPeopleAction,
  startRunAction,
} from "@/actions/outreach-people";
import { FundingCard, type Credits } from "@/components/campaigns/funding-card";
import { PersonRowItem } from "@/components/campaigns/person-row";
import { RunProgress } from "@/components/campaigns/run-progress";
import { SelectionBanner } from "@/components/campaigns/selection-banner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { friendlyError } from "@/lib/errors";
import type { RunSummary } from "@/lib/outreach/discovery/run";
import type { ResearchKeyStatus } from "@/lib/outreach/keys";
import type { PeopleCounts, PeopleFilter, PersonRow } from "@/lib/outreach/people";
import type { OutreachCriteria, OutreachFundingSource, OutreachRankTier } from "@/lib/outreach/types";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type Page = { rows: PersonRow[]; nextOffset: number | null; total: number; counts: PeopleCounts; criteriaVersion: number };

const TIERS: Array<{ key: OutreachRankTier; label: string }> = [
  { key: "strong", label: "Strong" },
  { key: "possible", label: "Possible" },
  { key: "weak", label: "Weak" },
];
const POLL_INTERVAL_MS = 2500;
const POLL_MAX_DELAY_MS = 30_000;
const POLL_MAX_FAILURES = 6;
const isActive = (run: RunSummary | null) => Boolean(run && (run.status === "queued" || run.status === "running"));

function Toggle({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        pressed ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

export function PeopleView({
  campaignId,
  criteria,
  initialRun,
  initialPage,
  credits: initialCredits,
  keys,
}: {
  campaignId: string;
  criteria: OutreachCriteria;
  initialRun: RunSummary | null;
  initialPage: Page;
  credits: Credits;
  keys: ResearchKeyStatus;
}) {
  const [run, setRun] = useState(initialRun);
  const [page, setPage] = useState<Page>(initialPage);
  const [credits, setCredits] = useState(initialCredits);
  const [filter, setFilter] = useState<PeopleFilter>({});
  const [banner, setBanner] = useState<null | "page" | "all">(null);
  const [funding, setFunding] = useState<OutreachFundingSource>(
    keys.fundingPreference ?? (keys.orbitSearchAvailable ? "orbit" : "personal")
  );
  const [busy, startBusy] = useTransition();
  const [pollingStalled, setPollingStalled] = useState(false);
  const pollFailures = useRef(0);
  const headingId = useId();

  const loaded = page.rows.length;
  const polling = isActive(run) || page.rows.some((r) => r.researchState === "queued" || r.researchState === "running");

  const refresh = useCallback(
    async (nextFilter: PeopleFilter, count: number) => {
      const next = await listPeopleAction({ campaignId, filter: nextFilter, offset: 0, limit: Math.max(25, count) });
      setPage(next);
      return next;
    },
    [campaignId]
  );

  // A self-scheduling setTimeout loop rather than setInterval: the next tick is only queued
  // once the previous one (including its network round trip) has settled, so a slow poll can
  // never overlap the next. `getRunAction` / `listPeopleAction` / `getCreditsAction` throw on
  // failure rather than returning ActionResult, so a missed tick must not crash the view — the
  // last good state stays on screen. A run of consecutive failures backs off exponentially
  // (capped at 30s) rather than hammering a dead endpoint every 2.5s, and after enough of them
  // in a row polling stops outright — resuming needs a page refresh, not a silent retry loop
  // running forever. A hidden tab just skips the fetch; it never counts as a failure. Polling
  // pauses (without unscheduling) while the tab is hidden, and resumes on its own once visible.
  useEffect(() => {
    if (!polling || pollingStalled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (document.visibilityState === "visible") {
        try {
          const [nextRun, nextPage, nextCredits] = await Promise.all([
            getRunAction(campaignId),
            listPeopleAction({ campaignId, filter, offset: 0, limit: Math.max(25, loaded) }),
            getCreditsAction(),
          ]);
          if (cancelled) return;
          pollFailures.current = 0;
          setRun(nextRun);
          setPage(nextPage);
          setCredits(nextCredits);
        } catch {
          // A missed tick keeps the last good data on screen.
          if (cancelled) return;
          pollFailures.current += 1;
          if (pollFailures.current >= POLL_MAX_FAILURES) {
            setPollingStalled(true);
            return;
          }
        }
      }
      if (!cancelled) {
        timer = setTimeout(tick, Math.min(POLL_MAX_DELAY_MS, POLL_INTERVAL_MS * 2 ** pollFailures.current));
      }
    }

    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [polling, pollingStalled, campaignId, filter, loaded]);

  const act = (fallback: string, work: () => Promise<void>) =>
    startBusy(async () => {
      try {
        await work();
      } catch (err) {
        toast.error(friendlyError(err, fallback));
      }
    });

  function start(source: OutreachFundingSource, researchBudget: number) {
    act("Couldn’t start the search", async () => {
      const result = await startRunAction({ campaignId, funding: source, researchBudget });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setRun(await getRunAction(campaignId));
      setCredits(await getCreditsAction());
      toast.success(
        result.value.demo ? "Searching with sample people — this is a demo account" : "Finding people — results appear as they’re ranked"
      );
    });
  }

  function cancel() {
    if (!run) return;
    act("Couldn’t stop the search", async () => {
      const result = await cancelRunAction(campaignId, run.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setRun(await getRunAction(campaignId));
      setCredits(await getCreditsAction());
      await refresh(filter, loaded);
      toast.success("Search stopped — unused credits are back");
    });
  }

  function applyFilter(next: PeopleFilter) {
    setFilter(next);
    setBanner(null);
    act("Couldn’t load people", async () => {
      await refresh(next, 25);
    });
  }

  function toggleTier(tier: OutreachRankTier) {
    const current = filter.tiers ?? [];
    const tiers = current.includes(tier) ? current.filter((t) => t !== tier) : [...current, tier];
    applyFilter({ ...filter, tiers: tiers.length ? tiers : undefined });
  }

  const selectable = page.rows.filter((r) => r.status !== "excluded" && r.rankTier !== "filtered");
  const allOnPageSelected = selectable.length > 0 && selectable.every((r) => r.status === "selected");

  function togglePage(checked: boolean) {
    act("Couldn’t update the selection", async () => {
      const result = await selectPeopleAction(campaignId, { scope: "ids", ids: selectable.map((r) => r.id), selected: checked });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const next = await refresh(filter, loaded);
      setBanner(checked && next.total > next.rows.length ? "page" : null);
    });
  }

  function selectAllMatching() {
    act("Couldn’t update the selection", async () => {
      const result = await selectPeopleAction(campaignId, { scope: "filter", filter, exceptIds: [], selected: true });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await refresh(filter, loaded);
      setBanner("all");
    });
  }

  function clearSelection() {
    act("Couldn’t update the selection", async () => {
      const result = await selectPeopleAction(campaignId, {
        scope: "filter",
        filter: { ...filter, selection: "any" },
        exceptIds: [],
        selected: false,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await refresh(filter, loaded);
      setBanner(null);
    });
  }

  function toggleRow(id: string, checked: boolean) {
    act("Couldn’t update the selection", async () => {
      const result = await selectPeopleAction(campaignId, { scope: "ids", ids: [id], selected: checked });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await refresh(filter, loaded);
    });
  }

  function exclude(id: string) {
    act("Couldn’t exclude that person", async () => {
      const result = await excludePeopleAction(campaignId, [id], null);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await refresh(filter, loaded);
    });
  }

  function restore(id: string) {
    act("Couldn’t restore that person", async () => {
      const result = await restorePeopleAction(campaignId, [id]);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await refresh({ ...filter, includeExcluded: true }, loaded);
    });
  }

  function research(id: string) {
    act("Couldn’t start research", async () => {
      const result = await researchPersonAction(id, funding);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await refresh(filter, loaded);
      setCredits(await getCreditsAction());
    });
  }

  function resolveDuplicate(id: string, decision: "distinct" | "merged") {
    act("Couldn’t update that person", async () => {
      const result = await resolveDuplicateAction(id, decision);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await refresh(filter, loaded);
    });
  }

  function showMore() {
    const offset = page.nextOffset;
    if (offset === null) return;
    act("Couldn’t load more people", async () => {
      const more = await listPeopleAction({ campaignId, filter, offset, limit: 25 });
      setPage((current) => ({ ...more, rows: [...current.rows, ...more.rows] }));
    });
  }

  const visible = page.counts.total - page.counts.filtered - page.counts.excluded;

  return (
    <div className="space-y-6">
      {run && <RunProgress run={run} busy={busy} onCancel={cancel} />}
      {pollingStalled && (
        <p role="status" className="text-sm text-muted-foreground">
          Live updates paused — refresh the page to resume
        </p>
      )}
      {!isActive(run) && (
        <FundingCard
          credits={credits}
          keys={keys}
          funding={funding}
          onFundingChange={setFunding}
          busy={busy}
          hasRun={Boolean(run)}
          onStart={start}
        />
      )}

      <section aria-labelledby={headingId} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={headingId} className="text-lg font-medium text-ink">
            People <span className="font-normal text-muted-foreground">({visible})</span>
          </h2>
          <div role="group" aria-label="Filter people" className="flex flex-wrap gap-1.5">
            {TIERS.map((tier) => (
              <Toggle key={tier.key} pressed={Boolean(filter.tiers?.includes(tier.key))} onClick={() => toggleTier(tier.key)}>
                {tier.label} {page.counts[tier.key]}
              </Toggle>
            ))}
            <Toggle pressed={Boolean(filter.hasEmail)} onClick={() => applyFilter({ ...filter, hasEmail: !filter.hasEmail || undefined })}>
              Has email
            </Toggle>
            <Toggle pressed={Boolean(filter.researched)} onClick={() => applyFilter({ ...filter, researched: !filter.researched || undefined })}>
              Researched
            </Toggle>
            <Toggle
              pressed={Boolean(filter.includeFiltered)}
              onClick={() => applyFilter({ ...filter, includeFiltered: !filter.includeFiltered || undefined })}
            >
              Filtered out {page.counts.filtered}
            </Toggle>
          </div>
        </div>

        {banner && (
          <SelectionBanner
            mode={banner}
            pageCount={selectable.length}
            matching={page.total}
            selected={page.counts.selected}
            busy={busy}
            onSelectAll={selectAllMatching}
            onClear={clearSelection}
          />
        )}

        {page.rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 p-10 text-center text-sm text-muted-foreground">
            {run ? "No one matches these filters yet." : "Start a search to find people for this campaign."}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-1 text-sm">
              <Checkbox
                aria-label="Select everyone on this page"
                checked={allOnPageSelected}
                disabled={busy || selectable.length === 0}
                onCheckedChange={(checked) => togglePage(Boolean(checked))}
              />
              <span className="text-muted-foreground">
                Select this page · {page.counts.selected} selected
              </span>
            </div>
            <ul className="space-y-2">
              {page.rows.map((person) => (
                <PersonRowItem
                  key={person.id}
                  person={person}
                  criteria={criteria}
                  busy={busy}
                  funding={funding}
                  onToggle={toggleRow}
                  onExclude={exclude}
                  onRestore={restore}
                  onResearch={research}
                  onResolveDuplicate={resolveDuplicate}
                />
              ))}
            </ul>
            {page.nextOffset !== null && (
              <Button variant="outline" onClick={showMore} disabled={busy}>
                Show more
              </Button>
            )}
          </>
        )}
      </section>

      {page.counts.selected > 0 && (
        <p className="text-sm text-muted-foreground">
          {page.counts.selected} {page.counts.selected === 1 ? "person" : "people"} selected. Drafting and review come next.
        </p>
      )}
    </div>
  );
}
