"use client";

/**
 * Connecting Luma / Eventbrite — and being honest about what that buys.
 *
 * The limitation stated here is real and worth repeating in the UI rather than burying in
 * docs: these APIs are host-scoped. A Luma API key is minted per calendar you own and needs
 * a paid Luma Plus plan; Eventbrite's attendees endpoint needs organiser scope. Neither can
 * return the guest list of an event you merely attended, and no other platform can either.
 *
 * A "Connect Luma" button that implied otherwise would generate a support ticket per user.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plug, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import {
  connectLuma,
  disconnectEventProvider,
  startEventbriteOAuth,
} from "@/actions/events";
import type { EventConnectionSummary } from "@/lib/events/connections";

export function EventConnectionsCard({
  connections,
  eventbriteConfigured,
}: {
  connections: EventConnectionSummary[];
  eventbriteConfigured: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [apiKey, setApiKey] = useState("");
  const [showLumaField, setShowLumaField] = useState(false);

  const luma = connections.find((c) => c.provider === "luma");
  const eventbrite = connections.find((c) => c.provider === "eventbrite");

  function saveLuma() {
    start(async () => {
      const result = await connectLuma(apiKey);
      if (!result.ok) {
        toast.error(result.error ?? "Luma rejected that key.");
        return;
      }
      setApiKey("");
      setShowLumaField(false);
      toast.success("Luma connected. Events you host will sync automatically.");
      router.refresh();
    });
  }

  function connectEventbrite() {
    start(async () => {
      try {
        const { url } = await startEventbriteOAuth();
        window.location.href = url;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not start Eventbrite.");
      }
    });
  }

  function disconnect(provider: "luma" | "eventbrite") {
    start(async () => {
      await disconnectEventProvider(provider);
      toast.success("Disconnected.");
      router.refresh();
    });
  }

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5">
      <h2 className="font-medium text-ink">Connected event platforms</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Orbit can pull full guest lists only for events you <strong>host</strong> — that is all
        these APIs expose. For events you attended, paste or upload the list on the event
        itself.
      </p>

      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">Luma</p>
            <p className="text-xs text-muted-foreground">
              {luma
                ? luma.status === "needs_reauth"
                  ? "Needs reconnecting — Luma rejected the saved key."
                  : `Connected${luma.label ? ` · ${luma.label}` : ""}`
                : "Needs a calendar API key from a Luma Plus account."}
            </p>
          </div>
          {luma ? (
            <Button variant="ghost" size="sm" onClick={() => disconnect("luma")} disabled={pending}>
              <Trash2 className="size-4" aria-hidden />
              Disconnect
            </Button>
          ) : showLumaField ? (
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Luma API key"
                type="password"
                aria-label="Luma API key"
              />
              <Button onClick={saveLuma} disabled={pending || !apiKey.trim()}>
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Save
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setShowLumaField(true)}>
              <Plug className="size-4" aria-hidden />
              Connect
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">Eventbrite</p>
            <p className="text-xs text-muted-foreground">
              {eventbrite
                ? eventbrite.status === "needs_reauth"
                  ? "Needs reconnecting — Eventbrite rejected the saved token."
                  : `Connected${eventbrite.label ? ` · ${eventbrite.label}` : ""}`
                : eventbriteConfigured
                  ? "Sign in to sync events your organisation runs."
                  : "Not configured on this deployment."}
            </p>
          </div>
          {eventbrite ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => disconnect("eventbrite")}
              disabled={pending}
            >
              <Trash2 className="size-4" aria-hidden />
              Disconnect
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={connectEventbrite}
              disabled={pending || !eventbriteConfigured}
            >
              <Plug className="size-4" aria-hidden />
              Connect
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
