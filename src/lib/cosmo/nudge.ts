import type { VoiceMode } from "@/lib/voice/contracts";

/**
 * Cosmo speaking up. From the app pulse every tab already polls, the one thing worth a nudge: a
 * meeting about to start, things due, a meeting that ended with no note, new Radar finds (in that
 * order). The idle orb shows it as a chip; a call opens with it; and, for the time-sensitive ones
 * only, Cosmo may say it during a call when `mayInterject` allows. Client-safe and pure
 * (scripts/smoke-cosmo-nudge.ts); the server builds openers with it too.
 *
 * Not to be confused with src/lib/meeting-nudge.ts, the job stack's "record this meeting" card.
 */
export type NudgeInput = {
  nextMeeting: { eventId: string; title: string; startIso: string; people: string[] } | null;
  unloggedMeeting: { eventId: string; title: string; people: string[] } | null;
  dueCount: number;
  radarNew: number;
};
export type Nudge = {
  id: string;
  kind: "meeting" | "due" | "debrief" | "radar";
  /** A few words beside the idle orb. */
  chip: string;
  /** What a call started from it opens with. */
  opener: string;
  /** What Cosmo may say mid-call; only the time-sensitive ones have it. */
  interject: string | null;
};

/** Calendar titles and names are free text: no control characters or markup, short, before TTS. */
const clean = (text: string, max = 48) => {
  const plain = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The pulse's fields a nudge reads (structural, so this stays free of the server pulse module). */
export function nudgeInput(pulse: {
  nextMeeting: NudgeInput["nextMeeting"];
  unloggedMeeting: NudgeInput["unloggedMeeting"];
  radarNew: number;
  panel: { dueCount: number };
}): NudgeInput {
  return {
    nextMeeting: pulse.nextMeeting,
    unloggedMeeting: pulse.unloggedMeeting,
    dueCount: pulse.panel.dueCount,
    radarNew: pulse.radarNew,
  };
}

/** The one to show, skipping any the person dismissed today. */
export function pickNudge(input: NudgeInput, now: number, dismissed: ReadonlySet<string>): Nudge | null {
  return allNudges(input, now).find((n) => !dismissed.has(n.id)) ?? null;
}

/** Every nudge the pulse supports, most pressing first. */
export function allNudges(input: NudgeInput, now: number): Nudge[] {
  const all: Nudge[] = [];
  if (input.nextMeeting) {
    const who = clean(input.nextMeeting.people[0] ?? input.nextMeeting.title);
    const mins = Math.max(1, Math.round((Date.parse(input.nextMeeting.startIso) - now) / 60_000));
    all.push({
      id: `meeting:${input.nextMeeting.eventId}`,
      kind: "meeting",
      chip: `${who} in ${mins} min`,
      opener: `Hi, I’m Cosmo. You meet ${who} in ${mins} minutes. Want a quick prep?`,
      interject: `Heads up: you meet ${who} in ${mins} minutes. Want a quick prep?`,
    });
  }
  if (input.dueCount > 0) {
    const n = plural(input.dueCount, "thing", "things");
    all.push({
      id: "due",
      kind: "due",
      chip: `${n} due`,
      opener: `Hi, I’m Cosmo. You have ${n} due. Want to go through them?`,
      interject: null,
    });
  }
  if (input.unloggedMeeting) {
    const who = clean(input.unloggedMeeting.people[0] ?? input.unloggedMeeting.title);
    all.push({
      id: `debrief:${input.unloggedMeeting.eventId}`,
      kind: "debrief",
      chip: `How did ${who} go?`,
      opener: `Hi, I’m Cosmo. How did ${who} go? Tell me and I’ll log it.`,
      interject: `When you have a second: how did ${who} go? I can log it.`,
    });
  }
  if (input.radarNew > 0)
    all.push({
      id: "radar",
      kind: "radar",
      chip: `${input.radarNew} new on Radar`,
      opener: `Hi, I’m Cosmo. Radar found ${plural(input.radarNew, "new suggestion", "new suggestions")}. Want the short version?`,
      interject: null,
    });
  return all;
}

export const INTERJECT_GAP_MS = 60_000;
export const MAX_INTERJECTIONS = 3;

/** Whether Cosmo may break into the call right now. Every condition must hold; the default is quiet. */
export function mayInterject(s: {
  off: boolean;
  mode: VoiceMode;
  confirmOpen: boolean;
  userSpeaking: boolean;
  now: number;
  lastAt: number;
  count: number;
  page: string;
  lastPage: string | null;
}): boolean {
  return (
    !s.off &&
    s.mode === "listening" &&
    !s.userSpeaking &&
    !s.confirmOpen &&
    s.count < MAX_INTERJECTIONS &&
    s.now - s.lastAt >= INTERJECT_GAP_MS &&
    s.page !== s.lastPage
  );
}

const said = (text: string) => text.toLowerCase().replace(/[’']/g, "").replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
/**
 * Only an explicit ask turns interjections off. "Be quiet", "shut up" or "stop talking" mean stop
 * talking NOW, which barge-in already does; they must not silence Cosmo for good.
 */
export function isStopInterrupting(text: string): boolean {
  return /\b(stop|quit) (interrupting|butting in)\b|\bdont interrupt\b|\bno more interrupt(ions|ing)\b/.test(said(text));
}
export function isResumeInterrupting(text: string): boolean {
  return /\byou can interrupt( me)? again\b|\bstart interrupting again\b/.test(said(text));
}
