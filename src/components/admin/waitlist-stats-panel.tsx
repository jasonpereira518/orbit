import Link from "next/link";
import { Rocket, Share2, UserCheck, Users, type LucideIcon } from "lucide-react";
import { AdminPanel, EmptyState, RelativeTime } from "@/components/admin/primitives";
import type { WaitlistStats } from "@/lib/admin-interest-list";
import { MIN_RATE_DENOMINATOR } from "@/lib/format-rate";
import { cn } from "@/lib/utils";

/**
 * The early-access waitlist at a glance, shared by the Overview and Growth pages.
 *
 * Four small tiles — how many are waiting, how many made the front wave, how fast it is
 * growing, and how much of that is word of mouth — then who is bringing people in and who
 * just arrived. Sized to sit at half width beside feature adoption on Growth. The roster
 * itself stays on /admin/growth/interest-list.
 */
export function WaitlistStatsPanel({
  stats,
  recent,
}: {
  /** Null when the read failed; the panel says so instead of taking the page down. */
  stats: WaitlistStats | null;
  /** Latest joins, when the page has them (Growth does). */
  recent?: Array<{ email: string | null; at: Date }>;
}) {
  return (
    <AdminPanel
      title="Waitlist"
      action={
        <Link
          href="/admin/growth/interest-list"
          className="text-xs text-muted-foreground hover:text-primary"
        >
          Full roster →
        </Link>
      }
    >
      {!stats ? (
        <EmptyState>Couldn&apos;t read the waitlist.</EmptyState>
      ) : stats.total === 0 ? (
        <EmptyState>Nobody has joined yet.</EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile
              label="Waiting"
              value={stats.active.toLocaleString("en-US")}
              icon={Users}
              accent
              hint={`${stats.total.toLocaleString("en-US")} joined in all`}
            />
            <Tile
              label="Front wave"
              value={stats.frontWave.toLocaleString("en-US")}
              icon={Rocket}
              hint="going in first"
            />
            <Tile
              label="New, 7 days"
              value={stats.joined7d.toLocaleString("en-US")}
              hint={`${stats.joined24h.toLocaleString("en-US")} in 24 hours`}
            />
            <Tile
              label="Referral rate"
              value={referralRate(stats.referred, stats.total)}
              icon={Share2}
              hint={
                stats.total >= MIN_RATE_DENOMINATOR
                  ? `${stats.referred.toLocaleString("en-US")} via invite link`
                  : `% shows at ${MIN_RATE_DENOMINATOR} signups`
              }
            />
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 flex items-center gap-1.5 text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground">
                <UserCheck className="size-3" aria-hidden />
                Top referrers
              </h3>
              {stats.topReferrers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No one has brought a friend yet.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {stats.topReferrers.map((r) => (
                    <li key={r.email} className="flex justify-between gap-4">
                      <span className="truncate">{r.email}</span>
                      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                        {r.referrals} friend{r.referrals === 1 ? "" : "s"}
                        {r.position !== null ? ` · #${r.position.toLocaleString("en-US")}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {recent && recent.length > 0 ? (
              <div>
                <h3 className="mb-2 text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground">
                  Latest joins
                </h3>
                <ul className="space-y-1 text-sm">
                  {recent.map((w, i) => (
                    <li key={i} className="flex justify-between gap-4">
                      <span className="truncate">{w.email ?? "—"}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        <RelativeTime date={w.at} /> ago
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </AdminPanel>
  );
}

/** A smaller MetricTile: four of these fit across half a Growth row. */
function Tile({
  label,
  value,
  hint,
  icon: Icon,
  accent = false,
}: {
  label: string;
  value: string;
  hint: string;
  icon?: LucideIcon;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/70 bg-card px-2.5 py-2">
      <div className="flex items-center gap-1 truncate text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground">
        {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-lg leading-tight tabular-nums",
          accent ? "text-accent-foreground" : "text-foreground"
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">{hint}</div>
    </div>
  );
}

/**
 * Share of signups that came through an invite link. The console's rate rule applies
 * (`lib/format-rate.ts`): below MIN_RATE_DENOMINATOR the fraction is shown, never a
 * percentage that would dress a handful of people up as a trend.
 */
function referralRate(referred: number, total: number) {
  if (total >= MIN_RATE_DENOMINATOR) return `${Math.round((referred / total) * 100)}%`;
  return `${referred.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;
}
