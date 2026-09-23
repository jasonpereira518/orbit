"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronDown, Lock, RefreshCw } from "lucide-react";
import { getGmailConnectionStatus, startGmailOAuth } from "@/actions/gmail";
import { saveOnboardingStep } from "@/actions/onboarding";
import { getOutlookConnectionStatus, startOutlookOAuth } from "@/actions/outlook";
import { GoogleContactsImport } from "@/components/imports/google-contacts-import";
import { OutlookContactsImport } from "@/components/imports/outlook-contacts-import";
import {
  BackButton,
  ProTag,
  Stagger,
  StaggerItem,
  StepHeading,
} from "@/components/onboarding/onboarding-ui";
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

function readReturn(): OAuthReturn | null {
  if (typeof window === "undefined") return null;
  const search = window.location.search;
  return (
    readOAuthReturn(search, {
      param: "google",
      provider: "Google",
      connectedText: "Google connected",
      reasons: { missing_scope: googleMissingScope("contacts") },
    }) ??
    readOAuthReturn(search, {
      param: "outlook",
      provider: "Microsoft",
      connectedText: "Microsoft connected",
      reasons: { missing_scope: microsoftMissingScope("contacts") },
    })
  );
}

/** `?preview=connect-locked` shows the free-plan row on a laptop, where every account is a demo. */
function previewLocked(): boolean {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("preview") === "connect-locked";
}

/**
 * Connect Google or Microsoft so contacts (and, on request, calendar) can come in. Each row
 * reads live state: connected, connectable, or locked behind a plan — so when sync becomes
 * free for everyone this step lights up with no change here. Connecting leaves the origin,
 * hence the awaited step save before the redirect; the query the callback returns with is
 * read once and stripped on the first gesture, never in a mount effect, because a
 * `replaceState` on mount is a router restore that drops any action queued alongside it.
 */
export function ConnectStep({
  canUseSync,
  initial,
  onContinue,
  onBack,
}: {
  canUseSync: boolean;
  initial: Record<ConnectProvider, ConnectAccount>;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [accounts, setAccounts] = useState(initial);
  const [pending, start] = useTransition();
  const [importing, setImporting] = useState<ConnectProvider | null>(null);
  const [oauth] = useState<OAuthReturn | null>(readReturn);
  const [locked] = useState(() => !canUseSync || previewLocked());

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
      window.history.replaceState(null, "", window.location.pathname + oauth.nextSearch);
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

  return (
    <Stagger className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-4">
        <StaggerItem>
          <BackButton onClick={onBack} disabled={pending} />
        </StaggerItem>
        <StepHeading eyebrow="Your contacts" title="Connect your contacts">
          Bring in the people you already email. Orbit reads only the contact details you choose
          to import.
        </StepHeading>
      </div>

      {oauth && (
        <StaggerItem>
          <p
            role="status"
            className={cn(
              "rounded-xl border px-3 py-2 text-sm",
              oauth.tone === "success" && "border-primary/30 bg-primary/5 text-foreground",
              oauth.tone === "message" && "border-border/70 bg-muted/30 text-muted-foreground",
              oauth.tone === "error" && "border-destructive/30 bg-destructive/5 text-destructive",
            )}
          >
            {oauth.text}
          </p>
        </StaggerItem>
      )}

      <Stagger as="ul" className="space-y-3">
        {rows.map((p) => {
          const account = accounts[p.id];
          const needsReauth = account.connected && account.health === "needs_reauth";
          return (
            <StaggerItem
              as="li"
              key={p.id}
              className={cn(
                "rounded-2xl border border-border/70 bg-card p-4 sm:p-5",
                locked && !account.connected && "bg-card/50",
              )}
            >
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-xl",
                    account.connected ? "bg-primary text-primary-foreground" : "bg-accent text-primary",
                    locked && !account.connected && "bg-muted text-muted-foreground",
                  )}
                  aria-hidden
                >
                  {account.connected ? (
                    <Check className="size-5" strokeWidth={3} />
                  ) : locked ? (
                    <Lock className="size-4" />
                  ) : (
                    <ArrowRight className="size-5" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium text-ink">
                    {p.label}
                    {locked && !account.connected && <ProTag />}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    {account.connected
                      ? needsReauth
                        ? SESSION_EXPIRED_LINE
                        : `Connected as ${account.email ?? "your account"}`
                      : locked
                        ? "Included with Orbit Pro"
                        : p.short}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {account.connected && !needsReauth ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-expanded={importing === p.id}
                      onClick={() => setImporting((cur) => (cur === p.id ? null : p.id))}
                    >
                      Import contacts now
                      <ChevronDown
                        className={cn("size-4 transition-transform", importing === p.id && "rotate-180")}
                        aria-hidden
                      />
                    </Button>
                  ) : locked && !account.connected ? (
                    <Link
                      href="/upgrade"
                      className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      See plans
                    </Link>
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
                <div className="mt-4 border-t border-border/60 pt-4">
                  <p className="mb-3 text-sm text-muted-foreground">
                    Connected. Import your {p.label} contacts now, or later from Imports.
                  </p>
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
        {locked && !anyConnected ? (
          <p className="text-xs text-muted-foreground">
            Sync unlocks on Orbit Pro. Everything else in Orbit works on the free plan.
          </p>
        ) : (
          <span />
        )}
        <Button type="button" size="lg" className="h-10 px-4" disabled={pending} onClick={onContinue}>
          {anyConnected ? "Continue" : "Skip for now"}
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      </StaggerItem>
    </Stagger>
  );
}
