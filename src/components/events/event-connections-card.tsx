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
import { CalendarPlus, ChevronDown, Loader2, Mail, Plug, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import {
  connectEventFeed,
  connectLuma,
  disconnectEventProvider,
  setGmailEventScan,
  startEventbriteOAuth,
} from "@/actions/events";
import type { EventConnectionSummary } from "@/lib/events/connections";
import type { EventConnectionProvider } from "@/lib/events/types";
import { friendlyError } from "@/lib/errors";

/** Where each platform hides its personal calendar link, in the fewest words that get there. */
const FEED_HELP: Record<
  "luma_ics" | "partiful_ics",
  { name: string; steps: string[] }
> = {
  luma_ics: {
    name: "Luma",
    steps: ["Settings", "Account Syncing", "Add iCal Subscription", "Copy Link"],
  },
  partiful_ics: {
    name: "Partiful",
    steps: ["Settings", "Calendar Sync", "Copy Link"],
  },
};

/** The menu path as a breadcrumb, each step in the words the platform itself uses. */
function Steps({ name, steps }: { name: string; steps: string[] }) {
  return (
    <span>
      In {name}:{" "}
      {steps.map((step, index) => (
        <span key={step}>
          {index > 0 ? <span aria-hidden> → </span> : null}
          <span className="font-medium text-ink/80">{step}</span>
          {index < steps.length - 1 ? <span className="sr-only">, then </span> : null}
        </span>
      ))}
    </span>
  );
}

export function EventConnectionsCard({
  connections,
  eventbriteConfigured,
  googleConnected,
}: {
  connections: EventConnectionSummary[];
  eventbriteConfigured: boolean;
  googleConnected: boolean;
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
  const gmail = byProvider("gmail");

  function setGmailScan(enabled: boolean) {
    start(async () => {
      const result = await setGmailEventScan(enabled);
      if (!result.ok) {
        toast.error(result.error ?? "Couldn’t change that — try again?");
        return;
      }
      toast.success(
        enabled
          ? "Scanning confirmation emails — events will appear over the next few syncs"
          : "Stopped scanning your email"
      );
      router.refresh();
    });
  }

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
          : `${FEED_HELP[provider].name} connected — new events will appear once you’re confirmed`
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
                : "Connected — events you’re confirmed for appear automatically."
              : <Steps name={help.name} steps={help.steps} />}
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
              placeholder={`Paste your ${help.name} link`}
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

  // What the collapsed row says. It is the only part most people will ever see, so it has to
  // carry the one thing worth knowing without opening it: whether anything is broken.
  const needsAttention = connections.filter((c) => c.status === "needs_reauth").length;
  const summary =
    needsAttention > 0
      ? `${needsAttention} ${needsAttention === 1 ? "connection needs" : "connections need"} attention`
      : connections.length > 0
        ? `${connections.length} connected${googleConnected ? " · Google Calendar" : ""}`
        : googleConnected
          ? "Google Calendar · connect Luma, Partiful and more"
          : "Connect Luma, Partiful, Gmail and more";

  return (
    // Collapsed by default and at the foot of the page: this is set-up you do once, and it
    // used to sit above the events themselves as the largest thing on the page. `<details>`
    // with the grid-rows height transition is the pattern `network-stats-card.tsx` set.
    <details className="group rounded-2xl border border-border/70 bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3 transition-colors duration-fast ease-house hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset focus-ring-fallback [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <Plug className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-medium text-ink">Where your events come from</h2>
          <span
            className={
              needsAttention > 0
                ? "truncate text-xs font-medium text-destructive"
                : "truncate text-xs text-muted-foreground"
            }
          >
            {summary}
          </span>
        </div>
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-slow ease-house group-open:rotate-180"
          aria-hidden
        />
      </summary>
      {/* `<details>` hides collapsed content with `content-visibility`, which would skip the
          transition, so the panel is force-shown and the grid row does the hiding. */}
      <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-slow ease-house group-open:grid-rows-[1fr] [content-visibility:visible]">
      <div className="overflow-hidden">
      <div className="space-y-3 border-t border-border/60 px-4 pb-4 pt-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Events you go to
        </p>
        <p className="-mt-2 text-sm text-muted-foreground">
          Paste your personal calendar link once and every event you&rsquo;re confirmed for shows
          up here — not the ones you&rsquo;re waitlisted, pending or invited to. A connected
          Google Calendar already does this for invites that land in it.
        </p>
        {feedRow("luma_ics")}
        {feedRow("partiful_ics")}

        {/* The mailbox scan. Off unless asked for, and it says exactly what it reads —
            `gmail.readonly` is a restricted scope the user granted for something else, and a
            toggle that quietly widened its purpose would be a breach of that. */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">Confirmation emails</p>
            <p className="text-xs text-muted-foreground">
              {gmail
                ? "On — Orbit reads only mail from Luma, Partiful, Eventbrite, Meetup and Posh, and keeps the subject line, nothing else."
                : googleConnected
                  ? "Find events from “you’re registered” emails. Orbit opens only mail from those platforms, stores no message content, and never sends any of it to AI."
                  : "Connect Google first — this reads the mailbox you have already connected."}
            </p>
          </div>
          {gmail ? (
            <Button variant="ghost" size="sm" onClick={() => setGmailScan(false)} disabled={pending}>
              <Trash2 className="size-4" aria-hidden />
              Turn off
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setGmailScan(true)}
              disabled={pending || !googleConnected}
            >
              <Mail className="size-4" aria-hidden />
              Turn on
            </Button>
          )}
        </div>

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
      </div>
    </details>
  );
}
