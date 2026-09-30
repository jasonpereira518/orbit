import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  Td,
  Th,
} from "@/components/admin/primitives";
import { TrafficTabs } from "@/components/admin/traffic-tabs";
import {
  RADAR_IGNORED_MIN_SEEN,
  RADAR_METRIC_WINDOWS,
  loadRadarMetrics,
  type RadarMetricWindow,
  type RadarMetrics,
  type RadarRates,
} from "@/lib/radar/metrics";
import { KIND_LABELS } from "@/lib/radar/types";

export const metadata = { title: "Admin · Radar" };

/**
 * Is Radar working? Every figure is read from rows Radar already keeps (see
 * `src/lib/radar/metrics.ts` for the definitions). The rerank panel is the one to watch:
 * if cards the AI moved up are not accepted more often than cards it moved down, the rerank
 * is noise and `RADAR_RERANK_ENABLED` should go off.
 */
export default async function AdminRadarPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const params = await searchParams;
  const windowDays: RadarMetricWindow = RADAR_METRIC_WINDOWS.includes(Number(params.window) as RadarMetricWindow)
    ? (Number(params.window) as RadarMetricWindow)
    : 28;

  // Degrades as a whole: the three statements share one window and read as one report.
  const metrics = await loadRadarMetrics(windowDays).catch(() => null);

  const windowLink = (value: RadarMetricWindow) => (
    <a
      key={value}
      href={`/admin/analytics/radar${value === 28 ? "" : `?window=${value}`}`}
      className={windowDays === value ? "text-primary" : "text-muted-foreground hover:text-foreground"}
    >
      {value} days
    </a>
  );

  return (
    <>
      <AdminPageHeader
        title="Radar"
        subtitle={`What people did with Radar's cards, over the last ${windowDays} days.`}
      />

      <TrafficTabs />

      <div className="space-y-6">
        <div className="flex items-center gap-3 text-xs">
          {windowLink(7)}
          <span className="text-muted-foreground/40">·</span>
          {windowLink(28)}
        </div>

        {!metrics ? (
          <AdminPanel>
            <EmptyState>Couldn’t read Radar’s numbers just now.</EmptyState>
          </AdminPanel>
        ) : (
          <RadarReport metrics={metrics} />
        )}
      </div>
    </>
  );
}

function RadarReport({ metrics }: { metrics: RadarMetrics }) {
  const { totals } = metrics;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Cards shown" value={count(totals.shown)} note={`${metrics.accountsShown.toLocaleString()} accounts`} />
        <Tile label="Accepted" value={pct(totals.acceptRate)} note={`${totals.accepted.toLocaleString()} cards`} />
        <Tile label="Led to a conversation" value={pct(totals.convertRate)} note="of accepted, within 14 days" />
        <Tile
          label="Median time to act"
          value={metrics.medianHoursToAction === null ? "—" : hours(metrics.medianHoursToAction)}
          note="first seen to first action"
        />
      </div>

      <AdminPanel title="By kind">
        {totals.shown === 0 ? (
          <EmptyState>No cards were shown in this window.</EmptyState>
        ) : (
          <AdminTable
            minWidth="sm"
            head={
              <>
                <Th>Kind</Th>
                <Th numeric>Shown</Th>
                <Th numeric>Accepted</Th>
                <Th numeric>Dismissed</Th>
                <Th numeric>Ignored</Th>
                <Th numeric>Converted</Th>
              </>
            }
          >
            {metrics.kinds
              .filter((k) => k.shown > 0)
              .map((k) => (
                <tr key={k.kind} className="border-b border-border/40">
                  <Td>{KIND_LABELS[k.kind]}</Td>
                  <Td numeric>{k.shown.toLocaleString()}</Td>
                  <Td numeric>{pct(k.acceptRate)}</Td>
                  <Td numeric>{pct(k.shown ? k.dismissed / k.shown : null)}</Td>
                  <Td numeric>{pct(k.ignoreRate)}</Td>
                  <Td numeric>{pct(k.convertRate)}</Td>
                </tr>
              ))}
          </AdminTable>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Ignored means seen {RADAR_IGNORED_MIN_SEEN} or more times, then expired untouched. Converted is a
          share of accepted cards.
        </p>
      </AdminPanel>

      <AdminPanel title="Did the AI rerank help?">
        <CompareTable
          rows={[
            ["Moved up by the AI", metrics.rerank.promoted],
            ["Moved down by the AI", metrics.rerank.demoted],
            ["Left alone", metrics.rerank.untouched],
          ]}
        />
        <p className="mt-3 text-xs text-muted-foreground">
          The rerank earns its keep only if cards it moved up are accepted more often than cards it moved down.
        </p>
      </AdminPanel>

      <AdminPanel title="Pre-written drafts">
        <CompareTable
          rows={[
            ["With a draft ready", metrics.drafts.withDraft],
            ["Without", metrics.drafts.without],
          ]}
        />
      </AdminPanel>

      <AdminPanel title="Runs">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Runs" value={count(metrics.runs.total)} note={`${metrics.runs.accounts.toLocaleString()} accounts`} />
          <Tile label="Failed" value={count(metrics.runs.failed)} />
          <Tile label="p95 duration" value={metrics.runs.p95Ms === null ? "—" : `${(metrics.runs.p95Ms / 1000).toFixed(1)}s`} />
          <Tile
            label="AI lines per run"
            value={metrics.runs.avgAiNotes === null ? "—" : metrics.runs.avgAiNotes.toFixed(1)}
          />
        </div>
      </AdminPanel>
    </>
  );
}

function CompareTable({ rows }: { rows: Array<[string, RadarRates]> }) {
  if (rows.every(([, r]) => r.shown === 0)) return <EmptyState>No cards were shown in this window.</EmptyState>;
  return (
    <AdminTable
      minWidth="sm"
      head={
        <>
          <Th>Cards</Th>
          <Th numeric>Shown</Th>
          <Th numeric>Accepted</Th>
          <Th numeric>Converted</Th>
        </>
      }
    >
      {rows.map(([label, r]) => (
        <tr key={label} className="border-b border-border/40">
          <Td>{label}</Td>
          <Td numeric>{r.shown.toLocaleString()}</Td>
          <Td numeric>{pct(r.acceptRate)}</Td>
          <Td numeric>{pct(r.convertRate)}</Td>
        </tr>
      ))}
    </AdminTable>
  );
}

const count = (n: number) => n.toLocaleString();
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const hours = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-medium tabular-nums text-ink">{value}</div>
      {note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}
