"use client";

import Link from "next/link";
import { SignOutButton } from "@clerk/nextjs";
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
 * The face comes from server-resolved props, so it paints on the first frame instead of
 * after Clerk JS loads. Only `SignOutButton` needs Clerk, and every caller already renders
 * this component behind a `clerkOn` gate — so no Clerk hook runs where there is no
 * provider.
 */
export function AccountMenu({ profile }: { profile: AccountMenuProfile | null }) {
  const name = profile?.name ?? "Your account";
  const email = profile?.email ?? "";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Your account"
        className="rounded-full ring-1 ring-border/60 transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Avatar>
          {profile?.imageUrl && <AvatarImage src={profile.imageUrl} alt="" />}
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
        <DropdownMenuItem render={<Link href="/settings/account" />}>
          <UserRound className="size-4" aria-hidden />
          Account
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link href="/settings" />}>
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
