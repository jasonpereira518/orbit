"use client";

import Link from "next/link";
import {
  LayoutDashboard,
  Users,
  Sparkles,
  Upload,
  MessageSquare,
  Network,
  Settings,
  Plus,
} from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { clerkAppearance } from "@/lib/clerk-appearance";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/capture", label: "Capture", icon: Sparkles },
  { href: "/imports", label: "Imports", icon: Upload },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/graph", label: "Constellation", icon: Network },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppSidebar({
  pathname,
  clerkOn,
  demoMode,
}: {
  pathname: string;
  clerkOn: boolean;
  demoMode: boolean;
}) {
  return (
    <aside className="flex h-full w-60 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between gap-2 px-5 py-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
            O
          </div>
          <div>
            <p className="font-[family-name:var(--font-display)] text-lg leading-none tracking-tight text-sidebar-primary">
              Orbit
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Network tracker
            </p>
          </div>
        </div>
        <ThemeToggle className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground" />
      </div>

      <div className="px-3 pb-3">
        <Link
          href="/capture"
          className={cn(
            buttonVariants(),
            "w-full justify-start gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
          )}
        >
          <Plus className="h-4 w-4" />
          Log interaction
        </Link>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-2">
        {nav.map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border p-4">
        {clerkOn ? (
          <div className="flex items-center gap-3">
            <UserButton appearance={clerkAppearance} />
            <span className="text-xs text-muted-foreground">Account</span>
          </div>
        ) : demoMode ? (
          <p className="text-xs text-muted-foreground">
            Demo mode — add Clerk keys to enable auth
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Sign in required
          </p>
        )}
      </div>
    </aside>
  );
}
