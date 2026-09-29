"use client";

import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import { ChevronLeft, ChevronRight, Focus, LayoutList, Play, RefreshCw, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RecommendationCard, type RecommendationCardData } from "@/components/radar/recommendation-card";
import { RadarSettingsSheet } from "@/components/radar/radar-settings-sheet";
import { useRadarKeys } from "@/components/radar/use-radar-keys";
import { refreshRadarNow, setRadarPaused, undoAutopilot } from "@/actions/radar";
import { friendlyError } from "@/lib/errors";
import type { ChangeLine } from "@/lib/radar/briefing";
import { RADAR_SHORTCUTS } from "@/lib/radar/focus-keys";
import type { RadarSettingsView } from "@/lib/radar/page-data";
import { RADAR_CAPS } from "@/lib/radar/score";
import { KIND_SECTION_TITLES, RECOMMENDATION_KINDS, type RecommendationKind } from "@/lib/radar/types";
import { toast } from "@/lib/toast";
import { syncTimeZoneCookie } from "@/lib/tz-cookie";
import { cn } from "@/lib/utils";

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
  paused: boolean;
  aiAvailable: boolean;
  hasContacts: boolean;
  settings: RadarSettingsView;
  autopilot: RadarAutopilotItem[];
  changes: ChangeLine[];
  signalsThisWeek: number;
  /** A card to open on, from the Monday email or the dashboard (`/radar?focus=<id>`). */
  focusId: string | null;
};

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

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function RadarView(props: RadarViewProps) {
  const { recommendations, lastRunAt, nextRunAt, paused, aiAvailable, hasContacts, settings, autopilot, changes, signalsThisWeek, focusId } =
    props;
  const router = useRouter();
  const [pending, start] = useTransition();
  const linked = focusId ? recommendations.findIndex((r) => r.id === focusId) : -1;
  // The server always draws the list; the browser then opens in focus mode for a linked card,
  // a remembered choice, or a phone. A choice made here wins from then on.
  const arrival = useSyncExternalStore(noSubscription, () => arrivalMode(linked >= 0), () => "list" as Mode);
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode = chosen ?? arrival;
  const [index, setIndex] = useState(Math.max(0, linked));

  // So the Monday email arrives on this person's Monday morning (`captureRadarTimeZone`).
  useEffect(() => syncTimeZoneCookie(), []);

  const chooseMode = (next: Mode) => {
    setChosen(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // Private mode: the choice lasts until the page closes.
    }
  };

  const jumpTo = (id: string) => {
    const i = recommendations.findIndex((r) => r.id === id);
    if (i < 0) return;
    if (mode === "focus") {
      setIndex(i);
      return;
    }
    document.getElementById(`radar-card-${id}`)?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  };

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

  const resume = () =>
    start(async () => {
      try {
        const result = await setRadarPaused(false);
        if (result.ok) toast.success(result.message ?? "Radar resumed");
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t change that — try again?"));
      }
    });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <p suppressHydrationWarning>
          {paused
            ? "Paused. Nothing updates overnight until you resume."
            : lastRunAt
              ? `Updated ${formatDistanceToNow(new Date(lastRunAt), { addSuffix: true })}`
              : "Your first list is being put together."}
          {!paused && signalsThisWeek > 0 && (
            <span>
              {" · "}
              {signalsThisWeek} new {signalsThisWeek === 1 ? "signal" : "signals"} this week
            </span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {recommendations.length > 0 && (
            <div role="group" aria-label="Layout" className="mr-1 inline-flex rounded-lg border border-border/70 p-0.5">
              <ModeButton active={mode === "focus"} onClick={() => chooseMode("focus")} icon={Focus} label="Focus" />
              <ModeButton active={mode === "list"} onClick={() => chooseMode("list")} icon={LayoutList} label="List" />
            </div>
          )}
          {paused ? (
            <Button type="button" size="sm" variant="outline" className="h-8" disabled={pending} onClick={resume}>
              <Play className="size-3.5" aria-hidden />
              Resume
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" className="h-8" disabled={pending} onClick={refresh}>
              <RefreshCw className={pending ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
              Refresh now
            </Button>
          )}
          <RadarSettingsSheet settings={settings} />
        </div>
      </div>

      {changes.length > 0 && <WhatChanged changes={changes} onJump={jumpTo} />}
      {autopilot.length > 0 && <AutopilotDid items={autopilot} />}

      {recommendations.length === 0 ? (
        <EmptyState hasContacts={hasContacts} ranOnce={lastRunAt !== null} nextRunAt={nextRunAt} paused={paused} />
      ) : mode === "focus" ? (
        <FocusDeck recommendations={recommendations} index={index} setIndex={setIndex} aiAvailable={aiAvailable} />
      ) : (
        <ListView recommendations={recommendations} aiAvailable={aiAvailable} />
      )}
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

/** One card at a time. `j`/`k` move; the card itself answers `s`, `d`, `z` and `x`. */
function FocusDeck({
  recommendations,
  index,
  setIndex,
  aiAvailable,
}: {
  recommendations: RecommendationCardData[];
  index: number;
  setIndex: (i: number) => void;
  aiAvailable: boolean;
}) {
  const count = recommendations.length;
  // A resolved card leaves the list, so the same index is already the next one.
  const at = Math.min(index, count - 1);
  const current = recommendations[at]!;
  const inToday = at < RADAR_CAPS.today;
  const move = (delta: number) => setIndex(Math.max(0, Math.min(count - 1, at + delta)));

  useRadarKeys(true, (command) => {
    if (command === "next") move(1);
    else if (command === "prev") move(-1);
  });

  return (
    <section aria-labelledby="radar-focus" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="radar-focus" className="text-lg font-medium text-ink">
          {inToday ? "Today" : KIND_SECTION_TITLES[current.kind]}
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
      <RecommendationCard key={current.id} rec={current} aiAvailable={aiAvailable} showAiPrompt={inToday} shortcuts />
      <p className="hidden text-xs text-muted-foreground pointer-fine:block">
        {RADAR_SHORTCUTS.map((s, i) => (
          <span key={s.label}>
            {i > 0 ? " · " : ""}
            {s.keys.map((k, j) => (
              <span key={k}>
                {j > 0 ? "/" : ""}
                <kbd className="rounded border border-border/70 bg-muted px-1 font-sans text-[11px] text-ink">{k}</kbd>
              </span>
            ))}{" "}
            {s.label}
          </span>
        ))}
      </p>
    </section>
  );
}

function ListView({ recommendations, aiAvailable }: { recommendations: RecommendationCardData[]; aiAvailable: boolean }) {
  // Best first, as the store returns them. Today is the top of the whole list; the rest
  // are grouped by kind so a person can work through one sort of thing at a time.
  const today = recommendations.slice(0, RADAR_CAPS.today);
  const rest = recommendations.slice(RADAR_CAPS.today);
  const groups = RECOMMENDATION_KINDS.map((kind) => ({
    kind,
    items: rest.filter((r) => r.kind === kind),
  })).filter((g) => g.items.length > 0);

  return (
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

function EmptyState({
  hasContacts,
  ranOnce,
  nextRunAt,
  paused,
}: {
  hasContacts: boolean;
  ranOnce: boolean;
  nextRunAt: string | null;
  paused: boolean;
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
        {paused
          ? "Radar is paused. Resume it to hear about new people."
          : ranOnce
            ? `Nobody needs you right now. Radar checks again ${next ? formatDistanceToNow(next, { addSuffix: true }) : "tonight"}, and anything new will show up here.`
            : "Radar hasn’t found anyone to suggest yet. It checks your network every night."}
      </p>
    </div>
  );
}
