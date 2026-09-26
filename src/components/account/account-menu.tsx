"use client";

import Link from "next/link";
import { SignOutButton, useUser } from "@clerk/nextjs";
import { LogOut, Settings, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

/** What the menu needs about the viewer. Deliberately not `UserProfile`: no id. */
export type AccountMenuProfile = {
  name: string;
  email: string;
  imageUrl?: string;
};

/** First letter of the name, for the avatar fallback. Never empty. */
function initial(name: string) {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

/**
 * The account menu, in place of Clerk's `UserButton` popover.
 *
 * The face arrives in two stages. The server-resolved prop paints on the first frame,
 * before Clerk JS has loaded; once `useUser()` has a user, Clerk's own values win. That
 * second stage is not a nicety: the prop comes from `getDisplayProfile()`, which answers
 * from the `user_settings` mirror, and the mirror only catches up via the `user.updated`
 * webhook — so without this, changing your name or photo on /settings/account left the nav
 * showing the old one until a webhook landed, which in local development (no tunnel) is
 * never. `ProfileForm` also calls `router.refresh()` so the server prop is re-resolved, but
 * Clerk is the authority here and it is already in the browser.
 *
 * `useUser()` needs a `ClerkProvider` above it — but so does `SignOutButton` below, which
 * this menu has always rendered, so the hook adds no new requirement: every caller already
 * renders this component behind a `clerkOn` gate, and no Clerk hook runs in demo mode
 * because the component itself is not rendered there. Before Clerk loads, and for a viewer
 * with no user, `isLoaded`/`user` send everything back to the server prop.
 *
 * `onNavigate` is for callers that own something the navigation has to close — the mobile
 * "More" sheet, which nothing else dismisses on a route change. The sidebar passes nothing.
 */
export function AccountMenu({
  profile,
  onNavigate,
}: {
  profile: AccountMenuProfile | null;
  onNavigate?: () => void;
}) {
  const { isLoaded, user } = useUser();

  // Clerk's live view of the same three fields, or null until it has one. An empty name is
  // left empty rather than filled with the address, so a nameless account reads "Your
  // account" over its email instead of the email twice — which is also what the server
  // sends for that account. `hasImage` is what distinguishes an uploaded photo from Clerk's
  // generated placeholder: with no photo we want our own initials fallback, not a
  // second-best avatar, and not the server prop either — it may still be holding the photo
  // that was just removed.
  const live =
    isLoaded && user
      ? {
          name: [user.firstName, user.lastName].filter(Boolean).join(" "),
          email: user.primaryEmailAddress?.emailAddress ?? "",
          imageUrl: user.hasImage ? user.imageUrl : undefined,
        }
      : null;

  const shown = live ?? profile;
  const name = shown?.name || "Your account";
  const email = shown?.email ?? "";
  const imageUrl = shown?.imageUrl;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Your account"
        className="rounded-full ring-1 ring-border/60 transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Avatar>
          {imageUrl && <AvatarImage src={imageUrl} alt="" />}
          <AvatarFallback>{initial(name)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate font-medium text-ink">{name}</span>
          {email && (
            <span className="truncate text-xs font-normal text-muted-foreground">
              {email}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/settings/account" />} onClick={onNavigate}>
          <UserRound className="size-4" aria-hidden />
          Account
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link href="/settings" />} onClick={onNavigate}>
          <Settings className="size-4" aria-hidden />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <SignOutButton>
          <DropdownMenuItem>
            <LogOut className="size-4" aria-hidden />
            Sign out
          </DropdownMenuItem>
        </SignOutButton>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
