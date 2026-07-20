import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ArrowRight, Bell, Sparkles, Users } from "lucide-react";
import { fetchDashboard } from "@/actions/reminders";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DueFollowUpRow } from "@/components/dashboard/due-follow-up-row";
import { DashboardCommandSearch } from "@/components/dashboard/command-search";
import { GenerateFollowUpsButton } from "@/components/dashboard/generate-follow-ups-button";
import { ReminderActions } from "@/components/dashboard/reminder-actions";
import { SuggestionActions } from "@/components/dashboard/suggestion-actions";
import { cn } from "@/lib/utils";

export default async function DashboardPage() {
  const data = await fetchDashboard();

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
        />
        <StatCard
          label="Due follow-ups"
          value={data.stats.dueFollowUps}
          icon={<Bell className="h-4 w-4" />}
        />
        <StatCard
          label="Strong ties"
          value={data.stats.strongConnections}
          icon={<Sparkles className="h-4 w-4" />}
        />
        <StatCard
          label="Reminders"
          value={data.stats.pendingReminders}
          icon={<Bell className="h-4 w-4" />}
        />
      </div>

      {data.stats.topCompany && (
        <p className="text-sm text-muted-foreground">
          Closest company cluster:{" "}
          <span className="font-medium text-foreground">
            {data.stats.topCompany.name}
          </span>{" "}
          ({data.stats.topCompany.count} people)
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-border/70 shadow-none">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Suggested outreach</CardTitle>
            <Link
              href="/capture"
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            >
              Capture <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.suggestions.length === 0 ? (
              <Empty hint="Add contacts or log interactions to get suggestions." />
            ) : (
              data.suggestions.map((s) => (
                <div
                  key={s.id}
                  className="rounded-xl border border-border/60 bg-card p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-primary">{s.title}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {s.description}
                      </p>
                    </div>
                    <SuggestionActions id={s.id} />
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Reminders</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.reminders.length === 0 ? (
              <Empty hint="No pending reminders. Capture notes to create follow-ups." />
            ) : (
              data.reminders.map((r) => (
                <div
                  key={r.id}
                  className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-card p-4"
                >
                  <div>
                    <p className="font-medium">{r.title}</p>
                    {r.dueDate && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Due {formatDistanceToNow(new Date(r.dueDate), { addSuffix: true })}
                      </p>
                    )}
                  </div>
                  <ReminderActions id={r.id} />
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-border/70 shadow-none">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Due follow-ups</CardTitle>
            <div className="flex items-center gap-1.5">
              <GenerateFollowUpsButton limit={8} />
              <Link
                href="/contacts"
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
                  relationshipScore={c.relationshipScore}
                  nextFollowUpAt={c.nextFollowUpAt}
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
              data.recentContacts.map((c) => (
                <Link
                  key={c.id}
                  href={`/contacts/${c.id}`}
                  className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-muted/60"
                >
                  <div>
                    <p className="font-medium">{c.fullName}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.company || "No company"}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(c.updatedAt), { addSuffix: true })}
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/80 p-4 backdrop-blur">
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <p className="mt-3 font-[family-name:var(--font-display)] text-3xl text-primary">
        {value}
      </p>
    </div>
  );
}

function Empty({ hint }: { hint: string }) {
  return <p className="text-sm text-muted-foreground">{hint}</p>;
}
