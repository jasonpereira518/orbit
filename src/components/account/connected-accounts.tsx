"use client";

import { useState } from "react";
import { useUser, useReverification } from "@clerk/nextjs";
import { isReverificationCancelledError } from "@clerk/nextjs/errors";
import { Button } from "@/components/ui/button";
import { canDisconnectAccount, type SignInMethods } from "@/lib/sign-in-methods";
import { clerkErrorMessage } from "@/lib/clerk-errors";
import { friendlyError } from "@/lib/errors";
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
 * values (`@clerk/shared/dist/types/oauth.d.mts`), and only the one actually enabled in the
 * dashboard works — the other fails at connect time. Which one is enabled could not be
 * determined from this repo; `oauth_linkedin_oidc` is used here because it's Clerk's current
 * recommended LinkedIn integration (the plain `linkedin` provider is the deprecated one this
 * Clerk version keeps only for back-compat). **Unconfirmed — settle this in the live pass.**
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
 * questions, and the browser returns to CALLBACK, which finishes the handshake and comes
 * back here. Disconnecting stays put, and is refused when it would be the last way in —
 * that rule lives in `@/lib/sign-in-methods`.
 */
export function ConnectedAccounts() {
  const { isLoaded, user } = useUser();
  const [busy, setBusy] = useState<string | null>(null);

  const disconnect = useReverification(async (identificationId: string) => {
    const account = user?.externalAccounts.find((a) => a.identificationId === identificationId);
    if (!account) return false;
    await account.destroy();
    return true;
  });

  if (!isLoaded) {
    return <div className="h-16 animate-pulse rounded-lg bg-muted/40" aria-hidden />;
  }
  if (!user) return null;

  const methods: SignInMethods = {
    emails: user.emailAddresses.map((e) => ({
      id: e.id,
      verified: e.verification?.status === "verified",
    })),
    externalAccountIds: user.externalAccounts.map((a) => a.identificationId),
    hasPassword: user.passwordEnabled,
    primaryEmailId: user.primaryEmailAddressId,
  };

  const anyBusy = busy !== null;

  const connect = async (strategy: ConnectStrategy) => {
    setBusy(strategy);
    try {
      const account = await user.createExternalAccount({ strategy, redirectUrl: CALLBACK });
      const next = account.verification?.externalVerificationRedirectURL;
      // Defensive only — Clerk always returns a redirect URL for a strategy it accepted, so
      // this should never actually throw; it exists so a future change that breaks that
      // assumption fails loudly here rather than silently doing nothing.
      if (!next) throw new Error("no redirect");
      navigateAway(next.toString());
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
      setBusy(null);
    }
  };

  const remove = async (identificationId: string, label: string) => {
    setBusy(identificationId);
    try {
      const gone = await disconnect(identificationId);
      await user.reload();
      if (gone) toast.success(`${label} disconnected`);
    } catch (err) {
      if (isReverificationCancelledError(err)) return;
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setBusy(null);
    }
  };

  const connectedProviders = new Set(user.externalAccounts.map((a) => a.providerSlug()));
  const offerable = CONNECTABLE.filter(({ provider }) => !connectedProviders.has(provider));

  return (
    <div className="space-y-4">
      {user.externalAccounts.length > 0 ? (
        <ul className="divide-y divide-border/60">
          {user.externalAccounts.map((account) => {
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
                  onClick={() => void remove(account.identificationId, label)}
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
      {offerable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {offerable.map(({ strategy, label }) => (
            <Button
              key={strategy}
              type="button"
              variant="outline"
              size="sm"
              disabled={anyBusy}
              aria-label={`Connect ${label}`}
              onClick={() => void connect(strategy)}
            >
              {busy === strategy ? "Working…" : `Connect ${label}`}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
