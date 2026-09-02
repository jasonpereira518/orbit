import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  Td,
  Th,
} from "@/components/admin/primitives";
import { LogExpenseForm, UpdateCashForm } from "@/components/admin/yc/runway-forms";
import { loadRunwayMetrics } from "@/lib/admin-yc-metrics";

export const metadata = { title: "Admin · Runway" };

export default async function RunwayPage() {
  const { cashBalanceUsd, monthlyBurnUsd, runwayMonths, recentExpenses } =
    await loadRunwayMetrics();

  return (
    <>
      <AdminPageHeader
        title="Runway"
        subtitle="Cash on hand, burn, and months until it runs out."
      />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricTile label="Cash on hand" value={`$${cashBalanceUsd.toLocaleString()}`} />
          <MetricTile label="Monthly burn" value={`$${monthlyBurnUsd.toLocaleString()}`} hint="trailing 30 days" />
          <MetricTile
            label="Runway"
            value={runwayMonths === null ? "∞" : `${runwayMonths.toFixed(1)} mo`}
            tone={runwayMonths !== null && runwayMonths < 3 ? "danger" : "default"}
          />
        </div>

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
            <AdminTable
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
                  <Td numeric>${e.amountUsd.toLocaleString()}</Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>
      </div>
    </>
  );
}
