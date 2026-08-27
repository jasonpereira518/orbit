import { Suspense } from "react";
import Link from "next/link";
import { CircleDollarSign, MessageSquareQuote, TrendingUp } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  AdminPanelSkeleton,
  AdminTable,
  EmptyState,
  MetricTile,
  MiniBars,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { LiveProvider, LiveValue } from "@/components/admin/live";
import { SCREEN_TIER } from "@/lib/admin-live-tiers";
import { displayName, loadAdminUserRows } from "@/lib/admin-metrics";
import {
  contactCapPicture,
  gateDemand,
  paidFeatureUsage,
  tierFindings,
} from "@/lib/admin-pricing";
import {
  getAiOperationAdoption,
  getArtifacts,
} from "@/lib/admin-product-health";
import { featureAdoption } from "@/lib/admin-trends";
import { PMF_LABELS, pmfSummary, recentFeedback } from "@/lib/feedback";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Product" };
export const dynamic = "force-dynamic";

/**
 * What to build, and what to charge.
 *
 * Split out of Growth, which was answering two unrelated questions on one screen: "do
 * people arrive and stay" (still there) and "is the product worth what it costs" (here).
 *
 * EVERY ACCOUNT-SHAPED FIGURE ON THIS PAGE IS A LIST OF NAMES, not a rate. "38% of free
 * accounts hit the cap" over a dozen users is four people wearing a percentage; the four
 * names are a to-do list. Rates appear only where the denominator is events — AI calls and
 * gate refusals run to hundreds even at this size.
 *
 * The pricing half only became possible once `gate_events` existed. `usage_events` records
 * what happened and, by construction, nothing about what somebody tried and could not — so
 * demand for a gated feature was invisible in both directions.
 */
type Cap = Awaited<ReturnType<typeof contactCapPicture>>;
type Demand = Awaited<ReturnType<typeof gateDemand>>;
type PaidUsage = Awaited<ReturnType<typeof paidFeatureUsage>>;
type Adoption = Awaited<ReturnType<typeof featureAdoption>>;
type AiOps = Awaited<ReturnType<typeof getAiOperationAdoption>>;
type Artifacts = Awaited<ReturnType<typeof getArtifacts>>;
type Pmf = Awaited<ReturnType<typeof pmfSummary>> | null;
type Verbatims = Awaited<ReturnType<typeof recentFeedback>>;

/**
 * NOT ASYNC, ON PURPOSE — every panel here rests on a different source, so each streams
 * behind its own boundary instead of the screen waiting on the slowest of eight.
 */
export default function AdminProductPage() {
  // `contactCapPicture` is the only thing here that needs the roster, so it chains off it
  // rather than the whole screen waiting for it first.
  const capPromise = loadAdminUserRows().then(contactCapPicture);
  const demandPromise = gateDemand().catch(() => []);
  const paidUsagePromise = paidFeatureUsage().catch(
    () => new Map<string, number | null>()
  );
  const adoptionPromise = featureAdoption();
  const aiOpsPromise = getAiOperationAdoption();
  const artifactsPromise = getArtifacts();
  const pmfPromise = pmfSummary().catch(() => null);
  const verbatimsPromise = recentFeedback({ limit: 15 }).catch(() => []);

  return (
    <LiveProvider screen="product" intervalMs={SCREEN_TIER.product} initial={{}}>
      <AdminPageHeader
        title="Product"
        subtitle="What earns its keep, and where money is being left on the table"
      />

      <div className="space-y-6">
        {/* ---------------------------------------------------------- what to charge */}

        <Suspense fallback={<AdminPanelSkeleton title="The free contact cap" />}>
          <CapPanel capPromise={capPromise} />
        </Suspense>

        <Suspense fallback={<AdminPanelSkeleton title="Which walls people hit" />}>
          <WallsPanel demandPromise={demandPromise} />
        </Suspense>

        <Suspense
          fallback={<AdminPanelSkeleton title="Is anything in the wrong tier?" />}
        >
          <TierPanel
            demandPromise={demandPromise}
            paidUsagePromise={paidUsagePromise}
          />
        </Suspense>

        {/* ------------------------------------------------------- voice of the user */}

        <Suspense
          fallback={
            <div className="grid gap-6 lg:grid-cols-2">
              <AdminPanelSkeleton title="Would they miss it?" />
              <AdminPanelSkeleton title="What people actually said" />
            </div>
          }
        >
          <VoicePanels pmfPromise={pmfPromise} verbatimsPromise={verbatimsPromise} />
        </Suspense>

        {/* ----------------------------------------------------------- what to build */}

        <Suspense
          fallback={
            <div className="grid gap-6 lg:grid-cols-2">
              <AdminPanelSkeleton title="Accounts that have used each feature" />
              <AdminPanelSkeleton title="What people have made" />
            </div>
          }
        >
          <AdoptionPanels
            adoptionPromise={adoptionPromise}
            artifactsPromise={artifactsPromise}
          />
        </Suspense>

        <Suspense fallback={<AdminPanelSkeleton title="AI operations used" />}>
          <AiOperationsPanel aiOpsPromise={aiOpsPromise} />
        </Suspense>
      </div>
    </LiveProvider>
  );
}

async function CapPanel({ capPromise }: { capPromise: Promise<Cap> }) {
  const cap = await capPromise;
  return (
        <AdminPanel
          title={`The ${cap.limit}-contact cap`}
          action={
            <span className="text-xs text-muted-foreground">
              {cap.convertedAfterBlock} upgraded after hitting it
            </span>
          }
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricTile
              label="At the cap"
              value={<LiveValue name="atCap">{cap.atCap.length}</LiveValue>}
              hint="free accounts, blocked from adding more"
            />
            <MetricTile
              label="Stalled 30+ days"
              value={String(cap.stalledAtCap.length)}
              tone={cap.stalledAtCap.length > 0 ? "danger" : undefined}
              hint="met the paywall and declined"
            />
            <MetricTile
              label="Approaching"
              value={<LiveValue name="nearCap">{cap.nearCap.length}</LiveValue>}
              hint="within 10% of the limit"
            />
          </div>

          <div className="mt-4">
            <MiniBars
              rows={cap.distribution.map((d) => ({
                label: d.band,
                count: d.accounts,
              }))}
            />
          </div>

          {/* The row that actually answers "is 100 the right number". An account here has
              met the paywall, thought about it, and said no. */}
          {cap.stalledAtCap.length > 0 && (
            <div className="mt-4">
              <AdminTable
                head={
                  <>
                    <Th>Stalled at the cap</Th>
                    <Th numeric>Contacts</Th>
                    <Th numeric>Times blocked</Th>
                    <Th numeric>First blocked</Th>
                  </>
                }
              >
                {cap.stalledAtCap.map((a) => (
                  <tr key={a.userId} className="border-b border-border/40 last:border-b-0">
                    <Td>
                      <Link
                        href={`/admin/users/${encodeURIComponent(a.userId)}`}
                        className="hover:text-primary"
                      >
                        {displayName(a)}
                      </Link>
                    </Td>
                    <Td numeric>{a.contacts}</Td>
                    <Td numeric>{a.blockedCount}</Td>
                    <Td numeric>
                      <RelativeTime date={a.firstBlockedAt} />
                    </Td>
                  </tr>
                ))}
              </AdminTable>
            </div>
          )}

          <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground">
            Enough accounts stalled here means the cap is annoying people rather than
            converting them, which is the opposite of what a limit is for. Blocked counts
            only exist from the day <code className="font-mono">gate_events</code> shipped.
          </p>
        </AdminPanel>
  );
}

async function WallsPanel({ demandPromise }: { demandPromise: Promise<Demand> }) {
  const demand = await demandPromise;
  return (
        <AdminPanel title="Which walls people hit">
          {demand.length === 0 ? (
            <EmptyState>
              No refusals recorded yet. This fills as free accounts meet paywalls — it does
              not backfill, so it stays empty until somebody does.
            </EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Feature</Th>
                  <Th numeric>Accounts</Th>
                  <Th numeric>Refusals</Th>
                  <Th numeric>Last</Th>
                </>
              }
            >
              {demand.map((d) => (
                <tr key={d.feature} className="border-b border-border/40 last:border-b-0">
                  <Td>{d.feature}</Td>
                  <Td numeric>{d.accounts}</Td>
                  <Td numeric className="text-muted-foreground">
                    {d.hits}
                  </Td>
                  <Td numeric>
                    <RelativeTime date={d.lastAt} />
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Sorted by distinct accounts, not refusals — one determined user retrying twenty
            times is intensity, not demand. Both columns are shown so the difference is
            visible.
          </p>
        </AdminPanel>
  );
}

async function TierPanel({
  demandPromise,
  paidUsagePromise,
}: {
  demandPromise: Promise<Demand>;
  paidUsagePromise: Promise<PaidUsage>;
}) {
  const [demand, paidUsage] = await Promise.all([demandPromise, paidUsagePromise]);
  const findings = tierFindings(demand, paidUsage);
  const wanted = findings.filter((f) => f.verdict === "wanted");
  const unwanted = findings.filter((f) => f.verdict === "unwanted");
  return (
        <AdminPanel title="Is anything in the wrong tier?">
          <div className="space-y-2">
            {findings.map((f) => (
              <div
                key={f.feature}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/40 pb-2 last:border-b-0"
              >
                <span className="flex items-center gap-2 text-sm">
                  {f.verdict === "wanted" && (
                    <CircleDollarSign className="size-3.5 text-primary" aria-hidden />
                  )}
                  {f.verdict === "unwanted" && (
                    <TrendingUp
                      className="size-3.5 rotate-180 text-destructive"
                      aria-hidden
                    />
                  )}
                  <span className="font-mono text-xs">{f.feature}</span>
                </span>
                <span
                  className={cn(
                    "text-xs",
                    f.verdict === "wanted" && "text-primary",
                    f.verdict === "unwanted" && "text-destructive",
                    f.verdict === "unproven" && "text-muted-foreground"
                  )}
                >
                  {f.note}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {wanted.length} feature{wanted.length === 1 ? "" : "s"} people asked for and
            could not reach · {unwanted.length} nobody has asked for and no paying account
            uses. &ldquo;Unproven&rdquo; is the honest verdict for most of these at this
            size, and is left as one rather than forced into a conclusion.
          </p>
        </AdminPanel>
  );
}

async function VoicePanels({
  pmfPromise,
  verbatimsPromise,
}: {
  pmfPromise: Promise<Pmf>;
  verbatimsPromise: Promise<Verbatims>;
}) {
  const [pmf, verbatims] = await Promise.all([pmfPromise, verbatimsPromise]);
  return (
        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Would they miss it?">
            {!pmf || pmf.total === 0 ? (
              <EmptyState>
                No responses yet. The in-app prompt that populates this has not shipped —
                the console only reads what it collects.
              </EmptyState>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <MetricTile
                    label="Very disappointed"
                    value={
                      pmf.score === null ? "—" : `${pmf.score}%`
                    }
                    hint={
                      pmf.score === null
                        ? `${pmf.total} of ${pmf.minimumResponses} responses needed`
                        : "40% is the conventional threshold"
                    }
                  />
                  <MetricTile
                    label="Responses"
                    value={String(pmf.total)}
                    hint="all time"
                  />
                </div>
                <div className="mt-4">
                  <MiniBars
                    rows={[3, 2, 1].map((score) => ({
                      label: PMF_LABELS[score],
                      count:
                        score === 3
                          ? pmf.veryDisappointed
                          : score === 2
                            ? pmf.somewhatDisappointed
                            : pmf.notDisappointed,
                    }))}
                  />
                </div>
                {pmf.score === null && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    The percentage is withheld below {pmf.minimumResponses} responses. With
                    four it can only be 0, 25, 50, 75 or 100 and moves 25 points on one
                    reply — a coin flip that reads as a trend. Read the verbatims instead.
                  </p>
                )}
              </>
            )}
          </AdminPanel>

          <AdminPanel title="What they actually said">
            {verbatims.length === 0 ? (
              <EmptyState>Nothing collected yet.</EmptyState>
            ) : (
              <ul className="space-y-3">
                {verbatims.map((f) => (
                  <li key={f.id} className="border-b border-border/40 pb-3 last:border-b-0">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <MessageSquareQuote className="size-3 shrink-0" aria-hidden />
                      <span className="font-mono">{f.kind}</span>
                      {f.score != null && <span>· {PMF_LABELS[f.score]}</span>}
                      <span>· </span>
                      <RelativeTime date={f.createdAt} />
                    </div>
                    {f.text && (
                      <p className="mt-1 whitespace-pre-wrap text-sm">{f.text}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Unaggregated and newest first. At this volume a dozen sentences of what people
              actually said is worth more than any chart drawn from them.
            </p>
          </AdminPanel>
        </div>
  );
}

async function AdoptionPanels({
  adoptionPromise,
  artifactsPromise,
}: {
  adoptionPromise: Promise<Adoption>;
  artifactsPromise: Promise<Artifacts>;
}) {
  const [adoption, artifacts] = await Promise.all([adoptionPromise, artifactsPromise]);
  return (
        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Accounts that have used each feature">
            <MiniBars
              rows={[
                { label: "Imports", count: adoption.imports },
                { label: "Chat", count: adoption.chat },
                { label: "Goals", count: adoption.goals },
                { label: "Calendar", count: adoption.calendar },
                { label: "Recruiters", count: adoption.recruiters },
                { label: "Gmail", count: adoption.gmail },
                { label: "Outreach", count: adoption.outreach },
                { label: "Outlook", count: adoption.outlook },
              ].sort((a, b) => b.count - a.count)}
            />
          </AdminPanel>

          <AdminPanel title="Durable artifacts">
            {/* What usage_events structurally cannot show: reminders, tags and goals leave
                no AI call behind, so a usage-only view reports them as unused. */}
            <AdminTable
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
                  <Td numeric className="text-muted-foreground">{a.users || "\u2014"}</Td>
                </tr>
              ))}
            </AdminTable>
          </AdminPanel>
        </div>
  );
}

async function AiOperationsPanel({ aiOpsPromise }: { aiOpsPromise: Promise<AiOps> }) {
  const aiOps = await aiOpsPromise;
  return (
          <AdminPanel title="AI operations used">
            {/* Complements the table-level adoption above: this is per code path, so it can
                show that nobody has ever run audio transcription or the Apollo enrichment. */}
            {aiOps.adoption.length === 0 ? (
              <EmptyState>No AI operations recorded in the last 30 days.</EmptyState>
            ) : (
              <AdminTable
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
                    <Td numeric className="text-muted-foreground">{row.calls}</Td>
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
            {aiOps.neverUsed.length > 0 && (
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
