"use client";

import { useState, useTransition } from "react";
import { Copy, EyeOff, Globe, MailPlus, Send, XCircle } from "lucide-react";
import {
  inviteToSiteAction,
  revokeSiteInviteAction,
  setSiteStealthAction,
} from "@/actions/admin";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import type { SiteInviteResult } from "@/lib/site-invites";
import { cn } from "@/lib/utils";

const BUTTON =
  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors duration-fast";

function copyLink(url: string) {
  navigator.clipboard
    .writeText(url)
    .then(() => toast.success(TOAST_COPY.copied))
    .catch(() => toast.error(TOAST_COPY.copyFailed));
}

/**
 * The stealth switch. Confirmed and reasoned through `ConfirmActionDialog` rather than a bare
 * toggle: switching it off opens every page to the public, and "who opened the site, when,
 * why" belongs in the audit log.
 */
export function StealthSwitch({
  stealth,
  fromConsole,
  stealthSinceLabel,
}: {
  stealth: boolean;
  fromConsole: boolean;
  stealthSinceLabel: string | null;
}) {
  // Stealth from `SITE_STEALTH` alone has no start date, so no account is being checked for an
  // invitation yet — see `src/lib/site-access.ts`. Saving it "on" here dates it.
  const unguarded = stealth && !stealthSinceLabel;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm">
            {stealth ? (
              <EyeOff className="size-3.5 text-primary" aria-hidden />
            ) : (
              <Globe className="size-3.5 text-muted-foreground" aria-hidden />
            )}
            {stealth ? "Stealth is on" : "The site is public"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {stealth
              ? "Anyone without an account is sent to the waitlist from every page. People with an account sign in at /sign-in and use Orbit as usual; new accounts need an invitation."
              : "Every public page is open and anyone can create an account."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {fromConsole
              ? stealth && stealthSinceLabel
                ? `On since ${stealthSinceLabel}.`
                : "Set from this console."
              : "Set by the SITE_STEALTH environment variable. Changing it here takes over from it."}{" "}
            Changes reach every server within about ten seconds.
          </p>
        </div>

        {/* Keyed on the state so the refresh after a switch remounts it: otherwise the
            closing dialog's fade shows the OPPOSITE action's title for a moment. */}
        <ConfirmActionDialog
          key={String(stealth)}
          trigger={
            <span
              className={cn(
                BUTTON,
                stealth
                  ? "border-destructive/40 text-destructive hover:bg-destructive/10"
                  : "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
              )}
            >
              {stealth ? <Globe className="size-3" aria-hidden /> : <EyeOff className="size-3" aria-hidden />}
              {stealth ? "Open the site" : "Turn on stealth"}
            </span>
          }
          title={stealth ? "Open the site to everyone?" : "Put the site in stealth?"}
          description={
            stealth
              ? "Every page becomes public and anyone can create an account without an invitation. Waitlist links keep working."
              : "Everyone without an account is sent to the waitlist from every page. Existing accounts keep working. Accounts created from now on need an invitation."
          }
          confirmLabel={stealth ? "Open the site" : "Turn on stealth"}
          danger={stealth}
          onConfirm={(reason) => setSiteStealthAction({ enabled: !stealth, reason })}
        />
      </div>

      {unguarded && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            New accounts aren’t checked for an invitation yet, because stealth came from the
            environment and has no start date. A Google sign-in could still create an account.
            Save stealth here to start checking every account created from now on.
          </p>
          <ConfirmActionDialog
            trigger={<span className={cn(BUTTON, "border-border/70 hover:text-foreground")}>Start checking</span>}
            title="Start checking new accounts?"
            description="Stealth stays on. Accounts created from now on need an invitation to get in. Every account that exists today keeps working."
            confirmLabel="Start checking"
            onConfirm={(reason) => setSiteStealthAction({ enabled: true, reason })}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Invite one address. The result stays on screen with the link, because the link is the
 * deliverable when "email it" is off, and worth having either way.
 */
function inviteResultMessage(result: SiteInviteResult, asked: boolean) {
  const bounced = asked && !result.emailed ? " The email didn’t send, so copy the link below." : "";
  if (result.kind === "existing-account") {
    return result.emailed
      ? `${result.email} already has an account. It’s now let in, and their pass is on its way.`
      : `${result.email} already has an account. It’s now let in — send them the sign-in link.${bounced}`;
  }
  return result.emailed
    ? `Boarding pass emailed to ${result.email}. The link is here too.`
    : `Invitation created for ${result.email}.${bounced || " Send them this link — it works once and expires in 30 days."}`;
}

export function InviteForm({ clerkOn }: { clerkOn: boolean }) {
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [notify, setNotify] = useState(true);
  const [result, setResult] = useState<SiteInviteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;
    setError(null);
    setResult(null);
    start(async () => {
      try {
        const res = await inviteToSiteAction({ email, notify, firstName });
        if (res.kind === "error") {
          setError(res.message);
          return;
        }
        setResult(res);
        setEmail("");
        setFirstName("");
      } catch (err) {
        setError(friendlyError(err, "Couldn’t create that invitation — try again?"));
      }
    });
  }

  if (!clerkOn) {
    return (
      <p className="text-sm text-muted-foreground">
        Invitations are Clerk invitations, and this server has no Clerk keys.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com"
          aria-label="Email address to invite"
          disabled={pending}
          className="h-8 w-64 max-w-full text-sm"
        />
        <Input
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder="First name (optional)"
          aria-label="Their first name, for the email greeting"
          maxLength={60}
          disabled={pending || !notify}
          className="h-8 w-44 max-w-full text-sm"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            disabled={pending}
            className="size-3.5 accent-[var(--primary)]"
          />
          Email them the link
        </label>
        <Button type="submit" size="sm" disabled={pending || !email.trim()}>
          {notify ? <Send className="size-3.5" aria-hidden /> : <MailPlus className="size-3.5" aria-hidden />}
          {pending ? "Inviting…" : notify ? "Send invite" : "Create link"}
        </Button>
      </form>

      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      {result && (
        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-3" role="status">
          <p className="text-xs text-muted-foreground">
            {inviteResultMessage(result, notify)}
          </p>
          {result.url ? (
            <div className="flex gap-2">
              <Input readOnly value={result.url} className="h-8 font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button type="button" variant="outline" size="icon" aria-label="Copy link" onClick={() => copyLink(result.url!)}>
                <Copy className="size-4" aria-hidden />
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Clerk didn’t return a link for this one.</p>
          )}
        </div>
      )}
    </div>
  );
}

export function InviteRowActions({
  id,
  email,
  url,
}: {
  id: string;
  email: string;
  url: string | null;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      {url && (
        <button
          type="button"
          onClick={() => copyLink(url)}
          className={cn(BUTTON, "border-border/70 px-2 text-muted-foreground hover:text-foreground")}
        >
          <Copy className="size-3" aria-hidden />
          Copy link
        </button>
      )}
      <ConfirmActionDialog
        trigger={
          <span className={cn(BUTTON, "border-destructive/40 px-2 text-destructive hover:bg-destructive/10")}>
            <XCircle className="size-3" aria-hidden />
            Revoke
          </span>
        }
        title="Revoke this invitation?"
        description={
          <>
            The link sent to <span className="font-medium text-ink">{email}</span> stops
            working. While stealth is on they’re back to the waitlist; you can invite them
            again later.
          </>
        }
        confirmLabel="Revoke"
        danger
        onConfirm={(reason) => revokeSiteInviteAction({ invitationId: id, reason })}
      />
    </div>
  );
}
