"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Key,
  Link2,
  Loader2,
  Mail,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import {
  connectEventFeed,
  connectLuma,
  disconnectEventProvider,
  setGmailEventScan,
  startEventbriteOAuth,
  triggerProviderSync,
} from "@/actions/events";
import { startGmailOAuth } from "@/actions/gmail";
import type { EventConnectionSummary } from "@/lib/events/connections";
import type { EventConnectionProvider } from "@/lib/events/types";
import { friendlyError } from "@/lib/errors";

const FEED_STEPS: Record<
  "luma_ics" | "partiful_ics",
  { title: string; steps: string[]; url: string }
> = {
  luma_ics: {
    title: "Luma Calendar Sync",
    steps: [
      "Open lu.ma and go to Settings",
      "Click on 'Account Syncing'",
      "Choose 'Add iCal Subscription'",
      "Copy your private calendar link and paste it below",
    ],
    url: "https://lu.ma/settings",
  },
  partiful_ics: {
    title: "Partiful Calendar Sync",
    steps: [
      "Open partiful.com and go to Settings",
      "Navigate to 'Calendar Sync'",
      "Click 'Copy Link' for your personal feed",
      "Paste the copied feed URL below",
    ],
    url: "https://partiful.com/settings",
  },
};

export function PlatformIntegrationsHub({
  connections,
  eventbriteConfigured,
  googleMailGranted,
  googleCalendarGranted,
}: {
  connections: EventConnectionSummary[];
  eventbriteConfigured: boolean;
  googleConnected: boolean;
  googleMailGranted: boolean;
  googleCalendarGranted: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [activeSyncProvider, setActiveSyncProvider] = useState<string | null>(null);

  // Modals / inputs
  const [openFeedModal, setOpenFeedModal] = useState<"luma_ics" | "partiful_ics" | null>(null);
  const [feedUrl, setFeedUrl] = useState("");
  const [showLumaApiKey, setShowLumaApiKey] = useState(false);
  const [lumaApiKey, setLumaApiKey] = useState("");

  const byProvider = (provider: EventConnectionProvider) =>
    connections.find((c) => c.provider === provider);

  const lumaFeed = byProvider("luma_ics");
  const lumaHost = byProvider("luma");
  const partifulFeed = byProvider("partiful_ics");
  const eventbrite = byProvider("eventbrite");
  const gmail = byProvider("gmail");

  function handleFeedSave(provider: "luma_ics" | "partiful_ics") {
    if (!feedUrl.trim()) return;
    start(async () => {
      try {
        const result = await connectEventFeed(provider, feedUrl);
        if (!result.ok) {
          toast.error(result.error ?? "Failed to connect feed URL");
          return;
        }
        setFeedUrl("");
        setOpenFeedModal(null);
        toast.success(
          result.found
            ? `Connected! Found ${result.found} event${result.found === 1 ? "" : "s"}.`
            : "Connected! Upcoming confirmed events will sync automatically."
        );
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Failed to connect feed"));
      }
    });
  }

  function handleLumaApiKeySave() {
    if (!lumaApiKey.trim()) return;
    start(async () => {
      try {
        const result = await connectLuma(lumaApiKey);
        if (!result.ok) {
          toast.error(result.error ?? "Luma rejected that API key");
          return;
        }
        setLumaApiKey("");
        setShowLumaApiKey(false);
        toast.success("Luma host account connected! Events you host will sync automatically.");
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Failed to connect Luma"));
      }
    });
  }

  function handleDisconnect(provider: EventConnectionProvider) {
    start(async () => {
      try {
        await disconnectEventProvider(provider);
        toast.success("Disconnected provider");
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Failed to disconnect"));
      }
    });
  }

  function handleSyncNow(provider: EventConnectionProvider) {
    setActiveSyncProvider(provider);
    start(async () => {
      try {
        const result = await triggerProviderSync(provider);
        if (!result.ok) {
          toast.error(friendlyError(result.error, "Sync failed"));
          return;
        }
        toast.success(`Sync complete — refreshed ${result.value.count} events.`);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Sync failed"));
      } finally {
        setActiveSyncProvider(null);
      }
    });
  }

  function handleConnectEventbrite() {
    start(async () => {
      try {
        const { url } = await startEventbriteOAuth();
        window.location.href = url;
      } catch (err) {
        toast.error(friendlyError(err, "Could not start Eventbrite sign in"));
      }
    });
  }

  function handleToggleGmail(enable: boolean) {
    if (enable && !googleMailGranted) {
      start(async () => {
        try {
          const { url } = await startGmailOAuth({ purpose: "event_mail", returnTo: "/events" });
          window.location.href = url;
        } catch (err) {
          toast.error(friendlyError(err, "Google sign in failed"));
        }
      });
      return;
    }

    start(async () => {
      const res = await setGmailEventScan(enable);
      if (!res.ok) {
        toast.error(res.error ?? "Could not toggle scan");
        return;
      }
      toast.success(
        enable
          ? "Scanning confirmation emails for upcoming events..."
          : "Stopped scanning confirmation emails"
      );
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {/* Luma Platform Card */}
      <div className="rounded-2xl border border-border/70 bg-card p-4 transition-shadow hover:shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 font-bold dark:text-indigo-400">
              Lu
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="font-medium text-ink">Luma</h4>
                {lumaFeed || lumaHost ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-3xs font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-3" /> Connected
                  </span>
                ) : (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-3xs text-muted-foreground">
                    Read-only
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Sync events you attend via your personal calendar feed, or sync hosted guest lists.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {lumaFeed ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleSyncNow("luma_ics")}
                  disabled={pending}
                  className="h-8 gap-1 text-xs"
                >
                  <RefreshCw
                    className={`size-3.5 ${activeSyncProvider === "luma_ics" ? "animate-spin" : ""}`}
                  />
                  Sync Feed
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDisconnect("luma_ics")}
                  disabled={pending}
                  className="h-8 text-xs text-muted-foreground hover:text-destructive"
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFeedUrl("");
                  setOpenFeedModal("luma_ics");
                }}
                className="h-8 gap-1.5 text-xs"
              >
                <CalendarPlus className="size-3.5" />
                Connect Luma Feed
              </Button>
            )}

            {!lumaHost && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowLumaApiKey(!showLumaApiKey)}
                className="h-8 text-xs text-muted-foreground"
              >
                <Key className="size-3.5" />
                Host API
              </Button>
            )}
          </div>
        </div>

        {/* Luma Host API Key Form Drawer */}
        {showLumaApiKey && !lumaHost && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-border/70 bg-muted/40 p-3">
            <Input
              type="password"
              placeholder="Paste Luma Calendar API Key (optional, for hosts)"
              value={lumaApiKey}
              onChange={(e) => setLumaApiKey(e.target.value)}
              className="h-8 text-xs"
            />
            <Button
              size="sm"
              onClick={handleLumaApiKeySave}
              disabled={pending || !lumaApiKey.trim()}
              className="h-8 text-xs"
            >
              Save Key
            </Button>
          </div>
        )}
      </div>

      {/* Eventbrite Platform Card */}
      <div className="rounded-2xl border border-border/70 bg-card p-4 transition-shadow hover:shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-orange-500/10 text-orange-600 font-bold dark:text-orange-400">
              Eb
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="font-medium text-ink">Eventbrite</h4>
                {eventbrite ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-3xs font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-3" /> Connected
                  </span>
                ) : (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-3xs text-muted-foreground">
                    OAuth
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                One-click login to sync events, registrations, and hosted organizer rosters.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {eventbrite ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleSyncNow("eventbrite")}
                  disabled={pending}
                  className="h-8 gap-1 text-xs"
                >
                  <RefreshCw
                    className={`size-3.5 ${activeSyncProvider === "eventbrite" ? "animate-spin" : ""}`}
                  />
                  Sync Now
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDisconnect("eventbrite")}
                  disabled={pending}
                  className="h-8 text-xs text-muted-foreground hover:text-destructive"
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handleConnectEventbrite}
                disabled={pending || !eventbriteConfigured}
                className="h-8 gap-1.5 text-xs"
              >
                Sign In with Eventbrite
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Partiful Platform Card */}
      <div className="rounded-2xl border border-border/70 bg-card p-4 transition-shadow hover:shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-pink-500/10 text-pink-600 font-bold dark:text-pink-400">
              Pt
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="font-medium text-ink">Partiful</h4>
                {partifulFeed ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-3xs font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-3" /> Connected
                  </span>
                ) : (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-3xs text-muted-foreground">
                    Feed Sync
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Sync parties and mixers you RSVP to via Partiful&apos;s personal calendar feed.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {partifulFeed ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleSyncNow("partiful_ics")}
                  disabled={pending}
                  className="h-8 gap-1 text-xs"
                >
                  <RefreshCw
                    className={`size-3.5 ${activeSyncProvider === "partiful_ics" ? "animate-spin" : ""}`}
                  />
                  Sync Feed
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDisconnect("partiful_ics")}
                  disabled={pending}
                  className="h-8 text-xs text-muted-foreground hover:text-destructive"
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFeedUrl("");
                  setOpenFeedModal("partiful_ics");
                }}
                className="h-8 gap-1.5 text-xs"
              >
                <CalendarPlus className="size-3.5" />
                Connect Partiful Feed
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Google Calendar & Ticket Mail Scan */}
      <div className="rounded-2xl border border-border/70 bg-card p-4 transition-shadow hover:shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 font-bold dark:text-blue-400">
              <Mail className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="font-medium text-ink">Google Calendar & Ticket Emails</h4>
                {gmail ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-3xs font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-3" /> Auto-Scanning
                  </span>
                ) : (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-3xs text-muted-foreground">
                    Optional
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Automatically scans RSVP and ticket confirmation emails from any ticketing platform.
              </p>
            </div>
          </div>

          <div>
            {gmail ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleToggleGmail(false)}
                disabled={pending}
                className="h-8 text-xs text-muted-foreground hover:text-destructive"
              >
                Turn off scan
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleToggleGmail(true)}
                disabled={pending}
                className="h-8 gap-1.5 text-xs"
              >
                Turn on scan
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Feed Connect Modal Dialog */}
      {openFeedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-ink">
                Connect {FEED_STEPS[openFeedModal].title}
              </h3>
              <button
                type="button"
                onClick={() => setOpenFeedModal(null)}
                className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-ink"
              >
                <X className="size-5" />
              </button>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-ink">How to get your private feed URL:</p>
              <ol className="mt-2 list-decimal space-y-1.5 pl-4">
                {FEED_STEPS[openFeedModal].steps.map((step, idx) => (
                  <li key={idx}>{step}</li>
                ))}
              </ol>
              <a
                href={FEED_STEPS[openFeedModal].url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2.5 inline-flex items-center gap-1 font-medium text-primary hover:underline"
              >
                Open {FEED_STEPS[openFeedModal].title.split(" ")[0]} Settings
                <ExternalLink className="size-3" />
              </a>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="feed-url-input" className="text-xs font-medium text-ink">
                Paste Feed URL (webcal:// or https://)
              </label>
              <Input
                id="feed-url-input"
                type="password"
                placeholder="webcal://... or https://..."
                value={feedUrl}
                onChange={(e) => setFeedUrl(e.target.value)}
                className="h-9 text-xs"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOpenFeedModal(null)}
                className="text-xs"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => handleFeedSave(openFeedModal)}
                disabled={pending || !feedUrl.trim()}
                className="text-xs"
              >
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Connect & Sync
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
