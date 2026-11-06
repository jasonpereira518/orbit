/**
 * How an email event becomes a Radar card: which kind, how many points, for how long, and that
 * every rule the scorer already has still applies. Orderings and structure, not literals. Pure.
 * Run: npx tsx scripts/smoke-radar-email-score.ts
 */
import { SIGNAL_CODES } from "../src/lib/radar/briefing";
import { EMAIL_REASON_CODES, isEmailReasonCode } from "../src/lib/radar/email-text";
import {
  NO_SUPPRESSION,
  RADAR_WEIGHTS,
  RADAR_WINDOWS,
  emailCardFor,
  pickWinner,
  scoreContactKinds,
  type RadarContact,
} from "../src/lib/radar/score";
import type { RadarModel, RadarSignal } from "../src/lib/radar/types";

type EmailSig = Extract<RadarSignal, { kind: "email_event" }>;

const DAY = 86_400_000;
const NOW = new Date("2026-10-01T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const sig = (over: Partial<EmailSig> = {}): EmailSig => ({
  kind: "email_event",
  contactId: "c1",
  at: ago(1),
  eventId: "e1",
  eventKind: "job_posting",
  stage: null,
  text: "Northwind is hiring a Staff Engineer for Payments.",
  company: "Northwind",
  why: "Works at Northwind",
  onThread: false,
  hasAsk: false,
  fit: 0.8,
  ...over,
});
const contact = (over: Partial<RadarContact> = {}): RadarContact => ({
  id: "c1",
  company: "Northwind",
  tier: null,
  priorityLevel: 0,
  relationshipScore: 2,
  statedCloseness: null,
  firstInteractionAt: null,
  lastInteractionAt: null,
  nextFollowUpAt: null,
  constellationPin: null,
  cadenceDays: null,
  cadencePhrase: null,
  targetPriority: null,
  goalFit: 0,
  hasEvidence: false,
  ...over,
});
const kindOf = (s: EmailSig) => emailCardFor(s, NOW)?.kind ?? null;
const score = (signals: EmailSig[], over: Partial<RadarContact> = {}, model: RadarModel | null = null) =>
  scoreContactKinds(contact(over), signals, NO_SUPPRESSION, NOW, model);
const pointsOf = (s: EmailSig, kind: string) =>
  score([s]).find((k) => k.kind === kind)?.reasons.find((r) => r.code.startsWith("email_"))?.points ?? 0;

console.log("\nWhich card an event becomes");
check("a job for someone at the company is an opportunity", kindOf(sig()) === "opportunity");
check("a job for someone on the thread, no ask, is an opportunity", kindOf(sig({ onThread: true })) === "opportunity");
check("a job with an open ask, for someone on the thread, is a follow-up", kindOf(sig({ onThread: true, hasAsk: true })) === "follow_up");
check("an ask means nothing to someone who is not on the thread", kindOf(sig({ hasAsk: true })) === "opportunity");
check("news is a heads-up", kindOf(sig({ eventKind: "news" })) === "heads_up");
check("an event is a heads-up", kindOf(sig({ eventKind: "event" })) === "heads_up");
const process = (over: Partial<EmailSig>) => sig({ eventKind: "process_update", ...over });
check("a rejection is no card for anyone", kindOf(process({ stage: "rejected" })) === null && kindOf(process({ stage: "rejected", onThread: true })) === null);
check("a withdrawn application is no card", kindOf(process({ stage: "withdrawn", onThread: true })) === null);
check("an application at a company you know someone at is an opportunity", kindOf(process({ stage: "applied" })) === "opportunity");
check("an interview at such a company is an opportunity for the colleague", kindOf(process({ stage: "interviewing" })) === "opportunity");
check("an interview in three days, for someone on the thread, is prep", kindOf(process({ stage: "interviewing", onThread: true, at: ahead(3) })) === "prep");
check("a screen in three days is prep too", kindOf(process({ stage: "screening", onThread: true, at: ahead(3) })) === "prep");
check("an interview dated beyond the prep window is a follow-up", kindOf(process({ stage: "interviewing", onThread: true, at: ahead(RADAR_WINDOWS.prepAhead + 3) })) === "follow_up");
check("an interview already past is a follow-up", kindOf(process({ stage: "interviewing", onThread: true, at: ago(2) })) === "follow_up");
check("an offer, for someone on the thread, is a follow-up", kindOf(process({ stage: "offer", onThread: true })) === "follow_up");
check("an update with an ask is a follow-up", kindOf(process({ stage: "in_conversation", onThread: true, hasAsk: true })) === "follow_up");
check("an update with nothing to do, for someone on the thread, is no card", kindOf(process({ stage: "applied", onThread: true })) === null);

console.log("\nHow long it lasts");
check("a job fades out of the window", kindOf(sig({ at: ago(RADAR_WINDOWS.emailJobMax - 1) })) === "opportunity" && kindOf(sig({ at: ago(RADAR_WINDOWS.emailJobMax + 1) })) === null);
check("news goes stale sooner", kindOf(sig({ eventKind: "news", at: ago(RADAR_WINDOWS.emailNewsMax - 1) })) === "heads_up" && kindOf(sig({ eventKind: "news", at: ago(RADAR_WINDOWS.emailNewsMax + 1) })) === null);
check("an event's window is its own", kindOf(sig({ eventKind: "event", at: ago(RADAR_WINDOWS.emailEventMax + 1) })) === null);
check("an old job is worth less than a new one", pointsOf(sig({ at: ago(12) }), "opportunity") < pointsOf(sig({ at: ago(1) }), "opportunity"));
check("old news is worth less than fresh news", pointsOf(sig({ eventKind: "news", at: ago(5) }), "heads_up") < pointsOf(sig({ eventKind: "news", at: ago(0) }), "heads_up"));

console.log("\nHow much it is worth");
check("a better match scores higher", pointsOf(sig({ fit: 1 }), "opportunity") > pointsOf(sig({ fit: 0.2 }), "opportunity"));
check("a poor match still counts for something", pointsOf(sig({ fit: 0 }), "opportunity") > 0);
check("a match cannot more than double the floor", pointsOf(sig({ fit: 1 }), "opportunity") <= Math.ceil(pointsOf(sig({ fit: 0 }), "opportunity") * 2));
const ask = sig({ onThread: true, hasAsk: true });
check("a reply you owe outweighs a colleague's opening", pointsOf(ask, "follow_up") > pointsOf(sig(), "opportunity"));
check("a colleague's job is worth less than one you were sent", pointsOf(sig(), "opportunity") < pointsOf(sig({ onThread: true }), "opportunity"));
check("an interview coming up outweighs a reply you owe", pointsOf(process({ stage: "interviewing", onThread: true, at: ahead(5) }), "prep") > pointsOf(ask, "follow_up"));
check("an interview within 48 hours gets the same bump a meeting does", pointsOf(process({ stage: "interviewing", onThread: true, at: ahead(1) }), "prep") - pointsOf(process({ stage: "interviewing", onThread: true, at: ahead(5) }), "prep") >= RADAR_WEIGHTS.upcomingMeetingWithin48h - 2);

console.log("\nWhat the card says");
const prep = score([process({ stage: "interviewing", onThread: true, at: ahead(3) })]).find((k) => k.kind === "prep")!;
check("the reason carries an email code", prep.reasons.some((r) => isEmailReasonCode(r.code)));
check("every email code the scorer emits is a known one", score([sig(), ask, sig({ eventKind: "news" }), process({ stage: "applied" }), process({ stage: "interviewing", onThread: true, at: ahead(3) })])
  .flatMap((k) => k.reasons).filter((r) => r.code.startsWith("email_")).every((r) => EMAIL_REASON_CODES.has(r.code)));
const job = score([sig()]).find((k) => k.kind === "opportunity")!;
const lead = job.reasons.find((r) => r.code === "email_job")!;
check("the label is the summary and why", lead.label.includes("Northwind is hiring") && lead.label.includes("Works at Northwind"));
check("and is one capped line", !lead.label.includes("\n") && lead.label.length <= 200);
check("the evidence says where it came from", job.evidence[0]!.label === "From your email");
check("and links the event", job.evidence[0]!.ref?.emailEventId === "e1" && job.evidence[0]!.ref?.onThread === false);
check("and dates it", job.evidence[0]!.at === sig().at.toISOString());
check("an interview card is anchored to the interview", prep.anchorAt?.getTime() === ahead(3).getTime());
const pick = pickWinner("c1", [prep], NOW)!;
check("and expires a day after it", pick.expiresAt.getTime() === ahead(3).getTime() + DAY);
check("the pick keeps the email evidence", pick.evidence[0]!.ref?.emailEventId === "e1");

console.log("\nEverything the scorer already does still applies");
check("one card per person: the higher score wins", (() => {
  const kinds = score([sig({ fit: 1 })], { tier: "inner", hasEvidence: true, lastInteractionAt: ago(200), relationshipScore: 4 });
  const winner = pickWinner("c1", kinds, NOW)!;
  return kinds.length >= 2 && kinds[0]!.kind === winner.kind && winner.reasons.some((r) => r.code.startsWith("also:"));
})());
check("a recent dismissal removes the kind", (() => {
  const s = ask;
  const kinds = scoreContactKinds(contact(), [s], { ...NO_SUPPRESSION, dismissedAt: { follow_up: ago(3) } }, NOW, null);
  return !kinds.some((k) => k.kind === "follow_up");
})());
check("a live snooze removes it", scoreContactKinds(contact(), [ask], { ...NO_SUPPRESSION, snoozedUntil: { follow_up: ahead(3) } }, NOW, null).length === 0);
check("'not for this person' removes it", scoreContactKinds(contact(), [ask], { ...NO_SUPPRESSION, never: "all" }, NOW, null).length === 0);
check("a pinned-off contact gets nothing", score([ask], { constellationPin: "out" }).length === 0);
check("a follow-up already set silences an opportunity but not news", (() => {
  const scheduled = { nextFollowUpAt: ahead(4) };
  return score([sig()], scheduled).length === 0 && score([sig({ eventKind: "news" })], scheduled).some((k) => k.kind === "heads_up");
})());
check("a target company adds context, as it does for everything", score([sig()], { targetPriority: 1 })[0]!.score > score([sig()])[0]!.score);
const disliked: RadarModel = { kinds: {}, reasons: { email_job: { a: 0, d: 30 } }, updatedAt: NOW.toISOString() };
const neutral = score([sig()])[0]!;
const learned = score([sig()], {}, disliked)[0]!;
check("an account that dismisses these learns to score them lower", learned.score < neutral.score);
check("but the reason's own points do not move", learned.reasons.find((r) => r.code === "email_job")!.points === neutral.reasons.find((r) => r.code === "email_job")!.points);
check("and it never drops below the model's floor", learned.score >= Math.floor(neutral.score * 0.6));

console.log("\nWhere else the codes are known");
check("the briefing counts every email code as news from outside", [...EMAIL_REASON_CODES].every((c) => SIGNAL_CODES.has(c)));
check("an 'also' line is recognised too", isEmailReasonCode("also:email_job") && !isEmailReasonCode("job_change") && !isEmailReasonCode("also:job_change"));

console.log("\nAll Radar email-score checks passed.");
