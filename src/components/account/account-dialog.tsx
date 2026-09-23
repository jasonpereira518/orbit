"use client";

import { useState } from "react";
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

/**
 * The account experience, as a dialog rather than a route.
 *
 * Replaces the `/settings/account` page tree (see the 2026-09-23 amendment in
 * `docs/superpowers/specs/2026-09-22-account-page-clerk-revision-design.md`). The section
 * components underneath — `ProfileForm`, `EmailList`, `AddEmailDialog`, `ConnectedAccounts`,
 * `DevicesList` — are unchanged from the pages that used to render them; every Clerk hook
 * inside them still assumes it is mounted only when `clerkOn` is true, which is exactly the
 * gate this dialog applies before rendering any of them.
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
          clerkOn && "md:grid md:grid-cols-[12rem_minmax(0,1fr)]"
        )}
      >
        {clerkOn ? (
          <AccountDialogBody section={section} onSectionChange={setSection} />
        ) : (
          <>
            <div className="px-4 pt-4 pb-3 pr-12 md:px-5 md:pt-5 md:pr-5">
              <DialogTitle className="font-[family-name:var(--font-display)] text-xl text-ink">
                Account
              </DialogTitle>
              <DialogDescription className="mt-1.5 text-xs">
                Manage your account info.
              </DialogDescription>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 md:px-5 md:pb-5">
              <AccountDemoPanel what="Your account" />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The rail plus the content pane, only mounted when `clerkOn` — the demo state above never
 * reaches this, so no Clerk hook downstream of `AccountPanel` can run without a provider.
 */
function AccountDialogBody({
  section,
  onSectionChange,
}: {
  section: AccountSectionId;
  onSectionChange: (section: AccountSectionId) => void;
}) {
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
        <nav
          aria-label="Account sections"
          className="flex gap-1 overflow-x-auto px-3 pb-3 [scrollbar-width:none] md:min-h-0 md:flex-1 md:flex-col md:overflow-x-visible md:overflow-y-auto md:pb-4 [&::-webkit-scrollbar]:hidden"
        >
          {ACCOUNT_SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = s.id === section;
            return (
              <button
                key={s.id}
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => onSectionChange(s.id)}
                className={cn(
                  "flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm whitespace-nowrap md:w-full",
                  "outline-none transition-colors duration-fast ease-house focus-visible:ring-2 focus-visible:ring-ring/70",
                  active
                    ? "bg-card text-ink shadow-sm ring-1 ring-border/70"
                    : "text-muted-foreground hover:bg-card/60 hover:text-foreground"
                )}
              >
                <Icon
                  aria-hidden
                  className={cn("size-4 shrink-0", active ? "text-primary" : "opacity-80")}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{s.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <SettingsSurfaceProvider surface="panel">
          <div className="space-y-5 p-5 md:p-7">
            <AccountPanel section={section} />
          </div>
        </SettingsSurfaceProvider>
      </div>
    </>
  );
}

/** Every rail section's content. Phase 3 has not shipped, so Security is one honest line. */
function AccountPanel({ section }: { section: AccountSectionId }) {
  switch (section) {
    case "profile":
      return (
        <>
          <SettingsSection title="Profile" description="Your name and picture.">
            <ProfileForm />
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
          <DevicesList />
        </SettingsSection>
      );
  }
}
