"use client";

import { useState } from "react";
import { useUser, useReverification } from "@clerk/nextjs";
import { isReverificationCancelledError } from "@clerk/nextjs/errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  connectedAccounts,
  failedAccounts,
  providerKey,
  signInMethodsFromUser,
  strategyForProvider,
} from "@/lib/clerk-sign-in-methods";
import { canDisconnectAccount } from "@/lib/sign-in-methods";
import { clerkApiErrorMessage, clerkErrorMessage } from "@/lib/clerk-errors";
import { friendlyError } from "@/lib/errors";
import { rememberPendingConnect } from "@/lib/pending-connect";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

/** Where Clerk sends the browser back after the provider is done. */
const CALLBACK = "/settings/account/sign-in/callback";

/**
 * A full-page navigation away to the provider's consent screen.
 *
 * Kept as a plain module-level function rather than a mutation inline in the component body:
 * the React Compiler lint (`react-hooks/immutability`) flags `window.location.href = …` when
 * it's written directly inside a component or hook, since `window` is a value defined outside
 * one. Outside the component, there's nothing to analyze.
 */
function navigateAway(url: string): void {
  window.location.href = url;
}

/**
 * The absolute callback URL.
 *
 * Clerk's own screens pass an absolute one — `window.location.href`
 * (`@clerk/ui/dist/components/UserProfile/ConnectedAccountsMenu.js:52`), or
 * `transport.getRedirectUrl()` — and the value is handed to the OAuth provider, which has no
 * origin to resolve a relative path against. Clerk may well absolutise it on the way out, but
 * a bare `/settings/...` is not a URL a provider can be expected to accept, so it is built
 * here rather than hoped for.
 */
function callbackUrl(): string {
  return new URL(CALLBACK, window.location.origin).toString();
}

/**
 * The strategy Clerk's `createExternalAccount` accepts, lifted from the method itself rather
 * than imported from `@clerk/types` — that package isn't installed here (only `@clerk/backend`,
 * `localizations`, `nextjs`, `react`, `shared`, `ui`), and `@clerk/nextjs` doesn't re-export
 * `OAuthStrategy`. If a strategy string below is wrong, `tsc` rejects it against this type.
 */
type ConnectStrategy = NonNullable<
  Parameters<NonNullable<ReturnType<typeof useUser>["user"]>["createExternalAccount"]>[0]["strategy"]
>;

/** What `ExternalAccountResource.providerSlug()` returns — used to tell an already-connected
 * provider apart from an offerable one, without a runtime string-split on the strategy. */
type ConnectProvider = ReturnType<
  NonNullable<ReturnType<typeof useUser>["user"]>["externalAccounts"][number]["providerSlug"]
>;

/**
 * The providers Orbit offers to connect, beyond email (Tasks 3/4 own email).
 *
 * No stable runtime way to read the dashboard's enabled strategies was found: `userSettings`
 * on Clerk's environment resource carries `socialProviderStrategies` (
 * `@clerk/shared/dist/types/userSettings.d.mts:105`), but the `Clerk` instance `useClerk()`
 * exposes has no public `environment` field — only `client`/`session`/`user` and a run of
 * `__internal_*` members (`@clerk/shared/dist/types/clerk.d.mts:260-298`, `:1001`), and no
 * `useEnvironment` hook is exported from `@clerk/shared/dist/react/index.d.mts`. Depending on
 * an `__internal_`/`__unstable__` field was ruled out, so this is a fixed list instead.
 *
 * Must match what's enabled in the Clerk dashboard: email, Google and LinkedIn are the three
 * sign-in methods this instance has.
 *
 * LinkedIn is the trap. This Clerk version carries BOTH `oauth_linkedin` (legacy provider
 * `linkedin`) and `oauth_linkedin_oidc` (provider `linkedin_oidc`) as valid `OAuthStrategy`
 * values (`@clerk/shared/dist/types/oauth.d.mts:30,32`), and only the one actually enabled in
 * the dashboard works — the other fails at connect time. Which one is enabled could not be
 * determined from this repo; `oauth_linkedin_oidc` is used here because it's Clerk's current
 * recommended LinkedIn integration (the plain `linkedin` provider is the deprecated one this
 * Clerk version keeps only for back-compat). **Which strategy a NEW connect should use is
 * still unconfirmed — settle it in the live pass.**
 *
 * Which strategy to *offer* is a separate question from whether LinkedIn is already connected:
 * an account carrying the legacy `linkedin` connection must not be offered LinkedIn again
 * under the other spelling, so the offer filter compares `providerKey`s, which fold the two
 * together.
 */
const CONNECTABLE: ReadonlyArray<{
  strategy: ConnectStrategy;
  provider: ConnectProvider;
  label: string;
}> = [
  { strategy: "oauth_google", provider: "google", label: "Google" },
  { strategy: "oauth_linkedin_oidc", provider: "linkedin_oidc", label: "LinkedIn" },
];

/**
 * Providers this account can arrive through.
 *
 * Connecting leaves the app: Clerk hands back a redirect URL, the provider asks its
 * questions, and the browser returns to CALLBACK, which reloads the user and comes back here.
 * Disconnecting stays put, and is refused when it would be the last way in — that rule lives
 * in `@/lib/sign-in-methods`.
 *
 * Three lists, not one. `user.externalAccounts` mixes verified and unverified rows, and
 * `createExternalAccount` writes its row BEFORE the person has agreed to anything, so an
 * abandoned or refused consent leaves a permanent entry behind. Rendering that as an ordinary
 * connected provider claimed a sign-in method the person did not have — and, worse, made the
 * disconnect rule see two providers where there was one, so with no password set the only
 * working provider became removable. Clerk's own section splits the same way:
 * `[...user.verifiedExternalAccounts, ...user.unverifiedExternalAccounts.filter(a =>
 * a.verification?.error)]` (`@clerk/ui/dist/components/UserProfile/ConnectedAccountsSection.js:44`).
 *
 *   - verified → a way in. Listed, and governed by the lockout rule.
 *   - unverified WITH an error → a failure worth showing, with a retry and a free removal.
 *     It is not a way in, so the lockout rule is not consulted: nothing is lost by dropping it.
 *   - unverified with no error → a consent screen walked away from. Nothing to report, so it is
 *     shown nowhere and its provider stays on offer.
 */
export function ConnectedAccounts() {
  const { isLoaded, user } = useUser();
  const [busy, setBusy] = useState<string | null>(null);

  // The lookup is against the MIXED `externalAccounts` on purpose: this one call also clears a
  // failed connection away, and those live only in `unverifiedExternalAccounts`.
  const disconnect = useReverification(async (identificationId: string) => {
    const account = user?.externalAccounts.find((a) => a.identificationId === identificationId);
    if (!account) return false;
    await account.destroy();
    return true;
  });
  // Wrapped like Clerk's own (`ConnectedAccountsSection.js:73`): linking a provider is on the
  // spec's reverification list.
  const createExternalAccount = useReverification(
    (strategy: ConnectStrategy, redirectUrl: string) =>
      user ? user.createExternalAccount({ strategy, redirectUrl }) : Promise.resolve(null)
  );

  if (!isLoaded) {
    return <div className="h-16 animate-pulse rounded-lg bg-muted/40" aria-hidden />;
  }
  if (!user) return null;

  const methods = signInMethodsFromUser(user);
  const connected = connectedAccounts(user);
  const failed = failedAccounts(user);

  const anyBusy = busy !== null;

  /**
   * `busyKey` is the row (or button) that should read as working: the strategy for an offer
   * button, the account's identification id for a retry on a failed row.
   */
  const connect = async (
    strategy: ConnectStrategy,
    provider: string,
    label: string,
    busyKey: string
  ) => {
    setBusy(busyKey);
    try {
      const account = await createExternalAccount(strategy, callbackUrl());
      const next = account?.verification?.externalVerificationRedirectURL;
      // Defensive only — Clerk always returns a redirect URL for a strategy it accepted, so
      // this should never actually throw; it exists so a future change that breaks that
      // assumption fails loudly here rather than silently doing nothing.
      if (!next) throw new Error("no redirect");
      // Written only once the request has succeeded, so a failure leaves no note for the
      // callback route to misread. Last thing before the browser leaves.
      rememberPendingConnect({ provider: providerKey(provider), label });
      navigateAway(next.toString());
    } catch (err) {
      // Backing out of Clerk's "confirm it's you" prompt is a choice, not a failure.
      if (!isReverificationCancelledError(err)) {
        toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.connectFailed)));
      }
      setBusy(null);
    }
  };

  /**
   * `done` is passed in rather than built here, because the two callers are removing different
   * things: a working connection is disconnected, while a failed one was never connected and
   * saying "disconnected" about it would be untrue.
   */
  const remove = async (identificationId: string, done: string) => {
    setBusy(identificationId);
    try {
      const gone = await disconnect(identificationId);
      await user.reload();
      if (gone) toast.success(done);
    } catch (err) {
      if (isReverificationCancelledError(err)) return;
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setBusy(null);
    }
  };

  // Only a verified connection suppresses its offer, which is the line Clerk's own menu draws
  // (`ConnectedAccountsMenu.js:89`). `providerKey` folds `linkedin` and `linkedin_oidc`
  // together so a legacy connection cannot sit beside a "Connect LinkedIn" button.
  const connectedProviders = new Set(connected.map((a) => providerKey(a.providerSlug())));
  const offerable = CONNECTABLE.filter(({ provider }) => !connectedProviders.has(providerKey(provider)));

  return (
    <div className="space-y-4">
      {connected.length > 0 ? (
        <ul className="divide-y divide-border/60">
          {connected.map((account) => {
            const label = account.providerTitle();
            const verdict = canDisconnectAccount(methods, account.identificationId);
            const working = busy === account.identificationId;
            const reasonId = `connected-account-reason-${account.identificationId}`;
            return (
              <li key={account.identificationId} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{label}</p>
                  {account.emailAddress && (
                    <p className="truncate text-xs text-muted-foreground">{account.emailAddress}</p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={anyBusy || !verdict.allowed}
                  aria-label={`Disconnect ${label}`}
                  aria-describedby={verdict.allowed ? undefined : reasonId}
                  onClick={() => void remove(account.identificationId, `${label} disconnected`)}
                >
                  {working ? "Working…" : "Disconnect"}
                </Button>
                {!verdict.allowed && (
                  <p id={reasonId} className="w-full text-xs text-muted-foreground">
                    {verdict.reason}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No accounts connected yet</p>
      )}

      {failed.length > 0 && (
        <ul className="divide-y divide-border/60">
          {failed.map((account) => {
            const label = account.providerTitle();
            const working = busy === account.identificationId;
            const reasonId = `failed-account-reason-${account.identificationId}`;
            // Never the provider's own words: the error is a `ClerkAPIError`, so it goes
            // through the same table every other Clerk failure does. Its own fallback rather
            // than `TOAST_COPY.connectFailed`, which ends in "try again?" — beside a Try again
            // button, in a row that already says it is not connected, that reads as a stutter.
            const why = clerkApiErrorMessage(
              account.verification?.error,
              friendlyError(account.verification?.error, "The provider didn’t confirm it")
            );
            return (
              <li key={account.identificationId} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
                    <span className="truncate font-medium">{label}</span>
                    <Badge variant="outline">Not connected</Badge>
                  </p>
                  <p id={reasonId} className="text-xs text-muted-foreground">
                    {why}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={anyBusy}
                  aria-label={`Try connecting ${label} again`}
                  aria-describedby={reasonId}
                  onClick={() =>
                    void connect(
                      strategyForProvider(account.provider),
                      account.provider,
                      label,
                      account.identificationId
                    )
                  }
                >
                  {working ? "Working…" : "Try again"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={anyBusy}
                  aria-label={`Remove the failed ${label} connection`}
                  onClick={() =>
                    void remove(account.identificationId, `${label} connection removed`)
                  }
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {offerable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {offerable.map(({ strategy, provider, label }) => (
            <Button
              key={strategy}
              type="button"
              variant="outline"
              size="sm"
              disabled={anyBusy}
              aria-label={`Connect ${label}`}
              onClick={() => void connect(strategy, provider, label, strategy)}
            >
              {busy === strategy ? "Working…" : `Connect ${label}`}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
