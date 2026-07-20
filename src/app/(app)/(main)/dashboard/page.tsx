import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ArrowRight, Bell, Sparkles, Users } from "lucide-react";
import { fetchDashboard } from "@/actions/reminders";
import { fetchNetworkStats } from "@/actions/stats";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";
import { DashboardGraphPreview } from "@/components/dashboard/dashboard-graph-preview";
import { DueFollowUpRow } from "@/components/dashboard/due-follow-up-row";
import { DashboardCommandSearch } from "@/components/dashboard/command-search";
import { GenerateFollowUpsButton } from "@/components/dashboard/generate-follow-ups-button";
import { GoalsSummary } from "@/components/dashboard/goals-summary";
import { NetworkDepthChart } from "@/components/dashboard/network-depth-chart";
import { NetworkStatsCard } from "@/components/dashboard/network-stats-card";
import { ReminderRow } from "@/components/dashboard/reminder-row";
import { SuggestionRow } from "@/components/dashboard/suggestion-row";
import { cn } from "@/lib/utils";

export default async function DashboardPage() {
  const [data, networkStats] = await Promise.all([
    fetchDashboard(),
    fetchNetworkStats(),
  ]);

  function tierForContact(id: string) {
    return data.closenessById.get(id)?.tier;
  }

  function contactMeta(contactId: string | null | undefined) {
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

  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm font-medium text-primary">Your network</p>
          <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-tight text-primary">
            Stay in orbit
          </h1>
          <p className="max-w-xl text-muted-foreground">
            Follow-ups, dormant connections, and people worth reaching out to — in one place.
          </p>
        </div>
        <DashboardCommandSearch />
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
          subtitle="Inner + mid orbit"
        />
        <StatCard
          label="Reminders"
          value={data.stats.pendingReminders}
          icon={<Bell className="h-4 w-4" />}
          href="#reminders"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <NetworkDepthChart metrics={data.networkMetrics} />
        <DashboardGraphPreview graphPreview={data.graphPreview} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-border/70 shadow-none">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Suggested outreach</CardTitle>
            <div className="flex items-center gap-2">
              {data.totalSuggestions > data.suggestions.length && (
                <Link
                  href="/dashboard#suggestions"
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "sm" }),
                    "text-xs"
                  )}
                >
                  {data.totalSuggestions} total
                </Link>
              )}
              <Link
                href="/capture"
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
              >
                Capture <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </div>
          </CardHeader>
          <CardContent id="suggestions" className="space-y-2 scroll-mt-8">
            {data.suggestions.length === 0 ? (
              <Empty hint="No outreach opportunities — add contacts or log interactions." />
            ) : (
              data.suggestions.map((s) => {
                const contactId = s.relatedContactIds?.[0] ?? null;
                const meta = contactMeta(contactId);
                return (
                  <SuggestionRow
                    key={s.id}
                    id={s.id}
                    suggestionType={s.suggestionType}
                    description={s.description}
                    contactId={contactId}
                    contactName={meta.name}
                    contactTitle={meta.title}
                    contactCompany={meta.company}
                    tier={contactId ? tierForContact(contactId) : undefined}
                  />
                );
              })
            )}
          </CardContent>
        </Card>

        <Card id="reminders" className="border-border/70 shadow-none scroll-mt-8">
          <CardHeader>
            <CardTitle className="text-base">Reminders</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.reminders.length === 0 ? (
              <Empty hint="No pending reminders. Capture notes to create follow-ups." />
            ) : (
              data.reminders.map((r) => (
                <ReminderRow
                  key={r.id}
                  id={r.id}
                  title={r.title}
                  description={r.description}
                  dueDate={r.dueDate}
                  reminderType={r.reminderType}
                  contactId={r.contactId}
                  contactName={
                    r.contactId
                      ? data.contactNameById.get(r.contactId)
                      : null
                  }
                />
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card id="due-follow-ups" className="border-border/70 shadow-none scroll-mt-8">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Due follow-ups</CardTitle>
            <div className="flex items-center gap-1.5">
              <GenerateFollowUpsButton limit={8} />
              <Link
                href="/contacts?followUp=due"
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
              >
                View all
              </Link>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.dueFollowUps.length === 0 ? (
              <div className="space-y-3">
                <Empty hint="You're caught up — or generate follow-ups from dormant / high-value contacts." />
                <GenerateFollowUpsButton limit={8} />
              </div>
            ) : (
              data.dueFollowUps.map((c) => (
                <DueFollowUpRow
                  key={c.id}
                  id={c.id}
                  fullName={c.fullName}
                  title={c.title}
                  company={c.company}
                  tier={tierForContact(c.id)}
                  nextFollowUpAt={c.nextFollowUpAt}
                  lastInteractionAt={c.lastInteractionAt}
                />
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Recently updated</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.recentContacts.length === 0 ? (
              <Empty hint="No contacts yet. Start by capturing notes." />
            ) : (
              data.recentContacts.map((c) => {
                const tier = tierForContact(c.id);
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
      <p className="mt-3 font-[family-name:var(--font-display)] text-3xl text-primary">
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
        className="block rounded-2xl border border-border/70 bg-card/80 p-4 backdrop-blur transition-colors hover:border-primary/30 hover:bg-card"
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
