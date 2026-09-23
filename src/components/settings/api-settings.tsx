"use client";

/**
 * API keys, the MCP endpoint, and where to point Zapier.
 *
 * Modelled on `calendar-feed-settings.tsx`, including its `withTimeout` guard: the failure
 * seen in production for that panel was a *hang* rather than a rejection, so a plain `.catch()`
 * never fired and the panel sat on "Loading…" forever. Racing a timer turns that into
 * something the user can see and retry.
 *
 * The one interaction rule that matters here: a freshly created key is shown once and never
 * again. That is a consequence of storing only its hash, and the UI has to make it obvious
 * rather than letting someone close the panel and lose it.
 */
import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { formatDistanceToNow } from "date-fns";
import { Copy, KeyRound, Plug, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeySummary,
  type CreatedApiKey,
} from "@/actions/api-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection } from "@/components/settings/settings-section";
import { useConfirmFocus } from "@/components/settings/use-confirm-focus";
import { friendlyError } from "@/lib/errors";
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

async function copy(value: string, what: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${what} copied`);
  } catch {
    toast.error(TOAST_COPY.copyFailed);
  }
}

/** The connector URL is derived from wherever Orbit is being served, so a preview domain
 * hands out its own URL rather than production's. */
const subscribeNever = () => () => {};
const getOriginSnapshot = () => `${window.location.origin}/api/mcp`;

export function ApiSettings() {
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [allowWrite, setAllowWrite] = useState(true);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const revokeFocus = useConfirmFocus(confirmingRevoke);
  // `useSyncExternalStore` rather than state-in-an-effect: the origin never changes, so there
  // is nothing to subscribe to, and the server snapshot is null because the server has no
  // `window` — which is exactly the hydration-safe shape this hook exists to express.
  const mcpUrl = useSyncExternalStore(subscribeNever, getOriginSnapshot, () => null);

  // Deliberately does not clear the error synchronously: doing so inside the mount effect
  // triggers a cascading render, and clearing it on success reads the same to the user.
  const load = useCallback(() => {
    withTimeout(listApiKeys(), LOAD_TIMEOUT_MS).then(
      (rows) => {
        setKeys(rows);
        setError(null);
      },
      (err: Error) => {
        setKeys([]);
        setError(
          err.message === TIMED_OUT
            ? "Took too long to load. Try again."
            : "Could not load your keys."
        );
      }
    );
  }, []);

  useEffect(load, [load]);

  function onCreate(kind: "api" | "mcp_url") {
    startTransition(async () => {
      try {
        const result = await createApiKey(
          name || (kind === "mcp_url" ? "MCP connector" : "API key"),
          allowWrite ? ["read", "write"] : ["read"],
          kind
        );
        if (!result.ok) {
          // A paywall, not a fault. Say what it is and where to go, rather than "something
          // went wrong" — the message is carried in the result precisely so this can.
          setBlocked(result.message);
          return;
        }
        setBlocked(null);
        setCreated(result);
        setName("");
        load();
      } catch (err) {
        toast.error(
          friendlyError(err, "Couldn’t create the key — try again?")
        );
      }
    });
  }

  function onRevoke(id: string) {
    startTransition(async () => {
      try {
        await revokeApiKey(id);
        setConfirmingRevoke(null);
        toast.success("Key revoked");
        load();
      } catch {
        toast.error("Couldn’t revoke that key — try again?");
      }
    });
  }

  return (
    <SettingsSection
      title="API and connectors"
      description="Use Orbit from Claude or ChatGPT, or connect it to Zapier, Make and n8n. Keys act as you, so treat them like a password."
    >
      {/* Connect an assistant. First, because it is what most people come here for. */}
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <Plug className="size-4" aria-hidden />
          <p className="text-sm font-medium">Connect Claude or ChatGPT</p>
        </div>
        <p className="text-muted-foreground text-xs">
          Add this as a custom connector, then sign in to Orbit when it asks. No key to copy,
          and you can disconnect it from your assistant at any time.
        </p>
        <div className="flex items-center gap-2">
          <code className="bg-background flex-1 overflow-x-auto rounded border px-3 py-2 font-mono text-xs">
            {mcpUrl ?? "…"}
          </code>
          <Button
            size="sm"
            variant="secondary"
            aria-label="Copy connector URL"
            disabled={!mcpUrl}
            onClick={() => mcpUrl && copy(mcpUrl, "Connector URL")}
          >
            <Copy className="size-4" />
          </Button>
        </div>
        <ol className="text-muted-foreground list-decimal space-y-1 pl-4 text-xs">
          <li>In Claude: Settings → Connectors → Add custom connector.</li>
          <li>In ChatGPT: Settings → Connectors → Add.</li>
          <li>Paste the URL, then sign in to Orbit on the page that opens.</li>
        </ol>
      </div>

      {/* A new key, shown once. */}
      {created ? (
        <div className="border-primary/40 bg-primary/5 space-y-3 rounded-lg border p-4">
          <p className="text-sm font-medium">
            Copy this now — it will not be shown again.
          </p>
          <p className="text-muted-foreground text-xs">
            Orbit stores only a hash of the key, so it cannot be recovered or re-displayed. If
            you lose it, revoke it and create another.
          </p>
          <div className="flex items-center gap-2">
            <code className="bg-background flex-1 overflow-x-auto rounded border px-3 py-2 font-mono text-xs">
              {created.mcpUrl ?? created.token}
            </code>
            <Button
              size="sm"
              variant="secondary"
              aria-label={created.mcpUrl ? "Copy MCP URL" : "Copy key"}
              onClick={() => copy(created.mcpUrl ?? created.token, "Key")}
            >
              <Copy className="size-4" />
            </Button>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
            Done
          </Button>
        </div>
      ) : null}

      {blocked ? (
        <div className="bg-muted/40 space-y-2 rounded-lg border p-4">
          <p className="text-sm">{blocked}</p>
          <a
            href="/upgrade"
            className="bg-primary text-primary-foreground inline-flex h-8 items-center rounded-md px-3 text-sm font-medium"
          >
            See plans
          </a>
        </div>
      ) : null}

      {/* Create */}
      <div className="space-y-3 rounded-lg border p-4">
        <label className="text-sm font-medium" htmlFor="api-key-name">
          Create a key
        </label>
        <Input
          id="api-key-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="What is it for? e.g. Zapier"
          maxLength={80}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allowWrite}
            onChange={(e) => setAllowWrite(e.target.checked)}
          />
          Allow this key to add contacts and log interactions
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={pending} onClick={() => onCreate("api")}>
            <KeyRound className="size-4" />
            API key
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Use an API key for Zapier, Make, n8n, or the command line. Claude and ChatGPT do not
          need one — connect them above and sign in instead.
        </p>
      </div>

      {/* Existing */}
      <div className="space-y-2">
        {error ? (
          <div className="text-sm">
            <p className="text-destructive">{error}</p>
            <Button size="sm" variant="ghost" onClick={load}>
              Retry
            </Button>
          </div>
        ) : keys === null ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading your keys">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : keys.length === 0 ? (
          <p className="text-muted-foreground text-sm">No keys yet.</p>
        ) : (
          keys.map((key) => (
            <div
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{key.name}</p>
                <p className="text-muted-foreground font-mono text-xs">
                  {key.prefix}…
                  {key.scopes.includes("write") ? " · read and write" : " · read only"}
                </p>
                <p className="text-muted-foreground text-xs">
                  {key.lastUsedAt
                    ? `Last used ${formatDistanceToNow(new Date(key.lastUsedAt), { addSuffix: true })}`
                    : "Never used"}
                </p>
              </div>
              {confirmingRevoke === key.id ? (
                <div className="flex items-center gap-2">
                  <span role="status" className="text-muted-foreground text-xs">
                    Anything using it stops working.
                  </span>
                  <Button
                    ref={revokeFocus.confirmRef(key.id)}
                    size="sm"
                    variant="destructive"
                    disabled={pending}
                    onClick={() => onRevoke(key.id)}
                  >
                    Revoke
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingRevoke(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  ref={revokeFocus.triggerRef(key.id)}
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmingRevoke(key.id)}
                  aria-label={`Revoke ${key.name}`}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          ))
        )}
      </div>
    </SettingsSection>
  );
}
