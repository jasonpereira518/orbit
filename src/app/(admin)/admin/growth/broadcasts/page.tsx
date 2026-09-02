import Link from "next/link";
import { Users } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { BroadcastComposer } from "@/components/admin/broadcast-composer";
import { BroadcastRowActions } from "@/components/admin/broadcast-actions";
import { audienceFor, listBroadcasts } from "@/lib/broadcasts";
import { getInterestListSummary } from "@/lib/admin-interest-list";

export const metadata = { title: "Admin · Broadcasts" };

/**
 * The "occasional note on what's new in Orbit" the landing page promises.
 *
 * Until this existed the interest list was write-only: two automated emails fired and there
 * was no way to send the thing actually promised. Composing and sending are separate steps
 * on purpose — see `BroadcastComposer`.
 */
export default async function AdminBroadcastsPage() {
  const [summary, audience, sent] = await Promise.all([
    getInterestListSummary(),
    audienceFor(),
    listBroadcasts(25),
  ]);

  return (
    <>
      <AdminPageHeader
        title="Broadcasts"
        subtitle={
          <>
            A note to everyone on the interest list.{" "}
            <Link
              href="/admin/growth/interest-list"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Back to the list
            </Link>
          </>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <MetricTile
          label="Audience"
          value={audience.length}
          hint="Subscribed, and not already an account"
          icon={Users}
          tone="accent"
        />
        <MetricTile
          label="Unsubscribed"
          value={summary.unsubscribed}
          hint="Never included in a send"
          tone="muted"
        />
        <MetricTile
          label="Converted"
          value={summary.converted}
          hint="Excluded — they already have an account"
          tone="muted"
        />
      </div>

      <AdminPanel title="Compose" className="mb-6">
        <BroadcastComposer audienceSize={audience.length} />
      </AdminPanel>

      <AdminPanel title="Drafts and sent">
        {sent.length === 0 ? (
          <EmptyState>Nothing composed yet.</EmptyState>
        ) : (
          <AdminTable
            head={
              <>
                <Th>Subject</Th>
                <Th>Status</Th>
                <Th numeric>Sent</Th>
                <Th numeric>Failed</Th>
                <Th>When</Th>
                <Th className="text-right">Actions</Th>
              </>
            }
          >
            {sent.map((row) => {
              const remaining = Math.max(0, row.recipientCount - row.sentCount);
              return (
                <tr key={row.id} className="border-b border-border/40 last:border-0">
                  <Td className="font-medium text-ink">{row.subject}</Td>
                  <Td>
                    {row.status === "sent" ? (
                      <span className="text-muted-foreground">Sent</span>
                    ) : row.status === "sending" ? (
                      <span className="text-accent-foreground">
                        Partly sent — {remaining} left
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Draft</span>
                    )}
                  </Td>
                  <Td numeric>{row.sentCount}</Td>
                  <Td
                    numeric
                    className={row.failedCount > 0 ? "text-destructive" : undefined}
                  >
                    {row.failedCount}
                  </Td>
                  <Td className="text-muted-foreground">
                    <RelativeTime date={row.sentAt ?? row.createdAt} /> ago
                  </Td>
                  <Td>
                    <BroadcastRowActions
                      id={row.id}
                      subject={row.subject}
                      status={row.status}
                      audienceSize={audience.length}
                      remaining={remaining}
                    />
                  </Td>
                </tr>
              );
            })}
          </AdminTable>
        )}
      </AdminPanel>
    </>
  );
}
