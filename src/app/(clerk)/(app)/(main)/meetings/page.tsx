import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import Form from "next/form";
import Link from "next/link";
import { Search } from "lucide-react";
import { getActiveCaptureJobs } from "@/actions/capture-jobs";
import { getPlanOverview, getSettings } from "@/actions/settings";
import { CaptureFlowLazy } from "@/components/capture/capture-flow-lazy";
import { MeetingsList } from "@/components/meetings/meetings-list";
import { RenderStamp } from "@/components/layout/render-stamp";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireUserId } from "@/lib/auth";
import { featureDenial, getEntitlements } from "@/lib/entitlements";
import { getEffectivePlanConfig } from "@/lib/plans/plan-rules";
import { getResumableMeeting } from "@/lib/meeting-sessions";
import { listMeetingsFor, type MeetingSourceFilter } from "@/lib/meetings-list";
import { cn } from "@/lib/utils";

export const metadata = { title: "Meetings" };

// Summarizing an hour-long recording is a map-reduce over several model calls, run by a
// server action from this page. The (main) layout is 60.
export const maxDuration = 300;

const SOURCES: { id: MeetingSourceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "orbit", label: "Recorded" },
  { id: "granola", label: "Granola" },
];

function listHref(q: string, source: MeetingSourceFilter): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (source !== "all") params.set("source", source);
  const s = params.toString();
  return s ? `/meetings?${s}` : "/meetings";
}

export default async function MeetingsPage({ searchParams }: { searchParams: Promise<{ q?: string; source?: string }> }) {
  const gate = await pageVisibilityGate("page.meetings");
  if (gate) return gate;

  const { q: rawQ, source: rawSource } = await searchParams;
  const q = (rawQ ?? "").trim().slice(0, 100);
  const source: MeetingSourceFilter = rawSource === "orbit" || rawSource === "granola" ? rawSource : "all";
  const userId = await requireUserId();

  const [page, settings, plan, { canUseMeetings }, planConfig, resumableMeeting, jobs] = await Promise.all([
    listMeetingsFor(userId, { q, source }),
    getSettings(),
    getPlanOverview(),
    getEntitlements(userId),
    getEffectivePlanConfig(),
    // Conveniences; a failure to read either must never take the page down.
    getResumableMeeting(userId).catch(() => null),
    getActiveCaptureJobs().catch(() => []),
  ]);
  // The recorder only resumes a meeting's own review; a notes capture stays Capture's.
  const meetingJob = jobs.find((j) => j.sourceKind === "meeting") ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <RenderStamp />
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">Meetings</h1>
        <p className="mt-1 text-muted-foreground">
          Record a call and Orbit summarizes it and pulls out the people. Everything you&apos;ve recorded or
          synced is below.
        </p>
      </div>

      <CaptureFlowLazy
        variant="meetings"
        initialJob={meetingJob}
        initialJobs={meetingJob ? [meetingJob] : []}
        hasApiKey={settings.hasApiKey}
        aiReason={settings.ai.reason}
        canTranscribe={settings.ai.canTranscribe}
        canUseMeetings={canUseMeetings}
        meetingsDeniedMessage={featureDenial("meetings", planConfig)}
        resumableMeeting={resumableMeeting}
        quota={{ used: plan.usage.used, limit: plan.usage.limit }}
        userId={userId}
      />

      <section className="space-y-4" aria-labelledby="past-meetings">
        <h2 id="past-meetings" className="font-[family-name:var(--font-display)] text-xl text-ink">
          Past meetings
        </h2>
        <Form action="/meetings" className="flex gap-2" role="search">
          {source !== "all" && <input type="hidden" name="source" value={source} />}
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              name="q"
              defaultValue={q}
              maxLength={100}
              placeholder="Search meetings — try “pricing” or a name"
              aria-label="Search meetings"
              className="pl-9"
            />
          </div>
          <Button type="submit">Search</Button>
          {q && (
            <Link
              href={listHref("", source)}
              className="inline-flex items-center px-2 text-sm text-muted-foreground hover:text-foreground"
            >
              Clear
            </Link>
          )}
        </Form>
        <nav aria-label="Meeting source" className="flex gap-1.5">
          {SOURCES.map((s) => (
            <Link
              key={s.id}
              href={listHref(q, s.id)}
              aria-current={source === s.id ? "page" : undefined}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                source === s.id
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border/70 text-muted-foreground hover:text-foreground"
              )}
            >
              {s.label}
            </Link>
          ))}
        </nav>
        <MeetingsList key={`${source}:${q}`} initial={page} q={q} source={source} />
      </section>
    </div>
  );
}
