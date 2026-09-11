"use client";

/**
 * Where events come from, in the order that matches what people actually want.
 *
 * ## Why "auto-add" is first and "host sync" is second
 *
 * Every platform API is host-scoped: a Luma key is minted per calendar you own and needs a
 * paid Plus plan, Eventbrite's attendees endpoint needs organiser scope, Partiful has no API
 * at all. So the APIs answer "what did I run", while almost everybody's real question is
 * "what did I go to".
 *
 * The calendar feeds answer that one, for free, with a link the platform already offers — so
 * they lead. The host APIs stay, clearly labelled as what they are, because for the people
 * who DO host, a full guest list with emails is worth far more than a list of event names.
 *
 * The limitation is stated in the UI rather than buried in docs: a "Connect Luma" button that
 * implied it would fetch the guest list of a party you attended would generate a support
 * ticket per user.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Loader2, Plug, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import {
  connectEventFeed,
  connectLuma,
  disconnectEventProvider,
  startEventbriteOAuth,
} from "@/actions/events";
import type { EventConnectionSummary } from "@/lib/events/connections";
import type { EventConnectionProvider } from "@/lib/events/types";
import { friendlyError } from "@/lib/errors";

/** Where each platform hides its personal calendar link, in the fewest words that get there. */
const FEED_HELP: Record<"luma_ics" | "partiful_ics", { name: string; where: string }> = {
  luma_ics: {
    name: "Luma",
    where: "luma.com → your profile → Calendar → Subscribe, then copy the link",
  },
  partiful_ics: {
    name: "Partiful",
    where: "Partiful → Settings → Calendar sync, then copy the link",
  },
};

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
  const [feedUrl, setFeedUrl] = useState("");
  const [openFeed, setOpenFeed] = useState<"luma_ics" | "partiful_ics" | null>(null);

  const byProvider = (provider: EventConnectionProvider) =>
    connections.find((c) => c.provider === provider);
  const luma = byProvider("luma");
  const eventbrite = byProvider("eventbrite");

  function saveFeed(provider: "luma_ics" | "partiful_ics") {
    start(async () => {
      const result = await connectEventFeed(provider, feedUrl);
      if (!result.ok) {
        toast.error(result.error ?? "That calendar link couldn’t be read");
        return;
      }
      setFeedUrl("");
      setOpenFeed(null);
      // The count is the proof it worked. "Connected" alone leaves the user wondering
      // whether anything actually happened until the next sync, fifteen minutes away.
      toast.success(
        result.found
          ? `${FEED_HELP[provider].name} connected — ${result.found} event${result.found === 1 ? "" : "s"} found`
          : `${FEED_HELP[provider].name} connected — new events will appear as you RSVP`
      );
      router.refresh();
    });
  }

  function saveLuma() {
    start(async () => {
      const result = await connectLuma(apiKey);
      if (!result.ok) {
        toast.error(result.error ?? "Luma didn’t accept that key — check it and try again");
        return;
      }
      setApiKey("");
      setShowLumaField(false);
      toast.success("Luma connected — events you host will sync automatically");
      router.refresh();
    });
  }

  function connectEventbrite() {
    start(async () => {
      try {
        const { url } = await startEventbriteOAuth();
        window.location.href = url;
      } catch (error) {
        toast.error(friendlyError(error, "Couldn’t connect Eventbrite — try again?"));
      }
    });
  }

  function disconnect(provider: EventConnectionProvider) {
    start(async () => {
      await disconnectEventProvider(provider);
      toast.success("Disconnected");
      router.refresh();
    });
  }

  function feedRow(provider: "luma_ics" | "partiful_ics") {
    const connection = byProvider(provider);
    const help = FEED_HELP[provider];
    return (
      <div
        key={provider}
        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 p-3"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{help.name} calendar</p>
          <p className="text-xs text-muted-foreground">
            {connection
              ? connection.status === "needs_reauth"
                ? "That link stopped working — paste a fresh one."
                : "Connected — events you RSVP to appear automatically."
              : help.where}
          </p>
        </div>
        {connection ? (
          <Button variant="ghost" size="sm" onClick={() => disconnect(provider)} disabled={pending}>
            <Trash2 className="size-4" aria-hidden />
            Disconnect
          </Button>
        ) : openFeed === provider ? (
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Input
              value={feedUrl}
              onChange={(e) => setFeedUrl(e.target.value)}
              placeholder="https://api.lu.ma/ics/get?…"
              // `type="password"`: this link shows everything its holder has registered
              // for, so it is a credential, not an address.
              type="password"
              aria-label={`${help.name} calendar link`}
            />
            <Button onClick={() => saveFeed(provider)} disabled={pending || !feedUrl.trim()}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Save
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFeedUrl("");
              setOpenFeed(provider);
            }}
          >
            <CalendarPlus className="size-4" aria-hidden />
            Connect
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5">
      <h2 className="font-medium text-ink">Where your events come from</h2>

      <div className="mt-4 space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Events you go to
        </p>
        <p className="-mt-2 text-sm text-muted-foreground">
          Paste your personal calendar link once and every event you RSVP to shows up here. A
          connected Google Calendar already does this for invites that land in it.
        </p>
        {feedRow("luma_ics")}
        {feedRow("partiful_ics")}

        <p className="pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Events you host
        </p>
        <p className="-mt-2 text-sm text-muted-foreground">
          Only these APIs return a full guest list, and only for events you run. For anything
          you attended, paste or upload the list on the event itself.
        </p>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">Luma API key</p>
            <p className="text-xs text-muted-foreground">
              {luma
                ? luma.status === "needs_reauth"
                  ? "Needs reconnecting — Luma rejected the saved key."
                  : `Connected${luma.label ? ` · ${luma.label}` : ""}`
                : "A calendar API key from a Luma Plus account."}
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
