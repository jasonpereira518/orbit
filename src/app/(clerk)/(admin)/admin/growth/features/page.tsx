import Link from "next/link";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MiniBars,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { GrowthTabs } from "@/components/admin/admin-tabs";
import { TimeSeriesChart } from "@/components/admin/growth-charts";
import {
  RANGES,
  capturesBySource,
  engagementDepth,
  formatDuration,
  importsByProvider,
  outreachByChannel,
  rangeBuckets,
  rangeDays,
  rangeGrain,
  topAccountsByTraffic,
  type Range,
} from "@/lib/admin-analytics";
import { depthTrend, featureAdoption } from "@/lib/admin-trends";
import { formatRate } from "@/lib/format-rate";
import { longLabel, shortLabel } from "@/lib/growth-range";
import { connectorUse } from "@/lib/product-metrics";
import { TrafficRangeLinks } from "../range-nav";

export const metadata = { title: "Admin · Growth · Features" };

/**
 * What signed-in accounts actually did, not just where they went.
 *
 * NONE OF THIS IS NEW TRACKING. Every row here is read out of a table a feature already
 * writes for its own reasons — an import job, a saved capture, a sent outreach message, a
 * chat message, a hand-confirmed merge. `page_views` covers the two rows below that leave
 * no other trace (`/graph`, `/upgrade`) — same cookieless pipeline as Acquisition, same bot
 * filter, same visitor-day caveat where it applies.
 *
 * This is depth, not the funnel. Acquisition and Activation answer "how many made it
 * through"; this answers "of the ones who did, what are they actually using" — which parts of
 * Orbit are load-bearing, and which are decoration.
 */
const IMPORT_LABELS: Record<string, string> = {
  linkedin_connections: "LinkedIn connections",
  linkedin_messages: "LinkedIn messages",
  whatsapp_chat: "WhatsApp chats",
  imessage_chat: "iMessage chats",
  google_contacts: "Google contacts",
  outlook_contacts: "Outlook contacts",
  contacts_file: "Contacts file",
  calendar_ics: "Calendar (ICS)",
  calendar_csv: "Calendar (CSV)",
  gmail_recruiter_scan: "Gmail recruiter scan",
};

const CAPTURE_LABELS: Record<string, string> = {
  messy: "Notes",
  voice: "Voice",
  meeting: "Meeting",
  scan: "Scan",
  phone: "Phone handoff",
};

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  linkedin: "LinkedIn",
  sms: "SMS",
};

export default async function AdminFeaturesPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const params = await searchParams;
  const range: Range = RANGES.includes(params.range as Range)
    ? (params.range as Range)
    : "30d";
  const days = rangeDays(range);
  const grain = rangeGrain(range);
  const now = new Date();

  // Each panel degrades on its own: one failed query used to take the whole page down.
  // A failed tile shows "—", never a zero it did not measure.
  const [imports, captures, outreach, depth, adoption, trend, mcp, extension, accounts] =
    await Promise.all([
      importsByProvider(range).catch(() => []),
      capturesBySource(range).catch(() => []),
      outreachByChannel(range).catch(() => []),
      engagementDepth(range).catch(() => null),
      featureAdoption().catch(() => []),
      depthTrend(grain, rangeBuckets(range)).catch(() => []),
      connectorUse(now, "mcp", days).catch(() => null),
      connectorUse(now, "extension", days).catch(() => null),
      topAccountsByTraffic(range).catch(() => []),
    ]);

  const labels = trend.map((p) => shortLabel(p.bucketStart, grain));
  const titles = trend.map((p) => longLabel(p.bucketStart, grain));
  const ratio = (count: number, active: number) =>
    active > 0 ? Math.round((count / active) * 10) / 10 : 0;

  return (
    <>
      <AdminPageHeader
        title="Growth"
        subtitle={`What signed-in accounts did, over the last ${days} days.`}
      />

      <GrowthTabs />

      <div className="space-y-6">
        <TrafficRangeLinks base="/admin/growth/features" range={range} />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Chat questions asked" value={depth?.chatQueries ?? null} />
          <Tile
            label="Contacts merged by hand"
            value={depth?.manualMerges ?? null}
            note="button and review queue"
          />
          <Tile
            label="Graph opened"
            value={depth?.graphViews ?? null}
            note="accounts, not views"
          />
          <Tile
            label="Reached /upgrade"
            value={depth?.upgradePageViews ?? null}
            note="accounts · intent, not a completed purchase"
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* The one cross-account total that changes a decision: which parts of Orbit are
              load-bearing and which are decoration. All time, whatever the range. */}
          <AdminPanel title="Accounts that have used each feature">
            {adoption.length === 0 ? (
              <EmptyState>Feature adoption is unavailable.</EmptyState>
            ) : (
              <MiniBars rows={adoption.map(({ label, count }) => ({ label, count }))} />
            )}
          </AdminPanel>

          <AdminPanel title={`Connector and extension · ${days} days`}>
            {!mcp || !extension ? (
              <EmptyState>Connector use is unavailable.</EmptyState>
            ) : (
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
            )}
            <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground">
              Counted from product events, which start at the deploy that introduced them: zeros before that are
              “not measured”, not “nobody”.
            </p>
          </AdminPanel>
        </div>

        <AdminPanel title="Actions per active account">
          <TimeSeriesChart
            labels={labels}
            titles={titles}
            partialLast
            ariaLabel={`Actions per active account per ${grain}, by feature.`}
            emptyLabel="Nobody has done anything in this window."
            notes={trend.map((p) => [
              { label: "Active accounts", value: p.active.toLocaleString() },
              {
                label: "Actions",
                value: (p.captures + p.notes + p.chats + p.imports).toLocaleString(),
              },
            ])}
            plots={[
              {
                mark: "stacked",
                height: 200,
                decimals: 1,
                series: [
                  {
                    key: "captures",
                    label: "Captures",
                    color: "var(--series-1)",
                    values: trend.map((p) => ratio(p.captures, p.active)),
                  },
                  {
                    key: "notes",
                    label: "Notes logged",
                    color: "var(--series-2)",
                    values: trend.map((p) => ratio(p.notes, p.active)),
                  },
                  {
                    key: "chats",
                    label: "Chat messages",
                    color: "var(--series-3)",
                    values: trend.map((p) => ratio(p.chats, p.active)),
                  },
                  {
                    key: "imports",
                    label: "Imports",
                    color: "var(--series-4)",
                    values: trend.map((p) => ratio(p.imports, p.active)),
                  },
                ],
              },
            ]}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Deliberate actions only, each counted once: a capture&apos;s notes are not
            counted again as notes, synced and imported interactions are excluded, and AI
            calls (a side effect of these) are on Ops.
          </p>
        </AdminPanel>

        <AdminPanel title="Imports completed, by provider">
          {imports.length === 0 ? (
            <EmptyState>Nothing completed in this window yet.</EmptyState>
          ) : (
            <AdminTable label="Imports completed, by provider" minWidth="sm"
              head={
                <>
                  <Th>Provider</Th>
                  <Th numeric>Completed</Th>
                  <Th numeric>Contacts created</Th>
                  <Th numeric>Contacts updated</Th>
                </>
              }
            >
              {imports.map((row) => (
                <tr key={row.provider} className="border-b border-border/40">
                  <Td>{IMPORT_LABELS[row.provider] ?? row.provider}</Td>
                  <Td numeric>{row.count.toLocaleString()}</Td>
                  <Td numeric>{row.created.toLocaleString()}</Td>
                  <Td numeric>{row.updated.toLocaleString()}</Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>

        <AdminPanel title="Captures saved, by source">
          {captures.length === 0 ? (
            <EmptyState>Nothing saved in this window yet.</EmptyState>
          ) : (
            <AdminTable label="Captures saved, by source" minWidth="sm"
              head={
                <>
                  <Th>Source</Th>
                  <Th numeric>Saved</Th>
                  <Th numeric>Contacts created</Th>
                  <Th numeric>Contacts updated</Th>
                </>
              }
            >
              {captures.map((row) => (
                <tr key={row.source} className="border-b border-border/40">
                  <Td>{CAPTURE_LABELS[row.source] ?? row.source}</Td>
                  <Td numeric>{row.count.toLocaleString()}</Td>
                  <Td numeric>{row.created.toLocaleString()}</Td>
                  <Td numeric>{row.updated.toLocaleString()}</Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>

        <AdminPanel title="Outreach messages sent, by channel">
          {outreach.length === 0 ? (
            <EmptyState>Nothing sent in this window yet.</EmptyState>
          ) : (
            <AdminTable label="Outreach messages sent, by channel" minWidth="none"
              head={
                <>
                  <Th>Channel</Th>
                  <Th numeric>Sent</Th>
                </>
              }
            >
              {outreach.map((row) => (
                <tr key={row.channel} className="border-b border-border/40">
                  <Td>{CHANNEL_LABELS[row.channel] ?? row.channel}</Td>
                  <Td numeric>{row.count.toLocaleString()}</Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>

        {/*
          Deliberately NOT the same question as Retention's "active accounts", which counts
          who WROTE something across five tables. Somebody who opens Orbit every morning
          and reads without editing is invisible there and shows up here.
        */}
        <AdminPanel title="Most active accounts">
          {accounts.length === 0 ? (
            <EmptyState>No signed-in traffic recorded in this window.</EmptyState>
          ) : (
            <AdminTable label="Most active accounts"
              head={
                <>
                  <Th>Account</Th>
                  <Th numeric>Views</Th>
                  <Th numeric>Sessions</Th>
                  <Th numeric>Days seen</Th>
                  {/* The share of views whose exit beacon landed: a total from a thin
                      sample is not "how long they spent in Orbit". */}
                  <Th numeric>Measured time (of views)</Th>
                  <Th numeric>Last seen</Th>
                </>
              }
            >
              {accounts.map((a) => (
                <tr key={a.userId} className="border-b border-border/40">
                  <Td>
                    <Link
                      href={`/admin/users/${encodeURIComponent(a.userId)}`}
                      className="transition-colors duration-fast hover:text-primary"
                    >
                      {a.email ?? a.userId}
                    </Link>
                  </Td>
                  <Td numeric>{a.views.toLocaleString()}</Td>
                  <Td numeric>{a.sessions.toLocaleString()}</Td>
                  <Td numeric>{a.activeDays}</Td>
                  <Td numeric className="text-muted-foreground">
                    {formatDuration(a.totalDwellSeconds)}
                    <span className="ml-1 text-muted-foreground/60">
                      ({Math.round(a.dwellCoverage * 100)}%)
                    </span>
                  </Td>
                  <Td numeric className="text-muted-foreground">
                    {a.lastSeen ? <RelativeTime date={a.lastSeen} /> : "—"}
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>

        <AdminPanel title="How to read this">
          <ul className="space-y-2 py-1 text-sm text-muted-foreground">
            <li>
              <span className="text-foreground">None of this is new tracking.</span>{" "}
              Every row is read out of a table a feature already writes — an import job,
              a saved capture, a sent message, a chat message, a hand-confirmed merge.
              Only &ldquo;Graph opened&rdquo; and &ldquo;Reached /upgrade&rdquo; come from
              the same pageview pipeline as Acquisition, since those two actions leave
              no other record.
            </li>
            <li>
              <span className="text-foreground">Reached /upgrade is intent, not revenue.</span>{" "}
              It counts a signed-in visit to the checkout page from any CTA, whether or
              not a purchase followed — see Acquisition&apos;s funnel → Paid for the outcome.
            </li>
            <li>
              <span className="text-foreground">Contacts merged by hand excludes the automatic sweep.</span>{" "}
              It counts merges a person confirmed — the &ldquo;Merge into…&rdquo; button
              and the duplicate-review queue — and none the background matcher or an
              import made on its own.
            </li>
            <li>
              <span className="text-foreground">Orbit&apos;s own accounts are left out.</span>{" "}
              Admins and the showcase account are excluded from every count except
              outreach, whose messages carry no account to filter by. Imports and
              captures are dated by when they started.
            </li>
          </ul>
        </AdminPanel>
      </div>
    </>
  );
}

function Tile({
  label,
  value,
  note,
}: {
  label: string;
  value: number | null;
  note?: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-medium tabular-nums text-ink">
        {value == null ? "—" : value.toLocaleString()}
      </div>
      {note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}
