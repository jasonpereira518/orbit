"use client";

import { useEffect, useState, useTransition } from "react";
import { ArrowRight, Check, ChevronDown, RefreshCw } from "lucide-react";
import { getGmailConnectionStatus, startGmailOAuth } from "@/actions/gmail";
import { saveOnboardingStep } from "@/actions/onboarding";
import { getOutlookConnectionStatus, startOutlookOAuth } from "@/actions/outlook";
import { GoogleContactsImport } from "@/components/imports/google-contacts-import";
import { OutlookContactsImport } from "@/components/imports/outlook-contacts-import";
import {
  BackButton,
  Stagger,
  StaggerItem,
  StepHeading,
} from "@/components/onboarding/onboarding-ui";
import { GoogleMark, MicrosoftMark } from "@/components/onboarding/provider-logo";
import { Button } from "@/components/ui/button";
import { SESSION_EXPIRED_LINE } from "@/lib/connection-status";
import { friendlyError } from "@/lib/errors";
import { missingScopeMessage as googleMissingScope } from "@/lib/google-scopes";
import { missingScopeMessage as microsoftMissingScope } from "@/lib/microsoft-scopes";
import { readOAuthReturn, type OAuthReturn } from "@/lib/oauth-return";
import {
  connectAccountFromGmail,
  connectAccountFromOutlook,
  type ConnectAccount,
  type ConnectProvider,
} from "@/lib/onboarding-connect";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import { cn } from "@/lib/utils";

/** The OAuth callback comes back to the stage, which resumes on this step from its saved id. */
const RETURN_TO = "/onboarding";

const PROVIDERS: Array<{ id: ConnectProvider; label: string; short: string }> = [
  { id: "google", label: "Google", short: "Gmail and Google Contacts" },
  { id: "microsoft", label: "Microsoft", short: "Outlook and Microsoft 365" },
];

function readReturn(): (OAuthReturn & { provider: ConnectProvider }) | null {
  if (typeof window === "undefined") return null;
  const search = window.location.search;
  const google = readOAuthReturn(search, {
    param: "google",
    provider: "Google",
    connectedText: "Google connected. Choose who to bring in below.",
    reasons: { missing_scope: googleMissingScope("contacts") },
  });
  if (google) return { ...google, provider: "google" };
  const microsoft = readOAuthReturn(search, {
    param: "outlook",
    provider: "Microsoft",
    connectedText: "Microsoft connected. Choose who to bring in below.",
    reasons: { missing_scope: microsoftMissingScope("contacts") },
  });
  return microsoft ? { ...microsoft, provider: "microsoft" } : null;
}

const HOW_IT_WORKS = [
  "Pick your account on the Google or Microsoft screen",
  "Allow contacts. Orbit can’t read or send your mail",
  "Come back here and choose who to add",
];

/**
 * Connect Google or Microsoft and bring contacts in, free on every plan (the sign-in asks only
 * for contacts; calendar, sending and the inbox scan are separate, paid purposes). Each row
 * reads live state: connected or connectable. After the sign-in returns here, that provider's
 * picker opens on its own. Connecting leaves the origin,
 * hence the awaited step save before the redirect; the query the callback returns with is
 * read once and stripped on the first gesture, never in a mount effect, because a
 * `replaceState` on mount is a router restore that drops any action queued alongside it.
 */
export function ConnectStep({
  initial,
  onContinue,
  onBack,
}: {
  initial: Record<ConnectProvider, ConnectAccount>;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [accounts, setAccounts] = useState(initial);
  const [pending, start] = useTransition();
  const [oauth] = useState<(OAuthReturn & { provider: ConnectProvider }) | null>(readReturn);
  // Coming back from a successful sign-in opens that provider's picker straight away: the
  // point of connecting here is to bring people in, not to see a green tick.
  const [importing, setImporting] = useState<ConnectProvider | null>(() =>
    oauth?.tone === "success" ? oauth.provider : null,
  );

  // Re-read both statuses on mount: the page's props are fresh, but this also covers an
  // account connected in another tab before this step was reached.
  useEffect(() => {
    let cancelled = false;
    Promise.all([getGmailConnectionStatus(), getOutlookConnectionStatus()])
      .then(([gmail, outlook]) => {
        if (cancelled) return;
        setAccounts({
          google: connectAccountFromGmail(gmail),
          microsoft: connectAccountFromOutlook(outlook),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!oauth) return;
    const strip = () => {
      // The existing state, not null: it carries the stage's step for the browser's Back.
      window.history.replaceState(window.history.state, "", window.location.pathname + oauth.nextSearch);
      window.removeEventListener("pointerdown", strip);
      window.removeEventListener("keydown", strip);
    };
    window.addEventListener("pointerdown", strip);
    window.addEventListener("keydown", strip);
    return () => {
      window.removeEventListener("pointerdown", strip);
      window.removeEventListener("keydown", strip);
    };
  }, [oauth]);

  const connect = (provider: ConnectProvider) =>
    start(async () => {
      try {
        // Awaited on purpose (the stage otherwise persists steps fire-and-forget): the next
        // thing that happens is a full-page redirect to the provider.
        await saveOnboardingStep("connect");
        const { url } =
          provider === "google"
            ? await startGmailOAuth({ purpose: "contacts", returnTo: RETURN_TO })
            : await startOutlookOAuth({ purpose: "contacts", returnTo: RETURN_TO });
        window.location.href = url;
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.connectFailed));
      }
    });

  const rows = PROVIDERS.filter((p) => accounts[p.id].configured);
  const anyConnected = rows.some((p) => accounts[p.id].connected);
  const retryProvider = oauth && oauth.tone !== "success" && accounts[oauth.provider].configured ? oauth.provider : null;

  return (
    <Stagger className="mx-auto max-w-2xl space-y-5">
      <div className="space-y-4">
        <StaggerItem>
          <BackButton onClick={onBack} disabled={pending} />
        </StaggerItem>
        <StepHeading eyebrow="Your contacts" title="Bring in the people you email">
          Connect Google or Outlook and pick who to add. It&apos;s free, and you choose every
          person before anything is imported.
        </StepHeading>
      </div>

      {!anyConnected && (
        <Stagger as="ol" className="grid gap-2 sm:grid-cols-3">
          {HOW_IT_WORKS.map((line, i) => (
            <StaggerItem as="li" key={line} className="flex gap-2.5 rounded-xl border border-border/60 bg-card/60 p-3 text-sm">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                {i + 1}
              </span>
              <span className="text-foreground">{line}</span>
            </StaggerItem>
          ))}
        </Stagger>
      )}

      {oauth && (
        <StaggerItem>
          <div
            role="status"
            className={cn(
              "flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm",
              oauth.tone === "success" && "border-primary/30 bg-primary/5 text-foreground",
              oauth.tone === "message" && "border-border/70 bg-muted/30 text-muted-foreground",
              oauth.tone === "error" && "border-destructive/30 bg-destructive/5 text-destructive",
            )}
          >
            <span>{oauth.text}</span>
            {retryProvider && (
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => connect(retryProvider)}>
                Try again
              </Button>
            )}
          </div>
        </StaggerItem>
      )}

      <Stagger as="ul" className="space-y-3">
        {rows.map((p) => {
          const account = accounts[p.id];
          const needsReauth = account.connected && account.health === "needs_reauth";
          const Mark = p.id === "google" ? GoogleMark : MicrosoftMark;
          return (
            <StaggerItem as="li" key={p.id} className="rounded-2xl border border-border/70 bg-card p-4">
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className="relative flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-white"
                  aria-hidden
                >
                  <Mark className="size-5" />
                  {account.connected && (
                    <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-2.5" strokeWidth={3.5} />
                    </span>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">{p.label}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {account.connected
                      ? needsReauth
                        ? SESSION_EXPIRED_LINE
                        : `Connected as ${account.email ?? "your account"}`
                      : p.short}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {account.connected && !needsReauth ? (
                    <Button
                      type="button"
                      variant={importing === p.id ? "ghost" : "default"}
                      size="sm"
                      aria-expanded={importing === p.id}
                      onClick={() => setImporting((cur) => (cur === p.id ? null : p.id))}
                    >
                      {importing === p.id ? "Hide" : "Choose who to add"}
                      <ChevronDown
                        className={cn("size-4 transition-transform", importing === p.id && "rotate-180")}
                        aria-hidden
                      />
                    </Button>
                  ) : (
                    <Button type="button" size="sm" disabled={pending} onClick={() => connect(p.id)}>
                      {needsReauth ? (
                        <>
                          <RefreshCw className="size-4" aria-hidden />
                          Reconnect
                        </>
                      ) : (
                        `Connect ${p.label}`
                      )}
                    </Button>
                  )}
                </div>
              </div>
              {importing === p.id && account.connected && (
                // Scrolls inside the card, so the step still fits one screen however many
                // people the account has.
                <div className="mt-4 max-h-[min(22rem,45dvh)] overflow-y-auto border-t border-border/60 pt-4">
                  {p.id === "google" ? (
                    <GoogleContactsImport returnTo={RETURN_TO} />
                  ) : (
                    <OutlookContactsImport returnTo={RETURN_TO} />
                  )}
                </div>
              )}
            </StaggerItem>
          );
        })}
      </Stagger>

      <StaggerItem className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
        <p className="text-xs text-muted-foreground">
          {anyConnected ? "You can bring in more any time from Imports." : "Orbit never sends email from your account."}
        </p>
        <Button type="button" size="lg" className="h-10 px-4" disabled={pending} onClick={onContinue}>
          {anyConnected ? "Continue" : "Skip for now"}
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      </StaggerItem>
    </Stagger>
  );
}
