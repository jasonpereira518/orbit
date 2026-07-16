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

const nav = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/capture", label: "Capture", icon: Sparkles },
  { href: "/imports", label: "Imports", icon: Upload },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/graph", label: "Graph", icon: Network },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppSidebar({
  pathname,
  clerkOn,
}: {
  pathname: string;
  clerkOn: boolean;
}) {
  return (
    <aside className="flex h-full w-60 flex-col border-r border-border/80 bg-[#f7f8f6]">
      <div className="flex items-center gap-2.5 px-5 py-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#0f3d3e] text-sm font-semibold text-[#e8f3f1]">
          O
        </div>
        <div>
          <p className="font-[family-name:var(--font-display)] text-lg leading-none tracking-tight text-[#0f3d3e]">
            Orbit
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Network tracker</p>
        </div>
      </div>

      <div className="px-3 pb-3">
        <Link
          href="/capture"
          className={cn(
            buttonVariants(),
            "w-full justify-start gap-2 bg-[#0f3d3e] text-white hover:bg-[#0c3233]"
          )}
        >
          <Plus className="h-4 w-4" />
          Log interaction
        </Link>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-2">
        {nav.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-white text-[#0f3d3e] shadow-sm"
                  : "text-muted-foreground hover:bg-white/70 hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border/70 p-4">
        {clerkOn ? (
          <div className="flex items-center gap-3">
            <UserButton />
            <span className="text-xs text-muted-foreground">Account</span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Demo mode — add Clerk keys to enable auth
          </p>
        )}
      </div>
    </aside>
  );
}
