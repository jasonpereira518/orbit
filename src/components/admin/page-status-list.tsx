"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Circle, Lock, RotateCcw } from "lucide-react";
import {
  setNavOrderAction,
  setSurfaceComingSoonAction,
  setSurfaceHiddenAction,
  setSurfaceTiersAction,
} from "@/actions/admin";
import { APP_NAV_CORE, APP_NAV_EXTRAS } from "@/components/layout/app-nav";
import {
  PLANS,
  PLAN_SHORT_LABELS,
  planHasFeature,
  type FeatureKey,
  type Plan,
} from "@/lib/plans/plan-config";
import {
  canMarkComingSoon,
  canTierLock,
  orderNavItems,
  surfaceKeyForHref,
  type Surface,
} from "@/lib/surfaces";
import { cn } from "@/lib/utils";

const DEFAULT_ITEMS = [...APP_NAV_CORE, ...APP_NAV_EXTRAS];

type Flags = { hidden: boolean; soon: boolean };
export type PageStatus = "live" | "soon" | "hidden";

/** Hidden beats coming-soon: a hidden page is gone, so the soon flag has nothing to show. */
function statusOf({ hidden, soon }: Flags): PageStatus {
  return hidden ? "hidden" : soon ? "soon" : "live";
}

const OPTIONS: Array<{ value: PageStatus; label: string; hint: string; tone: string }> = [
  {
    value: "live",
    label: "Live",
    hint: "Everyone can open it",
    tone: "bg-primary/12 text-primary",
  },
  {
    value: "soon",
    label: "Soon",
    hint: "Shows the coming-soon screen; listed under the sidebar divider",
    // amber-800 in light: --warning (amber-700) on its own 15% tint measured 3.91:1.
    tone: "bg-warning/15 text-amber-800 dark:text-warning",
  },
  {
    value: "hidden",
    label: "Hidden",
    hint: "Gone from the sidebar and unreachable. Nothing is deleted",
    tone: "bg-destructive/12 text-destructive",
  },
];

function StatusSegment({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: PageStatus;
  options: typeof OPTIONS;
  onChange: (next: PageStatus) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex shrink-0 rounded-lg border border-border/70 bg-muted/40 p-0.5"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={opt.hint}
            disabled={disabled}
            onClick={() => !active && onChange(opt.value)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs transition-colors duration-fast disabled:opacity-60",
              active
                ? cn("font-medium shadow-sm", opt.tone)
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Pages whose plan gate lives in code (`PLAN_CONFIG.features`). A tier rule can only narrow
 * who opens them, never widen it, so the chips for plans the code already refuses are off.
 */
const PAGE_FEATURE: Record<string, FeatureKey> = {
  "page.recruiters": "recruiters",
  "page.outreach": "outreach",
  "page.meetings": "meetings",
};

function TierChips({
  label,
  surfaceKey,
  value,
  onChange,
  disabled,
}: {
  label: string;
  surfaceKey: string;
  value: readonly Plan[];
  onChange: (next: Plan[]) => void;
  disabled?: boolean;
}) {
  const feature = PAGE_FEATURE[surfaceKey];
  const codeBlocks = (plan: Plan) => feature !== undefined && !planHasFeature(plan, feature);
  // Plans that can really open it: a rule naming a plan the code refuses still leaves it out.
  const open = value.filter((p) => !codeBlocks(p));
  return (
    <div role="group" aria-label={`${label}: plans that can open it`} className="flex shrink-0 gap-1">
      {PLANS.map((plan) => {
        const codeBlocked = codeBlocks(plan);
        const on = !codeBlocked && value.includes(plan);
        const last = on && open.length === 1;
        return (
          <button
            key={plan}
            type="button"
            data-plan={plan}
            aria-pressed={on}
            disabled={disabled || codeBlocked || last}
            title={
              codeBlocked
                ? `${PLAN_SHORT_LABELS[plan]} doesn't include this feature`
                : last
                  ? "At least one plan must open it. To close it for everyone, hide it"
                  : on
                    ? `${PLAN_SHORT_LABELS[plan]} can open it — click to lock them out`
                    : `${PLAN_SHORT_LABELS[plan]} is locked out — click to let them in`
            }
            onClick={() => onChange(on ? value.filter((p) => p !== plan) : PLANS.filter((p) => p === plan || value.includes(p)))}
            className={cn(
              "rounded-md border px-2 py-0.5 text-2xs transition-colors duration-fast",
              on
                ? "border-tier-border bg-tier-surface font-medium text-tier-accent"
                : "border-border/60 text-muted-foreground-subtle line-through decoration-muted-foreground/40 hover:text-foreground",
              codeBlocked && "opacity-40",
              last && "cursor-not-allowed"
            )}
          >
            {PLAN_SHORT_LABELS[plan]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Every page in one list, in the order the sidebar shows them.
 *
 * Replaces two separate panels (the per-page switches and the sidebar order editor) that
 * described the same rows twice. A page now has one status — Live, Soon or Hidden — instead
 * of a "Released" button and a "Visible" button whose four combinations nobody could read.
 * Underneath, status is still the two independent flags (`hidden`, `soon`); picking a
 * status writes whichever of them has to change, so the stored model and the actions are
 * untouched.
 *
 * Optimistic with rollback, per row: the control is the only feedback the operator gets,
 * and a row disables only while its own save is in flight so several pages can be changed
 * in a row. Order saves the whole list in one write, as before, with up/down buttons
 * rather than drag so a mis-drop cannot reorder the product for every user.
 */
export function PageStatusList({
  pages,
  order,
  hidden,
  comingSoon,
  tierRules,
}: {
  pages: Surface[];
  order: string[];
  hidden: string[];
  comingSoon: string[];
  /** Tier-limited pages → the plans that may open them. Absent means every plan. */
  tierRules: Record<string, Plan[]>;
}) {
  const router = useRouter();
  const [flagOverrides, setFlagOverrides] = useState<Record<string, Flags>>({});
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [orderBusy, setOrderBusy] = useState(false);
  const [tierOverrides, setTierOverrides] = useState<Record<string, Plan[]>>({});
  const tiersFor = (key: string): Plan[] => tierOverrides[key] ?? tierRules[key] ?? [...PLANS];

  const hiddenSet = new Set(hidden);
  const soonSet = new Set(comingSoon);
  const flagsFor = (key: string): Flags =>
    flagOverrides[key] ?? { hidden: hiddenSet.has(key), soon: soonSet.has(key) };

  const activeOrder = localOrder ?? order;
  const navItems = orderNavItems(DEFAULT_ITEMS, activeOrder);
  const navKeys = navItems.map((i) => surfaceKeyForHref(i.href) as string);
  const byKey = new Map(pages.map((p) => [p.key, p]));
  const inNav = new Set(navKeys);
  const rows = [
    ...navItems.map((item, i) => ({ key: navKeys[i], icon: item.icon, navIndex: i })),
    ...pages
      .filter((p) => !inNav.has(p.key))
      .map((p) => ({ key: p.key, icon: null, navIndex: -1 })),
  ].filter((r) => byKey.has(r.key));

  function setError(key: string, message: string | null) {
    setErrors((prev) => {
      const next = { ...prev };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });
  }

  async function changeStatus(key: string, target: PageStatus) {
    const before = flagsFor(key);
    const wants: Flags =
      target === "live"
        ? { hidden: false, soon: false }
        : target === "soon"
          ? { hidden: false, soon: true }
          : { hidden: true, soon: before.soon };

    setFlagOverrides((prev) => ({ ...prev, [key]: wants }));
    setBusy((prev) => new Set(prev).add(key));
    setError(key, null);
    try {
      if (before.hidden !== wants.hidden) {
        await setSurfaceHiddenAction({ surfaceKey: key, hidden: wants.hidden });
      }
      if (before.soon !== wants.soon) {
        await setSurfaceComingSoonAction({ surfaceKey: key, soon: wants.soon });
      }
      router.refresh();
    } catch (err) {
      setFlagOverrides((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setError(key, err instanceof Error ? err.message : "Could not save that.");
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function changeTiers(key: string, plans: Plan[]) {
    setTierOverrides((prev) => ({ ...prev, [key]: plans }));
    setBusy((prev) => new Set(prev).add(key));
    setError(key, null);
    try {
      await setSurfaceTiersAction({ surfaceKey: key, plans });
      router.refresh();
    } catch (err) {
      setTierOverrides((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setError(key, err instanceof Error ? err.message : "Could not save that.");
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function saveOrder(next: string[]) {
    setLocalOrder(next);
    setOrderBusy(true);
    setError("__order", null);
    try {
      await setNavOrderAction({ order: next });
      router.refresh();
    } catch (err) {
      setLocalOrder(null);
      setError("__order", err instanceof Error ? err.message : "Could not save that.");
    } finally {
      setOrderBusy(false);
    }
  }

  function move(navIndex: number, by: -1 | 1) {
    const next = [...navKeys];
    const target = navIndex + by;
    if (target < 0 || target >= next.length) return;
    [next[navIndex], next[target]] = [next[target], next[navIndex]];
    void saveOrder(next);
  }

  const isCustomOrder = activeOrder.length > 0;

  return (
    <div>
      <ul className="divide-y divide-border/50">
        {rows.map((row) => {
          const surface = byKey.get(row.key)!;
          const flags = flagsFor(row.key);
          const status = statusOf(flags);
          const locked = surface.alwaysVisible === true;
          const Icon = row.icon ?? Circle;
          const options = canMarkComingSoon(row.key)
            ? OPTIONS
            : OPTIONS.filter((o) => o.value !== "soon");

          return (
            <li key={row.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <Icon
                className={cn(
                  "size-4 shrink-0",
                  status === "live" ? "text-foreground/70" : "text-muted-foreground/60"
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1 basis-56">
                <p
                  className={cn(
                    "flex flex-wrap items-center gap-x-2 text-sm",
                    status === "hidden" && "text-muted-foreground line-through decoration-muted-foreground/40"
                  )}
                >
                  {surface.label}
                  {surface.href && (
                    <code className="rounded bg-muted/60 px-1 text-[0.6875rem] text-muted-foreground no-underline">
                      {surface.href}
                    </code>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {locked ? surface.reason : surface.description}
                </p>
                {errors[row.key] && (
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    {errors[row.key]}
                  </p>
                )}
              </div>

              {canTierLock(row.key) && (
                <TierChips
                  label={surface.label}
                  surfaceKey={row.key}
                  value={tiersFor(row.key)}
                  disabled={busy.has(row.key)}
                  onChange={(next) => void changeTiers(row.key, next)}
                />
              )}

              {locked ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <Lock className="size-3" aria-hidden />
                  Always live
                </span>
              ) : (
                <StatusSegment
                  label={`${surface.label} status`}
                  value={status}
                  options={options}
                  disabled={busy.has(row.key)}
                  onChange={(next) => void changeStatus(row.key, next)}
                />
              )}

              <div className="flex shrink-0 gap-1">
                {(["up", "down"] as const).map((dir) => {
                  const Arrow = dir === "up" ? ArrowUp : ArrowDown;
                  const edge =
                    dir === "up" ? row.navIndex === 0 : row.navIndex === navKeys.length - 1;
                  return (
                    <button
                      key={dir}
                      type="button"
                      disabled={row.navIndex < 0 || edge || orderBusy}
                      onClick={() => move(row.navIndex, dir === "up" ? -1 : 1)}
                      aria-label={`Move ${surface.label} ${dir} in the sidebar`}
                      className={cn(
                        "rounded-md border border-border/70 p-1 text-muted-foreground transition-colors duration-fast hover:text-foreground",
                        "disabled:opacity-25",
                        row.navIndex < 0 && "invisible"
                      )}
                    >
                      <Arrow className="size-3.5" aria-hidden />
                    </button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border/50 pt-3">
        <button
          type="button"
          disabled={orderBusy || !isCustomOrder}
          onClick={() => void saveOrder([])}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground disabled:opacity-40"
        >
          <RotateCcw className="size-3" aria-hidden />
          Reset sidebar order
        </button>
        <p className="text-xs text-muted-foreground">
          Arrows set the sidebar order. Pages marked Soon always sit under the sidebar&apos;s
          divider; order only ranks them within it. Plan chips choose who can open a page:
          a plan that is struck through sees it locked, with an upgrade screen.
        </p>
        {errors.__order && (
          <p role="alert" className="text-xs text-destructive">
            {errors.__order}
          </p>
        )}
      </div>
    </div>
  );
}
