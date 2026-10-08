/**
 * The pure half of Radar's morning briefing and the page's "What changed" strip: which cards
 * are news, and how the briefing summarises a list. No database, so the smoke pins it and the
 * dashboard and `/radar` agree on what "changed" means.
 */
import { JOB_LEFT_CODE, JOB_MOVE_CODE, leadReason, type RadarDraft, type RadarReason, type RecommendationKind } from "@/lib/radar/types";

/** Reasons that come from outside Orbit: a job move, a headline, a post. */
export const SIGNAL_CODES: ReadonlySet<string> = new Set([JOB_MOVE_CODE, JOB_LEFT_CODE, "company_news", "social_post"]);
/** People the dashboard's briefing shows; the rest are a count and a link. */
export const BRIEFING_TOP = 3;
export const WHAT_CHANGED_MAX = 4;
/** A card this new is news even after it has been seen once (a nightly run is ~24 h apart). */
export const WHAT_CHANGED_HOURS = 36;

type ChangeInput = {
  id: string;
  contactId: string;
  contactName: string;
  kind: RecommendationKind;
  reasons: readonly RadarReason[];
  createdAt: Date;
  firstSeenAt: Date | null;
};

export type ChangeLine = { id: string; contactId: string; contactName: string; label: string };

/**
 * The cards that are news: a signal from outside behind them, and either not yet seen or
 * made in the last day and a half. In list order (best first), at most `max`.
 */
export function whatChanged(rows: readonly ChangeInput[], now: Date, max = WHAT_CHANGED_MAX): ChangeLine[] {
  const recent = now.getTime() - WHAT_CHANGED_HOURS * 3_600_000;
  const out: ChangeLine[] = [];
  for (const r of rows) {
    const signal = r.reasons.find((x) => x.points > 0 && SIGNAL_CODES.has(x.code));
    if (!signal) continue;
    if (r.firstSeenAt !== null && r.createdAt.getTime() < recent) continue;
    out.push({ id: r.id, contactId: r.contactId, contactName: r.contactName, label: signal.label });
    if (out.length >= max) break;
  }
  return out;
}

/** The one line a compact card leads with: the AI's reason when there is one, else the scorer's. */
export function cardLine(row: {
  reasons: readonly RadarReason[];
  aiAngle?: string | null;
  aiNote?: { why: string } | null;
}): string | null {
  return row.aiNote?.why?.trim() || row.aiAngle?.trim() || leadReason(row.reasons)?.label || null;
}

export function draftsReady(rows: readonly { draft?: RadarDraft | null }[]): number {
  return rows.filter((r) => Boolean(r.draft)).length;
}
