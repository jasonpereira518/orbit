import Link from "next/link";
import { Building2, RefreshCw } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import type { CrmConnectorId, CrmProviderStatus, CrmStatus } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

const PITCH =
  "Bring your CRM in: your customers become work contacts, and your leads join this pipeline — ranked by who on your team knows them.";

function plural(n: number, one: string, many: string) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** The button (or pair, for Salesforce) that names the action mid-flight. */
export type CrmPending = { action: "connect" | "sync" | "disconnect"; id: CrmConnectorId } | null;

/** The CRM card's words and buttons for one status. `pending` names the connector mid-flight. */
export function CrmCardView({
  status,
  pending,
  onConnect,
  onSync,
  onDisconnect,
}: {
  status: CrmStatus;
  pending: CrmPending;
  onConnect: (id: CrmConnectorId, opts?: { sandbox?: boolean }) => void;
  onSync: (id: CrmConnectorId) => void;
  onDisconnect: (id: CrmConnectorId) => void;
}) {
  const connected = status.providers.filter((p) => p.connection);
  const connectable = status.providers.filter((p) => !p.connection && p.configured);
  // Any action in flight disables every button; a provider's own sync disables only its own.
  const acting = pending !== null;

  if (connected.length === 0) {
    return (
      <Shell title="Connect your CRM" body={PITCH}>
        {!status.entitled ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted-foreground">CRM sync is on Orbit Pro and Lifetime.</span>
            <Link href="/upgrade" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              See plans
            </Link>
          </div>
        ) : connectable.length === 0 ? (
          <p className="text-sm text-muted-foreground">CRM sync isn’t set up on this server yet.</p>
        ) : (
          <ConnectButtons providers={connectable} pending={pending} disabled={acting} onConnect={onConnect} />
        )}
      </Shell>
    );
  }

  return (
    <div className="space-y-4">
      {connected.map((p) => (
        <ConnectedProvider
          key={p.id}
          provider={p}
          entitled={status.entitled}
          pending={pending}
          onConnect={onConnect}
          onSync={onSync}
          onDisconnect={onDisconnect}
        />
      ))}
      {status.entitled && connectable.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-border/70 px-5 py-3 text-sm">
          <span className="text-muted-foreground">Use another CRM too?</span>
          <ConnectButtons providers={connectable} pending={pending} disabled={acting} onConnect={onConnect} size="sm" />
        </div>
      ) : null}
    </div>
  );
}

function ConnectButtons({
  providers,
  pending,
  disabled,
  onConnect,
  size,
}: {
  providers: CrmProviderStatus[];
  pending: CrmPending;
  disabled: boolean;
  onConnect: (id: CrmConnectorId, opts?: { sandbox?: boolean }) => void;
  size?: "default" | "sm";
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {providers.map((p) => {
        const opening = pending?.action === "connect" && pending.id === p.id;
        return (
          <div key={p.id} className="flex flex-wrap items-center gap-2">
            <Button type="button" size={size} disabled={disabled} onClick={() => onConnect(p.id)}>
              {opening ? `Opening ${p.label}…` : `Connect ${p.label}`}
            </Button>
            {p.id === "salesforce" ? (
              <Button
                type="button"
                variant="ghost"
                size={size}
                disabled={disabled}
                aria-label="Use a sandbox for Salesforce"
                onClick={() => onConnect("salesforce", { sandbox: true })}
              >
                Use a sandbox
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ConnectedProvider({
  provider,
  entitled,
  pending,
  onConnect,
  onSync,
  onDisconnect,
}: {
  provider: CrmProviderStatus;
  entitled: boolean;
  pending: CrmPending;
  onConnect: (id: CrmConnectorId, opts?: { sandbox?: boolean }) => void;
  onSync: (id: CrmConnectorId) => void;
  onDisconnect: (id: CrmConnectorId) => void;
}) {
  const { id, label, connection, counts } = provider;
  if (!connection) return null;
  const canConnect = entitled && provider.configured;
  const connecting = pending?.action === "connect" && pending.id === id;
  const syncingPending = pending?.action === "sync" && pending.id === id;
  // This provider's buttons only: another provider syncing leaves these free.
  const busy = pending !== null || connection.syncing;
  // A sandbox reconnects to the sandbox login by default; the other environment is secondary.
  const sandbox = id === "salesforce" && connection.sandbox;
  const reconnectPrimary = () => onConnect(id, sandbox ? { sandbox: true } : undefined);
  const reconnectOther = () => onConnect(id, sandbox ? undefined : { sandbox: true });
  const otherText = sandbox ? "Reconnect production" : "Reconnect a sandbox";
  const otherAria = `${otherText} for ${label}`;
  const disconnectButton = (size?: "sm") => (
    <Button
      type="button"
      variant={size ? "ghost" : "outline"}
      size={size}
      disabled={busy}
      aria-label={`Disconnect ${label}`}
      onClick={() => onDisconnect(id)}
    >
      Disconnect
    </Button>
  );

  if (connection.status === "needs_reauth") {
    const title = `${label} needs you to reconnect`;
    return (
      <Shell title={title} ariaLabel={title} body={`${label} stopped accepting Orbit’s sign-in — reconnect to keep syncing`}>
        <div className="flex flex-wrap gap-2">
          {canConnect ? (
            <Button type="button" disabled={busy} onClick={reconnectPrimary}>
              {connecting ? `Opening ${label}…` : `Reconnect ${label}`}
            </Button>
          ) : null}
          {canConnect && id === "salesforce" ? (
            <Button type="button" variant="ghost" disabled={busy} aria-label={otherAria} onClick={reconnectOther}>
              {otherText}
            </Button>
          ) : null}
          {disconnectButton()}
        </div>
      </Shell>
    );
  }

  const when = connection.syncing
    ? "Syncing now"
    : connection.lastSyncedAgo
      ? `Last synced ${connection.lastSyncedAgo}`
      : "The first sync starts within a few minutes";
  const title = connection.label ? `${label} · ${connection.label}` : label;

  return (
    <Shell title={title} ariaLabel={title} body={when}>
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
        {connection.paused && canConnect ? (
          <Button type="button" size="sm" disabled={busy} onClick={reconnectPrimary}>
            {connecting ? `Opening ${label}…` : `Reconnect ${label}`}
          </Button>
        ) : null}
        {connection.paused && canConnect && id === "salesforce" ? (
          <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={otherAria} onClick={reconnectOther}>
            {otherText}
          </Button>
        ) : null}
        {connection.demo ? (
          <span className="text-xs text-muted-foreground">Sample data — this demo connection doesn’t sync.</span>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            aria-label={syncingPending ? `Syncing ${label}…` : `Sync ${label} now`}
            onClick={() => onSync(id)}
          >
            <RefreshCw aria-hidden className={cn(syncingPending && "animate-spin motion-reduce:animate-none")} />
            {syncingPending ? "Syncing…" : "Sync now"}
          </Button>
        )}
        {disconnectButton("sm")}
      </div>
    </Shell>
  );
}

function Shell({
  title,
  body,
  children,
  ariaLabel,
}: {
  title: string;
  body: string;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  return (
    <section aria-label={ariaLabel ?? "Your CRM"} className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
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
