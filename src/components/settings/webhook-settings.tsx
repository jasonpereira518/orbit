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
import { useCallback, useEffect, useState, useTransition } from "react";
import { Copy, RefreshCw, Trash2, Webhook } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookEndpoints,
  retryWebhookEndpoint,
  type WebhookEndpointSummary,
} from "@/actions/webhook-endpoints";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection } from "@/components/settings/settings-section";
import { useConfirmFocus } from "@/components/settings/use-confirm-focus";
import { TOAST_COPY } from "@/lib/toast-copy";

const LOAD_TIMEOUT_MS = 12_000;
const TIMED_OUT = "orbit:timed-out";
/** The same line `api-settings.tsx` and `calendar-feed-settings.tsx` show; a shared helper is wanted. */
const LOAD_FAILED = "Couldn’t load this — try again?";

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

export function WebhookSettings() {
  const [endpoints, setEndpoints] = useState<WebhookEndpointSummary[] | null>(null);
  const [error, setError] = useState<"timeout" | "error" | null>(null);
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<string[]>(["contact.created"]);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const deleteFocus = useConfirmFocus(confirmingDelete);

  const load = useCallback(() => {
    setError(null);
    withTimeout(listWebhookEndpoints(), LOAD_TIMEOUT_MS)
      .then(setEndpoints)
      .catch((err: unknown) => {
        setEndpoints([]);
        setError(err instanceof Error && err.message === TIMED_OUT ? "timeout" : "error");
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
      if (result.verified) {
        toast.success("Webhook verified — it’s live");
      } else {
        // This used to tell the person to retry and give them no button, while
        // `retryWebhookEndpoint` already existed for exactly this.
        const endpointId = result.endpoint.id;
        toast.error(
          `Saved, but ${describeVerification(result.verificationError)} — retry once it’s reachable`,
          { action: { label: "Try again", onClick: () => onRetry(endpointId) } }
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

  return (
    <SettingsSection
      title="Webhooks"
      description="Have Orbit POST to your own endpoint — or a Zapier or Make hook — when something happens."
    >
      {revealedSecret ? (
        <div className="space-y-2 rounded-lg border border-primary/25 bg-primary/6 p-3">
          <p className="text-sm font-medium text-ink">Signing secret</p>
          <p className="text-xs text-muted-foreground">
            Shown once. Your receiver needs it to verify the{" "}
            <code className="font-mono">Orbit-Signature</code> header.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-muted px-2 py-1 font-mono text-xs">
              {revealedSecret}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(revealedSecret);
                  toast.success("Secret copied");
                } catch {
                  toast.error(TOAST_COPY.copyFailed);
                }
              }}
            >
              <Copy className="size-4" />
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRevealedSecret(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hooks.zapier.com/…"
          aria-label="Webhook URL"
        />
        <div className="flex flex-wrap gap-3">
          {EVENTS.map((event) => (
            <Label key={event.id} className="font-normal">
              <Checkbox
                checked={selected.includes(event.id)}
                onCheckedChange={() => toggle(event.id)}
              />
              {event.label}
            </Label>
          ))}
        </div>
        <Button size="sm" disabled={pending || !url.trim()} onClick={onCreate}>
          <Webhook className="size-4" />
          Add webhook
        </Button>
        <p className="text-xs text-muted-foreground">
          Orbit sends a signed test event straight away and only turns the webhook on if your
          endpoint answers. Must be an https:// address.
        </p>
      </div>

      <div className="space-y-2">
        {error ? (
          <ErrorState
            size="sm"
            title={LOAD_FAILED}
            description={
              error === "timeout" ? "The request took too long to answer." : "Something went wrong on our side."
            }
            onRetry={load}
          />
        ) : endpoints === null ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading your webhooks">
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-14 w-full rounded-lg" />
          </div>
        ) : endpoints.length === 0 ? (
          <EmptyState
            variant="plain"
            size="sm"
            title="No webhooks yet"
            description="Add an endpoint above and Orbit will send it a signed test event."
          />
        ) : (
          endpoints.map((endpoint) => (
            <div
              key={endpoint.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-subtle p-3"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-sm text-ink">{endpoint.url}</p>
                <p className="text-xs text-muted-foreground">
                  {endpoint.eventTypes.join(", ") || "no events"}
                </p>
                <p className="text-xs">
                  {endpoint.status === "active" ? (
                    <span className="text-muted-foreground">Active</span>
                  ) : endpoint.status === "pending" ? (
                    <span className="text-destructive">
                      Not verified — Orbit couldn’t reach it
                    </span>
                  ) : (
                    <span className="text-destructive">
                      Disabled{endpoint.disabledReason ? ` — ${endpoint.disabledReason}` : ""}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {endpoint.status === "active" ? null : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => onRetry(endpoint.id)}
                  >
                    <RefreshCw className="size-4" />
                    Try again
                  </Button>
                )}
                {confirmingDelete === endpoint.id ? (
                  <>
                    <span role="status" className="text-xs text-muted-foreground">
                      Orbit stops sending to it.
                    </span>
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
                  </>
                ) : (
                  <Button
                    ref={deleteFocus.triggerRef(endpoint.id)}
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmingDelete(endpoint.id)}
                    aria-label={`Remove ${endpoint.url}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </SettingsSection>
  );
}
