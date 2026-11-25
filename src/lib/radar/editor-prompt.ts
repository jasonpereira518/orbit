/**
 * The pure half of Radar's editor: what the model sees, how its reply is checked, and how far
 * it is allowed to move anything. The IO half (the call, the cache, the briefs) is
 * `editor.ts`; everything here is pinned by `scripts/smoke-radar-score.ts` with no model.
 *
 * The editor is one call per weekly build (docs/superpowers/specs/2026-11-10-radar-analyst-
 * design.md). It replaced two: the rerank (which moved scores) and one why-line call per card.
 * Now the same call that orders the week also says why each card matters and offers a first
 * line to send, so the order and the words cannot disagree.
 *
 * ## Bounded by construction
 *
 * The rules engine (`score.ts`) chooses the cards, writes every reason on them, and the proof
 * check (`verify.ts`) has already dropped any it could not prove. The model sees a shortlist of
 * at most `RADAR_EDITOR_SIZE` of those cards and may nudge each by at most
 * ±`RADAR_EDITOR_MAX_ADJUST` points. It cannot add a card, remove one (a card never drops below
 * the lowest bucket score it already cleared), write a reason, or push a meeting in the next two
 * days down at all. Its words are checked like any model output: guarded, one line, capped,
 * and dropped when they state a number the facts never contained.
 *
 * ## What it sees
 *
 * Per card: the kind, the person's title and company, their closeness tier, the reason and
 * evidence LABELS the scorer wrote, and the one-line standing from their contact brief. Not
 * their name: neither the order nor the words need it, so the prompt does not carry it. Never
 * notes, quotes from mail or message bodies; a card built from email carries one model-written
 * sentence about it, inside the same fence. The account's goal texts, which the person typed,
 * go in a fence of their own. Everything third-party-shaped is cleaned to single lines and
 * fenced.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { cleanSingleLine, fenceUntrusted, guardModelOutput } from "@/lib/ai-security";
import { RADAR_BUCKETS, type RadarPick } from "@/lib/radar/score";
import {
  KIND_LABELS,
  RADAR_PLAY_TYPES,
  recommendationKey,
  type RadarAiNote,
  type RadarEvidence,
  type RadarPlayType,
  type RadarReason,
  type RadarSteering,
} from "@/lib/radar/types";
import { scrubPunctuation } from "@/lib/message-format";

/** Cards the model sees: the top of the verified list after learning, before the plan's caps. */
export const RADAR_EDITOR_SIZE = 24;
/** The most the model may add or take away, in score points. Below every bucket gap. */
export const RADAR_EDITOR_MAX_ADJUST = 15;
/** A prep card this close to its meeting cannot be pushed down. */
export const RADAR_EDITOR_PROTECT_PREP_MS = 48 * 60 * 60 * 1000;
const WHY_MAX = 180;
const NEXT_STEP_MAX = 120;
const TALKING_POINT_MAX = 100;
const OPENER_MAX = 300;
const GOALS_MAX = 8;

const PLAY_TYPE_SET: ReadonlySet<string> = new Set(RADAR_PLAY_TYPES);

export const RADAR_EDITOR_SYSTEM = [
  "You are Orbit's Opportunity Analyst helping someone decide who in their network to act on right now.",
  "A rules engine has already chosen each verified candidate and written the factual reasons why.",
  "Given the person's goals, active projects, steering focus, and those reasons, adjust each candidate's priority:",
  `an integer from -${RADAR_EDITOR_MAX_ADJUST} to ${RADAR_EDITOR_MAX_ADJUST}, positive when this opportunity unlocks real leverage right now,`,
  "negative when routine or low leverage, 0 when the rules have it right.",
  "Most adjustments should be 0 or small. Do not reward someone only for being close;",
  "the rules already count that.",
  'For each candidate, return:',
  `- "playType": one of ${RADAR_PLAY_TYPES.join(", ")}`,
  '- "why": one crisp sentence (under 24 words) explaining the opportunity thesis from the given facts only',
  '- "nextStep": one concrete action phrase (under 14 words, e.g. "Ask Priya if she is open to meeting Sam")',
  '- "talkingPoints": optional array of up to 3 short bullets (under 14 words each) for meetings, warm paths, or events',
  '- "opener": one sentence the person could send as the first line of a message (warm, no flattery, no exclamation marks, no links, never ask about facts not given)',
  "Never invent a fact, a shared interest, a mutual contact, a job history, a person or a date.",
  'Reply as {"items": [{"id": string, "adjust": integer, "playType"?: string, "why": string, "nextStep"?: string, "talkingPoints"?: string[], "opener": string}]}.',
].join(" ");

/** Reasons that argue against a card; the model is told what the card is for, not against. */
const PENALTY_CODES: ReadonlySet<string> = new Set(["touched_recently", "dismissed_recently", "already_scheduled"]);

/** One shortlisted card, with what the editor may read about it. */
export type EditorCandidate = RadarPick & {
  inputsHash: string;
  title: string | null;
  company: string | null;
  tier: "inner" | "mid" | "outer" | null;
  /** The contact brief's one-line standing, if there is one. */
  standing: string | null;
  /** LinkedIn deep read: how you met and where you overlapped (`relationshipFactLines`, joined). */
  relationship?: string | null;
};

export type EditorPrompt = {
  system: string;
  user: string;
  /** Prompt id ("c1") → recommendation key (`contactId:kind`). */
  idToKey: Map<string, string>;
  /** Every fact string the model was shown, for checking its words against. */
  factText: string;
};

function factsOf(reasons: readonly RadarReason[], evidence: readonly RadarEvidence[]): string[] {
  return [
    ...reasons.filter((r) => (r.points > 0 || r.code.startsWith("also:")) && !PENALTY_CODES.has(r.code)).map((r) => r.label),
    ...evidence.map((e) => e.label),
  ]
    .map((line) => cleanSingleLine(line, 160))
    .filter((line): line is string => Boolean(line));
}

/** The shortlist in a stable order, so the same list always gets the same ids and bytes. */
function ordered(candidates: readonly EditorCandidate[]): EditorCandidate[] {
  return [...candidates].sort((a, b) =>
    recommendationKey(a.contactId, a.kind).localeCompare(recommendationKey(b.contactId, b.kind))
  );
}

export function buildEditorPrompt(
  candidates: readonly EditorCandidate[],
  goals: readonly string[],
  opts?: { projects?: readonly string[]; steering?: RadarSteering | null }
): EditorPrompt {
  const idToKey = new Map<string, string>();
  const allFacts: string[] = [];
  const list = ordered(candidates).map((c, i) => {
    const id = `c${i + 1}`;
    idToKey.set(id, recommendationKey(c.contactId, c.kind));
    const facts = factsOf(c.reasons, c.evidence);
    const context = cleanSingleLine(c.standing, 200);
    const howYouMet = cleanSingleLine(c.relationship, 300);
    allFacts.push(...facts);
    if (context) allFacts.push(context);
    if (howYouMet) allFacts.push(howYouMet);
    return {
      id,
      recommendation: KIND_LABELS[c.kind],
      title: cleanSingleLine(c.title, 120),
      company: cleanSingleLine(c.company, 120),
      closeness: c.tier,
      reasons: facts,
      context,
      // Absent, not null, when there is none: a prompt without the deep read is byte-for-byte today's.
      ...(howYouMet ? { howYouMet } : {}),
    };
  });
  const goalLines = goals
    .slice(0, GOALS_MAX)
    .map((g) => cleanSingleLine(g, 160))
    .filter((g): g is string => Boolean(g));
  const projectLines = (opts?.projects ?? [])
    .slice(0, 5)
    .map((p) => cleanSingleLine(p, 200))
    .filter((p): p is string => Boolean(p));
  const steeringParts = [
    opts?.steering?.topics?.length ? `Focus topics: ${opts.steering.topics.slice(0, 6).join(", ")}` : null,
    opts?.steering?.targetRoles?.length ? `Target roles: ${opts.steering.targetRoles.slice(0, 6).join(", ")}` : null,
    opts?.steering?.targetOrgs?.length ? `Target orgs: ${opts.steering.targetOrgs.slice(0, 6).join(", ")}` : null,
  ]
    .map((s) => cleanSingleLine(s, 200))
    .filter((s): s is string => Boolean(s));
  allFacts.push(...goalLines, ...projectLines, ...steeringParts);
  const userSections = [
    "The person's current goals:",
    fenceUntrusted("GOALS", goalLines.length ? goalLines.join("\n") : "(none stated)"),
  ];
  if (projectLines.length) {
    userSections.push("", "Active projects:", fenceUntrusted("PROJECTS", projectLines.join("\n")));
  }
  if (steeringParts.length) {
    userSections.push("", "Radar steering focus:", fenceUntrusted("STEERING", steeringParts.join("\n")));
  }
  userSections.push("", "Candidates:", fenceUntrusted("CANDIDATES", JSON.stringify(list)));
  return { system: RADAR_EDITOR_SYSTEM, user: userSections.join("\n"), idToKey, factText: allFacts.join("\n") };
}

/**
 * What the editor is cached under: who is on the shortlist, the facts behind each card,
 * the brief, goals, active projects, and steering. `v: 3`: v2 Opportunity Analyst fields.
 */
export function editorCacheKey(
  candidates: readonly EditorCandidate[],
  goals: readonly string[],
  opts?: { projects?: readonly string[]; steering?: RadarSteering | null }
) {
  const hash = (s: string | null) => (s ? createHash("sha256").update(s).digest("hex").slice(0, 16) : null);
  return {
    v: 3,
    shortlist: ordered(candidates).map((c) => [
      recommendationKey(c.contactId, c.kind),
      c.inputsHash,
      hash(c.standing),
      ...(c.relationship ? [hash(c.relationship)] : []),
    ]),
    goals: goals.slice(0, GOALS_MAX).map((g) => g.trim()),
    projects: (opts?.projects ?? []).slice(0, 5).map((p) => p.trim()),
    steering: opts?.steering ?? null,
  };
}

export type EditorItem = {
  adjust: number;
  why: string | null;
  opener: string | null;
  nextStep?: string | null;
  talkingPoints?: string[];
  playType?: RadarPlayType | null;
};

const replySchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      adjust: z.number(),
      playType: z.string().optional().nullable(),
      why: z.string().optional().nullable(),
      nextStep: z.string().optional().nullable(),
      talkingPoints: z.array(z.string()).optional().nullable(),
      opener: z.string().optional().nullable(),
    })
  ),
});

/**
 * The model's reply, checked: a schema, ids it was actually given, whole-number adjustments
 * clamped to the bound, and words through the output guard that are dropped when they name a
 * number the facts do not contain. Null when the reply is unusable at all.
 */
export function parseEditorReply(raw: string, prompt: Pick<EditorPrompt, "idToKey" | "factText" | "system">) {
  let data: z.infer<typeof replySchema>;
  try {
    const result = replySchema.safeParse(JSON.parse(raw));
    if (!result.success) return null;
    data = result.data;
  } catch {
    return null;
  }
  const out = new Map<string, EditorItem>();
  for (const item of data.items) {
    const key = prompt.idToKey.get(item.id.trim());
    if (!key || out.has(key) || !Number.isFinite(item.adjust)) continue;
    const adjust = Math.max(-RADAR_EDITOR_MAX_ADJUST, Math.min(RADAR_EDITOR_MAX_ADJUST, Math.round(item.adjust)));
    const playType = item.playType && PLAY_TYPE_SET.has(item.playType) ? (item.playType as RadarPlayType) : null;
    const nextStep = checkedLine(item.nextStep ?? null, NEXT_STEP_MAX, prompt);
    const talkingPoints = Array.isArray(item.talkingPoints)
      ? item.talkingPoints
          .slice(0, 3)
          .map((tp) => checkedLine(tp, TALKING_POINT_MAX, prompt))
          .filter((tp): tp is string => Boolean(tp))
      : undefined;
    out.set(key, {
      adjust,
      playType,
      why: checkedLine(item.why ?? null, WHY_MAX, prompt),
      nextStep,
      ...(talkingPoints?.length ? { talkingPoints } : {}),
      // A line the user sends, so the house bans apply (`@/lib/message-format`).
      opener: scrubLine(checkedLine(item.opener ?? null, OPENER_MAX, prompt)),
    });
  }
  return out;
}

function scrubLine(line: string | null): string | null {
  return line ? scrubPunctuation(line) : null;
}

function checkedLine(text: string | null, max: number, prompt: Pick<EditorPrompt, "factText" | "system">): string | null {
  if (!text) return null;
  const guarded = guardModelOutput(text.trim(), { system: prompt.system }).text;
  const line = cleanSingleLine(guarded, max);
  if (!line) return null;
  // A number the facts never mentioned is an invented one ("3 weeks", "2 roles"). Whole
  // numbers, compared as numbers: "3" is not vouched for by a "30" somewhere in the facts.
  const known = new Set(prompt.factText.match(/\d+/g) ?? []);
  for (const n of line.match(/\d+/g) ?? []) if (!known.has(n)) return null;
  return line;
}

export type EditedPick<T> = T & { aiDelta: number | null; aiAngle: string | null; aiNote: RadarAiNote | null };

/**
 * Apply the editor's answer to the shortlisted picks. Cards the model did not return, or that
 * were not shortlisted, are untouched (`aiDelta` and `aiNote` null). A card keeps at least the
 * lowest bucket score it cleared on its own, and a meeting in the next 48 hours is never pushed
 * down. The why and opener become the card's note, tied to the facts it was written from
 * (`inputsHash`), so a later run that changes those facts clears it.
 */
export function applyEditor<T extends RadarPick & { inputsHash: string }>(
  picks: readonly T[],
  items: ReadonlyMap<string, EditorItem>,
  now: Date
): Array<EditedPick<T>> {
  return picks.map((pick) => {
    const item = items.get(recommendationKey(pick.contactId, pick.kind));
    if (!item) return { ...pick, aiDelta: null, aiAngle: null, aiNote: null };
    let adjust = item.adjust;
    if (adjust < 0 && isImminentPrep(pick, now)) adjust = 0;
    const score = Math.max(RADAR_BUCKETS.later, Math.min(100, pick.score + adjust));
    const aiNote: RadarAiNote | null =
      item.why || item.opener || item.nextStep || item.talkingPoints?.length
        ? {
            why: item.why ?? "",
            opener: item.opener ?? "",
            inputsHash: pick.inputsHash,
            generatedAt: now.toISOString(),
            ...(item.nextStep ? { nextStep: item.nextStep } : {}),
            ...(item.talkingPoints?.length ? { talkingPoints: item.talkingPoints } : {}),
            ...(item.playType ? { playType: item.playType } : {}),
          }
        : null;
    return {
      ...pick,
      score,
      aiDelta: score - pick.score,
      aiAngle: item.why,
      aiNote,
      playType: item.playType ?? pick.playType ?? null,
    };
  });
}

function isImminentPrep(pick: RadarPick, now: Date): boolean {
  if (pick.kind !== "prep") return false;
  return pick.evidence.some((e) => {
    if (!e.at) return false;
    const t = new Date(e.at).getTime();
    return t >= now.getTime() && t - now.getTime() <= RADAR_EDITOR_PROTECT_PREP_MS;
  });
}
