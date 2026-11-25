/**
 * Radar v2 Graph & Warm-Path Opportunity Synthesizer.
 *
 * Surfaces structural opportunities across the user's network in four bounded reads:
 *   1. Open `contact_opportunities` without near due dates (referrals, intros, partnerships, investments).
 *   2. Target-company mobility & warm-path bridges (`contact_career_moves` + `contact_experiences` × `target_companies` + steering).
 *   3. Upcoming event leverage (`event_attendees` × `target_companies` + active projects + semantic hits).
 *
 * Every signal carries a verifiable `source` tied strictly to its `contactId` and filtered
 * through `metContactSql` so strangers never leak into contact cards.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { normalizeCompanyKey } from "@/lib/company-name";
import { companyMatchKeys } from "@/lib/events/company-list-parse";
import { attendedEventFilter } from "@/lib/events/store";
import { metContactSql } from "@/lib/met-contact";
import { OPEN_OPPORTUNITY_STATUSES } from "@/lib/opportunity-kinds";
import type { UserProject } from "@/lib/projects/store";
import type { SemanticContactHit } from "@/lib/radar/semantic-match";
import type { RadarSignal, RadarSteering } from "@/lib/radar/types";

const DAY_MS = 86_400_000;
const MOVE_LOOKBACK_DAYS = 60;
const EVENT_LOOKAHEAD_DAYS = 14;
const OPEN_OPP_MIN_AGE_DAYS = 2;

function asDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function produceGraphOpportunities(
  userId: string,
  now: Date,
  opts: {
    targetKeys: Map<string, number>;
    projects?: readonly UserProject[];
    steering?: RadarSteering | null;
    semanticMatches?: ReadonlyMap<string, SemanticContactHit>;
  }
): Promise<RadarSignal[]> {
  const db = await getDb();
  const moveSince = new Date(now.getTime() - MOVE_LOOKBACK_DAYS * DAY_MS);
  const eventUntil = new Date(now.getTime() + EVENT_LOOKAHEAD_DAYS * DAY_MS);
  const oppBefore = new Date(now.getTime() - OPEN_OPP_MIN_AGE_DAYS * DAY_MS);
  const dueSoonCutoff = new Date(now.getTime() + 7 * DAY_MS);

  // Combine target_companies keys with user steering targetOrgs.
  const allTargetKeys = new Map<string, { priority: number; fromSteering: boolean }>();
  for (const [k, p] of opts.targetKeys) allTargetKeys.set(k, { priority: p, fromSteering: false });
  for (const org of opts.steering?.targetOrgs ?? []) {
    for (const k of companyMatchKeys(org)) {
      if (!allTargetKeys.has(k)) allTargetKeys.set(k, { priority: 1, fromSteering: true });
    }
    const norm = normalizeCompanyKey(org);
    if (norm && !allTargetKeys.has(norm)) allTargetKeys.set(norm, { priority: 1, fromSteering: true });
  }

  const [openOpps, movesAndExperiences, eventRows] = await Promise.all([
    // 1. Open contact_opportunities without near due dates (internal.ts owns due_date <= 7d).
    db.execute(sql`
      SELECT DISTINCT ON (o.contact_id) o.id, o.contact_id, o.kind, left(o.label, 160) AS label, o.created_at
        FROM contact_opportunities o
        JOIN contacts c ON c.id = o.contact_id AND c.user_id = o.user_id
       WHERE o.user_id = ${userId}
         AND o.status IN (${sql.join(OPEN_OPPORTUNITY_STATUSES.map((s) => sql`${s}`), sql`, `)})
         AND (o.due_date IS NULL OR o.due_date > ${dueSoonCutoff})
         AND o.created_at <= ${oppBefore}
         AND c.constellation_pin IS DISTINCT FROM 'out'
         AND ${metContactSql(sql`c.id`, userId)}
       ORDER BY o.contact_id, o.created_at DESC
       LIMIT 40
    `),

    // 2. Career moves (60d) and current/recent experiences at target or steered orgs.
    allTargetKeys.size > 0
      ? db.execute(sql`
          SELECT 'move' AS src, m.id, m.contact_id, coalesce(m.to_org, c.company) AS org,
                 m.to_title AS title, m.detected_at AS at, true AS is_current
            FROM contact_career_moves m
            JOIN contacts c ON c.id = m.contact_id AND c.user_id = m.user_id
           WHERE m.user_id = ${userId}
             AND m.kind <> 'left'
             AND m.detected_at >= ${moveSince}
             AND c.constellation_pin IS DISTINCT FROM 'out'
             AND ${metContactSql(sql`c.id`, userId)}
          UNION ALL
          SELECT 'exp' AS src, e.id, e.contact_id, e.organization AS org,
                 e.title AS title, coalesce(c.last_interaction_at, e.created_at) AS at, e.is_current
            FROM contact_experiences e
            JOIN contacts c ON c.id = e.contact_id AND c.user_id = e.user_id
           WHERE e.user_id = ${userId}
             AND (e.is_current = true OR e.end_year >= ${now.getUTCFullYear() - 3})
             AND c.constellation_pin IS DISTINCT FROM 'out'
             AND ${metContactSql(sql`c.id`, userId)}
           LIMIT 300
        `)
      : Promise.resolve([]),

    // 3. Upcoming events (next 14d) with known contacts on the roster.
    db.execute(sql`
      SELECT a.id AS attendee_id, a.contact_id, e.id AS event_id, e.title AS event_title,
             e.starts_at, c.company, c.title AS contact_title, c.closeness_tier
        FROM events e
        JOIN event_attendees a ON a.event_id = e.id AND a.user_id = e.user_id
        JOIN contacts c ON c.id = a.contact_id AND c.user_id = e.user_id
       WHERE e.user_id = ${userId}
         AND a.contact_id IS NOT NULL
         AND ${attendedEventFilter()}
         AND e.starts_at > ${now}
         AND e.starts_at <= ${eventUntil}
         AND c.constellation_pin IS DISTINCT FROM 'out'
         AND ${metContactSql(sql`c.id`, userId)}
       ORDER BY e.starts_at ASC
       LIMIT 60
    `),
  ]);

  const out: RadarSignal[] = [];

  for (const r of rowsOf<{ id: string; contact_id: string; kind: string; label: string; created_at: string | Date }>(openOpps)) {
    const at = asDate(r.created_at) ?? now;
    out.push({
      kind: "open_opportunity",
      contactId: r.contact_id,
      at,
      oppKind: r.kind,
      label: r.label,
      source: { table: "contact_opportunities", id: r.id, text: r.label, quote: r.label },
    });
  }

  const warmSeen = new Set<string>();
  for (const r of rowsOf<{
    src: "move" | "exp";
    id: string;
    contact_id: string;
    org: string | null;
    title: string | null;
    at: string | Date;
    is_current: boolean;
  }>(movesAndExperiences)) {
    if (!r.org) continue;
    const keys = [...companyMatchKeys(r.org), normalizeCompanyKey(r.org)].filter(Boolean);
    const matched = keys.find((k) => allTargetKeys.has(k));
    if (!matched) continue;
    const dedupe = `${r.contact_id}:${matched}`;
    if (warmSeen.has(dedupe)) continue;
    warmSeen.add(dedupe);

    const viaMove = r.src === "move";
    const reasonText = viaMove
      ? `Recently joined ${r.org}${r.title ? ` as ${r.title}` : ""} (on your target list)`
      : r.is_current
        ? `Currently at ${r.org}${r.title ? ` (${r.title})` : ""} — warm path`
        : `Previously at ${r.org} — warm path`;

    out.push({
      kind: "warm_path",
      contactId: r.contact_id,
      at: asDate(r.at) ?? now,
      org: r.org,
      reasonText,
      isTarget: true,
      viaMove,
      source: {
        table: viaMove ? "contact_career_moves" : "contact_experiences",
        id: r.id,
      },
    });
  }

  const eventSeen = new Set<string>();
  for (const r of rowsOf<{
    attendee_id: string;
    contact_id: string;
    event_id: string;
    event_title: string;
    starts_at: string | Date;
    company: string | null;
    contact_title: string | null;
    closeness_tier: string | null;
  }>(eventRows)) {
    if (eventSeen.has(r.contact_id)) continue;
    const targetHit = r.company ? companyMatchKeys(r.company).some((k) => allTargetKeys.has(k)) : false;
    const semHit = opts.semanticMatches?.get(r.contact_id);
    if (!targetHit && (!semHit || semHit.similarity < 0.35)) continue;
    eventSeen.add(r.contact_id);

    const reasonText = targetHit
      ? `At ${r.event_title} — works at target org ${r.company}`
      : `At ${r.event_title} — aligns with ${semHit?.projectTitle ?? "your current focus"}`;
    out.push({
      kind: "event_leverage",
      contactId: r.contact_id,
      at: asDate(r.starts_at) ?? now,
      eventId: r.event_id,
      eventTitle: r.event_title,
      reasonText,
      source: { table: "event_attendees", id: r.attendee_id },
    });
  }

  return out;
}
