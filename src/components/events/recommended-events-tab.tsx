"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  Check,
  ExternalLink,
  Flame,
  Loader2,
  MapPin,
  Plus,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { addRecommendedEvent } from "@/actions/events";
import type { RecommendedEvent } from "@/lib/events/recommendations";
import { eventGradient, eventThemeVars } from "@/lib/events/theme";
import { friendlyError } from "@/lib/errors";

function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const PLATFORM_LABELS: Record<RecommendedEvent["platform"], string> = {
  luma: "Luma",
  eventbrite: "Eventbrite",
  partiful: "Partiful",
  web: "Web",
};

export function RecommendedEventsTab({
  recommendations,
}: {
  recommendations: RecommendedEvent[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(
    new Set(recommendations.filter((r) => r.alreadyAdded).map((r) => r.id))
  );
  const [filterCity, setFilterCity] = useState<string>("all");

  const cities = Array.from(
    new Set(
      recommendations
        .map((r) => r.city)
        .filter((c): c is string => Boolean(c && c.trim()))
    )
  );

  const filtered = recommendations.filter((r) => {
    if (filterCity === "all") return true;
    if (filterCity === "online") return r.attendanceMode === "online";
    return r.city?.toLowerCase() === filterCity.toLowerCase();
  });

  function handleAdd(rec: RecommendedEvent) {
    setAddingId(rec.id);
    start(async () => {
      try {
        const result = await addRecommendedEvent(rec);
        if (!result.ok) {
          toast.error(friendlyError(result.error, "Could not add event"));
          return;
        }
        setAddedIds((prev) => new Set([...prev, rec.id]));
        toast.success(
          result.value.existing
            ? "Already in your events list"
            : `Added "${rec.title}" to your upcoming events!`
        );
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Could not add event"));
      } finally {
        setAddingId(null);
      }
    });
  }

  if (recommendations.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 p-10 text-center">
        <Sparkles className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <h3 className="mt-3 text-base font-medium text-ink">No recommendations yet</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Attend or paste a few past events, and Orbit&apos;s recommendation engine will suggest
          upcoming events matching your topics and network.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* City Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Filter:</span>
        <button
          type="button"
          onClick={() => setFilterCity("all")}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            filterCity === "all"
              ? "bg-primary text-primary-foreground"
              : "border border-border/70 bg-card text-muted-foreground hover:bg-muted hover:text-ink"
          }`}
        >
          All Locations
        </button>
        {cities.map((city) => (
          <button
            key={city}
            type="button"
            onClick={() => setFilterCity(city)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              filterCity === city
                ? "bg-primary text-primary-foreground"
                : "border border-border/70 bg-card text-muted-foreground hover:bg-muted hover:text-ink"
            }`}
          >
            {city}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setFilterCity("online")}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            filterCity === "online"
              ? "bg-primary text-primary-foreground"
              : "border border-border/70 bg-card text-muted-foreground hover:bg-muted hover:text-ink"
          }`}
        >
          Virtual / Online
        </button>
      </div>

      {/* Grid of Recommended Events */}
      <div className="grid gap-5 sm:grid-cols-2">
        {filtered.map((event) => {
          const isAdded = addedIds.has(event.id);
          const isBusy = addingId === event.id && pending;
          const themeVars = eventThemeVars(event.themeColor);

          return (
            <div
              key={event.id}
              className="event-theme group relative flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-card transition-all hover:border-[var(--event-accent)] hover:shadow-lg"
              style={themeVars as React.CSSProperties}
            >
              {/* Event Cover Image / Gradient */}
              <div
                className="relative aspect-[16/7] w-full overflow-hidden bg-muted"
                style={
                  event.coverImageUrl
                    ? undefined
                    : { backgroundImage: eventGradient(event.themeColor) }
                }
              >
                {event.coverImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={event.coverImageUrl}
                    alt=""
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                    loading="lazy"
                  />
                ) : null}

                {/* Match Score Badge */}
                <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-black/75 px-2.5 py-1 text-xs font-semibold text-white shadow-sm backdrop-blur-md">
                  <Flame className="size-3.5 text-amber-400" aria-hidden />
                  <span>{event.matchScore}% Match</span>
                </div>

                {/* Platform Badge */}
                <div className="absolute left-3 top-3 rounded-full bg-black/60 px-2 py-0.5 text-3xs font-medium text-white/90 backdrop-blur-sm">
                  {PLATFORM_LABELS[event.platform]}
                </div>
              </div>

              {/* Event Body */}
              <div className="flex flex-1 flex-col p-4">
                <h3 className="line-clamp-1 font-medium text-ink transition-colors group-hover:text-[var(--event-accent)]">
                  {event.title}
                </h3>

                {event.organizerName ? (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    by {event.organizerName}
                  </p>
                ) : null}

                {/* Match Reasons */}
                <ul className="mt-2.5 flex flex-wrap gap-1.5">
                  {event.matchReasons.map((reason, idx) => (
                    <li
                      key={idx}
                      className="inline-flex items-center gap-1 rounded-full bg-[var(--event-tint)] px-2 py-0.5 text-2xs font-medium text-[var(--event-accent)]"
                    >
                      <Sparkles className="size-2.5 shrink-0" aria-hidden />
                      <span className="truncate max-w-[200px]">{reason}</span>
                    </li>
                  ))}
                </ul>

                <p className="mt-2.5 line-clamp-2 text-xs text-muted-foreground">
                  {event.description}
                </p>

                {/* Metadata */}
                <div className="mt-auto pt-4 space-y-1 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span>{formatDate(event.startsAt)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <MapPin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">
                      {event.attendanceMode === "online"
                        ? "Virtual / Online"
                        : [event.venue, event.city].filter(Boolean).join(", ") || "Location TBA"}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="mt-4 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
                  <a
                    href={event.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-ink hover:underline"
                  >
                    View RSVP
                    <ExternalLink className="size-3" aria-hidden />
                  </a>

                  {isAdded ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      <Check className="size-3.5" aria-hidden />
                      Added to Events
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => handleAdd(event)}
                      disabled={isBusy}
                      className="h-8 gap-1.5 text-xs"
                    >
                      {isBusy ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      ) : (
                        <Plus className="size-3.5" aria-hidden />
                      )}
                      Add to My Events
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
