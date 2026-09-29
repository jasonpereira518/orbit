/**
 * Who, out of everyone in the network, is worth a message this week — and why.
 *
 * ## A score, not a model
 *
 * Same reasoning as `src/lib/events/relevance.ts`, which this mirrors. The answer has to be
 * EXPLAINABLE: every point arrives with a reason a person can read, and the card shows the
 * reasons rather than the number. It has to be STABLE: the same inputs rank the same way on
 * every run, because a list that reshuffles overnight teaches people to stop reading it. The
 * optional AI line (`src/lib/radar/explain.ts`) writes prose about a row this has already
 * chosen; it never changes the choosing.
 *
 * ## One recommendation per person
 *
 * Signals are scored per KIND of recommendation (`src/lib/radar/types.ts`). A person with a
 * meeting on Thursday and an open action item has two candidate kinds; the higher score wins,
 * ties go to the more time-bound kind, and the loser's best reason rides along as an "also"
 * line on the winning card rather than becoming a second card about the same person.
 *
 * ## What the person already said wins
 *
 * Pinned off the constellation: nothing, ever. "Not for this person": nothing, ever.
 * Dismissed: that kind is gone for two weeks, then penalised until a month has passed.
 * Accepted: gone for a week. A follow-up already on the calendar: Reminders owns them, so
 * only a meeting or news can still surface them. Snoozed: gone until the snooze ends.
 *
 * Pure: no database, no network, no AI, and `now` is always an argument.
 */
import {
  CONTEXT_CODES,
  KIND_PRIORITY,
  type RadarEvidence,
  type RadarModel,
  type RadarReason,
  type RadarSignal,
  type RecommendationBucket,
  type RecommendationKind,
} from "@/lib/radar/types";
import { isLearnableReason, kindMultiplier, reasonMultiplier } from "@/lib/radar/model";
import {
  DORMANT_DAYS,
  LINKEDIN_QUIET_MAX_DAYS,
  LINKEDIN_QUIET_MIN_DAYS,
  idleThresholdFor,
} from "@/lib/outreach-thresholds";

const DAY_MS = 86_400_000;

/**
 * Every weight in one object, because they only make sense relative to each other. Exported
 * so the harness asserts ORDERINGS rather than re-typing numbers. Starting values.
 */
export const RADAR_WEIGHTS = {
  // prep
  upcomingMeeting: 40,
  upcomingMeetingWithin48h: 8,
  eventUpcoming: 24,
  // follow_up
  opportunityDue: 26,
  opportunityOverdue: 30,
  actionItemOpen: 20,
  actionItemStale: 6,
  briefNextStep: 10,
  // opportunity
  jobPosting: 28,
  // heads_up: a job move. A new employer is news; a new title at the same one, less so.
  jobChange: { joined: 32, left: 24, title_change: 18 },
  // heads_up: their company in the news; more when it is money or a deal.
  companyNews: 20,
  companyNewsBig: 6,
  // reach_out
  inboundUnanswered: 34,
  recentIntro: 30,
  postEvent: 26,
  linkedinThreadQuiet: 22,
  // reconnect
  dormantBase: 18,
  dormantOverdueStep: 7,
  dormantOverdueCap: 14,
  // context, added to every kind a person already has a reason for
  tier: { inner: 8, mid: 4, outer: 0 },
  priorityHigh: 8,
  priorityMedium: 4,
  statedClose: 4,
  targetCompany: { 1: 14, 2: 10, 3: 5 },
  goalFit: 10,
  // what the person already did or has
  recentTouchPenalty: -25,
  dismissedPenalty: -30,
  scheduledPenalty: -15,
} as const;

/** Half-lives for facts whose value fades. Everything else holds until it stops being true. */
export const RADAR_HALF_LIFE_DAYS = { jobPosting: 21, jobChange: 10, companyNews: 5 } as const;

export const RADAR_BUCKETS = { today: 50, soon: 32, later: 18 } as const;

export const RADAR_CAPS = {
  /** Live recommendations kept per person-account after a run. */
  pending: 12,
  /** Per kind, so one busy kind cannot crowd out the rest. */
  perKind: 4,
  /** Cards in the page's Today section. */
  today: 5,
} as const;

/** Windows, in days. */
export const RADAR_WINDOWS = {
  touchedRecently: 7,
  recentIntroMin: 7,
  recentIntroMax: 21,
  dismissExclude: 14,
  dismissPenalty: 30,
  acceptExclude: 7,
  prepAhead: 7,
  within48h: 2,
  actionItemStale: 14,
  expiry: 7,
  /** An unanswered message is worth a nudge after this long, and stops being one after the upper bound. */
  inboundMin: 5,
  inboundMax: LINKEDIN_QUIET_MAX_DAYS,
  /** A contact added at an event is not a follow-up; a touch a day or more after it is. */
  postEventGrace: 1,
  /** A job move older than this is history, not a reason to write. */
  jobChangeMax: 30,
  /** A headline older than this is not news. */
  newsMax: 7,
} as const;

/** Headlines about money or a deal: worth a little more than a product launch. */
const BIG_NEWS = /\b(raises?|raised|funding|series [a-f]\b|seed round|acquir\w*|merg\w*|ipo|goes public|files? for|valuation)/i;

/** A reason below this after decay is not worth a line. */
const MIN_REASON_POINTS = 4;

export type RadarTier = "inner" | "mid" | "outer";

/** Everything the scorer needs to know about one person, beyond their signals. */
export type RadarContact = {
  id: string;
  company: string | null;
  tier: RadarTier | null;
  priorityLevel: number;
  relationshipScore: number;
  statedCloseness: number | null;
  firstInteractionAt: Date | null;
  lastInteractionAt: Date | null;
  nextFollowUpAt: Date | null;
  constellationPin: "in" | "out" | null;
  cadenceDays: number | null;
  cadencePhrase: string | null;
  /** 1 dream, 2 target, 3 curious — from `target_companies`, or null. */
  targetPriority: 1 | 2 | 3 | null;
  /** 0..1 from `goalRelevanceComponent`. */
  goalFit: number;
  /**
   * Whether the closeness score rests on real evidence (`closeness_evidence` at or above
   * `EVIDENCE_FLOOR`). Every import stamps `last_interaction_at`, so without this a month-old
   * LinkedIn import would make hundreds of placed-by-guess contacts look "dormant".
   */
  hasEvidence: boolean;
};

/** What this person already did with Radar about this contact. */
export type RadarSuppression = {
  /** "Not for this person": every kind, or specific kinds. */
  never: "all" | ReadonlySet<RecommendationKind> | null;
  /** Most recent dismissal per kind. */
  dismissedAt: Partial<Record<RecommendationKind, Date>>;
  /** Most recent accept per kind. */
  acceptedAt: Partial<Record<RecommendationKind, Date>>;
  /** Live snoozes per kind. */
  snoozedUntil: Partial<Record<RecommendationKind, Date>>;
};

export const NO_SUPPRESSION: RadarSuppression = Object.freeze({
  never: null,
  dismissedAt: {},
  acceptedAt: {},
  snoozedUntil: {},
}) as RadarSuppression;

export type KindScore = {
  kind: RecommendationKind;
  /** After this account's learned multipliers. What ranks and buckets the card. */
  score: number;
  /** The scorer's own number, before learning: what a neutral model would have given. */
  baseScore: number;
  reasons: RadarReason[];
  evidence: RadarEvidence[];
  /** The date the most time-bound reason is about, for expiry (a meeting's start). */
  anchorAt: Date | null;
};

export type RadarPick = {
  contactId: string;
  kind: RecommendationKind;
  score: number;
  baseScore: number;
  /** What the AI rerank moved the score by, and its one-line angle. Unset without it. */
  aiDelta?: number | null;
  aiAngle?: string | null;
  bucket: RecommendationBucket;
  reasons: RadarReason[];
  evidence: RadarEvidence[];
  expiresAt: Date;
};

function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / DAY_MS);
}

/** Days since a date, clamped at zero: calendar sync writes meetings up to 60 days ahead. */
function daysSince(date: Date | null, now: Date): number | null {
  if (!date) return null;
  return Math.max(0, daysBetween(now, date));
}

export function decayed(points: number, ageDays: number, halfLifeDays: number): number {
  if (ageDays <= 0) return points;
  return Math.round(points * Math.pow(0.5, ageDays / halfLifeDays));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function dayLabel(date: Date, now: Date): string {
  const days = daysBetween(date, now);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

export function bucketFor(score: number): RecommendationBucket | null {
  if (score >= RADAR_BUCKETS.today) return "today";
  if (score >= RADAR_BUCKETS.soon) return "soon";
  if (score >= RADAR_BUCKETS.later) return "later";
  return null;
}

/** High enough value that silence is worth a nudge on its own. */
function isHighValue(c: RadarContact): boolean {
  return (
    c.priorityLevel >= 2 ||
    c.relationshipScore >= 4 ||
    (c.statedCloseness ?? 0) >= 4 ||
    (c.hasEvidence && (c.tier === "inner" || c.tier === "mid"))
  );
}

type Draft = { reasons: RadarReason[]; evidence: RadarEvidence[]; anchorAt: Date | null };

function add(
  drafts: Map<RecommendationKind, Draft>,
  kind: RecommendationKind,
  reason: RadarReason,
  evidence?: RadarEvidence,
  anchorAt?: Date | null
) {
  if (reason.points < MIN_REASON_POINTS) return;
  let draft = drafts.get(kind);
  if (!draft) {
    draft = { reasons: [], evidence: [], anchorAt: null };
    drafts.set(kind, draft);
  }
  draft.reasons.push(reason);
  if (evidence) draft.evidence.push(evidence);
  if (anchorAt && (!draft.anchorAt || anchorAt < draft.anchorAt)) draft.anchorAt = anchorAt;
}

/**
 * Score every kind this person has a reason for. Returns one entry per surviving kind, each
 * with at least one base reason; context points never create a kind on their own.
 */
export function scoreContactKinds(
  contact: RadarContact,
  signals: readonly RadarSignal[],
  suppression: RadarSuppression,
  now: Date,
  /** What this account has taught Radar (`src/lib/radar/model.ts`). Null scores neutrally. */
  model: RadarModel | null = null
): KindScore[] {
  if (contact.constellationPin === "out") return [];
  if (suppression.never === "all") return [];

  const W = RADAR_WEIGHTS;
  const drafts = new Map<RecommendationKind, Draft>();
  const iso = (d: Date | null) => (d ? d.toISOString() : null);

  for (const s of signals) {
    switch (s.kind) {
      case "upcoming_meeting": {
        const within48h = s.at.getTime() - now.getTime() <= RADAR_WINDOWS.within48h * DAY_MS;
        add(
          drafts,
          "prep",
          {
            code: "upcoming_meeting",
            label: `You’re meeting ${dayLabel(s.at, now)}`,
            points: W.upcomingMeeting + (within48h ? W.upcomingMeetingWithin48h : 0),
          },
          { label: s.title ? `Meeting: ${s.title}` : "Meeting on your calendar", at: iso(s.at) },
          s.at
        );
        break;
      }
      case "event_upcoming":
        add(
          drafts,
          "prep",
          { code: "event_upcoming", label: `You’ll both be at ${s.title} ${dayLabel(s.at, now)}`, points: W.eventUpcoming },
          { label: `Event: ${s.title}`, at: iso(s.at) },
          s.at
        );
        break;
      case "post_event": {
        const days = daysSince(s.at, now) ?? 0;
        const followedUp =
          contact.lastInteractionAt !== null &&
          contact.lastInteractionAt.getTime() > s.at.getTime() + RADAR_WINDOWS.postEventGrace * DAY_MS;
        if (followedUp) break;
        add(
          drafts,
          "reach_out",
          { code: "post_event", label: `You were both at ${s.title} ${plural(days, "day")} ago`, points: W.postEvent },
          { label: `Event: ${s.title}`, at: iso(s.at) }
        );
        break;
      }
      case "action_item_open": {
        const age = daysSince(s.at, now) ?? 0;
        const more = s.count > 1 ? ` (and ${plural(s.count - 1, "more")})` : "";
        add(
          drafts,
          "follow_up",
          {
            code: "action_item_open",
            label: `Open item: ${s.text}${more}`,
            points: W.actionItemOpen + (age > RADAR_WINDOWS.actionItemStale ? W.actionItemStale : 0),
          },
          { label: `Open for ${plural(age, "day")}`, at: iso(s.at) }
        );
        break;
      }
      case "opportunity_due": {
        const overdue = s.at.getTime() < now.getTime();
        add(
          drafts,
          "follow_up",
          {
            code: overdue ? "opportunity_overdue" : "opportunity_due",
            label: overdue ? `${s.label} was due ${plural(daysSince(s.at, now) ?? 0, "day")} ago` : `${s.label} is due ${dayLabel(s.at, now)}`,
            points: overdue ? W.opportunityOverdue : W.opportunityDue,
          },
          { label: `Opportunity: ${s.label}`, at: iso(s.at) }
        );
        break;
      }
      case "brief_next_step":
        add(drafts, "follow_up", { code: "brief_next_step", label: `Next step: ${s.text}`, points: W.briefNextStep });
        break;
      case "job_posting": {
        const age = daysSince(s.at, now) ?? 0;
        add(
          drafts,
          "opportunity",
          { code: "job_posting", label: s.text, points: decayed(W.jobPosting, age, RADAR_HALF_LIFE_DAYS.jobPosting) },
          { label: "New roles at their company", at: iso(s.at) }
        );
        break;
      }
      case "company_news": {
        const age = daysSince(s.at, now) ?? 0;
        if (age > RADAR_WINDOWS.newsMax) break;
        const base = W.companyNews + (BIG_NEWS.test(s.title) ? W.companyNewsBig : 0);
        add(
          drafts,
          "heads_up",
          { code: "company_news", label: `${s.company} in the news: ${s.title}`.slice(0, 200), points: decayed(base, age, RADAR_HALF_LIFE_DAYS.companyNews) },
          { label: s.source, at: iso(s.at), url: s.url }
        );
        break;
      }
      case "job_change": {
        const age = daysSince(s.at, now) ?? 0;
        if (age > RADAR_WINDOWS.jobChangeMax) break;
        add(
          drafts,
          "heads_up",
          { code: "job_change", label: s.text, points: decayed(W.jobChange[s.move], age, RADAR_HALF_LIFE_DAYS.jobChange) },
          { label: "Job move", at: iso(s.at) }
        );
        break;
      }
      case "inbound_unanswered": {
        const days = daysSince(s.at, now) ?? 0;
        if (days < RADAR_WINDOWS.inboundMin || days > RADAR_WINDOWS.inboundMax) break;
        add(
          drafts,
          "reach_out",
          { code: "inbound_unanswered", label: `They messaged you ${plural(days, "day")} ago and haven’t heard back`, points: W.inboundUnanswered },
          { label: "LinkedIn message", at: iso(s.at) }
        );
        break;
      }
      case "linkedin_thread_quiet": {
        const days = daysSince(s.at, now) ?? 0;
        // Only the lower bound bends to a stated rhythm; see `outreach-thresholds.ts`.
        if (days < idleThresholdFor(contact.cadenceDays, LINKEDIN_QUIET_MIN_DAYS) || days > LINKEDIN_QUIET_MAX_DAYS) break;
        if (s.count < 2) break;
        add(
          drafts,
          "reach_out",
          { code: "linkedin_thread_quiet", label: `Your LinkedIn thread went quiet ${plural(days, "day")} ago`, points: W.linkedinThreadQuiet },
          { label: `${plural(s.count, "message")} on LinkedIn`, at: iso(s.at) }
        );
        break;
      }
    }
  }

  // A fresh intro with nothing since: the one follow-up that decays fastest if skipped.
  if (contact.firstInteractionAt) {
    const days = daysSince(contact.firstInteractionAt, now) ?? 0;
    const single =
      !contact.lastInteractionAt ||
      contact.lastInteractionAt.getTime() === contact.firstInteractionAt.getTime();
    if (single && days >= RADAR_WINDOWS.recentIntroMin && days <= RADAR_WINDOWS.recentIntroMax) {
      add(
        drafts,
        "reach_out",
        { code: "recent_intro", label: `You met ${plural(days, "day")} ago and haven’t followed up`, points: W.recentIntro },
        { label: "First met", at: iso(contact.firstInteractionAt) }
      );
    }
  }

  // Dormancy, against the rhythm the person stated or the default window. Unknown recency
  // is not dormancy: a contact with no touch on record is skipped rather than nagged about.
  const idle = daysSince(contact.lastInteractionAt, now);
  if (idle !== null && isHighValue(contact)) {
    const window = idleThresholdFor(contact.cadenceDays, DORMANT_DAYS);
    if (idle >= window) {
      const overdue = Math.min(W.dormantOverdueCap, Math.round(W.dormantOverdueStep * (idle / window - 1)));
      add(
        drafts,
        "reconnect",
        {
          code: "dormant",
          label: contact.cadencePhrase
            ? `You said “${contact.cadencePhrase}”, and it’s been ${plural(idle, "day")}`
            : `${plural(idle, "day")} since you last spoke`,
          points: W.dormantBase + overdue,
        },
        { label: "Last touch", at: iso(contact.lastInteractionAt) }
      );
    }
  }

  // Context, suppression and totals, per kind.
  const touchedRecently = idle !== null && idle < RADAR_WINDOWS.touchedRecently;
  const scheduled = contact.nextFollowUpAt !== null;
  const out: KindScore[] = [];

  for (const [kind, draft] of drafts) {
    if (suppression.never !== null && suppression.never.has(kind)) continue;
    const snoozed = suppression.snoozedUntil[kind];
    if (snoozed && snoozed > now) continue;
    const accepted = suppression.acceptedAt[kind];
    if (accepted && daysBetween(now, accepted) < RADAR_WINDOWS.acceptExclude) continue;
    const dismissed = suppression.dismissedAt[kind];
    const dismissedDays = dismissed ? daysBetween(now, dismissed) : null;
    if (dismissedDays !== null && dismissedDays < RADAR_WINDOWS.dismissExclude) continue;
    if (scheduled && kind !== "prep" && kind !== "heads_up") continue;

    const reasons = [...draft.reasons];
    const tierPoints = contact.tier ? W.tier[contact.tier] : 0;
    if (tierPoints > 0) {
      reasons.push({ code: "tier", label: contact.tier === "inner" ? "One of your closest" : "A solid connection", points: tierPoints });
    }
    if (contact.priorityLevel >= 3) reasons.push({ code: "priority", label: "Marked high priority", points: W.priorityHigh });
    else if (contact.priorityLevel === 2) reasons.push({ code: "priority", label: "Marked a priority", points: W.priorityMedium });
    if ((contact.statedCloseness ?? 0) >= 4) reasons.push({ code: "stated_close", label: "You rated them close", points: W.statedClose });
    if (contact.targetPriority !== null) {
      reasons.push({
        code: "target_company",
        label: contact.company ? `Works at ${contact.company}, on your target list` : "At a company on your target list",
        points: W.targetCompany[contact.targetPriority],
      });
    }
    const goalPoints = Math.round(W.goalFit * Math.min(1, Math.max(0, contact.goalFit)));
    if (goalPoints > 0) reasons.push({ code: "goal_match", label: "Fits what you’re working on", points: goalPoints });
    if (touchedRecently && (kind === "reach_out" || kind === "reconnect")) {
      reasons.push({ code: "touched_recently", label: "You spoke recently", points: W.recentTouchPenalty });
    }
    if (dismissedDays !== null && dismissedDays < RADAR_WINDOWS.dismissPenalty) {
      reasons.push({ code: "dismissed_recently", label: "You dismissed this recently", points: W.dismissedPenalty });
    }
    if (scheduled) reasons.push({ code: "already_scheduled", label: "A follow-up is already set", points: W.scheduledPenalty });

    const baseScore = clampScore(reasons.reduce((sum, r) => sum + r.points, 0));
    const score = learnedScore(reasons, kind, model);
    reasons.sort((a, b) => b.points - a.points || a.code.localeCompare(b.code));
    out.push({ kind, score, baseScore, reasons, evidence: draft.evidence, anchorAt: draft.anchorAt });
  }

  return out.sort(compareKindScores);
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * The score after learning. Each learnable (signal) reason's points are scaled by the
 * geometric mean of its kind's multiplier and its own: a reconnect card nearly always
 * carries the dormancy reason, so multiplying by both would count the same votes twice.
 * The mean keeps each reason inside the model's bounds. Context reasons and penalties are
 * added back unchanged. With a neutral model every multiplier is 1 and this is exactly the
 * base score. Reason `points` stay the scorer's own, so the card, the "also" line and the AI
 * note key never move with it.
 */
function learnedScore(reasons: readonly RadarReason[], kind: RecommendationKind, model: RadarModel | null): number {
  if (!model) return clampScore(reasons.reduce((sum, r) => sum + r.points, 0));
  const k = kindMultiplier(model, kind);
  let total = 0;
  for (const r of reasons) {
    if (r.points > 0 && isLearnableReason(r.code)) total += r.points * Math.sqrt(k * reasonMultiplier(model, r.code));
    else total += r.points;
  }
  return clampScore(total);
}

function compareKindScores(a: KindScore, b: KindScore): number {
  return b.score - a.score || KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind];
}

/** When a recommendation stops being worth showing if nothing refreshes it. */
export function expiryFor(kind: RecommendationKind, anchorAt: Date | null, now: Date): Date {
  if (kind === "prep" && anchorAt) return new Date(anchorAt.getTime() + DAY_MS);
  return new Date(now.getTime() + RADAR_WINDOWS.expiry * DAY_MS);
}

/**
 * The winning kind for one person, with the runner-up's best base reason carried as a
 * zero-point "also" line. Null when nothing clears the lowest bucket.
 */
export function pickWinner(contactId: string, kinds: readonly KindScore[], now: Date): RadarPick | null {
  const ranked = [...kinds].sort(compareKindScores);
  const winner = ranked[0];
  if (!winner) return null;
  const bucket = bucketFor(winner.score);
  if (!bucket) return null;
  const reasons = [...winner.reasons];
  const runnerUp = ranked[1];
  const also = runnerUp?.reasons.find(
    (r) => r.points > 0 && !CONTEXT_CODES.has(r.code) && !REDUNDANT_ALSO[winner.kind]?.has(r.code)
  );
  if (also) reasons.push({ code: `also:${also.code}`, label: also.label, points: 0 });
  return {
    contactId,
    kind: winner.kind,
    score: winner.score,
    baseScore: winner.baseScore,
    bucket,
    reasons,
    evidence: winner.evidence.slice(0, 2),
    expiresAt: expiryFor(winner.kind, winner.anchorAt, now),
  };
}

/**
 * An "also" line that would only restate the winner's lead. A reach-out already dates the
 * silence ("They messaged you 43 days ago…"), so "43 days since you last spoke" under it
 * says the same thing twice. Under a prep or follow-up card the same line is real news.
 */
const REDUNDANT_ALSO: Partial<Record<RecommendationKind, ReadonlySet<string>>> = {
  reach_out: new Set(["dormant"]),
};

/** Re-exported from the vocabulary module, where the model can read it without a cycle. */
export { CONTEXT_CODES };

/**
 * The run's final list: best first, at most `perKind` of any kind, at most `pending` total.
 * Ties break on kind priority, then contact id, so the order is total and repeatable.
 */
export function rankPicks<T extends RadarPick>(picks: readonly T[], caps: { pending: number; perKind: number } = RADAR_CAPS): T[] {
  const sorted = [...picks].sort(
    (a, b) => b.score - a.score || KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind] || a.contactId.localeCompare(b.contactId)
  );
  const perKind = new Map<RecommendationKind, number>();
  const out: T[] = [];
  for (const pick of sorted) {
    if (out.length >= caps.pending) break;
    const n = perKind.get(pick.kind) ?? 0;
    if (n >= caps.perKind) continue;
    perKind.set(pick.kind, n + 1);
    out.push(pick);
  }
  return out;
}
