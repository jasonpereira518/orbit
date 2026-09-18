import {
  AdminPanel,
  AdminTable,
  EmptyState,
  MiniBars,
  Td,
  Th,
  TrendBars,
} from "@/components/admin/primitives";
import { aiVolumeTrend } from "@/lib/admin-trends";
import {
  getAiOperationAdoption,
  getArtifacts,
  getDataQuality,
  getFunnelParking,
} from "@/lib/admin-product-health";

/**
 * Sections that used to sit on `/admin/growth` and answer a different question.
 *
 * Growth now tracks one thing — how many people use Orbit, and how much, over time. These
 * panels are about whether the machinery works (AI calls failing, data drifting out of
 * shape) or where onboarding stalls, so they moved to the pages that ask those questions:
 * the first four to Health, the parking panel to Conversion.
 *
 * Each is an async server component that fetches its own data and degrades on its own. A
 * missing instrumentation table empties one panel instead of failing the page it has been
 * dropped into, which matters more here than on Growth: Health is the page you open when
 * something is already broken.
 */

const weekLabel = (d: Date) => d.toISOString().slice(5, 10);

/** Twelve weeks of AI calls, failures in red. */
export async function AiVolumePanel() {
  const aiVolume = await aiVolumeTrend("week", 12).catch(() => null);
  return (
    <AdminPanel
      title="AI calls by week"
      action={<span className="text-xs text-muted-foreground">failures in red</span>}
    >
      {!aiVolume ? (
        <EmptyState>AI usage is unavailable.</EmptyState>
      ) : (
        <TrendBars
          rows={aiVolume.map((p) => ({
            label: weekLabel(p.bucketStart),
            count: p.count,
            secondary: p.failures,
            secondaryLabel: "failures",
          }))}
          emptyLabel="No AI calls in this window."
        />
      )}
      <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground">
        usage_events is pruned at 180 days, so this window cannot reach further back.
      </p>
    </AdminPanel>
  );
}

/**
 * Per code path, so it can show that nobody has ever run audio transcription or the Apollo
 * enrichment — which table-level adoption counts cannot.
 */
export async function AiOperationsPanel() {
  const aiOps = await getAiOperationAdoption().catch(() => null);
  return (
    <AdminPanel title="AI operations used">
      {!aiOps ? (
        <EmptyState>AI usage is unavailable.</EmptyState>
      ) : aiOps.adoption.length === 0 ? (
        <EmptyState>No AI operations recorded in the last 30 days.</EmptyState>
      ) : (
        <AdminTable
          minWidth="sm"
          head={
            <>
              <Th>Operation</Th>
              <Th numeric>Accounts</Th>
              <Th numeric>Calls</Th>
              <Th numeric>Failed</Th>
            </>
          }
        >
          {aiOps.adoption.map((row) => (
            <tr key={row.operation} className="border-b border-border/40 last:border-b-0">
              <Td className="font-mono text-xs">{row.operation}</Td>
              <Td numeric>{row.users}</Td>
              <Td numeric className="text-muted-foreground">
                {row.calls}
              </Td>
              <Td
                numeric
                className={row.failures > 0 ? "text-destructive" : "text-muted-foreground"}
              >
                {row.failures}
              </Td>
            </tr>
          ))}
        </AdminTable>
      )}
      {aiOps && aiOps.neverUsed.length > 0 && (
        <div className="mt-3 border-t border-border/60 pt-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Never used
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {aiOps.neverUsed.join(", ")}
          </p>
        </div>
      )}
    </AdminPanel>
  );
}

/**
 * What usage_events structurally cannot show: reminders, tags and goals leave no AI call
 * behind, so a usage-only view reports them as unused.
 */
export async function ArtifactsPanel() {
  const artifacts = await getArtifacts().catch(() => null);
  return (
    <AdminPanel title="Durable artifacts">
      {!artifacts ? (
        <EmptyState>Row counts are unavailable.</EmptyState>
      ) : (
        <AdminTable
          minWidth="none"
          head={
            <>
              <Th>Table</Th>
              <Th numeric>Rows</Th>
              <Th numeric>Accounts</Th>
            </>
          }
        >
          {artifacts.map((a) => (
            <tr key={a.label} className="border-b border-border/40 last:border-b-0">
              <Td>{a.label}</Td>
              <Td numeric className={a.rows === 0 ? "text-muted-foreground" : undefined}>
                {a.rows}
              </Td>
              <Td numeric className="text-muted-foreground">
                {a.users || "—"}
              </Td>
            </tr>
          ))}
        </AdminTable>
      )}
    </AdminPanel>
  );
}

/**
 * A section rather than a screen: at this scale it is eight integers and most are zero.
 * Split it out when two rows stay non-zero for a week — at that point they have stopped
 * being checks and become work.
 */
export async function DataQualityPanel() {
  const quality = await getDataQuality().catch(() => null);
  return (
    <AdminPanel title="Data quality">
      {!quality ? (
        <EmptyState>Data-quality checks are unavailable.</EmptyState>
      ) : (
        <AdminTable
          minWidth="none"
          head={
            <>
              <Th>Check</Th>
              <Th numeric>Affected</Th>
              <Th>Note</Th>
            </>
          }
        >
          {quality.map((row) => (
            <tr key={row.label} className="border-b border-border/40 last:border-b-0">
              <Td>{row.label}</Td>
              <Td
                numeric
                className={row.count > 0 ? "text-destructive" : "text-muted-foreground"}
              >
                {row.count}
                {row.total ? (
                  <span className="text-muted-foreground"> / {row.total}</span>
                ) : null}
              </Td>
              <Td className="text-xs text-muted-foreground">{row.hint ?? ""}</Td>
            </tr>
          ))}
        </AdminTable>
      )}
    </AdminPanel>
  );
}

/** Where accounts that never finished onboarding stopped. */
export async function FunnelParkingPanel() {
  const parking = await getFunnelParking().catch(() => null);
  return (
    <AdminPanel title="Where incomplete accounts are parked">
      {!parking ? (
        <EmptyState>Onboarding progress is unavailable.</EmptyState>
      ) : parking.onboardingParking.length === 0 && parking.wizardParking.length === 0 ? (
        <EmptyState>Nobody is mid-onboarding.</EmptyState>
      ) : (
        <>
          {parking.onboardingParking.length > 0 && (
            <MiniBars
              rows={parking.onboardingParking.map((x) => ({
                label: `tour · ${x.step}`,
                count: x.count,
              }))}
            />
          )}
          {parking.wizardParking.length > 0 && (
            <div className="mt-3">
              <MiniBars
                rows={parking.wizardParking.map((x) => ({
                  label: `wizard · ${x.step}`,
                  count: x.count,
                }))}
              />
            </div>
          )}
        </>
      )}
      <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
        The tour auto-advances every 7 seconds, so its step records where the tab was closed
        rather than what held attention. Wizard steps are validated on write, so those
        reflect a real choice — the branch taken is the signal worth acting on.
      </p>
    </AdminPanel>
  );
}
