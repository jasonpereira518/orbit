import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  MetricTile,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { loadRevenueGrowth } from "@/lib/admin-yc-metrics";

export const metadata = { title: "Admin · Revenue" };

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;

/** Signed, so a contraction reads as a loss without the reader doing the arithmetic. */
function signed(cents: number) {
  const sign = cents > 0 ? "+" : cents < 0 ? "−" : "";
  return `${sign}$${Math.round(Math.abs(cents) / 100).toLocaleString()}`;
}

export default async function RevenuePage() {
  const {
    mrrUsd,
    subscriberGrowthPct,
    newSubscribers30d,
    newSubscribersPrior30d,
    movement,
    ledgerStart,
    windowPredatesLedger,
  } = await loadRevenueGrowth();

  // Ordered as a waterfall: what was added, then what was taken away, then the net.
  const rows = [
    { label: "New", cents: movement.newCents },
    { label: "Reactivation", cents: movement.reactivationCents },
    { label: "Expansion", cents: movement.expansionCents },
    { label: "Contraction", cents: movement.contractionCents },
    { label: "Churn", cents: movement.churnCents },
  ];

  return (
    <>
      <AdminPageHeader
        title="Revenue"
        subtitle="MRR from the billing ledger, and the movements that got it there."
      />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricTile
            label="MRR"
            value={`$${Math.round(mrrUsd).toLocaleString()}`}
            hint="recurring, excludes comps and one-time sales"
          />
          <MetricTile
            label="Subscriber growth"
            value={
              subscriberGrowthPct === null
                ? "—"
                : `${subscriberGrowthPct >= 0 ? "+" : ""}${subscriberGrowthPct.toFixed(0)}%`
            }
            hint="new subscribers, 30d vs. prior 30d"
            tone={subscriberGrowthPct !== null && subscriberGrowthPct < 0 ? "danger" : "default"}
          />
          <MetricTile
            label="New subscribers (30d)"
            value={newSubscribers30d}
            hint={`${newSubscribersPrior30d} in the prior 30 days`}
          />
        </div>

        <AdminPanel
          title="MRR movement (30d)"
          action={
            <span className="text-xs tabular-nums text-muted-foreground">
              net {signed(movement.netCents)}
            </span>
          }
        >
          <AdminTable
            head={
              <>
                <Th>Movement</Th>
                <Th numeric>MRR change</Th>
              </>
            }
          >
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-border/40 last:border-b-0">
                <Td>{row.label}</Td>
                <Td numeric>
                  <span
                    className={
                      row.cents < 0
                        ? "text-destructive"
                        : row.cents === 0
                          ? "text-muted-foreground"
                          : undefined
                    }
                  >
                    {row.cents === 0 ? "—" : signed(row.cents)}
                  </span>
                </Td>
              </tr>
            ))}
            <tr className="border-t border-border">
              <Td>Net</Td>
              <Td numeric>
                <span className={movement.netCents < 0 ? "text-destructive" : undefined}>
                  {signed(movement.netCents)}
                </span>
              </Td>
            </tr>
          </AdminTable>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <MetricTile
              label="Cash in (30d)"
              value={usd(movement.cashInCents)}
              tone="muted"
              hint="payments and one-time sales"
            />
            <MetricTile
              label="Refunded"
              value={usd(movement.refundedCents)}
              tone={movement.refundedCents > 0 ? "danger" : "muted"}
            />
            <MetricTile
              label="Failed payments"
              value={movement.failedPayments}
              tone={movement.failedPayments > 0 ? "danger" : "muted"}
            />
          </div>

          {/*
            Without this, a window that starts before the ledger does looks like a quiet
            month rather than a period nobody was recording.
          */}
          {ledgerStart ? (
            windowPredatesLedger && (
              <p className="mt-3 text-xs text-muted-foreground">
                The ledger begins <RelativeTime date={ledgerStart} />, partway into this
                window — movements before then are not recorded and this is an undercount.
              </p>
            )
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              No billing events recorded yet. Movement stays empty until Stripe sends one,
              or until the backfill script is run.
            </p>
          )}
        </AdminPanel>
      </div>
    </>
  );
}
