import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  Td,
  Th,
} from "@/components/admin/primitives";
import { TrafficTabs } from "@/components/admin/traffic-tabs";
import {
  RANGES,
  capturesBySource,
  engagementDepth,
  importsByProvider,
  outreachByChannel,
  rangeDays,
  type Range,
} from "@/lib/admin-analytics";

export const metadata = { title: "Admin · Engagement" };

/**
 * What signed-in accounts actually did, not just where they went.
 *
 * NONE OF THIS IS NEW TRACKING. Every row here is read out of a table a feature already
 * writes for its own reasons — an import job, a saved capture, a sent outreach message, a
 * chat message, a hand-confirmed merge. `page_views` covers the two rows below that leave
 * no other trace (`/graph`, `/upgrade`) — same cookieless pipeline as `/admin/analytics`,
 * same bot filter, same visitor-day caveat where it applies.
 *
 * This is depth, not the funnel. `/admin/analytics/funnel` answers "how many made it
 * through"; this answers "of the ones who did, what are they actually using".
 */
const IMPORT_LABELS: Record<string, string> = {
  linkedin_connections: "LinkedIn connections",
  linkedin_messages: "LinkedIn messages",
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

export default async function AdminEngagementPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const params = await searchParams;
  const range: Range = RANGES.includes(params.range as Range)
    ? (params.range as Range)
    : "30d";
  const days = rangeDays(range);

  const [imports, captures, outreach, depth] = await Promise.all([
    importsByProvider(range),
    capturesBySource(range),
    outreachByChannel(range),
    engagementDepth(range),
  ]);

  const rangeLink = (value: Range) => (
    <a
      key={value}
      href={`/admin/analytics/engagement${value === "30d" ? "" : `?range=${value}`}`}
      className={
        range === value
          ? "text-primary"
          : "text-muted-foreground hover:text-foreground"
      }
    >
      {value === "7d" ? "7 days" : value === "30d" ? "30 days" : "90 days"}
    </a>
  );

  return (
    <>
      <AdminPageHeader
        title="Engagement"
        subtitle={`What signed-in accounts did, over the last ${days} days.`}
      />

      <TrafficTabs />

      <div className="space-y-6">
        <div className="flex items-center gap-3 text-xs">
          {rangeLink("7d")}
          <span className="text-muted-foreground/40">·</span>
          {rangeLink("30d")}
          <span className="text-muted-foreground/40">·</span>
          {rangeLink("90d")}
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Chat questions asked" value={depth.chatQueries} />
          <Tile label="Contacts merged by hand" value={depth.manualMerges} />
          <Tile label="Graph opened" value={depth.graphViews} />
          <Tile
            label="Reached /upgrade"
            value={depth.upgradePageViews}
            note="intent, not a completed purchase"
          />
        </div>

        <AdminPanel title="Imports completed, by provider">
          {imports.length === 0 ? (
            <EmptyState>Nothing completed in this window yet.</EmptyState>
          ) : (
            <AdminTable minWidth="sm"
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
            <AdminTable minWidth="sm"
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
            <AdminTable minWidth="none"
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

        <AdminPanel title="How to read this">
          <ul className="space-y-2 py-1 text-sm text-muted-foreground">
            <li>
              <span className="text-foreground">None of this is new tracking.</span>{" "}
              Every row is read out of a table a feature already writes — an import job,
              a saved capture, a sent message, a chat message, a hand-confirmed merge.
              Only &ldquo;Graph opened&rdquo; and &ldquo;Reached /upgrade&rdquo; come from
              the same pageview pipeline as the Traffic tab, since those two actions leave
              no other record.
            </li>
            <li>
              <span className="text-foreground">Reached /upgrade is intent, not revenue.</span>{" "}
              It counts a signed-in visit to the checkout page from any CTA, whether or
              not a purchase followed — see Conversion → Paid for the outcome.
            </li>
            <li>
              <span className="text-foreground">Contacts merged by hand excludes the automatic sweep.</span>{" "}
              Only merges made from the &ldquo;Merge into…&rdquo; button on a
              contact&apos;s own page — the one action here with a reason string that
              can&apos;t also mean &ldquo;the background matcher decided this for
              you&rdquo;.
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
  value: number;
  note?: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-medium tabular-nums text-ink">
        {value.toLocaleString()}
      </div>
      {note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}
