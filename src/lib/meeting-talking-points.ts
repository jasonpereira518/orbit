/**
 * Talking points for one upcoming meeting: what to bring up, each tied to a fact Orbit holds.
 *
 * The facts come from what is already stored — the meeting context (due-before to-dos, notes,
 * last time, next step), recent job moves, the relationship digest (what they're working on,
 * open threads and who owes them), and how each person fits the user's goals. With an AI key the
 * model picks and phrases up to five, and every point must cite one fact by key; a point that
 * cites nothing is dropped. Without one, the same facts become points by rule — still useful,
 * never invented.
 */
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { contactBriefs, relationshipDigests } from "@/db/schema";
import { cachedCompleteJson } from "@/lib/ai-result-cache";
import { parseAiJson, userCanUseAi } from "@/lib/ai";
import { fenceUntrusted, UNTRUSTED_DATA_RULES } from "@/lib/ai-security";
import { getRecentMoveLines } from "@/lib/job-changes";
import { listActiveGoalsForUser } from "@/lib/user-goals";
import type { getMeetingContext } from "@/lib/meeting-context";

type MeetingCtx = NonNullable<Awaited<ReturnType<typeof getMeetingContext>>>;

export type TalkingFactKind =
  | "due"
  | "owe_me"
  | "move"
  | "last_time"
  | "owe_them"
  | "working_on"
  | "goal"
  | "next_step"
  | "note"
  | "agenda"
  /** A guest who is not a contact, from a "Look up" brief: recent public things worth raising. */
  | "web";

export type TalkingFact = { key: string; kind: TalkingFactKind; person: string | null; text: string };
export type TalkingPoint = { text: string; basis: string };
export type TalkingPointsResult = { points: TalkingPoint[]; source: "ai" | "facts" };

const MAX_POINTS = 5;
const MAX_FACTS = 30;

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Everything worth raising, as numbered facts. Pure over its inputs, for the smoke. */
export function talkingFacts(
  ctx: Pick<MeetingCtx, "people" | "lastTime"> & { agenda: string | null; notInOrbit?: MeetingCtx["notInOrbit"] },
  extra: {
    moves: Map<string, string>;
    digests: Map<string, { workingOn: string | null; openThreads: { text: string; owedBy: "me" | "them" | null }[] }>;
    goalFit: Map<string, string[]>;
  }
): TalkingFact[] {
  const facts: Omit<TalkingFact, "key">[] = [];
  for (const p of ctx.people) {
    for (const t of p.dueBefore) facts.push({ kind: "due", person: p.name, text: t });
    const digest = extra.digests.get(p.contactId);
    for (const t of digest?.openThreads ?? []) {
      if (t.owedBy === "me") facts.push({ kind: "owe_me", person: p.name, text: t.text });
      else if (t.owedBy === "them") facts.push({ kind: "owe_them", person: p.name, text: t.text });
    }
    const move = extra.moves.get(p.contactId);
    if (move) facts.push({ kind: "move", person: p.name, text: move });
    if (digest?.workingOn) facts.push({ kind: "working_on", person: p.name, text: digest.workingOn });
    for (const g of extra.goalFit.get(p.contactId) ?? []) facts.push({ kind: "goal", person: p.name, text: g });
    if (p.nextStep) facts.push({ kind: "next_step", person: p.name, text: p.nextStep });
    if (p.fromNotes[0]) facts.push({ kind: "note", person: p.name, text: p.fromNotes[0].snippet });
  }
  // A looked-up guest: only a confident brief has a profile, and only its sourced points count.
  for (const g of ctx.notInOrbit ?? []) {
    for (const p of g.profile?.talkingPoints ?? []) facts.push({ kind: "web", person: g.name || null, text: p.text });
  }
  for (const t of ctx.lastTime?.actionItems ?? []) facts.push({ kind: "last_time", person: null, text: t });
  const agendaLines = (ctx.agenda ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 4);
  for (const line of agendaLines) facts.push({ kind: "agenda", person: null, text: line });
  return facts.slice(0, MAX_FACTS).map((f, i) => ({ ...f, key: `f${i + 1}` }));
}

/** How a fact reads as its own basis line: "Priya — recent move: Joined Stripe". */
export function factLine(f: TalkingFact): string {
  const label: Record<TalkingFactKind, string> = {
    due: "due before this meeting",
    owe_me: "you owe them",
    owe_them: "they owe you",
    move: "recent move",
    last_time: "open from last time",
    working_on: "working on",
    goal: "fits your goal",
    next_step: "suggested next step",
    note: "from your notes",
    agenda: "on the agenda",
    web: "found when you looked them up",
  };
  return `${f.person ? `${f.person} — ` : ""}${label[f.kind]}: ${f.text}`;
}

/** No model: the facts that most want saying, in that order, as plain points. */
export function heuristicTalkingPoints(facts: TalkingFact[], limit = MAX_POINTS): TalkingPoint[] {
  const order: TalkingFactKind[] = ["due", "owe_me", "move", "last_time", "owe_them", "working_on", "web", "goal", "next_step"];
  const phrase = (f: TalkingFact): string => {
    const who = f.person ? firstName(f.person) : "them";
    switch (f.kind) {
      case "due":
        return `Close the loop on “${f.text}” — it’s due before this meeting`;
      case "owe_me":
        return `You owe ${who}: ${f.text}`;
      case "move":
        return `Congratulate ${who} — ${f.text}`;
      case "last_time":
        return `Follow up from last time: ${f.text}`;
      case "owe_them":
        return `Ask ${who} about ${f.text}`;
      case "working_on":
        return `Ask ${who} how ${f.text} is going`;
      case "goal":
        return `Bring up what you’re working towards: ${f.text}`;
      case "web":
        return `Ask ${who} about this: ${f.text}`;
      default:
        return f.text;
    }
  };
  const out: TalkingPoint[] = [];
  for (const kind of order) {
    for (const f of facts.filter((x) => x.kind === kind)) {
      if (out.length >= limit) return out;
      out.push({ text: phrase(f), basis: factLine(f) });
    }
  }
  return out;
}

/** The model's answer → points that cite a real fact; anything else is dropped. */
export function parseTalkingPoints(raw: unknown, facts: TalkingFact[]): TalkingPoint[] {
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const list = (raw as { points?: unknown })?.points;
  if (!Array.isArray(list)) return [];
  const out: TalkingPoint[] = [];
  for (const item of list) {
    const text = typeof item?.text === "string" ? item.text.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    const fact = typeof item?.basis === "string" ? byKey.get(item.basis.trim()) : undefined;
    if (!text || !fact) continue;
    out.push({ text, basis: factLine(fact) });
    if (out.length >= MAX_POINTS) break;
  }
  return out;
}

function systemPrompt(): string {
  return [
    "You suggest what the user should bring up in an upcoming meeting, for their personal networking CRM.",
    'Return JSON: {"points": [{"text": string, "basis": string}]} — at most 5 points, most useful first.',
    "Each point is one short sentence (under 20 words), addressed to the user, naming the person where it helps.",
    '"basis" is the key of the ONE fact the point comes from (like "f3"). A point with no fact behind it must not be written. Never add names, numbers or events that are not in the facts.',
    "Prefer what is owed or due, then recent news about the person, then what they are working on, then goals.",
    UNTRUSTED_DATA_RULES,
  ].join("\n");
}

export function talkingPointsPrompt(title: string, people: string[], facts: TalkingFact[]): string {
  return [
    `MEETING:\n${fenceUntrusted("TITLE", title || "Untitled meeting")}`,
    people.length ? `With: ${people.join(", ")}` : "",
    `FACTS:\n${fenceUntrusted("FACTS", facts.map((f) => `[${f.key}] ${factLine(f)}`).join("\n"))}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What the fact-gathering needs from the database, beyond the meeting context. */
async function loadExtras(userId: string, ids: string[]) {
  const empty = {
    moves: new Map<string, string>(),
    digests: new Map<string, { workingOn: string | null; openThreads: { text: string; owedBy: "me" | "them" | null }[] }>(),
    goalFit: new Map<string, string[]>(),
  };
  if (!ids.length) return empty;
  const db = await getDb();
  const [moves, digests, briefs, goals] = await Promise.all([
    getRecentMoveLines(userId, ids),
    db
      .select({
        contactId: relationshipDigests.contactId,
        workingOn: relationshipDigests.workingOn,
        openThreads: relationshipDigests.openThreads,
      })
      .from(relationshipDigests)
      .where(and(eq(relationshipDigests.userId, userId), inArray(relationshipDigests.contactId, ids))),
    db
      .select({ contactId: contactBriefs.contactId, goalFit: contactBriefs.goalFit })
      .from(contactBriefs)
      .where(and(eq(contactBriefs.userId, userId), inArray(contactBriefs.contactId, ids))),
    listActiveGoalsForUser(userId),
  ]);
  const goalText = new Map(goals.map((g) => [g.id, g.text]));
  for (const d of digests) empty.digests.set(d.contactId, { workingOn: d.workingOn, openThreads: d.openThreads.slice(0, 4) });
  for (const b of briefs) {
    empty.goalFit.set(
      b.contactId,
      (b.goalFit?.items ?? []).flatMap((i) => (goalText.has(i.goalId) ? [`${goalText.get(i.goalId)} (${i.why})`] : []))
    );
  }
  return { ...empty, moves };
}

export async function generateTalkingPoints(
  userId: string,
  ctx: MeetingCtx,
  deps: { complete?: typeof cachedCompleteJson; canUseAi?: (userId: string) => Promise<boolean> } = {}
): Promise<TalkingPointsResult> {
  const extras = await loadExtras(userId, ctx.people.map((p) => p.contactId));
  const facts = talkingFacts(
    { people: ctx.people, lastTime: ctx.lastTime, agenda: ctx.event.agenda, notInOrbit: ctx.notInOrbit },
    extras
  );
  const fallback: TalkingPointsResult = { points: heuristicTalkingPoints(facts), source: "facts" };
  if (!facts.length || !(await (deps.canUseAi ?? userCanUseAi)(userId))) return fallback;
  try {
    // The `prep` bucket (audit M-07). Past it the rule-based points below are the answer.
    await consumeBucket("prep", userId, RATE_LIMITS.prep);
    const raw = await (deps.complete ?? cachedCompleteJson)(
      userId,
      {
        operation: "meeting.talking_points",
        system: systemPrompt(),
        user: talkingPointsPrompt(ctx.event.title, ctx.people.map((p) => p.name), facts),
        temperature: 0.3,
        maxOutputTokens: 2048,
      },
      // The same facts the same day ask the same question; a new fact changes the prompt.
      { ttlDays: 1, accept: (v) => parseTalkingPoints(parseAiJson(v), facts).length > 0 }
    );
    const points = parseTalkingPoints(parseAiJson(raw), facts);
    return points.length ? { points, source: "ai" } : fallback;
  } catch {
    // A refused or failed model call still leaves the user something to say.
    return fallback;
  }
}
