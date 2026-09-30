"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The account routes, in order. One list so the rail and
 * `scripts/smoke-account-routes.ts` cannot drift: the smoke asserts a page file exists for
 * every entry here.
 *
 * `/settings/account/security` arrives in a later task; its entry is added with its page,
 * not before, so the rail never offers a 404.
 */
export const ACCOUNT_TABS = [
  { href: "/settings/account", label: "Profile" },
  { href: "/settings/account/devices", label: "Devices" },
] as const satisfies ReadonlyArray<{ href: string; label: string }>;

export function AccountNav({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Account sections" className="flex gap-1 overflow-x-auto sm:flex-col sm:gap-0.5">
      {ACCOUNT_TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-muted font-medium text-ink"
                : "text-muted-foreground hover:bg-muted/60 hover:text-ink"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Reads the pathname on the client, so the shell can stay a server component. */
export function AccountNavSlot() {
  return <AccountNav pathname={usePathname()} />;
}
