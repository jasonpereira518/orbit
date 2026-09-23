"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { LucideIcon } from "lucide-react";
import { Laptop, Mail, ShieldCheck, UserRound } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AccountDemoPanel } from "@/components/account/account-demo-panel";
import { AddEmailDialog } from "@/components/account/add-email-dialog";
import { ConnectedAccounts } from "@/components/account/connected-accounts";
import { DevicesList } from "@/components/account/devices-list";
import { EmailList } from "@/components/account/email-list";
import { ProfileForm } from "@/components/account/profile-form";
import { DeleteAccountDialog } from "@/components/settings/delete-account-dialog";
import { SettingsSection, SettingsSurfaceProvider } from "@/components/settings/settings-section";
import { cn } from "@/lib/utils";

/**
 * The rail, in the order the spec fixes: Profile, Sign-in, Security, Devices. One list so
 * the rail and `scripts/smoke-account-routes.ts` cannot drift the way `ACCOUNT_TABS` and its
 * smoke used to for the routed version.
 */
const ACCOUNT_SECTIONS = [
  { id: "profile", label: "Profile", icon: UserRound },
  { id: "sign-in", label: "Sign-in", icon: Mail },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "devices", label: "Devices", icon: Laptop },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: LucideIcon }>;

type AccountSectionId = (typeof ACCOUNT_SECTIONS)[number]["id"];

const MD_QUERY = "(min-width: 768px)";

/**
 * Side rail on `md`+, a horizontal strip below the title on a phone — `aria-orientation` has
 * to say which. Copied from `integrations-dialog.tsx`'s `useIsWide`, whose rail this one is
 * built to look and behave like.
 */
function useIsWide() {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(MD_QUERY);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(MD_QUERY).matches,
    () => true
  );
}

/**
 * The account experience, as a dialog rather than a route.
 *
 * Replaces the `/settings/account` page tree (see the 2026-09-23 amendment in
 * `docs/superpowers/specs/2026-09-22-account-page-clerk-revision-design.md`). The section
 * components underneath — `ProfileForm`, `EmailList`, `AddEmailDialog`, `ConnectedAccounts`,
 * `DevicesList` — are unchanged from the pages that used to render them; every Clerk hook
 * inside them still assumes it is mounted only when `clerkOn` is true, which is exactly the
 * gate `AccountPanel` applies before rendering any of them.
 *
 * Selected section is local `useState`, never the URL: a server action queued during a
 * `history.replaceState` restore hangs in this repo (see `orbit-replacestate-drops-server-
 * actions`), and tab switching here fires actions on nearly every interaction. `onOpenChange`
 * is the dialog's real close/open, and `onOpenChangeComplete` resets the section back to
 * Profile only once Base UI's exit animation has actually finished — resetting it any earlier
 * would flash Profile's content in place of whatever was showing while the dialog is still
 * animating away.
 */
export function AccountDialog({
  open,
  onOpenChange,
  clerkOn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clerkOn: boolean;
}) {
  const [section, setSection] = useState<AccountSectionId>("profile");

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) setSection("profile");
      }}
    >
      <DialogContent
        className={cn(
          "flex h-[min(85dvh,40rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl",
          "md:grid md:grid-cols-[12rem_minmax(0,1fr)]"
        )}
      >
        <AccountDialogBody section={section} onSectionChange={setSection} clerkOn={clerkOn} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The rail plus the content pane.
 *
 * Panels mount the first time their section is visited and then stay mounted (hidden) for
 * as long as the dialog is open — the same rule `integrations-dialog.tsx` uses, and for the
 * same reason: `ProfileForm` keeps its typed-but-unsaved name in local state, and unmounting
 * it on every rail click threw that state away the instant someone switched sections to
 * check something else. `clerkOn` is threaded down to `AccountPanel` rather than gating
 * anything here, so a signed-in demo account still gets a working rail and a working danger
 * zone — only the Clerk-backed pieces of each section fall back to `AccountDemoPanel`.
 */
function AccountDialogBody({
  section,
  onSectionChange,
  clerkOn,
}: {
  section: AccountSectionId;
  onSectionChange: (section: AccountSectionId) => void;
  clerkOn: boolean;
}) {
  const wide = useIsWide();
  const [visited, setVisited] = useState<ReadonlySet<AccountSectionId>>(() => new Set([section]));
  const tabRefs = useRef(new Map<AccountSectionId, HTMLButtonElement>());
  const panelScroller = useRef<HTMLDivElement>(null);

  // Adjusting state during render rather than in an effect: a section chosen from outside
  // (nothing does that today, but the dialog's own reset-to-Profile is exactly this shape)
  // must be mounted in the same paint it is shown in.
  if (!visited.has(section)) setVisited(new Set(visited).add(section));

  // Each section starts at its own top rather than wherever the last one was scrolled to,
  // and its rail entry is brought into view — on a phone the rail scrolls sideways, and a
  // section chosen by keyboard can otherwise sit off its right edge.
  useEffect(() => {
    panelScroller.current?.scrollTo({ top: 0 });
    tabRefs.current.get(section)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [section]);

  const ids = ACCOUNT_SECTIONS.map((s) => s.id);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = ids.indexOf(section);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = (index + 1) % ids.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = (index - 1 + ids.length) % ids.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = ids.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const id = ids[next];
    onSectionChange(id);
    tabRefs.current.get(id)?.focus();
  }

  return (
    <>
      <aside className="flex min-h-0 shrink-0 flex-col border-b border-border/60 bg-muted/30 md:border-r md:border-b-0">
        <div className="px-4 pt-4 pb-3 pr-12 md:px-5 md:pt-5 md:pr-5">
          <DialogTitle className="font-[family-name:var(--font-display)] text-xl text-ink">
            Account
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-xs">
            Manage your account info.
          </DialogDescription>
        </div>
        <div
          role="tablist"
          aria-label="Account sections"
          aria-orientation={wide ? "vertical" : "horizontal"}
          onKeyDown={onKeyDown}
          className="flex gap-1 overflow-x-auto px-3 pb-3 [scrollbar-width:none] md:min-h-0 md:flex-1 md:flex-col md:overflow-x-visible md:overflow-y-auto md:pb-4 [&::-webkit-scrollbar]:hidden"
        >
          {ACCOUNT_SECTIONS.map((s) => {
            const Icon = s.icon;
            const selected = s.id === section;
            return (
              <button
                key={s.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(s.id, el);
                  else tabRefs.current.delete(s.id);
                }}
                type="button"
                role="tab"
                id={`account-tab-${s.id}`}
                aria-selected={selected}
                aria-controls={`account-panel-${s.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onSectionChange(s.id)}
                className={cn(
                  "flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm whitespace-nowrap md:w-full",
                  "outline-none transition-colors duration-fast ease-house focus-visible:ring-2 focus-visible:ring-ring/70",
                  selected
                    ? "bg-card text-ink shadow-sm ring-1 ring-border/70"
                    : "text-muted-foreground hover:bg-card/60 hover:text-foreground"
                )}
              >
                <Icon
                  aria-hidden
                  className={cn("size-4 shrink-0", selected ? "text-primary" : "opacity-80")}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{s.label}</span>
              </button>
            );
          })}
        </div>
      </aside>

      <div ref={panelScroller} className="min-h-0 flex-1 overflow-y-auto">
        <SettingsSurfaceProvider surface="panel">
          {ACCOUNT_SECTIONS.map((s) =>
            visited.has(s.id) ? (
              <div
                key={s.id}
                role="tabpanel"
                id={`account-panel-${s.id}`}
                aria-labelledby={`account-tab-${s.id}`}
                hidden={s.id !== section}
                className="space-y-5 p-5 md:p-7"
              >
                <AccountPanel section={s.id} clerkOn={clerkOn} />
              </div>
            ) : null
          )}
        </SettingsSurfaceProvider>
      </div>
    </>
  );
}

/**
 * Every rail section's content, exactly as the pages composed it before the amendment. Phase
 * 3 has not shipped, so Security is one honest line regardless of `clerkOn`. Every other
 * section falls back to `AccountDemoPanel` for its Clerk-backed piece only — Profile keeps
 * its danger zone and Sign-in and Devices keep their heading and description, because
 * `deleteMyAccount` has no Clerk dependency and genuinely works against the local demo
 * account, and silently taking away a working control would be a regression even on
 * localhost.
 */
function AccountPanel({ section, clerkOn }: { section: AccountSectionId; clerkOn: boolean }) {
  switch (section) {
    case "profile":
      return (
        <>
          <SettingsSection title="Profile" description="Your name and picture.">
            {clerkOn ? <ProfileForm /> : <AccountDemoPanel what="Your profile" />}
          </SettingsSection>
          <SettingsSection
            title="Delete account"
            description="Your data and your sign-in, erased. There is no undo."
          >
            <DeleteAccountDialog
              trigger={
                <Button type="button" variant="destructive" size="sm">
                  Delete account
                </Button>
              }
            />
          </SettingsSection>
        </>
      );
    case "sign-in":
      if (!clerkOn) {
        return (
          <SettingsSection
            title="Sign-in"
            description="The addresses and accounts you sign in with."
          >
            <AccountDemoPanel what="Your sign-in methods" />
          </SettingsSection>
        );
      }
      return (
        <>
          <SettingsSection
            title="Email addresses"
            description="Where Orbit reaches you, and what you can sign in with."
            action={
              <AddEmailDialog
                trigger={
                  <Button type="button" size="sm" variant="outline">
                    Add address
                  </Button>
                }
              />
            }
          >
            <EmailList />
          </SettingsSection>
          <SettingsSection
            title="Connected accounts"
            description="Providers you can sign in through."
          >
            <ConnectedAccounts />
          </SettingsSection>
        </>
      );
    case "security":
      return (
        <SettingsSection title="Security">
          <p className="text-sm text-muted-foreground">
            Password and two-step verification arrive next. There is nothing to configure
            here yet.
          </p>
        </SettingsSection>
      );
    case "devices":
      return (
        <SettingsSection
          title="Devices"
          description="Everywhere you’re signed in. Sign out anything you don’t recognise."
        >
          {clerkOn ? <DevicesList /> : <AccountDemoPanel what="Your device list" />}
        </SettingsSection>
      );
  }
}
