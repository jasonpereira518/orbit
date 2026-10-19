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
import { Copy, KeyRound, Trash2 } from "lucide-react";
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
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection } from "@/components/settings/settings-section";
import { useConfirmFocus } from "@/components/settings/use-confirm-focus";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

const LOAD_TIMEOUT_MS = 12_000;
const TIMED_OUT = "orbit:timed-out";
/** The same line `calendar-feed-settings.tsx` and `webhook-settings.tsx` show; a shared helper is wanted. */
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
  const [error, setError] = useState<"timeout" | "error" | null>(null);
  const [name, setName] = useState("");
  const [allowWrite, setAllowWrite] = useState(true);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const revokeFocus = useConfirmFocus(confirmingRevoke);

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
        setError(err.message === TIMED_OUT ? "timeout" : "error");
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
      title="API keys"
      description="Connect Orbit to Zapier, Make, n8n or your own scripts. A key acts as you, so treat it like a password."
    >
      {/* A new key, shown once. */}
      {created ? (
        <div className="space-y-3 rounded-lg border border-primary/25 bg-primary/6 p-4">
          <p className="text-sm font-medium text-ink">
            Copy this now — it won’t be shown again.
          </p>
          <p className="text-xs text-muted-foreground">
            Orbit stores only a hash of the key, so it can’t be recovered or shown again. If
            you lose it, revoke it and create another.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-lg border border-border-subtle bg-background px-3 py-2 font-mono text-xs">
              {created.mcpUrl ?? created.token}
            </code>
            <Button
              size="sm"
              variant="secondary"
              aria-label="Copy key"
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
        <div className="space-y-2 rounded-lg border border-border-subtle bg-surface-inset p-4">
          <p className="text-sm">{blocked}</p>
          <a href="/upgrade" className={buttonVariants({ size: "sm" })}>
            See plans
          </a>
        </div>
      ) : null}

      {/* Create */}
      <div className="space-y-3 rounded-lg border border-border-subtle p-4">
        <Label htmlFor="api-key-name">Create a key</Label>
        <Input
          id="api-key-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="What is it for? e.g. Zapier"
          maxLength={80}
        />
        <Label className="font-normal">
          <Checkbox
            checked={allowWrite}
            onCheckedChange={(checked) => setAllowWrite(checked === true)}
          />
          Allow this key to add contacts and log interactions
        </Label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={pending} onClick={() => onCreate("api")}>
            <KeyRound className="size-4" />
            API key
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Use an API key for Zapier, Make, n8n or the command line. Claude and ChatGPT don’t
          need one — set them up under Claude and ChatGPT.
        </p>
      </div>

      {/* Existing */}
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
        ) : keys === null ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading your keys">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : keys.length === 0 ? (
          <EmptyState
            variant="plain"
            size="sm"
            title="No keys yet"
            description="Create one above to connect Zapier, Make, n8n or your own scripts."
          />
        ) : (
          keys.map((key) => (
            <div
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-subtle p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{key.name}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {key.prefix}…
                  {key.scopes.includes("write") ? " · read and write" : " · read only"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {key.lastUsedAt ? (
                    <>
                      Last used <RelativeTime date={key.lastUsedAt} />
                    </>
                  ) : (
                    "Never used"
                  )}
                </p>
              </div>
              {confirmingRevoke === key.id ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span role="status" className="text-xs text-muted-foreground">
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
