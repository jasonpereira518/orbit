import { AdminPageHeader, AdminPanel, AdminTable, EmptyState, MetricTile, Td, Th } from "@/components/admin/primitives";
import { formatRate } from "@/lib/format-rate";
import {
  channelBreakdown,
  cohortActivation,
  connectorUse,
  costSince,
  freeToPaid,
  gateConversion,
  weeklyActiveNetworkers,
  week2Return,
} from "@/lib/product-metrics";

export const metadata = { title: "Admin · Launch" };
export const dynamic = "force-dynamic";

const usdMicros = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/**
 * Launch: acquisition and conversion. Where people come from, whether they stick, whether the
 * connector and the extension are acquiring or only being installed, and what the limits do.
 *
 * Counts with their denominators throughout. Channel rows are small at this scale; the
 * percentage appears only past thirty, and until then a row reads "3 of 9".
 */
export default async function AdminLaunchPage() {
  const now = new Date();
  const [channels, activation, week2, mcp, extension, gates, paid, wan, cost] = await Promise.all([
    channelBreakdown(now, 28),
    cohortActivation(now, 14, 7),
    week2Return(now, 28, 14),
    connectorUse(now, "mcp", 28),
    connectorUse(now, "extension", 28),
    gateConversion(now, 28),
    freeToPaid(now),
    weeklyActiveNetworkers(now),
    costSince(now, 30),
  ]);
  const costPerActive = wan.mau > 0 ? (cost.aiMicros + cost.speechMicros) / wan.mau : null;

  return (
    <>
      <AdminPageHeader title="Launch" subtitle="Acquisition and conversion, last 28 days." />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Activated" value={formatRate(activation.activated, activation.size)} hint="finished their first week last week" />
        <MetricTile label="Back in week two" value={formatRate(week2.activated, week2.size)} hint="accounts two weeks old or more" />
        <MetricTile
          label="Free to paid"
          value={formatRate(paid.paid, paid.eligible)}
          hint={
            paid.paid >= 5 && paid.medianDaysToPay !== null
              ? `activated accounts a month old · median ${paid.medianDaysToPay} days to pay`
              : "activated accounts a month old · median shown from five payers"
          }
        />
        <MetricTile
          label="Cost per active account"
          value={costPerActive === null ? "—" : usdMicros(costPerActive)}
          hint="managed AI and voice, 30 days, over the month's active accounts"
        />
      </div>

      <AdminPanel title="Sign-ups by channel">
        {channels.length === 0 ? (
          <EmptyState>No sign-ups in this window.</EmptyState>
        ) : (
          <AdminTable
            label="Sign-ups by channel"
            minWidth="sm"
            head={
              <>
                <Th>First touch</Th>
                <Th numeric>Sign-ups</Th>
                <Th numeric>Activated</Th>
              </>
            }
          >
            {channels.map((c) => (
              <tr key={c.channel} className="border-b border-border/40 last:border-b-0">
                <Td>{c.channel}</Td>
                <Td numeric>{c.signups}</Td>
                <Td numeric>{c.matured === 0 ? "—" : formatRate(c.activated, c.matured)}</Td>
              </tr>
            ))}
          </AdminTable>
        )}
        <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground">
          Invited accounts carry the waitlist row&apos;s first touch. “unattributed” is an account that never rendered the app (API
          or connector only); it is not the same as “direct”.
        </p>
      </AdminPanel>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <AdminPanel title="Connector and extension · 28 days">
          <AdminTable
            label="Connector and extension"
            minWidth="sm"
            head={
              <>
                <Th>Surface</Th>
                <Th numeric>Connected</Th>
                <Th numeric>Used it</Th>
                <Th numeric>Back this week</Th>
              </>
            }
          >
            <tr className="border-b border-border/40">
              <Td>MCP (Claude, ChatGPT)</Td>
              <Td numeric>{mcp.connected}</Td>
              <Td numeric>{formatRate(mcp.withCall, mcp.connected)}</Td>
              <Td numeric>{formatRate(mcp.returning, mcp.withCall)}</Td>
            </tr>
            <tr>
              <Td>Chrome extension</Td>
              <Td numeric>{extension.connected}</Td>
              <Td numeric>{formatRate(extension.withCall, extension.connected)}</Td>
              <Td numeric>{formatRate(extension.returning, extension.withCall)}</Td>
            </tr>
          </AdminTable>
          <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground">
            Counted from product events, which start at the deploy that introduced them: zeros before that are “not measured”,
            not “nobody”.
          </p>
        </AdminPanel>

        <AdminPanel title="Limits hit, and what followed">
          <p className="py-1 text-sm">
            <span className="text-2xl tabular-nums">{gates.accounts}</span>{" "}
            <span className="text-muted-foreground">
              accounts met a limit · {gates.converted} paid within a week
            </span>
          </p>
          {gates.byFeature.length === 0 ? (
            <EmptyState>No limits hit in this window.</EmptyState>
          ) : (
            <AdminTable
              label="Limits by feature"
              minWidth="sm"
              head={
                <>
                  <Th>Limit</Th>
                  <Th numeric>Accounts</Th>
                  <Th numeric>Paid in a week</Th>
                </>
              }
            >
              {gates.byFeature.map((g) => (
                <tr key={g.feature} className="border-b border-border/40 last:border-b-0">
                  <Td>{g.feature}</Td>
                  <Td numeric>{g.accounts}</Td>
                  <Td numeric>{formatRate(g.converted, g.accounts)}</Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>
      </div>
    </>
  );
}
