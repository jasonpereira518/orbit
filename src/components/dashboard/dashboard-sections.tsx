import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ArrowRight, Bell, Sparkles, Users } from "lucide-react";
import type { getOutreachPerformanceSummary } from "@/actions/outreach";
import type { fetchDashboard } from "@/actions/reminders";
import { listTodaySuggestions } from "@/actions/follow-ups";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { DashboardGraphPreview } from "@/components/dashboard/dashboard-graph-preview";
import { GoalsSummary } from "@/components/dashboard/goals-summary";
import { NetworkDepthChart } from "@/components/dashboard/network-depth-chart";
import { NetworkStatsCard } from "@/components/dashboard/network-stats-card";
import { PlanLaunchCard } from "@/components/dashboard/plan-launch-card";
import { OutreachPerformanceCard } from "@/components/outreach/outreach-performance-card";
import { buttonVariants } from "@/components/ui/button";
import { CARD_HOVER, PRESS, ROW_HOVER_INSET } from "@/lib/interaction";
import { cn } from "@/lib/utils";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";

/**
 * Async server sections for the streamed dashboard. Every bundle section
 * awaits the SAME fetchDashboard() promise (started, un-awaited, in
 * page.tsx) — one scan feeds all cards; the win is the instant shell.
 * Each section's root carries .reveal-mount so streamed arrival plays a rise
 * (pure CSS — swaps happen pre-hydration). The rise is per-boundary, not a
 * page-wide cascade; see `revealDelay` below for why.
 */

type DashboardBundle = ReturnType<typeof fetchDashboard>;
type OutreachSummary = ReturnType<typeof getOutreachPerformanceSummary>;

type BundleData = Awaited<DashboardBundle>["data"];

function tierForContact(data: BundleData, id: string) {
  return data.closenessById.get(id)?.tier;
}

/**
 * Stagger for elements that share ONE Suspense boundary.
 *
 * `--reveal-delay` is an `animation-delay`, and `.reveal-mount` plays on
 * insertion — so the clock starts when THAT boundary's content lands, not when
 * the page did. These delays used to run 60/120/160/180/240 ACROSS the seven
 * boundaries below, which encoded a cascade that never happens: each boundary
 * arrives when its own data does, so the number was pure added latency on
 * whatever was already slowest, and it stacked worst on the card that arrived
 * last. Outreach performance was the clearest case — it awaits a different
 * promise from its row partner and could never have been in step with it.
 *
 * So every boundary now restarts at 0. A delay is only correct BETWEEN siblings
 * that land in the same commit, where it produces a real cascade — that is the
 * 40ms below, inside the three sections that render two cards each.
 */
const revealDelay = (ms: number) =>
  ({ "--reveal-delay": `${ms}ms` }) as React.CSSProperties;

export async function StatsSection({ bundle }: { bundle: DashboardBundle }) {
  const { data } = await bundle;
  const isEmptyNetwork = data.stats.totalContacts === 0;

  return (
    <>
      {isEmptyNetwork && (
        <div
          className="reveal-mount rounded-2xl border border-dashed border-border/70 px-6 py-10 text-center"
          style={revealDelay(0)}
        >
          <h2 className="font-[family-name:var(--font-display)] text-2xl text-ink">
            Your orbit is empty
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Import LinkedIn connections, capture notes from a meeting, or add
            someone by hand — then Orbit can remind you who to reach out to.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <Link
              href="/imports"
              className={cn(buttonVariants(), "bg-primary text-primary-foreground")}
            >
              Import LinkedIn
            </Link>
            <Link
              href="/capture"
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              Capture notes
            </Link>
            <Link
              href="/contacts/new"
              className={cn(buttonVariants({ variant: "ghost" }))}
            >
              Add a contact
            </Link>
          </div>
        </div>
      )}

      <div
        // Two across on a phone. One-per-row pushed the four cards to roughly three
        // screens of scrolling before the first thing you can act on, which is the
        // wrong trade on the surface that is supposed to answer "what should I do
        // today" — the cards are four short numbers and fit side by side fine.
        className="reveal-mount grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4"
        style={revealDelay(40)}
      >
        <StatCard
          label="Contacts"
          value={data.stats.totalContacts}
          icon={<Users className="h-4 w-4" />}
          href="/contacts"
        />
        <StatCard
          label="Due follow-ups"
          value={data.stats.dueFollowUps}
          icon={<Bell className="h-4 w-4" />}
          href="/contacts?followUp=due"
          subtitle={data.stats.dueFollowUps > 0 ? "Needs attention" : undefined}
        />
        <StatCard
          label="Strong ties"
          value={data.stats.strongConnections}
          icon={<Sparkles className="h-4 w-4" />}
          href="/graph"
          // Counted from the absolute tiers, like the Network depth card — so it uses
          // that card's words, not the cohort-ranked orbit badges'.
          subtitle="Close + warm"
        />
        <StatCard
          label="Reminders"
          value={data.stats.pendingReminders}
          icon={<Bell className="h-4 w-4" />}
          href="/reminders"
        />
      </div>
    </>
  );
}

export async function ChartsSection({ bundle }: { bundle: DashboardBundle }) {
  const { data } = await bundle;
  // On an empty account this card is six zero rows, a zero-width bar and a paragraph
  // explaining how a measurement of nothing is computed — the only thing on the
  // first-run dashboard that neither says anything nor offers anything to do. Every
  // other card here has a real empty state with a call to action; this one earns its
  // place as soon as there is a single contact to measure.
  const showDepth = data.stats.totalContacts > 0;
  return (
    <>
      {showDepth && (
        <div
          className="reveal-mount min-w-0 lg:flex-1 [&>*]:h-full"
          style={revealDelay(0)}
        >
          <NetworkDepthChart metrics={data.networkMetrics} />
        </div>
      )}
      <div
        className="reveal-mount min-w-0 lg:flex-1 [&>*]:h-full"
        style={revealDelay(40)}
      >
        <DashboardGraphPreview graphPreview={data.graphPreview} />
      </div>
    </>
  );
}

/**
 * The dashboard's single follow-up glance card — the engine's top picks for today,
 * with just enough to act on and a link into the full `/reminders` Today section for
 * everything else (drafting, snoozing, dismissing). Replaces the old dashboard's two
 * competing sections (Suggested outreach + Reminders/Due follow-ups): now there is one
 * producer of system-generated follow-ups, so there is one card that shows its picks.
 */
const TODAY_GLANCE_PREVIEW_COUNT = 3;

export async function TodayGlanceSection() {
  const suggestions = await listTodaySuggestions();
  const preview = suggestions.slice(0, TODAY_GLANCE_PREVIEW_COUNT);
  return (
    <div
      className="reveal-mount h-full min-w-0 lg:flex-1 [&>*]:h-full"
      style={revealDelay(0)}
    >
      <Card className="flex h-full flex-col border-border/70 shadow-none">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle as="h2" className="text-base">Today</CardTitle>
          <Link
            href="/reminders"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
          >
            View all <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Link>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col space-y-2">
          {preview.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
              Nobody&apos;s due for outreach today.
            </p>
          ) : (
            preview.map((s) => (
              <Link
                key={s.id}
                href={`/contacts/${s.contactId}`}
                className={cn(
                  "flex items-center gap-3 rounded-xl border border-border/60 bg-card p-3",
                  ROW_HOVER_INSET,
                  PRESS
                )}
              >
                <ContactAvatar
                  fullName={s.contactName}
                  profileImageUrl={s.avatarUrl}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{s.contactName}</p>
                  <p className="truncate text-xs text-muted-foreground">{s.reason}</p>
                </div>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export async function OutreachPerformanceSection({
  summary,
}: {
  summary: OutreachSummary;
}) {
  const outreachPerformance = await summary;
  // Nothing sent and nothing built: the card renders "—", "0 positive / 0 sent" and an
  // invitation into a paid surface. That is a hole on the dashboard for every account that
  // has never run a campaign, which is most of them and all new ones. It reappears the
  // moment there is a campaign to report on.
  if (
    outreachPerformance.accountMetrics.sentCount === 0 &&
    outreachPerformance.accountMetrics.campaignCount === 0
  ) {
    return null;
  }
  return (
    <div
      className="reveal-mount h-full min-w-0 lg:flex-1 [&>*]:h-full"
      style={revealDelay(0)}
    >
      <OutreachPerformanceCard
        accountRate={outreachPerformance.accountMetrics.successfulReplyRate}
        sentCount={outreachPerformance.accountMetrics.sentCount}
        positiveReplyCount={outreachPerformance.accountMetrics.positiveReplyCount}
        campaigns={outreachPerformance.topCampaigns}
      />
    </div>
  );
}

export async function RecentlyUpdatedSection({
  bundle,
}: {
  bundle: DashboardBundle;
}) {
  const { data } = await bundle;
  return (
    <div className="reveal-mount min-w-0" style={revealDelay(0)}>
      <Card className="border-border/70 shadow-none">
        <CardHeader>
          <CardTitle as="h2" className="text-base">Recently updated</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.recentContacts.length === 0 ? (
            <div className="space-y-3">
              <Empty hint="No contacts yet." />
              <div className="flex flex-wrap gap-2">
                <Link
                  href="/imports"
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                >
                  Import
                </Link>
                <Link
                  href="/capture"
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                >
                  Capture
                </Link>
                <Link
                  href="/contacts/new"
                  className={cn(buttonVariants({ size: "sm" }))}
                >
                  Add contact
                </Link>
              </div>
            </div>
          ) : (
            // Two columns from lg. This card owns a full-width row (see page.tsx),
            // and six rows stretched across it would put each name a thousand
            // pixels from its own timestamp. Splitting the same six into 3x2 fills
            // the width with content instead of with gap.
            <div className="grid gap-x-8 gap-y-1 lg:grid-cols-2">
            {data.recentContacts.map((c) => {
              const tier = tierForContact(data, c.id);
              return (
                <Link
                  key={c.id}
                  href={`/contacts/${c.id}`}
                  className={cn(
                    "flex items-center justify-between px-2 py-2",
                    ROW_HOVER_INSET,
                    PRESS
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {tier && <ClosenessTierBadge tier={tier} dotOnly />}
                    <div className="min-w-0">
                      <p className="font-medium">{c.fullName}</p>
                      <p className="text-xs text-muted-foreground">
                        {c.company || "No company"}
                      </p>
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(c.updatedAt), { addSuffix: true })}
                  </span>
                </Link>
              );
            })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export async function TailSection({ bundle }: { bundle: DashboardBundle }) {
  const { data, networkStats } = await bundle;
  // Both are request-cached (`cache()`), and the layout above has already
  // resolved them for the sidebar's tier ring — so this costs nothing extra.
  const { plan } = await getEntitlements(await requireUserId());
  return (
    // space-y-6, not the page's space-y-8: these three are a group at the foot of
    // the dashboard, and giving them the same gap as the major section breaks made
    // them read as three more top-level sections rather than one block.
    <div className="reveal-mount space-y-6" style={revealDelay(0)}>
      <GoalsSummary
        goals={data.goals}
        goalAlignedContacts={data.goalAlignedContacts.map((c) => ({
          id: c.id,
          fullName: c.fullName,
          preferredName: c.preferredName,
          company: c.company,
          title: c.title,
          goalRelevance: c.goalRelevance,
        }))}
      />

      <NetworkStatsCard stats={networkStats} />

      {/* Foot of the dashboard on purpose: prominent enough to find, far
          enough down that it isn't the first thing between you and your
          follow-ups. */}
      <PlanLaunchCard plan={plan} />
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  href,
  subtitle,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  href?: string;
  subtitle?: string;
}) {
  const inner = (
    <>
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <p className="mt-3 font-[family-name:var(--font-display)] text-3xl text-ink">
        {value}
      </p>
      {subtitle && (
        <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
      )}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className={cn(
          "block rounded-2xl border border-border/70 bg-card/80 p-4 backdrop-blur hover:bg-card",
          CARD_HOVER,
          PRESS
        )}
      >
        {inner}
      </Link>
    );
  }

  return (
    <div className="rounded-2xl border border-border/70 bg-card/80 p-4 backdrop-blur">
      {inner}
    </div>
  );
}

function Empty({ hint }: { hint: string }) {
  return <p className="text-sm text-muted-foreground">{hint}</p>;
}
