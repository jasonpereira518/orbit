import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  Td,
  Th,
} from "@/components/admin/primitives";
import {
  AddInvestorForm,
  CreateRoundForm,
} from "@/components/admin/yc/fundraising-forms";
import { loadFundraisingSummary } from "@/lib/admin-yc-metrics";

export const metadata = { title: "Admin · Fundraising" };

export default async function FundraisingPage() {
  const { rounds } = await loadFundraisingSummary();

  return (
    <>
      <AdminPageHeader title="Fundraising" subtitle="Rounds, targets, and commitments." />

      <div className="space-y-6">
        <AdminPanel title="Open a round">
          <CreateRoundForm />
        </AdminPanel>

        {rounds.length === 0 ? (
          <AdminPanel>
            <EmptyState>No rounds yet — open one above.</EmptyState>
          </AdminPanel>
        ) : (
          rounds.map((round) => (
            <AdminPanel
              key={round.id}
              title={`${round.name} · ${round.status}`}
              action={
                <span className="text-xs text-muted-foreground">
                  ${round.raisedUsd.toLocaleString()} / ${round.targetUsd.toLocaleString()} ({round.progressPct.toFixed(0)}%)
                </span>
              }
            >
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <MetricTile label="Raised" value={`$${round.raisedUsd.toLocaleString()}`} />
                  <MetricTile label="Progress" value={`${round.progressPct.toFixed(0)}%`} />
                </div>

                <AddInvestorForm roundId={round.id} />

                {round.investors.length === 0 ? (
                  <EmptyState>No commitments yet.</EmptyState>
                ) : (
                  <AdminTable
                    head={
                      <>
                        <Th>Investor</Th>
                        <Th numeric>Amount</Th>
                      </>
                    }
                  >
                    {round.investors.map((i) => (
                      <tr key={i.id} className="border-b border-border/40 last:border-b-0">
                        <Td>{i.name}</Td>
                        <Td numeric>${i.amountUsd.toLocaleString()}</Td>
                      </tr>
                    ))}
                  </AdminTable>
                )}
              </div>
            </AdminPanel>
          ))
        )}
      </div>
    </>
  );
}
