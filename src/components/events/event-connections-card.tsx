"use client";

/**
 * Where events come from — set-up that should need none.
 *
 * Calendar discovery already turns platform invites in a connected Google, Outlook or iCloud
 * calendar into events, so the one thing worth saying is whether a calendar is connected, and
 * if not, where to connect one. Everything else is optional and sits under "More sources":
 *
 * - the Luma and Partiful personal calendar links, for events that never reach a calendar;
 * - the host APIs (Luma key, Eventbrite). Every platform API is host-scoped — a Luma key is
 *   minted per calendar you own and needs Luma Plus, Eventbrite's attendees endpoint needs
 *   organiser scope, Partiful has no API — so they answer "what did I run", and are labelled
 *   that way rather than implying they fetch the guest list of a party you went to.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarPlus, ChevronDown, Loader2, Plug, RefreshCw, Trash2, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import {
  connectEventFeed,
  connectEventbriteKey,
  connectLuma,
  disconnectEventProvider,
  startEventbriteOAuth,
  triggerProviderSync,
} from "@/actions/events";
import type { EventConnectionSummary } from "@/lib/events/connections";
import type { EventConnectionProvider } from "@/lib/events/types";
import { friendlyError } from "@/lib/errors";
import { readOAuthReturn } from "@/lib/oauth-return";
import { integrationHref } from "@/components/settings/sections";

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

const EVENTBRITE_RETURN = {
  param: "eventbrite",
  provider: "Eventbrite",
  connectedText: "Eventbrite connected — events you host will sync automatically",
  reasons: {
    no_organization:
      "That Eventbrite account has no organization to sync — create one on Eventbrite, then connect again",
  },
};

export function EventConnectionsCard({
  connections,
  eventbriteConfigured,
  calendarConnected,
}: {
  connections: EventConnectionSummary[];
  eventbriteConfigured: boolean;
  /** A Google, Outlook or iCloud calendar is syncing, so calendar discovery is running. */
  calendarConnected: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [apiKey, setApiKey] = useState("");
  const [showLumaField, setShowLumaField] = useState(false);
  const [eventbriteKey, setEventbriteKey] = useState("");
  const [showEventbriteField, setShowEventbriteField] = useState(false);
  const [feedUrl, setFeedUrl] = useState("");
  const [openFeed, setOpenFeed] = useState<"luma_ics" | "partiful_ics" | null>(null);

  const oauthToasted = useRef(false);
  useEffect(() => {
    const result = readOAuthReturn(window.location.search, EVENTBRITE_RETURN);
    if (!result) return;
    if (!oauthToasted.current) {
      oauthToasted.current = true;
      if (result.tone === "success") toast.success(result.text);
      else if (result.tone === "message") toast.message(result.text);
      else toast.error(result.text);
    }
    // Stripped on the first gesture, not now — see `readOAuthReturn`. pointerdown/keydown
    // fire before the click that could queue an action, so the restore lands first.
    const strip = () =>
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${result.nextSearch}${window.location.hash}`
      );
    window.addEventListener("pointerdown", strip, { once: true, capture: true });
    window.addEventListener("keydown", strip, { once: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", strip, true);
      window.removeEventListener("keydown", strip, true);
    };
  }, []);

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

  function saveEventbriteKey() {
    start(async () => {
      const result = await connectEventbriteKey(eventbriteKey);
      if (!result.ok) {
        toast.error(result.error ?? "Eventbrite didn’t accept that token");
        return;
      }
      setEventbriteKey("");
      setShowEventbriteField(false);
      toast.success("Eventbrite connected — events you host will sync automatically");
      router.refresh();
    });
  }

  function syncNow(provider: EventConnectionProvider) {
    start(async () => {
      const result = await triggerProviderSync(provider);
      if (!result.ok) {
        toast.error(friendlyError(result.error, "Couldn’t sync events right now"));
        return;
      }
      toast.success(
        result.value.count > 0
          ? `Synced — ${result.value.count} event${result.value.count === 1 ? "" : "s"} updated`
          : "Synced — all events up to date"
      );
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

  // The one line most people will ever read on this card, so it carries whether anything
  // under More sources is broken without being opened.
  const needsAttention = connections.filter((c) => c.status === "needs_reauth").length;

  return (
    <div className="rounded-2xl border border-border/70 bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarPlus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">
            {calendarConnected
              ? "Events on your calendar show up here on their own."
              : "Connect your calendar and the events on it show up here on their own."}
          </p>
        </div>
        {calendarConnected ? null : (
          <Link href={integrationHref("overview")} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Connect your calendar
          </Link>
        )}
      </div>

      {/* Collapsed: optional set-up you do once, if ever. `<details>` with the grid-rows height
          transition is the pattern `network-stats-card.tsx` set. */}
      <details className="group border-t border-border/60">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-b-2xl px-4 py-2.5 transition-colors duration-fast ease-house hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset focus-ring-fallback [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-2">
            <Plug className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-sm font-medium text-ink">More sources</span>
            <span
              className={
                needsAttention > 0
                  ? "truncate text-xs font-medium text-destructive"
                  : "truncate text-xs text-muted-foreground"
              }
            >
              {needsAttention > 0
                ? `${needsAttention} ${needsAttention === 1 ? "connection needs" : "connections need"} attention`
                : connections.length > 0
                  ? `${connections.length} connected`
                  : "Luma, Partiful, Eventbrite"}
            </span>
          </span>
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
          For events that never reach your calendar: paste your personal calendar link once and
          every event you&rsquo;re confirmed for shows up here — not the ones you&rsquo;re
          waitlisted, pending or invited to.
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

        {eventbrite ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Eventbrite</p>
              <p className="text-xs text-muted-foreground">
                {eventbrite.status === "needs_reauth"
                  ? "Needs reconnecting — Eventbrite rejected the saved token."
                  : `Connected${eventbrite.label ? ` · ${eventbrite.label}` : ""}`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => syncNow("eventbrite")}
                disabled={pending}
              >
                <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} aria-hidden />
                Sync
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => disconnect("eventbrite")}
                disabled={pending}
              >
                <Trash2 className="size-4" aria-hidden />
                Disconnect
              </Button>
            </div>
          </div>
        ) : showEventbriteField ? (
          <div className="space-y-2 rounded-xl border border-border/60 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-ink">Eventbrite Private Token</p>
              <button
                type="button"
                onClick={() => setShowEventbriteField(false)}
                aria-label="Cancel"
                className="text-muted-foreground hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Paste your personal token from Eventbrite &rarr; Account Settings &rarr; Developer Links &rarr; API Keys.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={eventbriteKey}
                onChange={(e) => setEventbriteKey(e.target.value)}
                placeholder="Eventbrite Private Token"
                type="password"
                aria-label="Eventbrite Private Token"
                className="flex-1 min-w-[200px]"
              />
              <Button onClick={saveEventbriteKey} disabled={pending || !eventbriteKey.trim()}>
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Save &amp; Sync
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Eventbrite</p>
              <p className="text-xs text-muted-foreground">
                {eventbriteConfigured
                  ? "Sign in with OAuth or connect with a private token to sync events you host."
                  : "Connect with your Eventbrite private token to sync events you host."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {eventbriteConfigured ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={connectEventbrite}
                  disabled={pending}
                >
                  <Plug className="size-4" aria-hidden />
                  Sign in with Eventbrite
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowEventbriteField(true)}
                disabled={pending}
              >
                <Plug className="size-4" aria-hidden />
                {eventbriteConfigured ? "Token" : "Connect"}
              </Button>
            </div>
          </div>
        )}
      </div>
      </div>
      </div>
      </details>
    </div>
  );
}
