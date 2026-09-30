"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import { setNavOrderAction } from "@/actions/admin";
import { APP_NAV_CORE, APP_NAV_EXTRAS } from "@/components/layout/app-nav";
import { orderNavItems, surfaceKeyForHref } from "@/lib/surfaces";
import { cn } from "@/lib/utils";

const DEFAULT_ITEMS = [...APP_NAV_CORE, ...APP_NAV_EXTRAS];

/**
 * Reorders the sidebar for everyone.
 *
 * Up/down buttons rather than drag: they work by keyboard and on a phone, and a mis-drop
 * here would reorder the product for every user. Each click saves the whole list (the
 * action replaces it in one write) and is optimistic, like the toggles beside it.
 *
 * Pages marked coming soon still render below the sidebar's "Coming soon" divider whatever
 * their position here; the order decides their place within that group.
 */
export function NavOrderEditor({
  order,
  comingSoon,
}: {
  order: string[];
  comingSoon: string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<string[] | null>(null);

  const soon = new Set(comingSoon);
  const items = orderNavItems(DEFAULT_ITEMS, local ?? order);
  const keys = items.map((i) => surfaceKeyForHref(i.href) as string);
  const isCustom = (local ?? order).length > 0;

  function save(next: string[]) {
    setLocal(next);
    setError(null);
    start(async () => {
      try {
        await setNavOrderAction({ order: next });
        router.refresh();
      } catch (err) {
        setLocal(null);
        setError(err instanceof Error ? err.message : "Could not save that.");
      }
    });
  }

  function move(index: number, by: -1 | 1) {
    const next = [...keys];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    save(next);
  }

  return (
    <div>
      <ul className="divide-y divide-border/50">
        {items.map((item, i) => {
          const isSoon = soon.has(keys[i]!);
          return (
            <li key={item.href} className="flex items-center gap-3 py-2">
              <item.icon className="size-4 text-muted-foreground" aria-hidden />
              <span className="flex-1 text-sm">{item.label}</span>
              {isSoon && (
                <span className="rounded-full border border-warning/40 px-1.5 py-px text-[10px] uppercase tracking-wide text-warning">
                  Soon · shown below divider
                </span>
              )}
              {(["up", "down"] as const).map((dir) => {
                const by = dir === "up" ? -1 : 1;
                const disabled =
                  pending || (dir === "up" ? i === 0 : i === items.length - 1);
                const Icon = dir === "up" ? ArrowUp : ArrowDown;
                return (
                  <button
                    key={dir}
                    type="button"
                    disabled={disabled}
                    onClick={() => move(i, by)}
                    aria-label={`Move ${item.label} ${dir}`}
                    className={cn(
                      "rounded-md border border-border/70 p-1 text-muted-foreground transition-colors duration-fast hover:text-foreground",
                      "disabled:opacity-30"
                    )}
                  >
                    <Icon className="size-3.5" aria-hidden />
                  </button>
                );
              })}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={pending || !isCustom}
          onClick={() => save([])}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground disabled:opacity-40"
        >
          <RotateCcw className="size-3" aria-hidden />
          Reset to default order
        </button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}
