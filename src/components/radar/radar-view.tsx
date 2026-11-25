"use client";

import { useEffect, useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { format, formatDistanceToNow, startOfWeek } from "date-fns";
import { ChevronLeft, ChevronRight, Circle, CircleCheck, Clock, Focus, LayoutList, Wand2 } from "lucide-react";
import { AiKeyNotice } from "@/components/ai-key-notice";
import { Button } from "@/components/ui/button";
import { useViewerPlan } from "@/components/viewer-plan";
import { RecommendationCard, type RecommendationCardData } from "@/components/radar/recommendation-card";
import { RadarSettingsSheet } from "@/components/radar/radar-settings-sheet";
import { RefreshRadarButton } from "@/components/radar/refresh-radar-button";
import { useRadarRunProgress } from "@/components/radar/use-radar-run-progress";
import { useRadarKeys } from "@/components/radar/use-radar-keys";
import { addInboxPerson, dismissInboxPerson, refreshRadarNow, undoAutopilot } from "@/actions/radar";
import { InboxPeople, type InboxPersonView } from "@/components/radar/inbox-people";
import { RadarSteeringBar } from "@/components/radar/radar-steering-bar";
import { friendlyError } from "@/lib/errors";
import type { ChangeLine } from "@/lib/radar/briefing";
import { RADAR_SHORTCUTS } from "@/lib/radar/focus-keys";
import type { RadarColdStart, RadarMomentumStats, RadarPageData, RadarSettingsView } from "@/lib/radar/page-data";
import { LANE_OF_KIND, LANE_TITLES, RADAR_LANES, type RadarLane } from "@/lib/radar/types";
import type { OpportunityView } from "@/lib/radar/opportunity-actions";
import { OpportunityCard } from "@/components/radar/opportunity-card";
import { toast } from "@/lib/toast";
import { syncTimeZoneCookie } from "@/lib/tz-cookie";
import { clearRadarNew } from "@/lib/app-pulse-store";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/motion-preference";

export type RadarAutopilotItem = {
  id: string;
  contactId: string;
  contactName: string;
  dueDate: string | null;
};

export type RadarViewProps = {
  recommendations: RecommendationCardData[];
  lastRunAt: string | null;
  nextRunAt: string | null;
  aiAvailable: boolean;
  hasContacts: boolean;
  settings: RadarSettingsView;
  autopilot: RadarAutopilotItem[];
  changes: ChangeLine[];
  signalsThisWeek: number;
  /** People the account's email names who are not in the network yet. Empty unless Email insights is on. */
  inboxPeople: InboxPersonView[];
  /** A card to open on, from the Monday email or the dashboard (`/radar?focus=<id>`). */
  focusId: string | null;
  /** The weekly web pass's open finds, shown in the Opportunities lane. */
  opportunities: OpportunityView[];
  /** When this week's plan was built; null before the first weekly run. */
  weekBuiltAt: string | null;
  /** What Radar still needs, shown only when the week is thin. */
  coldStart: RadarColdStart | null;
  /** 30-day Radar momentum outcomes. */
  momentum: RadarMomentumStats;
  /** Context chips shown in the steering bar. */
  steeringContext: RadarPageData["steeringContext"];
};

type DeckItem =
  | { id: string; kind: "rec"; bucket: RecommendationCardData["bucket"]; rec: RecommendationCardData }
  | { id: string; kind: "opp"; bucket: OpportunityView["bucket"]; find: OpportunityView };

type Mode = "focus" | "list";
const MODE_KEY = "orbit.radar.mode";

function storedMode(): Mode | null {
  try {
    const v = window.localStorage.getItem(MODE_KEY);
    return v === "focus" || v === "list" ? v : null;
  } catch {
    return null;
  }
}

const noSubscription = () => () => {};

/** The layout to open in: focus for a linked card, else a remembered choice, else focus on a phone. */
function arrivalMode(linked: boolean): Mode {
  if (linked) return "focus";
  const phone = window.matchMedia?.("(max-width: 639px)").matches === true;
  return storedMode() ?? (phone ? "focus" : "list");
}

export function RadarView(props: RadarViewProps) {
  const {
    lastRunAt,
    nextRunAt,
    aiAvailable,
    hasContacts,
    settings,
    autopilot,
    changes,
    signalsThisWeek,
    inboxPeople,
    focusId,
    opportunities,
    weekBuiltAt,
    coldStart,
    momentum,
    steeringContext,
  } = props;
  // Today first, then the three lanes: the order both layouts and the focus deck walk.
  const recommendations = useMemo(() => planOrder(props.recommendations), [props.recommendations]);
  const deckItems = useMemo<DeckItem[]>(() => {
    const todayRecs = recommendations.filter((r) => r.bucket === "today").map((rec) => ({ id: rec.id, kind: "rec" as const, bucket: rec.bucket, rec }));
    const todayOpps = opportunities.filter((o) => o.bucket === "today").map((find) => ({ id: find.id, kind: "opp" as const, bucket: find.bucket, find }));
    const laterRecs = recommendations.filter((r) => r.bucket !== "today").map((rec) => ({ id: rec.id, kind: "rec" as const, bucket: rec.bucket, rec }));
    const laterOpps = opportunities.filter((o) => o.bucket !== "today").map((find) => ({ id: find.id, kind: "opp" as const, bucket: find.bucket, find }));
    return [...todayRecs, ...todayOpps, ...laterRecs, ...laterOpps];
  }, [recommendations, opportunities]);
  const { aiReason } = useViewerPlan();
  const router = useRouter();
  const [pending, start] = useTransition();
  // A run something else started (the nightly pass, another tab) finishing while this page is open.
  const run = useRadarRunProgress((status) => {
    if (status === "failed") toast.error("Couldn’t update Radar just now — try again in a minute");
    else toast.success("Radar is up to date");
    router.refresh();
  });
  // The bar holds at 100% for a beat when our own refresh lands, before the page swaps in.
  const [landing, setLanding] = useState(false);
  const refreshing = pending || run.watching;
  const percent = landing ? 100 : (run.snap?.progress ?? 0);
  const linked = focusId ? deckItems.findIndex((item) => item.id === focusId) : -1;
  // The server always draws the list; the browser then opens in focus mode for a linked card,
  // a remembered choice, or a phone. A choice made here wins from then on.
  // Fixed at arrival: resolving the linked card removes it, and must not flip the layout.
  const [arrivedLinked] = useState(linked >= 0);
  const arrival = useSyncExternalStore(noSubscription, () => arrivalMode(arrivedLinked), () => "list");
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode = chosen ?? arrival;
  const [index, setIndex] = useState(Math.max(0, linked));

  // So the Monday email arrives on this person's Monday morning (`captureRadarTimeZone`).
  useEffect(() => syncTimeZoneCookie(), []);
  // Looking at Radar is what clears the nav's green "new suggestions" pulse.
  useEffect(() => clearRadarNew(), []);

  const chooseMode = (next: Mode) => {
    setChosen(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // Private mode: the choice lasts until the page closes.
    }
  };

  const jumpTo = (id: string) => {
    const i = deckItems.findIndex((item) => item.id === id);
    if (i < 0) return;
    if (mode === "focus") {
      setIndex(i);
      return;
    }
    const target = document.getElementById(`radar-card-${id}`) ?? document.getElementById(`radar-opp-${id}`);
    target?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  };

  const refresh = () =>
    start(async () => {
      run.watch("own");
      let attached = false;
      try {
        const result = await refreshRadarNow();
        if (result.ok) {
          toast.success(result.message ?? "Radar is up to date");
          setLanding(true);
          await new Promise((resolve) => setTimeout(resolve, prefersReducedMotion() ? 0 : 500));
        } else if (result.busy) {
          // Already updating: watch that run instead of refusing; the poll refreshes the page when it ends.
          attached = true;
          run.watch("attach");
          return;
        } else toast.error(result.message);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t update Radar just now — try again in a minute"));
      } finally {
        setLanding(false);
        if (!attached) run.stop();
      }
    });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <p suppressHydrationWarning>
          {refreshing
            ? [run.snap?.label ?? "Starting", run.snap?.detail].filter(Boolean).join(" · ") + "…"
            : weekBuiltAt
              ? weekLine(new Date(weekBuiltAt), recommendations.length + opportunities.length)
              : lastRunAt
                ? `Updated ${formatDistanceToNow(new Date(lastRunAt), { addSuffix: true })}`
                : "Building your first plan…"}
          {!refreshing && !weekBuiltAt && signalsThisWeek > 0 && (
            <span>
              {" · "}
              {signalsThisWeek} new {signalsThisWeek === 1 ? "signal" : "signals"} this week
            </span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {deckItems.length > 0 && (
            <div role="group" aria-label="Layout" className="mr-1 inline-flex rounded-lg border border-border/70 p-0.5">
              <ModeButton active={mode === "focus"} onClick={() => chooseMode("focus")} icon={Focus} label="Focus" />
              <ModeButton active={mode === "list"} onClick={() => chooseMode("list")} icon={LayoutList} label="List" />
            </div>
          )}
          <RefreshRadarButton busy={refreshing} percent={percent} onClick={refresh} />
          <RadarSettingsSheet settings={settings} />
        </div>
      </div>

      <RadarSteeringBar steering={settings.steering} context={steeringContext} paused={settings.paused} />
      <MomentumStrip momentum={momentum} />

      {changes.length > 0 && <WhatChanged changes={changes} onJump={jumpTo} />}
      {autopilot.length > 0 && <AutopilotDid items={autopilot} />}
      <InboxPeople people={inboxPeople} onAdd={addInboxPerson} onDismiss={dismissInboxPerson} onChanged={() => router.refresh()} />

      {!aiAvailable && recommendations.length > 0 && <AiKeyNotice feature="draft" reason={aiReason ?? "key_required"} compact />}

      {recommendations.length === 0 && opportunities.length === 0 && lastRunAt === null && hasContacts ? (
        <BuildingFirstPlan />
      ) : recommendations.length === 0 && opportunities.length === 0 ? (
        <EmptyState hasContacts={hasContacts} ranOnce={lastRunAt !== null} nextRunAt={nextRunAt} />
      ) : mode === "focus" && deckItems.length > 0 ? (
        <FocusDeck items={deckItems} index={index} setIndex={setIndex} aiAvailable={aiAvailable} />
      ) : (
        <ListView recommendations={recommendations} opportunities={opportunities} aiAvailable={aiAvailable} />
      )}
      {coldStart && <HelpRadar coldStart={coldStart} />}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Focus;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "tap-target inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors",
        active ? "bg-muted text-ink" : "text-muted-foreground hover:text-ink"
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </button>
  );
}

/** New job moves, headlines and posts, one line each; a line takes you to its card. */
function WhatChanged({ changes, onJump }: { changes: ChangeLine[]; onJump: (id: string) => void }) {
  return (
    <section aria-labelledby="radar-changed" className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 sm:px-4">
      <h2 id="radar-changed" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        What changed
      </h2>
      <ul className="mt-1.5 space-y-1">
        {changes.map((c) => (
          <li key={c.id} className="min-w-0">
            <button
              type="button"
              onClick={() => onJump(c.id)}
              className="tap-target w-full truncate text-left text-sm text-ink/90 hover:text-ink hover:underline"
            >
              <span className="font-medium text-ink">{c.contactName}</span>
              <span className="text-muted-foreground"> · </span>
              {c.label}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What autopilot scheduled this week, each with an Undo that removes the follow-up it set. */
function AutopilotDid({ items }: { items: RadarAutopilotItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const undo = (id: string) =>
    start(async () => {
      try {
        const result = await undoAutopilot(id);
        if (result.ok) toast.success(result.message ?? "Follow-up removed");
        else toast.error(result.message);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t undo that — try again?"));
      }
    });
  return (
    <section aria-labelledby="radar-autopilot" className="rounded-xl border border-border/60 px-3 py-2.5 sm:px-4">
      <h2 id="radar-autopilot" className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <Wand2 className="size-3.5" aria-hidden />
        Autopilot did this
      </h2>
      <ul className="mt-1.5 space-y-1">
        {items.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate" suppressHydrationWarning>
              Follow-up with{" "}
              <Link href={`/contacts/${a.contactId}`} className="font-medium text-primary hover:underline">
                {a.contactName}
              </Link>
              {a.dueDate ? ` on ${format(new Date(a.dueDate), "EEE d MMM")}` : ""}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 px-2 text-xs"
              disabled={pending}
              aria-label={`Undo the follow-up with ${a.contactName}`}
              onClick={() => undo(a.id)}
            >
              Undo
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One card at a time across both people and opportunity finds. `j`/`k` move; the card answers `s`, `d`, `z`, `x`. */
function FocusDeck({
  items,
  index,
  setIndex,
  aiAvailable,
}: {
  items: DeckItem[];
  index: number;
  setIndex: (i: number) => void;
  aiAvailable: boolean;
}) {
  const count = items.length;
  // A resolved card leaves the list, so the same index is already the next one.
  const at = Math.min(index, count - 1);
  const current = items[at];
  const inToday = current.bucket === "today";
  const heading = inToday
    ? "Today"
    : current.kind === "rec"
      ? LANE_TITLES[LANE_OF_KIND[current.rec.kind]]
      : LANE_TITLES.opportunities;
  const move = (delta: number) => setIndex(Math.max(0, Math.min(count - 1, at + delta)));

  useRadarKeys(true, (command) => {
    if (command === "next") move(1);
    else if (command === "prev") move(-1);
  });

  return (
    <section aria-labelledby="radar-focus" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="radar-focus" className="text-lg font-medium text-ink">
          {heading}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {at + 1} of {count}
          </span>
        </h2>
        <div className="flex items-center gap-1">
          <Button type="button" size="icon" variant="outline" className="size-8" disabled={at === 0} aria-label="Previous card" onClick={() => move(-1)}>
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button type="button" size="icon" variant="outline" className="size-8" disabled={at >= count - 1} aria-label="Next card" onClick={() => move(1)}>
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
      {current.kind === "rec" ? (
        <RecommendationCard key={current.id} rec={current.rec} aiAvailable={aiAvailable} showAiPrompt={inToday} shortcuts />
      ) : (
        <OpportunityCard key={current.id} find={current.find} />
      )}
      {current.kind === "rec" && (
        <p className="hidden text-xs text-muted-foreground pointer-fine:block">
          {RADAR_SHORTCUTS.map((s, i) => (
            <span key={s.label}>
              {i > 0 ? " · " : ""}
              {s.keys.map((k, j) => (
                <span key={k}>
                  {j > 0 ? "/" : ""}
                  <kbd className="rounded border border-border/70 bg-muted px-1 font-sans text-2xs text-ink">{k}</kbd>
                </span>
              ))}{" "}
              {s.label}
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

/** 30-day momentum strip showing outcomes produced by acting on Radar. */
function MomentumStrip({ momentum }: { momentum: RadarMomentumStats }) {
  const total =
    momentum.conversationsSparked +
    momentum.introsMade +
    momentum.opportunitiesSaved +
    momentum.loopsClosed;
  if (total === 0) return null;
  const cells = [
    { label: "Conversations sparked", value: momentum.conversationsSparked },
    { label: "Intros & asks", value: momentum.introsMade },
    { label: "Opportunities saved", value: momentum.opportunitiesSaved },
    { label: "Loops closed", value: momentum.loopsClosed },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/50 bg-muted/25 px-3 py-2 sm:grid-cols-4">
      {cells.map((cell) => (
        <div key={cell.label} className="min-w-0">
          <p className="truncate text-2xs font-medium text-muted-foreground uppercase">{cell.label}</p>
          <p className="font-[family-name:var(--font-display)] text-base font-semibold text-ink">{cell.value}</p>
        </div>
      ))}
    </div>
  );
}

/** Today's moments first, then each lane in order; within a group, the store's order (best first). */
function planOrder(recs: readonly RecommendationCardData[]): RecommendationCardData[] {
  // The run already caps Today at the plan's size (`composeWeek`), so the bucket is the whole rule.
  const today = recs.filter((r) => r.bucket === "today");
  return [...today, ...RADAR_LANES.flatMap((lane) => recs.filter((r) => r.bucket !== "today" && LANE_OF_KIND[r.kind] === lane))];
}

function weekLine(builtAt: Date, open: number) {
  const monday = startOfWeek(builtAt, { weekStartsOn: 1 });
  return `Week of ${format(monday, "MMM d")} · built ${format(builtAt, "EEEE h:mmaaa")} · ${open} open`;
}

type ListFilter = "all" | "today" | RadarLane;

function ListView({
  recommendations,
  opportunities,
  aiAvailable,
}: {
  recommendations: RecommendationCardData[];
  opportunities: OpportunityView[];
  aiAvailable: boolean;
}) {
  const [filter, setFilter] = useState<ListFilter>("all");
  const todayRecs = recommendations.filter((r) => r.bucket === "today");
  const todayOpps = opportunities.filter((o) => o.bucket === "today");
  const restRecs = recommendations.filter((r) => r.bucket !== "today");
  const restOpps = opportunities.filter((o) => o.bucket !== "today");

  const todayCount = todayRecs.length + todayOpps.length;
  const counts: Record<ListFilter, number> = {
    all: recommendations.length + opportunities.length,
    today: todayCount,
    opportunities: restRecs.filter((r) => LANE_OF_KIND[r.kind] === "opportunities").length + restOpps.length,
    connect: restRecs.filter((r) => LANE_OF_KIND[r.kind] === "connect").length,
    follow_up: restRecs.filter((r) => LANE_OF_KIND[r.kind] === "follow_up").length,
  };

  const tabs: Array<{ id: ListFilter; label: string }> = [
    { id: "all", label: "All" },
    ...(todayCount > 0 ? [{ id: "today" as const, label: "Act now" }] : []),
    ...RADAR_LANES.map((lane): { id: ListFilter; label: string } => ({ id: lane, label: LANE_TITLES[lane] })).filter((t) => counts[t.id] > 0),
  ];

  const showToday = (filter === "all" || filter === "today") && todayCount > 0;
  const visibleLanes =
    filter === "today" ? [] : filter === "all" ? RADAR_LANES : RADAR_LANES.filter((l) => l === filter);

  return (
    <>
      {tabs.length > 2 && (
        <div role="tablist" aria-label="Filter Radar list" className="flex flex-wrap items-center gap-1.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={filter === tab.id}
              onClick={() => setFilter(tab.id)}
              className={cn(
                "tap-target inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                filter === tab.id
                  ? "bg-ink text-background"
                  : "border border-border/60 text-muted-foreground hover:bg-muted hover:text-ink"
              )}
            >
              <span>{tab.label}</span>
              <span className="opacity-70">{counts[tab.id]}</span>
            </button>
          ))}
        </div>
      )}
      {showToday && (
        <section
          aria-labelledby="radar-today"
          className="space-y-3 rounded-2xl border border-amber-500/25 bg-amber-500/5 p-3 sm:p-4"
        >
          <h2 id="radar-today" className="flex items-center gap-1.5 text-sm font-medium text-amber-800 dark:text-amber-300">
            <Clock className="size-4" aria-hidden />
            Today · {todayCount} {todayCount === 1 ? "thing that won’t keep" : "things that won’t keep"}
          </h2>
          <div className="space-y-3">
            {todayRecs.map((rec) => (
              <RecommendationCard key={rec.id} rec={rec} aiAvailable={aiAvailable} showAiPrompt />
            ))}
            {todayOpps.map((find) => (
              <OpportunityCard key={find.id} find={find} />
            ))}
          </div>
        </section>
      )}
      {visibleLanes.map((lane) => {
        const items = restRecs.filter((r) => LANE_OF_KIND[r.kind] === lane);
        const finds = lane === "opportunities" ? restOpps : [];
        if (items.length === 0 && finds.length === 0) return null;
        return (
          <section key={lane} aria-labelledby={`radar-lane-${lane}`} className="space-y-3">
            <h2 id={`radar-lane-${lane}`} className="text-lg font-medium text-ink">
              {LANE_TITLES[lane]}
              <span className="ml-2 text-sm font-normal text-muted-foreground">{items.length + finds.length}</span>
            </h2>
            <div className="space-y-3">
              {items.map((rec) => (
                <RecommendationCard key={rec.id} rec={rec} aiAvailable={aiAvailable} showAiPrompt={false} />
              ))}
              <Finds opportunities={finds} />
            </div>
          </section>
        );
      })}
    </>
  );
}

/** Open web & graph opportunity finds. */
function Finds({ opportunities }: { opportunities: OpportunityView[] }) {
  if (opportunities.length === 0) return null;
  return (
    <>
      {opportunities.map((find) => (
        <OpportunityCard key={find.id} find={find} />
      ))}
    </>
  );
}

/**
 * Shown when the week is thin. Radar only suggests what it can prove, so a quiet week usually
 * means it is missing something only the person can give it.
 */
function HelpRadar({ coldStart }: { coldStart: RadarColdStart }) {
  const steps = [
    { done: coldStart.closePeople >= 3, label: "Rate who’s close to you", href: "/contacts", cta: "Contacts" },
    { done: coldStart.hasCity, label: "Set your city, for events near you", href: "/settings#settings-profile", cta: "Settings" },
    { done: coldStart.goals > 0, label: "Add a goal, for people and programs to look for", href: "/settings#settings-goals", cta: "Goals" },
    { done: coldStart.recentNotes, label: "Log notes after you meet someone", href: "/capture", cta: "Capture" },
  ];
  if (steps.every((s) => s.done)) return null;
  return (
    <section aria-labelledby="radar-help" className="rounded-2xl border border-dashed border-border p-4">
      <h2 id="radar-help" className="font-medium text-ink">
        Help Radar find more
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">Radar only suggests what it can prove, so it needs a few things from you.</p>
      <ul className="mt-3 space-y-2 text-sm">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-2">
            {step.done ? (
              <CircleCheck className="size-4 shrink-0 text-primary" aria-label="Done" />
            ) : (
              <Circle className="size-4 shrink-0 text-muted-foreground" aria-label="To do" />
            )}
            <span className={cn("min-w-0 flex-1", step.done && "text-muted-foreground line-through")}>{step.label}</span>
            {!step.done && (
              <Link href={step.href} className="shrink-0 font-medium text-primary hover:underline">
                {step.cta}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function EmptyState({
  hasContacts,
  ranOnce,
  nextRunAt,
}: {
  hasContacts: boolean;
  ranOnce: boolean;
  nextRunAt: string | null;
}) {
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
  const next = nextRunAt ? new Date(nextRunAt) : null;
  return (
    <div className="rounded-2xl border border-dashed border-border p-8 text-center">
      <p className="font-medium text-ink">{ranOnce ? "All clear" : "Nothing yet"}</p>
      <p className="mt-1 text-sm text-muted-foreground" suppressHydrationWarning>
        {ranOnce
            ? `Nobody needs you right now. Radar checks again ${next ? formatDistanceToNow(next, { addSuffix: true }) : "tonight"}, and anything new will show up here.`
            : "Radar hasn’t found anyone to suggest yet. It checks your network every night."}
      </p>
    </div>
  );
}

const BUILD_STEPS = ["Reading your notes", "Checking who’s moved", "Finding openings", "Picking who matters this week"];
/** Rechecks this often while the first plan builds, and stops after BUILD_POLL_MAX tries (~60s). */
const BUILD_POLL_MS = 5_000;
const BUILD_POLL_MAX = 12;

/**
 * Right after "Turn on Radar": the first plan is building in the background
 * (`turnOnRadar`'s `after()`). Rotates honest step copy and re-reads the page until the run lands.
 */
function BuildingFirstPlan() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  useEffect(() => {
    let n = 0;
    const id = window.setInterval(() => {
      n += 1;
      setStep((s) => (s + 1) % BUILD_STEPS.length);
      router.refresh();
      if (n >= BUILD_POLL_MAX) window.clearInterval(id);
    }, BUILD_POLL_MS);
    return () => window.clearInterval(id);
  }, [router]);
  return (
    <div className="rounded-2xl border border-dashed border-border p-8 text-center" role="status">
      <p className="font-medium text-ink">Building your first plan</p>
      <p className="mt-1 text-sm text-muted-foreground">{BUILD_STEPS[step]}…</p>
    </div>
  );
}
