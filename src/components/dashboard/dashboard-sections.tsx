import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Bell, Sparkles, Users } from "lucide-react";
import type { getOutreachPerformanceSummary } from "@/actions/outreach";
import type { fetchDashboard } from "@/actions/reminders";
import { getLinkedInExportStatus } from "@/actions/linkedin-export";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";
import { DashboardGraphPreview } from "@/components/dashboard/dashboard-graph-preview";
import { DueFollowUpRow } from "@/components/dashboard/due-follow-up-row";
import { GenerateFollowUpsButton } from "@/components/dashboard/generate-follow-ups-button";
import { GoalsSummary } from "@/components/dashboard/goals-summary";
import { LinkedInExportNudge } from "@/components/imports/linkedin-export-nudge";
import { NetworkDepthChart } from "@/components/dashboard/network-depth-chart";
import { NetworkStatsCard } from "@/components/dashboard/network-stats-card";
import { PlanLaunchCard } from "@/components/dashboard/plan-launch-card";
import { RemindersDashboardCard } from "@/components/dashboard/reminders-dashboard-card";
import { SuggestedOutreachCard } from "@/components/dashboard/suggested-outreach-card";
import { OutreachPerformanceCard } from "@/components/outreach/outreach-performance-card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";

/** Beyond this the export almost certainly isn't coming; the nudge stops offering it. */
const LINKEDIN_NUDGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Async server sections for the streamed dashboard. Every bundle section
 * awaits the SAME fetchDashboard() promise (started, un-awaited, in
 * page.tsx) — one scan feeds all cards; the win is the instant shell.
 * Each section's root carries .reveal-mount so streamed arrival plays the
 * staged-reveal cascade (pure CSS — swaps happen pre-hydration).
 */

type DashboardBundle = ReturnType<typeof fetchDashboard>;
type OutreachSummary = ReturnType<typeof getOutreachPerformanceSummary>;

type BundleData = Awaited<DashboardBundle>["data"];

function tierForContact(data: BundleData, id: string) {
  return data.closenessById.get(id)?.tier;
}

function contactMeta(data: BundleData, contactId: string | null | undefined) {
  if (!contactId) {
    return {
      name: "Unknown contact",
      title: null as string | null,
      company: null as string | null,
    };
  }
  const c = data.contactById.get(contactId);
  return {
    name: data.contactNameById.get(contactId) || c?.fullName || "Contact",
    title: c?.title ?? null,
    company: c?.company ?? null,
  };
}

const revealDelay = (ms: number) =>
  ({ "--reveal-delay": `${ms}ms` }) as React.CSSProperties;

/**
 * Plain module-level function, not inlined in the component: `Date.now()` in the render
 * body itself trips `react-hooks/purity` (impure call during render).
 */
function shouldShowLinkedInNudge(status: {
  requestedAt: string | null;
  hasLinkedInImport: boolean;
}): boolean {
  if (!status.requestedAt || status.hasLinkedInImport) return false;
  return (
    Date.now() - new Date(status.requestedAt).getTime() <
    LINKEDIN_NUDGE_MAX_AGE_MS
  );
}

export async function StatsSection({ bundle }: { bundle: DashboardBundle }) {
  const [{ data }, linkedInExport] = await Promise.all([
    bundle,
    getLinkedInExportStatus(),
  ]);
  const isEmptyNetwork = data.stats.totalContacts === 0;
  const showLinkedInNudge = shouldShowLinkedInNudge(linkedInExport);

  return (
    <>
      {isEmptyNetwork && (
        <div
          className="reveal-mount rounded-2xl border border-dashed border-border/70 px-6 py-10 text-center"
          style={revealDelay(60)}
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

      {showLinkedInNudge && (
        <div className="reveal-mount" style={revealDelay(70)}>
          <LinkedInExportNudge
            requestedAt={linkedInExport.requestedAt as string}
          />
        </div>
      )}

      <div
        // Two across on a phone. One-per-row pushed the four cards to roughly three
        // screens of scrolling before the first thing you can act on, which is the
        // wrong trade on the surface that is supposed to answer "what should I do
        // today" — the cards are four short numbers and fit side by side fine.
        className="reveal-mount grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4"
        style={revealDelay(60)}
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
          style={revealDelay(120)}
        >
          <NetworkDepthChart metrics={data.networkMetrics} />
        </div>
      )}
      <div
        className="reveal-mount min-w-0 lg:flex-1 [&>*]:h-full"
        style={revealDelay(160)}
      >
        <DashboardGraphPreview graphPreview={data.graphPreview} />
      </div>
    </>
  );
}

export async function SuggestedOutreachSection({
  bundle,
}: {
  bundle: DashboardBundle;
}) {
  const { data } = await bundle;
  return (
    <div
      className="reveal-mount h-full min-w-0 lg:flex-1 [&>*]:h-full"
      style={revealDelay(180)}
    >
      <SuggestedOutreachCard
        networkIsEmpty={data.stats.totalContacts === 0}
        dueFollowUpCount={data.stats.dueFollowUps}
        items={data.suggestions.map((s) => {
          const contactId = s.relatedContactIds?.[0] ?? null;
          const meta = contactMeta(data, contactId);
          return {
            id: s.id,
            suggestionType: s.suggestionType,
            description: s.description,
            contactId,
            contactName: meta.name,
            contactTitle: meta.title,
            contactCompany: meta.company,
            tier: contactId ? tierForContact(data, contactId) : undefined,
          };
        })}
      />
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
      style={revealDelay(180)}
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

export async function RemindersAndFollowUpsSection({
  bundle,
}: {
  bundle: DashboardBundle;
}) {
  const { data } = await bundle;
  return (
    <>
      <div className="reveal-mount min-w-0" style={revealDelay(240)}>
        <RemindersDashboardCard
          items={data.reminders.map((r) => ({
            id: r.id,
            title: r.title,
            description: r.description,
            dueDate: r.dueDate,
            reminderType: r.reminderType,
            actionKind: r.actionKind,
            contactId: r.contactId,
            contactName: r.contactId
              ? data.contactNameById.get(r.contactId) ?? null
              : null,
          }))}
        />
      </div>

      <div className="reveal-mount min-w-0" style={revealDelay(240)}>
        <Card id="due-follow-ups" className="border-border/70 shadow-none scroll-mt-8">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Due follow-ups</CardTitle>
            {data.dueFollowUps.length > 0 && (
              <div className="flex items-center gap-1.5">
                <GenerateFollowUpsButton limit={8} />
                <Link
                  href="/contacts?followUp=due"
                  className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
                >
                  View all
                </Link>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {data.dueFollowUps.length === 0 ? (
              <div className="space-y-3">
                <Empty hint="You're caught up." />
                <GenerateFollowUpsButton limit={8} label="Generate follow-ups" />
              </div>
            ) : (
              data.dueFollowUps.map((c) => (
                <DueFollowUpRow
                  key={c.id}
                  id={c.id}
                  fullName={c.fullName}
                  title={c.title}
                  company={c.company}
                  tier={tierForContact(data, c.id)}
                  nextFollowUpAt={c.nextFollowUpAt}
                  lastInteractionAt={c.lastInteractionAt}
                />
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export async function RecentlyUpdatedSection({
  bundle,
}: {
  bundle: DashboardBundle;
}) {
  const { data } = await bundle;
  return (
    <div className="reveal-mount min-w-0" style={revealDelay(240)}>
      <Card className="border-border/70 shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Recently updated</CardTitle>
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
            data.recentContacts.map((c) => {
              const tier = tierForContact(data, c.id);
              return (
                <Link
                  key={c.id}
                  href={`/contacts/${c.id}`}
                  className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-muted/60"
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
            })
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
    <div className="reveal-mount space-y-8" style={revealDelay(240)}>
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
        className="block rounded-2xl border border-border/70 bg-card/80 p-4 backdrop-blur transition-[border-color,box-shadow,background-color] hover:border-primary/30 hover:bg-card hover:shadow-md"
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
