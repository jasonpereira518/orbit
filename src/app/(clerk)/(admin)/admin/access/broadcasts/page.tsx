import { Users } from "lucide-react";
import {
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
import { audienceCount, listBroadcasts } from "@/lib/broadcasts";
import { getSiteMode } from "@/lib/site-access";
import { AccessHeader } from "../access-header";

export const metadata = { title: "Admin · Broadcasts" };

/**
 * The "occasional note on what's new in Orbit" the landing page promises.
 *
 * Until this existed the interest list was write-only: two automated emails fired and there
 * was no way to send the thing actually promised. Composing and sending are separate steps
 * on purpose — see `BroadcastComposer`. Unsubscribed and converted counts live on the
 * Waitlist tab; the one number this page needs is how many a send would reach.
 */
export default async function AdminBroadcastsPage() {
  const [mode, audience, sent] = await Promise.all([
    getSiteMode({ fresh: true }),
    audienceCount(),
    listBroadcasts(25),
  ]);

  return (
    <>
      <AccessHeader mode={mode} subtitle="A note to everyone on the waitlist." />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <MetricTile
          label="Audience"
          value={audience}
          hint="Subscribed, and not already an account"
          icon={Users}
          tone="accent"
        />
      </div>

      <AdminPanel title="Compose" className="mb-6">
        <BroadcastComposer audienceSize={audience} />
      </AdminPanel>

      <AdminPanel title="Drafts and sent">
        {sent.length === 0 ? (
          <EmptyState>Nothing composed yet.</EmptyState>
        ) : (
          <AdminTable label="Drafts and sent"
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
                      audienceSize={audience}
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
