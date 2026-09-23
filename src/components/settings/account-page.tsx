"use client";

/**
 * The frame every account page (Google, Microsoft) is drawn in, and the row it is made of.
 *
 * The page is "connect once, then a row per feature", replacing the stack of cards each
 * account used to have — one for contacts, one for the inbox scan — where every card repeated
 * the same account line, the same Connect button and the same Disconnect. The account is
 * stated once, at the top; below it each feature answers for itself.
 *
 * ## What the shell renders, in order
 *
 * 1. `loading` — a skeleton. The cards this replaces rendered NOTHING at all until the status
 *    landed (`if (!status) return null`), so opening the page showed an empty panel that
 *    suddenly filled.
 * 2. `failed` — "Couldn't check your {Provider} connection." and **Try again**. Also nothing,
 *    before: a status fetch that rejected left the same empty panel forever.
 * 3. `not_configured` — this deployment has no credentials for the provider. Nothing to
 *    connect, so no button.
 * 4. `not_connected` — the connect prompt: what Orbit will ask for, and what it will never do.
 * 5. `needs_reauth` — the account signed Orbit out. The header still names it (so Switch
 *    account and Disconnect stay reachable), the notice says what happened, and the rows below
 *    render dimmed and `inert`: their capabilities are empty in this state, so every control
 *    would be a no-op anyway, and making that visible is better than letting them look live.
 * 6. otherwise — the header, then the rows.
 *
 * The shell owns no data. `useGoogleConnection` / `useMicrosoftConnection` own the status and
 * the sign-in return for the page; this takes the four things it needs as props so that a page
 * has exactly one owner of the OAuth return (`use-provider-connection.ts` explains why two
 * would race each other's `history.replaceState`).
 */

import { useId, useState } from "react";
import { Check, Lock, MoreHorizontal } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { DisconnectAccountDialog } from "@/components/settings/disconnect-account-dialog";
import type { AccountProvider, AccountStatus, RowControl } from "@/lib/integration-status";
import type { DisconnectProvider } from "@/lib/data-categories";
import { cn } from "@/lib/utils";

const PROVIDER_NAME: Record<AccountProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

/** The disconnect dialog is keyed by the connection it deletes, which predates these pages. */
const DISCONNECT_PROVIDER: Record<AccountProvider, DisconnectProvider> = {
  google: "gmail",
  microsoft: "outlook",
};

export function AccountPageShell({
  provider,
  account,
  loading,
  failed,
  onRetry,
  onConnect,
  onDisconnect,
  children,
}: {
  provider: AccountProvider;
  /** Null while the status is still loading, or if it never arrived. */
  account: AccountStatus | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  /** Both Connect and Switch account: switching accounts is connecting again. */
  onConnect: () => void;
  onDisconnect: (opts: { alsoDelete: boolean }) => void;
  /** The feature rows. */
  children: React.ReactNode;
}) {
  const name = PROVIDER_NAME[provider];

  if (loading) return <AccountSkeleton name={name} />;

  if (failed) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Couldn’t check your {name} connection.</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  // Settled without an error but with nothing to show: keep the placeholder rather than an
  // empty page, which is what the cards this replaces did here.
  if (!account) return <AccountSkeleton name={name} />;

  if (account.state === "not_configured") {
    return (
      <section className="space-y-2 rounded-2xl border border-dashed border-border/70 bg-card/50 p-5">
        <h2 className="text-lg font-medium text-ink">{name}</h2>
        <p className="text-sm text-muted-foreground">
          This copy of Orbit can’t connect {name} accounts. You can still bring people in from a
          file on the Imports page.
        </p>
      </section>
    );
  }

  if (account.state === "not_connected") {
    return <ConnectPrompt name={name} onConnect={onConnect} />;
  }

  const signedOut = account.state === "needs_reauth";

  return (
    <div className="space-y-4">
      <AccountHeader
        provider={provider}
        name={name}
        email={account.email}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
      />

      {signedOut ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warning/10 p-4 text-sm text-warning">
          <p className="min-w-0 flex-1">
            {name} signed Orbit out. Sign in again to keep things up to date.
          </p>
          <Button size="sm" onClick={onConnect}>
            Sign in again
          </Button>
        </div>
      ) : null}

      {/* `inert` rather than `disabled` on each control: in this state the account has no
          capabilities at all, so every row's control is already a no-op, and one attribute
          keeps them out of the tab order without each row needing to know why. */}
      <ul inert={signedOut} className={cn("-my-1", signedOut && "opacity-60")}>
        {children}
      </ul>
    </div>
  );
}

/**
 * One feature. The icon, the name, one line of description, the control on the right, and —
 * for a feature that expands where it stands — whatever it opens beneath: the contacts review
 * list, the scan in progress.
 *
 * A bordered list item rather than a card: the dialog panel already supplies the chrome, and
 * five cards down a page is the stack these rows exist to replace.
 */
export function FeatureRow({
  id,
  icon,
  title,
  description,
  control,
  onAction,
  disabled,
  children,
}: {
  /** Anchor for a link that opens the page at one row — `?integration=gmail` at the inbox. */
  id?: string;
  icon: React.ReactNode;
  title: string;
  /** A node, so a row can carry a link — "Turn on AI" — inside its own sentence. */
  description: React.ReactNode;
  control: RowControl;
  /** The action, the switch and the locked row's Upgrade all report through this. */
  onAction: () => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const titleId = useId();

  return (
    <li
      id={id}
      className="scroll-mt-4 border-b border-border/60 py-4 first:pt-1 last:border-b-0 last:pb-1"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p id={titleId} className="text-sm font-medium text-ink">
            {title}
          </p>
          <p className="mt-0.5 text-sm leading-snug text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center pt-0.5">
          <RowControlButton
            control={control}
            disabled={disabled}
            labelledBy={titleId}
            onAction={onAction}
          />
        </div>
      </div>
      {children ? <div className="mt-3 space-y-3 sm:pl-11">{children}</div> : null}
    </li>
  );
}

function RowControlButton({
  control,
  disabled,
  labelledBy,
  onAction,
}: {
  control: RowControl;
  disabled?: boolean;
  labelledBy: string;
  onAction: () => void;
}) {
  switch (control.kind) {
    case "action":
      return (
        <Button variant="outline" size="sm" disabled={disabled} onClick={onAction}>
          {control.label}
        </Button>
      );
    case "locked":
      return (
        <Button variant="outline" size="sm" disabled={disabled} onClick={onAction}>
          <Lock aria-hidden />
          {control.label}
        </Button>
      );
    case "switch":
      return (
        <button
          type="button"
          role="switch"
          aria-checked={control.on}
          // Named by the row's own title, so the switch never needs a label of its own that
          // could drift from it.
          aria-labelledby={labelledBy}
          disabled={disabled}
          onClick={onAction}
          className={cn(
            "tap-target relative inline-flex h-5 w-9 shrink-0 items-center rounded-full outline-none transition-colors duration-fast ease-house focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
            control.on ? "bg-primary" : "bg-muted-foreground/30"
          )}
        >
          <span
            aria-hidden
            className={cn(
              "pointer-events-none size-4 rounded-full bg-background shadow-sm transition-transform duration-fast ease-house",
              control.on ? "translate-x-[1.125rem]" : "translate-x-0.5"
            )}
          />
        </button>
      );
    case "none":
      return null;
  }
}

function AccountHeader({
  provider,
  name,
  email,
  onConnect,
  onDisconnect,
}: {
  provider: AccountProvider;
  name: string;
  email: string | null;
  onConnect: () => void;
  onDisconnect: (opts: { alsoDelete: boolean }) => void;
}) {
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  return (
    <div className="flex items-center gap-3">
      <Avatar>
        <AvatarFallback className="text-xs font-medium">{initials(email, name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{name}</p>
        <p className="truncate text-sm text-muted-foreground">{email ?? "Connected"}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${name} account options`}
              className="tap-target relative"
            >
              <MoreHorizontal aria-hidden />
            </Button>
          }
        />
        {/* The popup is as wide as its anchor by default, and the anchor here is one icon. */}
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuItem onClick={onConnect}>Switch account</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirmingDisconnect(true)}>
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Controlled: the menu item above is the trigger, so the dialog renders none itself. */}
      <DisconnectAccountDialog
        provider={DISCONNECT_PROVIDER[provider]}
        open={confirmingDisconnect}
        onOpenChange={setConfirmingDisconnect}
        onConfirm={onDisconnect}
      />
    </div>
  );
}

function ConnectPrompt({ name, onConnect }: { name: string; onConnect: () => void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Bring in your contacts and log your meetings from your {name} account.
      </p>
      <Button onClick={onConnect}>Connect {name}</Button>
      <div className="space-y-2 rounded-xl bg-muted/40 p-4">
        <p className="text-sm font-medium text-ink">Orbit will ask to</p>
        <ul className="space-y-1.5">
          {["See your contacts", "See your calendar"].map((line) => (
            <li key={line} className="flex items-center gap-2 text-sm text-muted-foreground">
              <Check aria-hidden className="size-4 shrink-0 text-primary" />
              {line}
            </li>
          ))}
        </ul>
        <p className="text-xs leading-snug text-muted-foreground">
          It never changes, sends or deletes anything in your {name} account. Mail features ask
          separately, only if you turn them on.
        </p>
      </div>
    </div>
  );
}

function AccountSkeleton({ name }: { name: string }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-label={`Loading your ${name} connection`}>
      <div className="flex items-center gap-3">
        <Skeleton className="size-8 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-3.5 w-44" />
        </div>
      </div>
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-3 border-t border-border/60 pt-4">
          <Skeleton className="size-8 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-3/4" />
          </div>
          <Skeleton className="h-7 w-24 rounded-lg" />
        </div>
      ))}
    </div>
  );
}

/** Two letters for the header's avatar — from the address, or the provider when there is none. */
function initials(email: string | null, name: string): string {
  const local = (email ?? "").split("@")[0] ?? "";
  const letters = local.replace(/[^a-zA-Z0-9]/g, "");
  return (letters.slice(0, 2) || name.slice(0, 1)).toUpperCase();
}
