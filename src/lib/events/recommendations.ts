/**
 * The Events page's Recommended tab: upcoming events Radar's web pass found near the person
 * (`src/lib/radar/opportunities.ts`). Every one has a link the search cited and a date in the
 * future; nothing here is invented. Empty until the person's account has run a web pass.
 */
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { events, radarOpportunities } from "@/db/schema";
import { resolveThemeColor } from "@/lib/events/theme";

export type RecommendedEvent = {
  id: string;
  title: string;
  description: string;
  startsAt: string;
  endsAt?: string | null;
  venue: string | null;
  city: string | null;
  attendanceMode: "offline" | "online" | "mixed";
  url: string;
  coverImageUrl?: string | null;
  themeColor: string;
  organizerName: string | null;
  platform: "luma" | "eventbrite" | "partiful" | "web";
  /** 0 = no score to show. */
  matchScore: number;
  matchReasons: string[];
  topics: string[];
  alreadyAdded: boolean;
};

const SHOWN = 12;

function platformOf(url: string): RecommendedEvent["platform"] {
  const host = new URL(url).hostname;
  if (/(^|\.)(lu\.ma|luma\.com)$/.test(host)) return "luma";
  if (/(^|\.)eventbrite\./.test(host)) return "eventbrite";
  if (/(^|\.)partiful\.com$/.test(host)) return "partiful";
  return "web";
}

export async function getRecommendedUpcomingEvents(userId: string, now: Date = new Date()): Promise<RecommendedEvent[]> {
  const db = await getDb();
  const [rows, mine] = await Promise.all([
    db
      .select()
      .from(radarOpportunities)
      .where(
        and(
          eq(radarOpportunities.userId, userId),
          eq(radarOpportunities.kind, "event"),
          inArray(radarOpportunities.status, ["found", "pending"]),
          gt(radarOpportunities.startsAt, now)
        )
      )
      .orderBy(asc(radarOpportunities.startsAt))
      .limit(SHOWN),
    db.select({ url: events.url }).from(events).where(eq(events.userId, userId)),
  ]);
  const added = new Set(mine.map((e) => e.url).filter(Boolean));
  return rows.flatMap((r) => {
    if (!r.url || !r.startsAt) return [];
    // The writer puts the venue the page (or search) gave in the proof's label: "At <venue>".
    const label = r.evidence[0]?.label ?? "";
    return [
      {
        id: r.id,
        title: r.title,
        description: r.why ?? "",
        startsAt: r.startsAt.toISOString(),
        endsAt: null,
        venue: label.startsWith("At ") ? label.slice(3) : null,
        city: null,
        attendanceMode: "offline" as const,
        url: r.url,
        coverImageUrl: null,
        themeColor: resolveThemeColor({ seed: r.title }).color,
        organizerName: null,
        platform: platformOf(r.url),
        matchScore: 0,
        matchReasons: r.why ? [r.why] : [],
        topics: [],
        alreadyAdded: added.has(r.url),
      },
    ];
  });
}
