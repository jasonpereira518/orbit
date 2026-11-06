"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

type Outcome = { ok: boolean; error?: string };

/**
 * The rebuild in flight for each person, shared by every instance of this component. React
 * Strict Mode runs an effect twice in development, a person clicked twice in a row is one
 * call, and a dossier remounted while its rebuild is still running should join it rather than
 * start another (or wait forever on a request nobody is watching).
 */
const inFlight = new Map<string, Promise<Outcome>>();

function rebuild(contactId: string, force: boolean): Promise<Outcome> {
  const existing = inFlight.get(contactId);
  if (existing) return existing;
  const request = fetch("/api/knowledge/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contactId, force }),
  })
    .then(async (res): Promise<Outcome> => {
      if (res.ok) return { ok: true };
      const detail = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: detail?.error };
    })
    .catch((): Outcome => ({ ok: false }))
    .finally(() => inFlight.delete(contactId));
  inFlight.set(contactId, request);
  return request;
}

/**
 * The dossier's "Updated 2 days ago · Refresh" line, and the rebuild behind it.
 *
 * When the server found the brief out of date it renders this with `auto`, and the rebuild
 * starts here, in the browser, once the dossier is actually on screen. That is deliberate:
 * the same render also happens when a row is merely hovered (`IntentLink` prefetches the
 * whole route), and a model call per hover is not a cost anyone signed up for. A prefetch
 * never hydrates a component, so an effect here only runs for a dossier someone opened.
 *
 * The rebuild is a route handler, not a server action, so it neither queues other actions
 * in the tab nor snaps the router back if the person has already clicked someone else.
 * When it finishes it refreshes the page only if this person is still the one selected.
 */
export function DossierRefresh({
  contactId,
  updatedLabel,
  auto,
}: {
  contactId: string;
  /** "Updated 2 days ago", or null when there is no brief yet. */
  updatedLabel: string | null;
  auto: boolean;
}) {
  const router = useRouter();
  // Starts true when the server already knows a rebuild is about to run, so the first paint
  // says "Updating…" instead of flashing the old timestamp.
  const [working, setWorking] = useState(auto);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function settle(force: boolean) {
    const outcome = await rebuild(contactId, force);
    if (mounted.current) setWorking(false);
    if (!outcome.ok) {
      // A background rebuild that fails leaves the dossier as it was; only a click says why.
      if (force) toast.error(outcome.error ?? "Couldn’t refresh that — try again?");
      return;
    }
    if (new URL(window.location.href).searchParams.get("p") === contactId) router.refresh();
  }

  useEffect(() => {
    if (auto) void settle(false);
    // Once per opened dossier: `contactId` is the only thing that should restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, auto]);

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span aria-live="polite">{working ? "Updating…" : updatedLabel}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
        disabled={working}
        onClick={() => {
          setWorking(true);
          void settle(true);
        }}
      >
        <RefreshCw className={working ? "size-3.5 motion-safe:animate-spin" : "size-3.5"} aria-hidden />
        Refresh
      </Button>
    </div>
  );
}
