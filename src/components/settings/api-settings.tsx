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
import { useCallback, useEffect, useState, useTransition } from "react";
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
    toast.error("Could not copy — select and copy it manually");
  }
}

export function ApiSettings() {
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [allowWrite, setAllowWrite] = useState(true);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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
          err instanceof Error ? err.message : "Could not create the key."
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
        toast.error("Could not revoke that key.");
      }
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">API and connectors</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Connect Orbit to Zapier, Make, n8n, or an AI assistant like Claude. Keys act as you,
          so treat them like a password.
        </p>
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
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => onCreate("mcp_url")}
          >
            <Plug className="size-4" />
            Claude connector URL
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Use an API key for Zapier, Make, n8n, or Claude Code. Use a connector URL for
          claude.ai, which has no field for a header.
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
          <p className="text-muted-foreground text-sm">Loading…</p>
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
                  <span className="text-muted-foreground text-xs">
                    Anything using it stops working.
                  </span>
                  <Button
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
    </div>
  );
}
