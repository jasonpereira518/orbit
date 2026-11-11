import { Suspense } from "react";
import { getOutreachPerformanceSummary } from "@/actions/outreach";
import { fetchDashboard } from "@/actions/reminders";
import { AgentDraftsCard } from "@/components/dashboard/agent-drafts-card";
import { TodayMeetingsSection } from "@/components/dashboard/today-meetings";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import {
  ChartsSection,
  LinkedInExportNudgeSection,
  MorningBriefingSection,
  RecentlyUpdatedSection,
  RemindersAndFollowUpsSection,
  SetupChecklistSection,
  StatsSection,
  SuggestedOutreachSection,
  TailSection,
} from "@/components/dashboard/dashboard-sections";
import { DashboardBodySkeleton } from "@/components/loading/page-skeletons";
import { listPendingAgentSends } from "@/lib/agent-sends";
import { requireUserId } from "@/lib/auth";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { RenderStamp } from "@/components/layout/render-stamp";
import { fetchRadarBriefing } from "@/actions/radar";

export const metadata = { title: "Dashboard" };

async function AgentDraftsSection() {
  const drafts = await listPendingAgentSends(await requireUserId());
  return <AgentDraftsCard drafts={drafts} />;
}

export default async function DashboardPage() {
  // Start the bundle BEFORE the visibility await below. That await is free on a full page
  // load (the layouts resolved it on the same request), but a sidebar click skips the
  // shared layouts, so there it is real round trips — and awaiting it first put them in
  // front of the dashboard's own queries. The bundle feeds every card from one network
  // scan (don't split it into per-card fetches); each Suspense section awaits it.
  const bundle = fetchDashboard();
  // Unhandled until a section awaits it; an early rejection must not crash the render.
  bundle.catch(() => {});

  const { hidden, comingSoonMarked } = await resolveSurfaceVisibility(await requireUserId());
  const show = (key: string) => !hidden.has(key);

  // Radar's morning briefing leads the page for viewers who can open Radar, and takes over
  // from the suggestions card once their first run exists. Started only for them, so
  // everyone else pays nothing, and never awaited ahead of the bundle. While Radar is marked
  // coming soon the widget stays off for everyone — an admin previewing unreleased pages can
  // still open /radar itself, but the dashboard doesn't advertise what hasn't shipped.
  const radarBriefing =
    !hidden.has("page.radar") && !comingSoonMarked.has("page.radar") ? fetchRadarBriefing() : null;
  radarBriefing?.catch(() => {});

  // The outreach summary streams independently, and is not started at all when its card
  // is hidden — it is the one query on this page that no other card shares.
  const outreachSummary = show("dashboard.outreach-performance")
    ? getOutreachPerformanceSummary()
    : null;

  // Each row is guarded as well as each card: a `grid` whose children are all hidden still
  // renders, and its `gap` would leave an unexplained band of empty page behind.
  const showSuggestedRow = show("dashboard.suggested-outreach");

  return (
    <div className="space-y-8">
      <RenderStamp />
      <DashboardHeader />

      {/* One boundary for everything below the header. The optional leading cards are
          data-dependent — today's meetings, the LinkedIn nudge, agent drafts and the setup
          checklist — and each used to mount late, above content that had already painted,
          pushing it down by ~219 px. That was the dashboard's only layout shift (CLS 0.141,
          worst for a new account, where most of them render). Holding the body until they
          settle paints it once with the cards already in place; the header still streams
          immediately, so first paint is unchanged. */}
      <Suspense fallback={<DashboardBodySkeleton />}>
        <div className="space-y-8">
          {/* Radar flagship morning briefing: centerpiece hero at the top of the dashboard */}
          {radarBriefing && (
            <div className="w-full">
              <MorningBriefingSection briefing={radarBriefing} bundle={bundle} />
            </div>
          )}

          {/* Today's meetings (when the calendar has any). Drops row when neither renders. */}
          <div className="empty:hidden">
            <TodayMeetingsSection now={new Date()} />
          </div>

          {/* Renders the LinkedIn export card or the arrival nudge, or nothing once a LinkedIn import exists. */}
          <LinkedInExportNudgeSection />

          {/* Above every other card, and outside the surface-visibility switches: a message
              waiting to go out is the only thing on this page that needs a decision rather
              than attention, and it expires. It renders nothing when there is none. */}
          <AgentDraftsSection />

          {/* What onboarding left open. Nothing while the guided tour is running, nothing once
              every item is done or the person dismissed it on this device. */}
          <SetupChecklistSection />

          {show("dashboard.stats") && <StatsSection bundle={bundle} />}

          {/* Flex for the same reason as the row below: the Network depth card removes itself
              on an empty network (it can only draw zeros), and the constellation preview
              should then fill the row rather than sit beside an empty grid column. */}
          {show("dashboard.charts") && (
            <div className="flex flex-col gap-6 lg:flex-row">
              <ChartsSection bundle={bundle} />
            </div>
          )}

          {/* Full width. The reply rate that used to be a second card here now sits beside the
              heading, so this row holds the one card. */}
          {showSuggestedRow && (
            // `empty:hidden`: for a Radar viewer the suggestions card steps aside for the
            // briefing, and the row would otherwise be an empty band.
            <div className="flex flex-col items-stretch gap-6 empty:hidden lg:flex-row">
              <SuggestedOutreachSection
                bundle={bundle}
                radar={radarBriefing}
                outreach={outreachSummary}
              />
            </div>
          )}

          {/* One section, TWO cards — so this grid always holds exactly two children,
              and `dashboard.reminders` hides both together. Recently updated used to
              share this row, which put THREE children in a two-column grid and left a
              visible empty cell beside the third; hiding Reminders left the same hole
              on the other side. It owns the row below instead, where its own column
              count can adapt. Stretched, like every other two-card row here: the two cards
              end on one line, and the shorter one's footer drops to meet it. */}
          {show("dashboard.reminders") && (
            <div className="grid gap-6 lg:grid-cols-2">
              <RemindersAndFollowUpsSection bundle={bundle} />
            </div>
          )}

          {show("dashboard.recently-updated") && <RecentlyUpdatedSection bundle={bundle} />}

          {show("dashboard.tail") && <TailSection bundle={bundle} />}
        </div>
      </Suspense>
    </div>
  );
}
