import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  DefinitionRow,
  EmptyState,
  MetricTile,
  Td,
  Th,
} from "@/components/admin/primitives";
import { LogExpenseForm, UpdateCashForm } from "@/components/admin/yc/runway-forms";
import { loadRunwayMetrics } from "@/lib/admin-yc-metrics";

export const metadata = { title: "Admin · Runway" };

const usd = (value: number) => `$${Math.round(value).toLocaleString()}`;
const MONTH = new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" });

export default async function RunwayPage() {
  const {
    cashBalanceUsd,
    monthlyBurnUsd,
    expenseBurnUsd,
    infraMonthlyUsd,
    managedAiMonthlyUsd,
    deepgramMonthlyUsd,
    acquisitionMonthlyUsd,
    acquisitionMonth,
    infraEntered,
    recentExpenses,
    runwayMonths,
  } = await loadRunwayMetrics();

  return (
    <>
      <AdminPageHeader
        title="Runway"
        subtitle="Cash on hand, burn, and months until it runs out."
      />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricTile label="Cash on hand" value={usd(cashBalanceUsd)} />
          <MetricTile
            label="Monthly burn"
            value={usd(monthlyBurnUsd)}
            hint="expenses + infrastructure + included AI + Deepgram + acquisition"
            tone={infraEntered ? "default" : "danger"}
          />
          <MetricTile
            label="Runway"
            value={runwayMonths === null ? "∞" : `${runwayMonths.toFixed(1)} mo`}
            tone={runwayMonths !== null && runwayMonths < 3 ? "danger" : "default"}
          />
        </div>

        {/*
          Burn is shown as its parts, not as one figure. A single merged number hides the
          case that matters: a month where nobody entered the provider bills, where burn
          silently drops and runway silently grows.
        */}
        <AdminPanel title="What burn is made of">
          <dl className="space-y-0">
            <DefinitionRow label="Ad-hoc expenses">
              {usd(expenseBurnUsd)} · trailing 30 days
            </DefinitionRow>
            <DefinitionRow label="Infrastructure">
              {infraEntered ? (
                <>{usd(infraMonthlyUsd)} · latest month billed</>
              ) : (
                <span className="text-destructive">
                  not entered — burn is understated and runway overstated
                </span>
              )}
            </DefinitionRow>
            <DefinitionRow label="Included AI (Pro and Max)">
              {usd(managedAiMonthlyUsd)} · model cost on Orbit&apos;s keys, trailing 30 days
            </DefinitionRow>
            <DefinitionRow label="Deepgram (voice)">
              {usd(deepgramMonthlyUsd)} · priced from recorded seconds, trailing 30 days. Drawn from the
              prepaid credit until it runs out, but it is what voice costs to run.
            </DefinitionRow>
            <DefinitionRow label="Acquisition">
              {acquisitionMonth ? (
                <>
                  {usd(acquisitionMonthlyUsd)} · marketing spend logged for{" "}
                  {MONTH.format(acquisitionMonth)}, the latest month with any
                </>
              ) : (
                "none logged"
              )}
            </DefinitionRow>
            <DefinitionRow label="= Monthly burn">
              <span className="font-medium text-foreground">{usd(monthlyBurnUsd)}</span>
            </DefinitionRow>
          </dl>
          {!infraEntered && (
            <p className="mt-3 text-xs text-muted-foreground">
              Provider bills are recorded in the Money section, under Costs.
            </p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Burn = ad-hoc expenses + infrastructure + included AI + Deepgram + acquisition. The AI and
            Deepgram lines include your own accounts: burn is cash, whoever spent it.
          </p>
        </AdminPanel>

        <AdminPanel title="Update">
          <div className="space-y-4">
            <UpdateCashForm />
            <LogExpenseForm />
          </div>
        </AdminPanel>

        <AdminPanel title="Recent expenses (30d)">
          {recentExpenses.length === 0 ? (
            <EmptyState>No expenses logged in the last 30 days.</EmptyState>
          ) : (
            <AdminTable label="Recent expenses (30d)" minWidth="none"
              head={
                <>
                  <Th>Category</Th>
                  <Th>Note</Th>
                  <Th numeric>Amount</Th>
                </>
              }
            >
              {recentExpenses.map((e) => (
                <tr key={e.id} className="border-b border-border/40 last:border-b-0">
                  <Td>{e.category}</Td>
                  <Td className="text-muted-foreground">{e.note ?? "—"}</Td>
                  <Td numeric>{usd(e.amountUsd)}</Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>
      </div>
    </>
  );
}
