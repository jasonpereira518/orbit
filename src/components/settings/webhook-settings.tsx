"use client";

/**
 * Where Orbit should POST when something happens.
 *
 * Same idiom as `api-settings.tsx` next to it — the `withTimeout` load guard, the once-only
 * secret reveal, the two-step destructive confirm — because these two panels are the same job
 * from the user's point of view and should not behave differently.
 *
 * The interaction that carries the design: adding an endpoint verifies it immediately, and
 * says so. A webhook that registers "successfully" and then silently never fires is the
 * classic way this feature wastes someone's afternoon, so the panel reports the handshake
 * result rather than a hopeful "saved".
 */
import { useCallback, useEffect, useState } from "react";
import { useGuardedTransition } from "@/lib/single-flight";
import { Copy, KeyRound, Plus, Trash2, Webhook } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  rotateWebhookEndpointSecret,
  listWebhookEndpoints,
  retryWebhookEndpoint,
  type WebhookEndpointSummary,
} from "@/actions/webhook-endpoints";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { AccountHeader, FeatureRow, LoadError } from "@/components/settings/account-page";
import { StatusDot } from "@/components/settings/integration-ui";
import { useConfirmFocus } from "@/components/settings/use-confirm-focus";
import { TOAST_COPY } from "@/lib/toast-copy";

const LOAD_TIMEOUT_MS = 12_000;
const TIMED_OUT = "orbit:timed-out";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(TIMED_OUT)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

const EVENTS = [
  { id: "contact.created", label: "A contact is added" },
  { id: "interaction.created", label: "An interaction is logged" },
  { id: "followup.due", label: "Someone is due a follow-up" },
] as const;

const EVENT_LABELS: Record<string, string> = Object.fromEntries(EVENTS.map((e) => [e.id, e.label]));

export function WebhookSettings() {
  const [endpoints, setEndpoints] = useState<WebhookEndpointSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<string[]>(["contact.created"]);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [pending, startTransition] = useGuardedTransition();
  const deleteFocus = useConfirmFocus(confirmingDelete);

  const load = useCallback(() => {
    setError(null);
    withTimeout(listWebhookEndpoints(), LOAD_TIMEOUT_MS)
      .then(setEndpoints)
      .catch((err: unknown) => {
        setEndpoints([]);
        setError(
          err instanceof Error && err.message === TIMED_OUT
            ? "That took too long. Check your connection and retry."
            : "Could not load your webhooks."
        );
      });
  }, []);

  useEffect(load, [load]);

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id]));
  }

  /**
   * Why a verification ping failed, in words a person configuring their own endpoint can
   * act on. The HTTP status is worth keeping — "answered HTTP 404" tells them exactly
   * what to fix. `verifyEndpoint`'s other path is a raw fetch error sliced to 200
   * characters (undici internals, resolver codes), which is not.
   */
  function describeVerification(error: string | null | undefined) {
    const status = error?.match(/^Endpoint answered HTTP (\d{3})$/)?.[1];
    return status
      ? `your endpoint answered HTTP ${status}`
      : "your endpoint didn’t respond";
  }

  function onCreate() {
    startTransition(async () => {
      const result = await createWebhookEndpoint(url.trim(), selected);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      // Shown once, like an API key: only the encrypted copy is kept, and the receiver needs
      // this value to validate the signature on every delivery.
      setRevealedSecret(result.secret);
      setUrl("");
      setAdding(false);
      if (result.verified) {
        toast.success("Webhook verified — it’s live");
      } else {
        // This used to tell the person to retry and give them no button, while
        // `retryWebhookEndpoint` already existed for exactly this.
        const endpointId = result.endpoint.id;
        toast.error(
          `Saved, but ${describeVerification(result.verificationError)} — retry once it’s reachable`,
          { action: { label: "Retry", onClick: () => onRetry(endpointId) } }
        );
      }
      load();
    });
  }

  function onDelete(id: string) {
    startTransition(async () => {
      await deleteWebhookEndpoint(id);
      setConfirmingDelete(null);
      toast.success("Webhook removed");
      load();
    });
  }

  function onRotate(id: string, url: string) {
    if (!window.confirm(`Replace the signing secret for ${url}? Deliveries are signed with the new one straight away, so update your receiver with it.`)) return;
    startTransition(async () => {
      const result = await rotateWebhookEndpointSecret(id);
      if (result.ok) {
        setRevealedSecret(result.secret);
        toast.success("New signing secret — copy it now");
      } else {
        toast.error(result.message);
      }
    });
  }

  function onRetry(id: string) {
    startTransition(async () => {
      const result = await retryWebhookEndpoint(id);
      if (result.ok) toast.success("Verified — the webhook is live");
      else {
        const reason = describeVerification(result.error);
        toast.error(`Still no luck — ${reason}`);
      }
      load();
    });
  }

  const showForm = adding || endpoints?.length === 0;
  const live = endpoints?.filter((e) => e.status === "active").length ?? 0;
  const stuck = (endpoints?.length ?? 0) - live;

  return (
    <div className="space-y-4">
      <AccountHeader
        name="Webhooks"
        mark={<Webhook className="text-ink" />}
        accountLine={null}
        status={
          endpoints === null
            ? { state: "off", detail: "Checking…", busy: true }
            : stuck > 0
              ? { state: "partial", detail: `${stuck} not live${live ? ` · ${live} live` : ""}` }
              : live > 0
                ? { state: "on", detail: `${live} live` }
                : { state: "off", detail: "None yet" }
        }
        primaryAction={
          showForm ? undefined : { label: "Add webhook", icon: <Plus aria-hidden />, onClick: () => setAdding(true) }
        }
        menuItems={[]}
      />
      <div aria-hidden className="h-1 rounded-full bg-muted" />

      {/* Shown once, like an API key: only the encrypted copy is kept, and the receiver
          needs this value to validate the signature on every delivery. */}
      {revealedSecret ? (
        <div className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 p-4">
          <p className="text-sm font-medium text-ink">
            Signing secret · shown once, for the <code className="font-mono">Orbit-Signature</code> header
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded border bg-background px-3 py-2 font-mono text-xs">
              {revealedSecret}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(revealedSecret);
                  toast.success("Secret copied");
                } catch {
                  toast.error(TOAST_COPY.copyFailed);
                }
              }}
            >
              <Copy aria-hidden />
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRevealedSecret(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      {showForm ? (
        <div className="space-y-3 rounded-xl border p-4">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://hooks.zapier.com/…"
            aria-label="Webhook URL"
          />
          <div className="flex flex-col gap-2">
            {EVENTS.map((event) => (
              <label key={event.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={selected.includes(event.id)} onCheckedChange={() => toggle(event.id)} />
                {event.label}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={pending || !url.trim()} onClick={onCreate}>
              Add webhook
            </Button>
            {endpoints?.length ? (
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            https only · Orbit sends a signed test and turns it on once your endpoint answers
          </p>
        </div>
      ) : null}

      {error ? (
        <LoadError what="webhooks" onRetry={load} />
      ) : endpoints === null ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading your webhooks">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : endpoints.length > 0 ? (
        <ul className="-my-1">
          {endpoints.map((endpoint) => (
            <FeatureRow
              key={endpoint.id}
              icon={<Webhook />}
              title={shortUrl(endpoint.url)}
              description={
                <>
                  <EndpointStatus status={endpoint.status} reason={endpoint.disabledReason} />
                  <span className="block text-xs">
                    {endpoint.eventTypes.map((id) => EVENT_LABELS[id] ?? id).join(" · ") || "No events"}
                  </span>
                </>
              }
              control={endpoint.status === "active" ? { kind: "none" } : { kind: "action", label: "Retry" }}
              disabled={pending}
              onAction={() => onRetry(endpoint.id)}
            >
              {confirmingDelete === endpoint.id ? (
                <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Orbit stops sending to it</span>
                  <Button
                    ref={deleteFocus.confirmRef(endpoint.id)}
                    size="sm"
                    variant="destructive"
                    disabled={pending}
                    onClick={() => onDelete(endpoint.id)}
                  >
                    Remove
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="-ml-2.5 flex flex-wrap items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    disabled={pending}
                    onClick={() => onRotate(endpoint.id, endpoint.url)}
                    aria-label={`Rotate the signing secret for ${endpoint.url}`}
                  >
                    <KeyRound aria-hidden />
                    Rotate secret
                  </Button>
                  <Button
                    ref={deleteFocus.triggerRef(endpoint.id)}
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => setConfirmingDelete(endpoint.id)}
                    aria-label={`Remove ${endpoint.url}`}
                  >
                    <Trash2 aria-hidden />
                    Remove
                  </Button>
                </div>
              )}
            </FeatureRow>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Host and path, without the scheme: the part a person recognises their endpoint by. */
function shortUrl(url: string) {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    const short = `${u.host}${path}`;
    return short.length > 48 ? `${short.slice(0, 47)}…` : short;
  } catch {
    return url;
  }
}

/** The same dot-and-words status line the account pages use. */
function EndpointStatus({ status, reason }: { status: string; reason?: string | null }) {
  const [state, detail] =
    status === "active"
      ? (["on", "Live"] as const)
      : status === "pending"
        ? (["partial", "Not verified · Orbit couldn’t reach it"] as const)
        : (["partial", `Off${reason ? ` · ${reason}` : ""}`] as const);
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <StatusDot status={{ state, detail }} />
      {detail}
    </span>
  );
}
