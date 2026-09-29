"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Pause, Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RecommendationCard, type RecommendationCardData } from "@/components/radar/recommendation-card";
import { refreshRadarNow, setRadarPaused } from "@/actions/radar";
import { friendlyError } from "@/lib/errors";
import { RADAR_CAPS } from "@/lib/radar/score";
import { KIND_SECTION_TITLES, RECOMMENDATION_KINDS, type RecommendationKind } from "@/lib/radar/types";
import { toast } from "@/lib/toast";

export type RadarViewProps = {
  recommendations: RecommendationCardData[];
  lastRunAt: string | null;
  paused: boolean;
  aiAvailable: boolean;
  hasContacts: boolean;
};

export function RadarView({ recommendations, lastRunAt, paused, aiAvailable, hasContacts }: RadarViewProps) {
  const router = useRouter();
  const [pending, start] = useTransition();

  // Best first, as the store returns them. Today is the top of the whole list; the rest
  // are grouped by kind so a person can work through one sort of thing at a time.
  const today = recommendations.slice(0, RADAR_CAPS.today);
  const rest = recommendations.slice(RADAR_CAPS.today);
  const groups = RECOMMENDATION_KINDS.map((kind) => ({
    kind,
    items: rest.filter((r) => r.kind === kind),
  })).filter((g) => g.items.length > 0);

  const refresh = () =>
    start(async () => {
      try {
        const result = await refreshRadarNow();
        if (result.ok) toast.success(result.message ?? "Radar is up to date");
        else toast.error(result.message);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t update Radar just now — try again in a minute"));
      }
    });

  const togglePause = () =>
    start(async () => {
      try {
        const result = await setRadarPaused(!paused);
        if (result.ok) toast.success(result.message ?? (paused ? "Radar resumed" : "Radar paused"));
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t change that — try again?"));
      }
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <p suppressHydrationWarning>
          {paused
            ? "Paused. Nothing updates overnight until you resume."
            : lastRunAt
              ? `Updated ${formatDistanceToNow(new Date(lastRunAt), { addSuffix: true })}. Next update tonight.`
              : "Your first list is being put together."}
        </p>
        <div className="flex items-center gap-1.5">
          <Button type="button" size="sm" variant="outline" className="h-8" disabled={pending || paused} onClick={refresh}>
            <RefreshCw className={pending ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
            Refresh now
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-8" disabled={pending} onClick={togglePause}>
            {paused ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </div>

      {recommendations.length === 0 ? (
        <EmptyState hasContacts={hasContacts} ranOnce={lastRunAt !== null} />
      ) : (
        <>
          <section aria-labelledby="radar-today" className="space-y-3">
            <h2 id="radar-today" className="text-lg font-medium text-ink">
              Today
            </h2>
            <div className="space-y-3">
              {today.map((rec) => (
                <RecommendationCard key={rec.id} rec={rec} aiAvailable={aiAvailable} showAiPrompt />
              ))}
            </div>
          </section>
          {groups.map((group) => (
            <KindSection key={group.kind} kind={group.kind} items={group.items} aiAvailable={aiAvailable} />
          ))}
        </>
      )}
    </div>
  );
}

function KindSection({ kind, items, aiAvailable }: { kind: RecommendationKind; items: RecommendationCardData[]; aiAvailable: boolean }) {
  return (
    <section aria-labelledby={`radar-${kind}`} className="space-y-3">
      <h2 id={`radar-${kind}`} className="text-base font-medium text-ink">
        {KIND_SECTION_TITLES[kind]}
      </h2>
      <div className="space-y-3">
        {items.map((rec) => (
          <RecommendationCard key={rec.id} rec={rec} aiAvailable={aiAvailable} showAiPrompt={false} />
        ))}
      </div>
    </section>
  );
}

function EmptyState({ hasContacts, ranOnce }: { hasContacts: boolean; ranOnce: boolean }) {
  if (!hasContacts) {
    return (
      <div className="rounded-2xl border border-dashed border-border p-8 text-center">
        <p className="font-medium text-ink">Radar needs people to look at</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Add a few contacts or import your LinkedIn connections, and Radar will start suggesting who to reach out to.
        </p>
        <Link href="/imports" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
          Import your network
        </Link>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-dashed border-border p-8 text-center">
      <p className="font-medium text-ink">{ranOnce ? "All clear" : "Nothing yet"}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {ranOnce
          ? "Nobody needs you right now. Radar checks again tonight, and anything new will show up here."
          : "Radar hasn’t found anyone to suggest yet. It checks your network every night."}
      </p>
    </div>
  );
}
