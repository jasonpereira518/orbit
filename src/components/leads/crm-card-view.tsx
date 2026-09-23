import Link from "next/link";
import { Building2, RefreshCw } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import type { CrmStatus } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

const PITCH =
  "Bring HubSpot in: your customers become work contacts, and your leads join this pipeline — ranked by who on your team knows them.";

function plural(n: number, one: string, many: string) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** The CRM card's words and buttons for one status. `pending` names the button that is busy. */
export function CrmCardView({
  status,
  pending,
  onConnect,
  onSync,
  onDisconnect,
}: {
  status: CrmStatus;
  pending: "connect" | "sync" | "disconnect" | null;
  onConnect: () => void;
  onSync: () => void;
  onDisconnect: () => void;
}) {
  const { connection, counts } = status;
  const canConnect = status.entitled && status.configured;

  if (!connection) {
    return (
      <Shell title="Connect your CRM" body={PITCH}>
        {!status.entitled ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted-foreground">HubSpot sync is on Orbit Pro and Lifetime.</span>
            <Link href="/upgrade" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              See plans
            </Link>
          </div>
        ) : !status.configured ? (
          <p className="text-sm text-muted-foreground">HubSpot isn’t set up on this server yet.</p>
        ) : (
          <Button type="button" disabled={pending !== null} onClick={onConnect}>
            {pending === "connect" ? "Opening HubSpot…" : "Connect HubSpot"}
          </Button>
        )}
      </Shell>
    );
  }

  if (connection.status === "needs_reauth") {
    return (
      <Shell title="HubSpot needs you to reconnect" body={connection.error ?? "HubSpot stopped accepting Orbit’s sign-in."}>
        <div className="flex flex-wrap gap-2">
          {canConnect ? (
            <Button type="button" disabled={pending !== null} onClick={onConnect}>
              {pending === "connect" ? "Opening HubSpot…" : "Reconnect HubSpot"}
            </Button>
          ) : null}
          <Button type="button" variant="outline" disabled={pending !== null} onClick={onDisconnect}>
            Disconnect
          </Button>
        </div>
      </Shell>
    );
  }

  const when = connection.syncing
    ? "Syncing now"
    : connection.lastSyncedAgo
      ? `Last synced ${connection.lastSyncedAgo}`
      : "The first sync starts within a few minutes";

  return (
    <Shell title={connection.label ? `HubSpot · ${connection.label}` : "HubSpot"} body={when}>
      {connection.error ? <p className="text-sm text-amber-700 dark:text-amber-400">{connection.error}</p> : null}
      {counts ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink">
          <span>
            {plural(counts.workContacts, "work contact", "work contacts")} · {counts.pipeline.toLocaleString()} in your pipeline
          </span>
          <Link href="/contacts?view=work" className="text-primary underline-offset-4 hover:underline">
            See work contacts
          </Link>
        </p>
      ) : null}
      {counts && counts.blocked > 0 ? (
        <p className="text-xs text-muted-foreground">
          {plural(counts.blocked, "customer didn’t fit your plan’s contact limit", "customers didn’t fit your plan’s contact limit")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {connection.demo ? (
          <span className="text-xs text-muted-foreground">Sample data — this demo connection doesn’t sync.</span>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled={pending !== null || connection.syncing} onClick={onSync}>
            <RefreshCw aria-hidden className={cn(pending === "sync" && "animate-spin motion-reduce:animate-none")} />
            {pending === "sync" ? "Syncing…" : "Sync now"}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" disabled={pending !== null} onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>
    </Shell>
  );
}

function Shell({ title, body, children }: { title: string; body: string; children: React.ReactNode }) {
  return (
    <section aria-label="Your CRM" className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
      <div className="flex gap-3">
        <div className="mt-0.5 h-9 w-9 shrink-0 rounded-full bg-primary/10 p-2 text-primary">
          <Building2 className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0">
          <h2 className="font-medium text-ink">{title}</h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">{body}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
