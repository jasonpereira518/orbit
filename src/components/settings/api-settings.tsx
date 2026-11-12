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
import { Copy, KeyRound, Plus } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeySummary,
  type CreatedApiKey,
} from "@/actions/api-keys";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AccountHeader, FeatureRow, LoadError, whenLine } from "@/components/settings/account-page";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirmFocus } from "@/components/settings/use-confirm-focus";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import { withTimeout } from "@/lib/async";

const LOAD_TIMEOUT_MS = 12_000;
const TIMED_OUT = "orbit:timed-out";

async function copy(value: string, what: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${what} copied`);
  } catch {
    toast.error(TOAST_COPY.copyFailed);
  }
}

export function ApiSettings() {
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [allowWrite, setAllowWrite] = useState(true);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const revokeFocus = useConfirmFocus(confirmingRevoke);

  // Deliberately does not clear the error synchronously: doing so inside the mount effect
  // triggers a cascading render, and clearing it on success reads the same to the user.
  const load = useCallback(() => {
    withTimeout(listApiKeys(), LOAD_TIMEOUT_MS, TIMED_OUT).then(
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
        if (!result.ok && result.reason === "limit_reached") {
          // At the active-key cap: no plan lifts it, so no "See plans" — revoking one does.
          toast.error(result.message);
          return;
        }
        if (!result.ok) {
          // A paywall, not a fault. Say what it is and where to go, rather than "something
          // went wrong" — the message is carried in the result precisely so this can.
          setBlocked(result.message);
          return;
        }
        setBlocked(null);
        setCreated(result);
        setName("");
        setAdding(false);
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

  const showForm = adding || keys?.length === 0;

  return (
    <div className="space-y-4">
      <AccountHeader
        name="API keys"
        mark={<KeyRound className="text-ink" />}
        accountLine={null}
        status={
          keys === null
            ? { state: "off", detail: "Checking…", busy: true }
            : keys.length > 0
              ? { state: "on", detail: `${keys.length} ${keys.length === 1 ? "key" : "keys"} · each acts as you` }
              : { state: "off", detail: "No keys yet" }
        }
        primaryAction={
          showForm ? undefined : { label: "New key", icon: <Plus aria-hidden />, onClick: () => setAdding(true) }
        }
        menuItems={[]}
      />
      <div aria-hidden className="h-1 rounded-full bg-muted" />

      {/* A new key, shown once: Orbit stores only its hash. */}
      {created ? (
        <div className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 p-4">
          <p className="text-sm font-medium text-ink">Copy it now · it won’t be shown again</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded border bg-background px-3 py-2 font-mono text-xs">
              {created.mcpUrl ?? created.token}
            </code>
            <Button size="sm" variant="outline" onClick={() => copy(created.mcpUrl ?? created.token, "Key")}>
              <Copy aria-hidden />
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      {blocked ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/50 p-3 text-sm">
          <p className="min-w-0 flex-1">{blocked}</p>
          <a href="/upgrade?gate=api" className={buttonVariants({ size: "sm" })}>
            See plans
          </a>
        </div>
      ) : null}

      {showForm ? (
        <div className="space-y-3 rounded-xl border p-4">
          <Input
            id="api-key-name"
            aria-label="What the key is for"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What is it for? e.g. Zapier"
            maxLength={80}
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={allowWrite} onCheckedChange={(on) => setAllowWrite(on === true)} />
            Can add contacts and log interactions
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={pending} onClick={() => onCreate("api")}>
              Create key
            </Button>
            {keys?.length ? (
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            For Zapier, Make, n8n or scripts · Claude and ChatGPT don’t need one
          </p>
        </div>
      ) : null}

      {error ? (
        <LoadError what="API keys" onRetry={load} />
      ) : keys === null ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading your keys">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : keys.length > 0 ? (
        <ul className="-my-1">
          {keys.map((key) => (
            <FeatureRow
              key={key.id}
              icon={<KeyRound />}
              title={key.name}
              description={
                <span className="tabular-nums">
                  <span className="font-mono">{key.prefix}…</span>
                  {key.scopes.includes("write") ? " · read and write" : " · read only"}
                  {" · "}
                  {key.lastUsedAt ? `used ${whenLine(key.lastUsedAt)}` : "never used"}
                </span>
              }
              control={confirmingRevoke === key.id ? { kind: "none" } : { kind: "action", label: "Revoke" }}
              onAction={() => setConfirmingRevoke(key.id)}
            >
              {confirmingRevoke === key.id ? (
                <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Anything using it stops working</span>
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
              ) : null}
            </FeatureRow>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
