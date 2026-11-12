import Link from "next/link";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  AdminTr,
  EmptyState,
  MetricTile,
  Td,
  Th,
  TrendTable,
} from "@/components/admin/primitives";
import { MoneyTabs } from "@/components/admin/admin-tabs";
import { USAGE_EVENT_RETENTION_DAYS } from "@/lib/admin-health";
import {
  ALLOWANCES,
  ALLOWANCE_LABELS,
  loadAdminUsage,
  totalsByPlan,
  type Allowance,
  type Meter,
} from "@/lib/admin-usage";
import { PLAN_SHORT_LABELS } from "@/lib/plans/plan-config";

export const metadata = { title: "Admin · Money · Usage" };

/** Rows in the per-account table: the fullest accounts are the ones worth reading. */
const ACCOUNT_ROWS = 100;

const MONTH = new Intl.DateTimeFormat("en", { month: "short", year: "2-digit", timeZone: "UTC" });
const LONG_MONTH = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" });

function amount(a: Allowance, n: number): string {
  if (a === "meeting" || a === "shortform") return `${(n / 3600).toFixed(1)}h`;
  return Math.round(n).toLocaleString("en");
}

function meterText(a: Allowance, m: Meter): string {
  return m.limit === null ? `${amount(a, m.used)} · no cap` : `${amount(a, m.used)} / ${amount(a, m.limit)}`;
}

/** Percent of the cap, or null when there is no cap to compare with. */
function pct(m: Meter): number | null {
  if (m.limit === null) return null;
  if (m.limit === 0) return m.used > 0 ? Infinity : null;
  return (m.used / m.limit) * 100;
}

function PctText({ m }: { m: Meter }) {
  const p = pct(m);
  if (p === null) return null;
  return (
    <span className={p >= 100 ? "text-destructive" : p >= 90 ? "text-accent-foreground" : "text-muted-foreground"}>
      {" "}
      ({p === Infinity ? "over" : `${Math.round(p)}%`})
    </span>
  );
}

/**
 * How much of each plan allowance accounts have used: this period across everyone, per account
 * against its own cap, and month by month. Read-only; figures come from the tables the gates
 * read (`src/lib/admin-usage.ts`).
 */
export default async function MoneyUsagePage() {
  const { rows, totals, trend, monthStart } = await loadAdminUsage();
  // Every account as one bucket, for the headline tiles.
  const [all] = totalsByPlan(rows.map((r) => ({ ...r, plan: "free" as const })));
  const atCap = (a: Allowance) => rows.filter((r) => (pct(r.meters[a]) ?? 0) >= 100).length;
  const busy = rows.filter((r) => r.peak > 0).slice(0, ACCOUNT_ROWS);

  return (
    <>
      <AdminPageHeader
        title="Usage"
        subtitle={`How much of each plan allowance accounts have used, ${LONG_MONTH.format(monthStart)} so far`}
      />
      <MoneyTabs />

      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {ALLOWANCES.map((a) => {
            const m = all?.meters[a] ?? { used: 0, limit: 0 };
            const p = pct(m);
            const capped = atCap(a);
            return (
              <MetricTile
                key={a}
                label={ALLOWANCE_LABELS[a]}
                value={amount(a, m.used)}
                tone={capped > 0 ? "danger" : "default"}
                hint={`${m.limit === null ? "some plans uncapped" : `of ${amount(a, m.limit)} granted`}${
                  p === null || p === Infinity ? "" : ` · ${Math.round(p)}%`
                } · ${capped} at cap`}
              />
            );
          })}
        </div>

        <AdminPanel title="This period, by plan">
          {totals.length === 0 ? (
            <EmptyState>No accounts yet.</EmptyState>
          ) : (
            <AdminTable
              label="This period, by plan"
              head={
                <>
                  <Th>Plan</Th>
                  <Th numeric>Accounts</Th>
                  {ALLOWANCES.map((a) => (
                    <Th key={a} numeric>
                      {ALLOWANCE_LABELS[a]}
                    </Th>
                  ))}
                </>
              }
            >
              {totals.map((t) => (
                <AdminTr key={t.plan}>
                  <Td>{PLAN_SHORT_LABELS[t.plan]}</Td>
                  <Td numeric>{t.accounts}</Td>
                  {ALLOWANCES.map((a) => (
                    <Td key={a} numeric>
                      {meterText(a, t.meters[a])}
                      <PctText m={t.meters[a]} />
                    </Td>
                  ))}
                </AdminTr>
              ))}
            </AdminTable>
          )}
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Used against granted, summed over each plan&apos;s accounts. Credits are this cycle&apos;s
            allowance grant (its own billing period; packs and the starter grant are not
            allowances); an account with no grant yet has not used AI this cycle and counts its
            plan&apos;s full allowance. Speech and enrichment run on the UTC calendar month.
            Contacts are the current count against the cap. Limits include any override set on
            the{" "}
            <Link href="/admin/product/plans" className="underline hover:text-primary">
              plan table
            </Link>
            . Internal and tester accounts are left out.
          </p>
        </AdminPanel>

        <AdminPanel title="Accounts nearest their cap">
          {busy.length === 0 ? (
            <EmptyState>No account has used any allowance this period.</EmptyState>
          ) : (
            <AdminTable
              label="Accounts nearest their cap"
              head={
                <>
                  <Th>Account</Th>
                  <Th>Plan</Th>
                  <Th numeric>Fullest</Th>
                  {ALLOWANCES.map((a) => (
                    <Th key={a} numeric>
                      {ALLOWANCE_LABELS[a]}
                    </Th>
                  ))}
                </>
              }
            >
              {busy.map((r) => (
                <AdminTr key={r.userId}>
                  <Td>
                    <Link href={`/admin/users/${encodeURIComponent(r.userId)}`} className="hover:text-primary">
                      {r.userId}
                    </Link>
                  </Td>
                  <Td>{PLAN_SHORT_LABELS[r.plan]}</Td>
                  <Td numeric>
                    <span className={r.peak >= 1 ? "text-destructive" : undefined}>
                      {r.peak === Infinity ? "over" : `${Math.round(r.peak * 100)}%`}
                    </span>
                  </Td>
                  {ALLOWANCES.map((a) => (
                    <Td key={a} numeric className={r.meters[a].used === 0 ? "text-muted-foreground" : undefined}>
                      {meterText(a, r.meters[a])}
                      <PctText m={r.meters[a]} />
                    </Td>
                  ))}
                </AdminTr>
              ))}
            </AdminTable>
          )}
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Each account against its own effective limit, sorted by its fullest capped allowance;
            &ldquo;over&rdquo; means use against a cap of zero. Accounts with no use are left out
            {busy.length === ACCOUNT_ROWS ? `, and only the ${ACCOUNT_ROWS} fullest are shown` : ""}.
          </p>
        </AdminPanel>

        <AdminPanel title="Last 12 months">
          <TrendTable
            label="Last 12 months"
            columns={["AI credits", "Meeting hrs", "Short-form hrs", "Enrichments", "Contacts added"]}
            rows={[...trend].reverse().map((p) => ({
              period: MONTH.format(new Date(`${p.month}-01T00:00:00Z`)),
              values: [
                Math.round(p.credits),
                Math.round((p.meeting / 3600) * 10) / 10,
                Math.round((p.shortform / 3600) * 10) / 10,
                p.enrichment,
                p.contacts,
              ],
            }))}
          />
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            From the same tables, newest first: allowance credits by the month each cycle began,
            speech and contacts by when they were recorded, enrichment by its month. These tables
            keep their history; <code>usage_events</code> does not — it keeps{" "}
            {USAGE_EVENT_RETENTION_DAYS} days, so the AI cost trend on{" "}
            <Link href="/admin/billing/costs" className="underline hover:text-primary">
              Costs
            </Link>{" "}
            is shorter than this one.
          </p>
        </AdminPanel>
      </div>
    </>
  );
}
