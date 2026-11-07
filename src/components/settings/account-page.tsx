"use client";

/**
 * The frame every account page (Google, Microsoft, LinkedIn, Granola) is drawn in, and the row
 * it is made of: the account stated once at the top — logo, name, account, a status line, one
 * main action, a ··· menu — then a row per feature. Each page passes its own pieces; the frame
 * draws them the same way, in its brand theme (`provider-themes.ts`).
 *
 * ## What the shell renders, in order
 *
 * 1. `loading` — a skeleton shaped like the header and three rows.
 * 2. `failed` AND no status yet — "Couldn't check your {name} connection." and **Try again**.
 *    The order is load-bearing: a re-read that fails after a good one leaves `account` in place,
 *    and a status in hand outranks a failed refresh (it would otherwise swap a working page for
 *    an error right after a success toast).
 * 3. `not_configured` — this deployment has no credentials for the provider.
 * 4. `not_connected` — the connect prompt: what Orbit will ask for, and what it will never do.
 * 5. `needs_reauth` — the header still names the account (so the menu stays reachable), a notice
 *    says what happened, and the rows render dimmed and `inert`.
 * 6. otherwise — the header, the strip, then the rows.
 *
 * The shell owns no data: each page's connection hook owns the status and the sign-in return,
 * so a page has exactly one owner of the OAuth return (`use-provider-connection.ts`).
 */

import { useId, useState } from "react";
import { formatDistance } from "date-fns";
import { Check, Lock, MoreHorizontal } from "lucide-react";
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
import type { ProviderTheme } from "@/components/settings/provider-themes";
import type { AccountStatus, PageStatus, RowControl } from "@/lib/integration-status";
import type { DisconnectProvider } from "@/lib/data-categories";
import { cn } from "@/lib/utils";

/** The line under the account: a dot and a few words ("Synced 5 minutes ago"). */
export type HeaderStatus = {
  state: Exclude<PageStatus["state"], "none">;
  detail: string;
  /** Pulses the dot: a sync is running. */
  busy?: boolean;
  /** Hover text, e.g. the last error. */
  title?: string;
};

export type HeaderAction = { label: string; icon?: React.ReactNode; onClick: () => void; disabled?: boolean };
export type HeaderMenuItem = { label: string; onSelect: () => void };

/** What the not-connected state says before the Connect button. */
export type ConnectCopy = {
  intro: string;
  asksTitle: string;
  asks: readonly string[];
  note: string;
};

const DEFAULT_CONNECT = (name: string): ConnectCopy => ({
  intro: `Bring in your contacts and log your meetings from your ${name} account.`,
  asksTitle: "Orbit will ask to",
  asks: ["See your contacts", "See your calendar"],
  note: `It never changes, sends or deletes anything in your ${name} account. Mail features ask separately, only if you turn them on.`,
});

export function AccountPageShell({
  name,
  mark,
  theme,
  account,
  loading,
  failed,
  onRetry,
  onConnect,
  connectCopy,
  connectError,
  connectBusy,
  status,
  primaryAction,
  menuItems = [],
  disconnect,
  signedOutText,
  children,
}: {
  name: string;
  /** The provider's logo, drawn in the header's white tile. */
  mark: React.ReactNode;
  theme: ProviderTheme;
  /** Null while the status is still loading, or if it never arrived. */
  account: AccountStatus | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  /** Connect, and the signed-out notice's Sign in again. */
  onConnect: () => void;
  connectCopy?: ConnectCopy;
  /** Shown under the Connect button, e.g. after a sign-in that came back refused. */
  connectError?: string | null;
  connectBusy?: boolean;
  status?: HeaderStatus;
  /** The one button beside the name: Sync now, Upload export. Hidden while signed out. */
  primaryAction?: HeaderAction;
  /** The ··· menu's items, before Disconnect. */
  menuItems?: readonly HeaderMenuItem[];
  /** Adds "Disconnect…" to the menu, confirmed through `DisconnectAccountDialog`. */
  disconnect?: {
    provider: DisconnectProvider;
    onConfirm: (opts: { alsoDelete: boolean }) => void;
    /** `undefined` is "not known", which keeps the dialog's delete offer. */
    hasDeletableData?: boolean;
  };
  signedOutText?: string;
  /** The feature rows. */
  children: React.ReactNode;
}) {
  const frame = (body: React.ReactNode) => <div className={theme.className}>{body}</div>;

  if (loading) return frame(<AccountSkeleton name={name} />);

  // `&& !account`: a refresh that failed leaves the last good status in place. See above.
  if (failed && !account) return frame(<LoadError what={`${name} connection`} verb="check" onRetry={onRetry} />);

  // Settled without an error but with nothing to show: keep the placeholder.
  if (!account) return frame(<AccountSkeleton name={name} />);

  if (account.state === "not_configured") {
    return frame(
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
    return frame(
      <ConnectPrompt
        name={name}
        mark={mark}
        theme={theme}
        copy={connectCopy ?? DEFAULT_CONNECT(name)}
        error={connectError}
        busy={connectBusy}
        onConnect={onConnect}
      />
    );
  }

  const signedOut = account.state === "needs_reauth";

  return frame(
    <div className="space-y-4">
      <AccountHeader
        name={name}
        mark={mark}
        accountLine={account.email}
        status={status}
        primaryAction={signedOut ? undefined : primaryAction}
        menuItems={menuItems}
        disconnect={disconnect}
      />
      <BrandStrip theme={theme} />

      {signedOut ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warning/10 p-4 text-sm text-warning">
          <p className="min-w-0 flex-1">
            {signedOutText ?? `${name} signed Orbit out. Sign in again to keep things up to date.`}
          </p>
          <Button size="sm" onClick={onConnect}>
            Sign in again
          </Button>
        </div>
      ) : null}

      {/* `inert` rather than `disabled` on each control: in this state every row's control is
          already a no-op, and one attribute keeps them out of the tab order. */}
      <ul inert={signedOut} className={cn("-my-1", signedOut && "opacity-60")}>
        {children}
      </ul>
    </div>
  );
}

/** Google's bar of four, Microsoft's square panes, or one solid bar. Decorative. */
function BrandStrip({ theme }: { theme: ProviderTheme }) {
  if (theme.stripeVariant === "tiles") {
    return (
      <div aria-hidden className="flex gap-[3px]">
        {theme.stripe.map((color) => (
          <span key={color} className="size-2.5" style={{ backgroundColor: color }} />
        ))}
      </div>
    );
  }
  return (
    <div aria-hidden className="flex h-1 overflow-hidden rounded-full">
      {theme.stripe.map((color) => (
        <span key={color} className="flex-1" style={{ backgroundColor: color }} />
      ))}
    </div>
  );
}

/** The status line for an account that syncs: Google, Microsoft, Granola. */
export function syncStatusLine({
  signedOut,
  syncing,
  lastSyncedAt,
  error,
}: {
  signedOut: boolean;
  syncing: boolean;
  lastSyncedAt: string | Date | null | undefined;
  /** Never shown verbatim (it can be a raw provider body) — only as hover text. */
  error?: string | null;
}): HeaderStatus {
  if (signedOut) return { state: "partial", detail: "Signed out — sign in again" };
  if (syncing) return { state: "on", detail: "Syncing…", busy: true };
  if (error) return { state: "partial", detail: "Last sync hit a problem", title: error };
  if (lastSyncedAt) return { state: "on", detail: `Synced ${whenLine(lastSyncedAt)}` };
  return { state: "on", detail: "First sync is running", busy: true };
}

/**
 * A read that failed, with the way back. One wording everywhere: "Couldn't load your API keys."
 * (`verb="check"` for a connection, which is checked rather than loaded).
 */
export function LoadError({
  what,
  verb = "load",
  onRetry,
}: {
  what: string;
  verb?: "load" | "check";
  onRetry: () => void;
}) {
  return (
    <div className="space-y-3" role="alert">
      <p className="text-sm text-muted-foreground">
        Couldn’t {verb} your {what}.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * When something happened, for a status or history line: "5 minutes ago" inside a week, then
 * the date ("Nov 6", with the year once it isn't this one).
 */
export function whenLine(at: Date | string | number, now: Date = new Date()): string {
  const date = new Date(at);
  if (now.getTime() - date.getTime() < 7 * 24 * 60 * 60 * 1000) return formatDistance(date, now, { addSuffix: true });
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
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
  tone,
  children,
}: {
  /**
   * A brand color (hex) for the icon tile: the tile is a soft wash of it, the icon the color
   * itself. Decorative — the title names the row. Leave out for the neutral tile.
   */
  tone?: string;
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
          style={
            tone
              ? { backgroundColor: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone }
              : undefined
          }
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
  name,
  mark,
  accountLine,
  status,
  primaryAction,
  menuItems,
  disconnect,
}: {
  name: string;
  mark: React.ReactNode;
  accountLine: string | null;
  status?: HeaderStatus;
  primaryAction?: HeaderAction;
  menuItems: readonly HeaderMenuItem[];
  disconnect?: React.ComponentProps<typeof AccountPageShell>["disconnect"];
}) {
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const hasMenu = menuItems.length > 0 || disconnect;

  return (
    // Wraps on a phone: the actions drop to their own line rather than squeezing the name.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <MarkTile mark={mark} />
      <div className="min-w-0 flex-1 basis-40">
        <h2 className="text-sm font-medium text-ink">{name}</h2>
        {accountLine ? <p className="truncate text-sm text-muted-foreground">{accountLine}</p> : null}
        {status ? (
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground" title={status.title}>
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                status.state === "on" && "bg-primary",
                status.state === "partial" && "bg-warning",
                status.state === "off" && "bg-muted-foreground/35",
                status.busy && "animate-pulse"
              )}
            />
            {status.detail}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {primaryAction ? (
          <Button variant="outline" size="sm" disabled={primaryAction.disabled} onClick={primaryAction.onClick}>
            {primaryAction.icon}
            {primaryAction.label}
          </Button>
        ) : null}
        {hasMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={`${name} options`} className="tap-target relative">
                  <MoreHorizontal aria-hidden />
                </Button>
              }
            />
            {/* The popup is as wide as its anchor by default, and the anchor here is one icon. */}
            <DropdownMenuContent align="end" className="w-auto min-w-40">
              {menuItems.map((item) => (
                <DropdownMenuItem key={item.label} onClick={item.onSelect}>
                  {item.label}
                </DropdownMenuItem>
              ))}
              {disconnect ? (
                <>
                  {menuItems.length ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirmingDisconnect(true)}>
                    Disconnect…
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {disconnect ? (
        // Controlled: the menu item above is the trigger, so the dialog renders none itself.
        <DisconnectAccountDialog
          provider={disconnect.provider}
          open={confirmingDisconnect}
          onOpenChange={setConfirmingDisconnect}
          onConfirm={disconnect.onConfirm}
          hasDeletableData={disconnect.hasDeletableData}
        />
      ) : null}
    </div>
  );
}

/** The logo in a white rounded tile, the same size on every account page. */
function MarkTile({ mark }: { mark: React.ReactNode }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-border/60 [&>*]:size-6">
      {mark}
    </span>
  );
}

function ConnectPrompt({
  name,
  mark,
  theme,
  copy,
  error,
  busy,
  onConnect,
}: {
  name: string;
  mark: React.ReactNode;
  theme: ProviderTheme;
  copy: ConnectCopy;
  error?: string | null;
  busy?: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <MarkTile mark={mark} />
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-ink">{name}</h2>
          <p className="text-sm text-muted-foreground">{copy.intro}</p>
        </div>
      </div>
      <BrandStrip theme={theme} />
      <div className="space-y-2 rounded-xl bg-muted/40 p-4">
        <p className="text-sm font-medium text-ink">{copy.asksTitle}</p>
        <ul className="space-y-1.5">
          {copy.asks.map((line) => (
            <li key={line} className="flex items-center gap-2 text-sm text-muted-foreground">
              <Check aria-hidden className="size-4 shrink-0 text-primary" />
              {line}
            </li>
          ))}
        </ul>
        <p className="text-xs leading-snug text-muted-foreground">{copy.note}</p>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button disabled={busy} onClick={onConnect}>
        Connect {name}
      </Button>
    </div>
  );
}

function AccountSkeleton({ name }: { name: string }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-label={`Loading your ${name} connection`}>
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-xl" />
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
