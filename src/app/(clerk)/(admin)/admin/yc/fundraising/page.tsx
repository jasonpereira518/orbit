import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  DefinitionRow,
  EmptyState,
  MetricTile,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { RankedBars } from "@/components/admin/charts";
import {
  AddInvestorForm,
  AddNonDilutiveForm,
  CreateRoundForm,
  DeleteInvestorButton,
  DeleteNonDilutiveButton,
  MarkReceivedButton,
  RepaymentForm,
  RoundStatusButton,
} from "@/components/admin/yc/fundraising-forms";
import { loadFundingTotals } from "@/lib/admin-yc-metrics";

export const metadata = { title: "Admin · Funding" };

/** Whole dollars. Nothing here is worth cents, and cents make a column of totals unreadable. */
function usd(value: number) {
  return `$${Math.round(value).toLocaleString()}`;
}

/**
 * An expiry date, absolute.
 *
 * Deliberately not `RelativeTime`, which counts elapsed time and renders a date in the
 * future as a negative age — an AWS credit good for another 200 days displayed as `-200d`.
 */
const expiryFormat = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const KIND_LABELS: Record<string, string> = {
  credit: "Credits",
  grant: "Grant",
  prize: "Prize",
  accelerator: "Accelerator",
  loan: "Loan / RBF",
  other: "Other",
};

export default async function FundingPage() {
  const { totals, rounds, nonDilutive, cash } = await loadFundingTotals();

  const hasDebt = totals.debtOutstandingUsd > 0;
  const composition = [
    { label: "Dilutive cash", count: totals.dilutiveCashReceivedUsd },
    { label: "Non-dilutive cash", count: totals.nonDilutiveCashReceivedUsd },
    { label: "Credits (active)", count: totals.inKindActiveUsd },
    ...(hasDebt ? [{ label: "Debt outstanding", count: totals.debtOutstandingUsd }] : []),
  ].filter((row) => row.count > 0);

  return (
    <>
      <AdminPageHeader
        title="Funding"
        subtitle="Everything we've raised — dilutive, non-dilutive, and in-kind."
      />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="In the bank"
            value={usd(totals.bankedUsd)}
            hint="cash received, all sources"
          />
          <MetricTile
            label="Non-dilutive"
            value={usd(totals.nonDilutiveCashReceivedUsd + totals.inKindActiveUsd)}
            hint="grants, prizes, credits"
          />
          <MetricTile
            label="Credits (active)"
            value={usd(totals.inKindActiveUsd)}
            tone="muted"
            hint="in-kind — never hits the bank"
          />
          <MetricTile
            label={hasDebt ? "Debt outstanding" : "Committed, not received"}
            value={usd(hasDebt ? totals.debtOutstandingUsd : totals.committedNotReceivedUsd)}
            tone={hasDebt ? "danger" : "muted"}
            hint={hasDebt ? "borrowed, still owed" : "signed, not wired"}
          />
        </div>

        {/*
          The headline number never appears without its own derivation on the same screen.
          Every line here is a number someone could otherwise reasonably assume is included
          in "total capital in" when it is not.
        */}
        <AdminPanel title="How the total is built">
          <dl className="space-y-0">
            <DefinitionRow label="Dilutive cash received">
              {usd(totals.dilutiveCashReceivedUsd)}
            </DefinitionRow>
            <DefinitionRow label="Non-dilutive cash received">
              {usd(totals.nonDilutiveCashReceivedUsd)}
            </DefinitionRow>
            <DefinitionRow label="= In the bank">
              <span className="font-medium text-foreground">{usd(totals.bankedUsd)}</span>
            </DefinitionRow>
            <DefinitionRow label="+ Credits still active">
              {usd(totals.inKindActiveUsd)}
            </DefinitionRow>
            <DefinitionRow label="= Total capital in">
              <span className="font-medium text-foreground">
                {usd(totals.totalCapitalInUsd)}
              </span>
            </DefinitionRow>
            {hasDebt && (
              <DefinitionRow label="− Debt outstanding">
                {usd(totals.debtOutstandingUsd)} · net {usd(totals.netOfDebtUsd)}
              </DefinitionRow>
            )}
            <DefinitionRow label="Memo · committed, not received">
              {usd(totals.committedNotReceivedUsd)} — excluded above
            </DefinitionRow>
            <DefinitionRow label="Memo · credits expired">
              {usd(totals.inKindExpiredUsd)} — excluded above
            </DefinitionRow>
          </dl>
        </AdminPanel>

        {composition.length > 0 && (
          <AdminPanel title="Composition">
            <RankedBars
              rows={composition.map((row) => ({
                label: row.label,
                count: row.count,
                valueLabel: usd(row.count),
                detail: `${((row.count / Math.max(1, totals.totalCapitalInUsd)) * 100).toFixed(0)}% of total capital in`,
              }))}
            />
          </AdminPanel>
        )}

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
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    {round.closedAt ? (
                      <>
                        closed <RelativeTime date={round.closedAt} />
                      </>
                    ) : (
                      `${usd(round.committedUsd)} / ${usd(round.targetUsd)}`
                    )}
                  </span>
                  <RoundStatusButton roundId={round.id} status={round.status} />
                </div>
              }
            >
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <MetricTile
                    label="Committed"
                    value={usd(round.committedUsd)}
                    hint="signed, wired or not"
                  />
                  <MetricTile
                    label="Received"
                    value={usd(round.receivedUsd)}
                    hint="actually in the bank"
                  />
                  <MetricTile
                    label="Progress"
                    value={`${round.progressPct.toFixed(0)}%`}
                    hint="of target, on commitments"
                  />
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
                        <Th>Committed</Th>
                        <Th>Received</Th>
                        <Th>Note</Th>
                        <Th />
                      </>
                    }
                  >
                    {round.investors.map((i) => (
                      <tr key={i.id} className="border-b border-border/40 last:border-b-0">
                        <Td>{i.name}</Td>
                        <Td numeric>{usd(i.amountUsd)}</Td>
                        <Td>
                          <RelativeTime date={i.committedAt} />
                        </Td>
                        <Td>
                          {i.receivedAt ? (
                            <RelativeTime date={i.receivedAt} />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </Td>
                        <Td className="text-muted-foreground">{i.note ?? "—"}</Td>
                        <Td>
                          <div className="flex items-center gap-1">
                            <MarkReceivedButton
                              investorId={i.id}
                              received={!!i.receivedAt}
                            />
                            <DeleteInvestorButton investorId={i.id} />
                          </div>
                        </Td>
                      </tr>
                    ))}
                  </AdminTable>
                )}
              </div>
            </AdminPanel>
          ))
        )}

        <AdminPanel title="Non-dilutive">
          <div className="space-y-4">
            <AddNonDilutiveForm />

            {nonDilutive.length === 0 ? (
              <EmptyState>
                No grants, prizes, credits or loans recorded yet.
              </EmptyState>
            ) : (
              <AdminTable
                head={
                  <>
                    <Th>Source</Th>
                    <Th>Kind</Th>
                    <Th>Form</Th>
                    <Th numeric>Amount</Th>
                    <Th>Awarded</Th>
                    <Th>Received</Th>
                    <Th>Expires</Th>
                    <Th />
                  </>
                }
              >
                {nonDilutive.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-b border-border/40 last:border-b-0 ${
                      row.expired ? "text-muted-foreground" : ""
                    }`}
                  >
                    <Td>{row.source}</Td>
                    <Td>{KIND_LABELS[row.kind] ?? row.kind}</Td>
                    <Td>{row.form === "in_kind" ? "In-kind" : "Cash"}</Td>
                    <Td numeric>
                      {usd(row.amountUsd)}
                      {row.repayable && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {" "}
                          · {usd(row.amountUsd - row.repaidUsd)} owed
                        </span>
                      )}
                    </Td>
                    <Td>
                      <RelativeTime date={row.awardedAt} />
                    </Td>
                    <Td>
                      {row.receivedAt ? (
                        <RelativeTime date={row.receivedAt} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </Td>
                    <Td>
                      {row.expiresAt ? (
                        <span className={row.expired ? "text-destructive" : undefined}>
                          {row.expired ? "expired" : expiryFormat.format(row.expiresAt)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        {row.repayable && (
                          <RepaymentForm
                            id={row.id}
                            repaidUsd={row.repaidUsd}
                            amountUsd={row.amountUsd}
                          />
                        )}
                        <DeleteNonDilutiveButton id={row.id} />
                      </div>
                    </Td>
                  </tr>
                ))}
              </AdminTable>
            )}
          </div>
        </AdminPanel>

        {/*
          Cash on hand and banked capital will never match, and the question "why?" is
          otherwise asked every time someone looks at this page. Answering it here is
          cheaper than re-deriving it each time.
        */}
        <AdminPanel title="Reconciliation">
          <dl className="space-y-0">
            <DefinitionRow label="Banked capital">{usd(totals.bankedUsd)}</DefinitionRow>
            <DefinitionRow label="Cash on hand">
              {cash ? (
                <>
                  {usd(cash.balanceUsd)} · as of <RelativeTime date={cash.asOf} />
                </>
              ) : (
                <span className="text-muted-foreground">
                  no snapshot yet — record one on Runway
                </span>
              )}
            </DefinitionRow>
            {cash && (
              <DefinitionRow
                label={
                  cash.balanceUsd < totals.bankedUsd ? "Spent since" : "Earned since"
                }
              >
                {usd(Math.abs(cash.balanceUsd - totals.bankedUsd))}
              </DefinitionRow>
            )}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            The gap is everything that has happened to the money since it arrived — spend,
            less revenue. Runway is the authority for cash on hand; funding is never added
            to it here, because the snapshot is a hand-asserted bank balance that already
            includes every wire that has landed.
          </p>
        </AdminPanel>
      </div>
    </>
  );
}
