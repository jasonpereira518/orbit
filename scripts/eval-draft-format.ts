/**
 * Does real model output follow the house message format (`src/lib/message-format.ts`)?
 *
 * Drafts a fixed set of messages through the REAL generators (outreach, follow-ups, recruiter
 * emails) on a real model, for a seeded user in a disposable PGlite, then checks every hard
 * rule on what came back: subject shape, greeting, full-name sign-off, the 200-character
 * LinkedIn note, no dashes, no "!", no hype. Soft rules (word counts, who-I-am opener, ending
 * on a question) are reported apart. Every draft is printed so the tone can be read.
 *
 *   ORBIT_EVAL_OPENAI_KEY=… npx tsx scripts/eval-draft-format.ts
 *   npx tsx scripts/eval-draft-format.ts --keys-from ../../.env.local --model gpt-4.1 --runs 2
 *   npx tsx scripts/eval-draft-format.ts --keys-from ../../.env.local --mirror
 *
 * `--mirror` first distills a writing style profile (`@/lib/writing-style-profile`) from a few
 * synthetic sent emails in a casual voice, prints it, and drafts with it on: the hard rules
 * must hold with a personal voice too, and the drafts should read more like those emails.
 *
 * Through the AI gate with the synthetic user's own OpenAI key, like scripts/eval-voice.ts:
 * nothing calls a provider directly, and nothing touches a shared database.
 */
import "./smoke/_env";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { calendarEvents, calendarSources, contacts, interactions, rateLimitBuckets, userSettings } from "../src/db/schema";
import { freeWindows } from "../src/lib/calendar-free-windows";
import { encrypt } from "../src/lib/crypto";
import { bootstrapAuthenticatedUser } from "../src/lib/auth";
import { generateOutreachDraft, type DraftInput } from "../src/lib/outreach-drafts";
import { generateContactFollowUpDraft } from "../src/lib/follow-up-drafts";
import { generateRecruiterDraft } from "../src/lib/recruiter-drafts";
import { loadWritingInstructions } from "../src/lib/writing-instructions-store";
import { cleanSentBody, distillStyleProfile } from "../src/lib/writing-style-profile";
import { LINKEDIN_DM_MAX, LINKEDIN_NOTE_MAX, charLength, claimsAttachment, hypeHits, type MessageKind } from "../src/lib/message-format";

const USER = "eval-draft-format-user";
/** The two real free times the seeded calendar gives; any weekday an email names must be one. */
let WINDOW_DAYS: string[] = [];
const WEEKDAYS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
/** What drafts are told about the user's voice, read the way the actions read it. */
let VOICE: string | null = null;
const SENDER = "Jason Pereira";
const flag = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);

type Draft = { subject?: string | null; body: string };
/**
 * `forbid`: what this case's history does NOT record the user doing. Grace only offered an intro
 * IF the resume was sent, and Dana only asked for one: a draft saying it was sent (or is being
 * sent, or is attached) invented it.
 */
type Case = { name: string; kind: MessageKind; run: () => Promise<Draft>; previousSubject?: string; forbid?: RegExp };
// "…if I sent my resume" restates the offer, which is right; only a claim is a miss.
const SENT_RESUME = /(?<!\bif )\b(i(['’]ve| have)? (sent|attached|forwarded)|i['’]m (sending|attaching)|sending (along|over)|(here['’]?s|here is|attached is) my|i['’]ve included)\b/i;
type Check = { rule: string; ok: boolean; hard: boolean };

/** The bare generics; "Introduction to the payments team" is specific and fine. */
const BANNED_SUBJECTS = /^(following up|quick question|hello|introduction|checking in)\W*(\w+\W*)?$/i;
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/** The body between the greeting and the sign-off, for word counts. */
function core(body: string): string {
  return body
    .replace(/^hi [^,\n]+,\s*/i, "")
    .replace(/\n+(best|thanks|thank you|cheers),?\s*\n+[^\n]+\s*$/i, "")
    .trim();
}

function checks(c: Case, d: Draft): Check[] {
  const body = d.body.trim();
  const out: Check[] = [
    { rule: "no em/en dash", ok: !/[–—]/.test(`${d.subject ?? ""}${body}`), hard: true },
    { rule: "no exclamation mark", ok: !/!/.test(`${d.subject ?? ""}${body}`), hard: true },
    { rule: "no hype words", ok: hypeHits(body).length === 0, hard: true },
    { rule: "no [placeholders]", ok: !/\[[^\]]+\]/.test(body), hard: true },
    { rule: "no invented attachment", ok: !claimsAttachment(body), hard: true },
    { rule: "no invented action (history never records it)", ok: !c.forbid || !c.forbid.test(body), hard: true },
  ];
  if (c.kind.startsWith("email")) {
    const subject = (d.subject ?? "").trim();
    if (c.kind === "email_followup") {
      out.push({ rule: "follow-up keeps the thread subject", ok: subject === `Re: ${c.previousSubject}`, hard: true });
    } else {
      out.push(
        { rule: "subject is 3-7 words", ok: words(subject) >= 3 && words(subject) <= 7, hard: true },
        { rule: "subject is not a banned generic", ok: !BANNED_SUBJECTS.test(subject), hard: true }
      );
    }
    const named = [...new Set((body.match(WEEKDAYS) ?? []).map((d) => d.toLowerCase()))];
    out.push(
      { rule: "offers only the calendar's free days", ok: named.every((d) => WINDOW_DAYS.includes(d)), hard: true },
      { rule: 'opens "Hi <name>,"', ok: /^hi [^,\n]+,/i.test(body), hard: true },
      { rule: "signs off with the full name", ok: new RegExp(`\\n${SENDER}\\s*$`).test(body), hard: true },
      { rule: "sign-off word is Best/Thanks", ok: /\n(best|thanks),\s*\n/i.test(body), hard: false }
    );
    const n = words(core(body));
    if (c.kind === "email_cold") {
      out.push(
        { rule: "cold: 60-120 words", ok: n >= 60 && n <= 120, hard: false },
        { rule: "cold: first sentence says who the sender is", ok: /\b(i['’]m|i am|my name is)\b/i.test(core(body).split(/[.?]\s/)[0] ?? ""), hard: false }
      );
    }
    if (c.kind === "email_warm") out.push({ rule: "warm: 40-90 words", ok: n >= 40 && n <= 90, hard: false });
    if (c.kind === "email_followup") out.push({ rule: "follow-up: 2-4 sentences", ok: (core(body).match(/[.?](\s|$)/g) ?? []).length <= 5, hard: false });
  } else {
    out.push({ rule: "no sign-off name", ok: !new RegExp(`${SENDER}\\s*$`).test(body), hard: true });
    if (c.kind === "linkedin_note") {
      out.push(
        { rule: `note at most ${LINKEDIN_NOTE_MAX} chars`, ok: charLength(body) <= LINKEDIN_NOTE_MAX, hard: true },
        { rule: "note ends on a question", ok: /\?\s*$/.test(body), hard: false }
      );
    }
    if (c.kind === "linkedin_dm") {
      out.push(
        { rule: `DM at most ${LINKEDIN_DM_MAX} chars`, ok: charLength(body) <= LINKEDIN_DM_MAX, hard: true },
        { rule: "DM ends on a question", ok: /\?\s*$/.test(body), hard: false }
      );
    }
  }
  return out;
}

/** A casual, short voice, so a profile built from it visibly changes the drafts. */
const SENT_SAMPLES = [
  "hey Marco,\n\nthanks for grabbing coffee yesterday, really useful. I took your advice and cut the onboarding down to two screens, signups went up the same day. can I send you the new flow next week to poke holes in?\n\nJason",
  "Hi Dana,\n\nquick update: I finished the backend project we talked about and put the writeup on my site. would love to know if it changes which roles you'd put me up for. no rush, I know Q1 is busy for you.\n\nthanks,\nJason",
  "hey team,\n\nshipping the import fix tonight. if anything looks off in the morning ping me, I'll be up early. also moving standup to 10 tomorrow since half of us are at the career fair.\n\nJason",
  "Hi Professor Liu,\n\nthanks for the feedback on the proposal. I reworked section 2 so the evaluation comes first, and I cut the related work down by half like you suggested. could we use Thursday office hours to go over the new version?\n\nJason",
  "hey Priya,\n\ngreat seeing you at the mixer. I mentioned the student networking app, here's the short version: it tells you who to follow up with and drafts the note. if you're ever up for 15 min of feedback I'd owe you one.\n\nJason",
  "Hi Sam,\n\nsorry for the slow reply, midterms ate my week. yes to the Saturday hackathon, count me in for the backend side. I can bring the API starter we used last time so we don't burn the first hour on setup.\n\nJason",
];

const PROSPECTS: Array<DraftInput["prospect"] & { intent: string; cta: string }> = [
  {
    fullName: "Priya Shah",
    title: "Head of Talent",
    company: "Ramp",
    location: "New York",
    enrichmentSummary: "Spoke on a Collision panel about how Ramp hires new-grad engineers; said referrals beat cold applications.",
    intent: "Learn how Ramp hires new-grad engineers and whether they take summer interns",
    cta: "book_intro",
  },
  {
    fullName: "Marcus Lee",
    title: "Partner",
    company: "Lightspeed",
    location: "San Francisco",
    enrichmentSummary: "Led seed rounds in consumer social apps; writes about network effects in student products.",
    intent: "Get feedback on Orbit, a networking app for students",
    cta: "get_feedback",
  },
  {
    fullName: "Elena Ruiz",
    title: "Senior Technical Recruiter",
    company: "Stripe",
    location: "Seattle",
    enrichmentSummary: "Recruits for Stripe's payments infrastructure teams; posted about the 2027 internship cycle opening.",
    intent: "Find out about Stripe's 2027 software engineering internship and who to talk to",
    cta: "ask_referral",
  },
];

function outreach(p: (typeof PROSPECTS)[number], channel: "email" | "linkedin", step = 0, previous?: { subject: string; body: string }) {
  return generateOutreachDraft(USER, {
    channel,
    tone: "friendly",
    messageIntent: p.intent,
    replyCta: p.cta,
    userGoals: ["Land a software engineering internship for summer 2027", "Grow Orbit's first 1,000 users"],
    prospect: p,
    stepIndex: step,
    lastStep: step >= 2,
    previousBody: previous?.body,
    previousSubject: previous?.subject,
    writingInstructions: VOICE,
  });
}

async function seed(key: string, model: string): Promise<{ ada: string; grace: string }> {
  await bootstrapAuthenticatedUser(USER);
  const db = await getDb();
  const settings = {
    writingStyleProfile: null,
    aiProvider: "openai",
    aiModel: model,
    openaiApiKeyEncrypted: encrypt(key),
    firstName: "Jason",
    lastName: "Pereira",
    senderBio: "CS student at UNC Chapel Hill and founder of Orbit, a networking app for students.",
  };
  await db.insert(userSettings).values({ userId: USER, ...settings }).onConflictDoUpdate({ target: userSettings.userId, set: settings });
  await db.delete(contacts).where(eq(contacts.userId, USER));
  const [ada, grace] = await db
    .insert(contacts)
    .values([
      { userId: USER, fullName: "Ada Lovelace", firstName: "Ada", company: "Analytical Engines", title: "Founder", notes: "Met at the fintech mixer in Durham." },
      { userId: USER, fullName: "Grace Hopper", firstName: "Grace", company: "Stripe", title: "Engineering Manager", notes: "Mentor from the HackNC hackathon." },
    ])
    .returning();
  await db.insert(interactions).values([
    { userId: USER, contactId: ada!.id, interactionType: "coffee", interactionDate: new Date("2026-10-20T15:00:00Z"), rawNotes: "Talked about her seed round, the London office, and that she is hiring a founding engineer in January." },
    { userId: USER, contactId: grace!.id, interactionType: "meeting", interactionDate: new Date("2026-10-04T18:00:00Z"), rawNotes: "Judged our HackNC project. Offered to introduce me to the payments infra team lead if I sent her my resume." },
  ]);
  // A connected calendar with the first eligible morning booked, so the windows are real ones
  // the model could not have guessed.
  await db.delete(calendarSources).where(eq(calendarSources.userId, USER));
  const [source] = await db
    .insert(calendarSources)
    .values({ userId: USER, provider: "google", connectionId: crypto.randomUUID(), calendarId: "primary", enabled: 1 })
    .returning();
  const busyFrom = new Date(Date.now() + 2 * 86_400_000);
  await db.insert(calendarEvents).values(
    Array.from({ length: 3 }, (_, i) => ({
      userId: USER,
      sourceId: source!.id,
      providerEventId: `eval-busy-${i}`,
      title: "Busy",
      startAt: new Date(busyFrom.getTime() + i * 86_400_000 - 6 * 3_600_000),
      endAt: new Date(busyFrom.getTime() + i * 86_400_000 + 6 * 3_600_000),
    }))
  );
  return { ada: ada!.id, grace: grace!.id };
}

async function main() {
  const keysFrom = flag("--keys-from");
  const file: Record<string, string> = keysFrom ? (parseEnv(readFileSync(keysFrom, "utf8")) as Record<string, string>) : {};
  const key = process.env.ORBIT_EVAL_OPENAI_KEY?.trim() || file.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("Needs ORBIT_EVAL_OPENAI_KEY, or --keys-from <env file> with OPENAI_API_KEY");
  const model = flag("--model") ?? "gpt-4.1";
  const runs = Math.max(1, Number(flag("--runs") ?? 1));
  const { ada, grace } = await seed(key, model);
  const db = await getDb();
  if (process.argv.includes("--mirror")) {
    const samples = SENT_SAMPLES.map(cleanSentBody).filter((b): b is string => Boolean(b));
    const profile = await distillStyleProfile(USER, samples);
    if (!profile) throw new Error("--mirror: the style profile came back empty");
    console.log(`Learned style (${samples.length} samples, ${Array.from(profile).length} chars):\n${profile}\n`);
    if (/marco|dana|priya|sam\b|liu|orbit|hackathon|midterm/i.test(profile)) console.log("   MISS the profile names a person or a topic");
    await db.update(userSettings).set({ writingStyleProfile: profile }).where(eq(userSettings.userId, USER));
  }
  VOICE = await loadWritingInstructions(USER);
  const windows = await freeWindows(USER);
  WINDOW_DAYS = (windows ?? []).map((w) => w.split(" ")[0]!.toLowerCase());
  console.log(`Calendar windows: ${windows ? windows.join(" | ") : "(none)"}\n`);

  const cases: Case[] = [
    ...PROSPECTS.map((p): Case => ({ name: `cold email: ${p.fullName}`, kind: "email_cold", run: () => outreach(p, "email") })),
    ...PROSPECTS.map((p): Case => ({ name: `LinkedIn note: ${p.fullName}`, kind: "linkedin_note", run: () => outreach(p, "linkedin") })),
    {
      name: "sequence follow-up (last step): Priya Shah",
      kind: "email_followup",
      previousSubject: "Ramp's new-grad hiring",
      run: () =>
        outreach(PROSPECTS[0]!, "email", 2, {
          subject: "Ramp's new-grad hiring",
          body: "Hi Priya,\n\nI'm Jason, a CS student at UNC building Orbit. Your Collision point about referrals stuck with me. Would Tuesday or Thursday afternoon next week work for 20 minutes?\n\nThanks,\nJason Pereira",
        }),
    },
    { name: "warm email: Ada", kind: "email_warm", run: () => generateContactFollowUpDraft(USER, ada, [], { channel: "email", intent: "Ask about the founding engineer role", writingInstructions: VOICE }) },
    { name: "warm email: Grace", kind: "email_warm", forbid: SENT_RESUME, run: () => generateContactFollowUpDraft(USER, grace, [], { channel: "email", writingInstructions: VOICE }) },
    { name: "LinkedIn DM: Ada", kind: "linkedin_dm", run: () => generateContactFollowUpDraft(USER, ada, [], { channel: "linkedin", writingInstructions: VOICE }) },
    { name: "LinkedIn DM: Grace", kind: "linkedin_dm", forbid: SENT_RESUME, run: () => generateContactFollowUpDraft(USER, grace, [], { channel: "linkedin", writingInstructions: VOICE }) },
    {
      name: "recruiter email: Dana Kim",
      kind: "email_warm",
      forbid: SENT_RESUME,
      run: () =>
        generateRecruiterDraft(USER, {
          intent: "set_up_chat",
          recruiter: { fullName: "Dana Kim", firm: "Northbridge Talent", specialty: ["fintech", "backend"] },
          history: "Emailed in September about backend roles at fintech startups; she asked for an updated resume and said Q1 is when her clients hire interns.",
          companiesMentioned: ["Plaid", "Ramp"],
          rolesDiscussed: ["Backend engineering intern"],
          lastEmailAt: new Date("2026-09-18T12:00:00Z"),
          userGoals: ["Land a software engineering internship for summer 2027"],
          senderName: SENDER,
          writingInstructions: VOICE,
        }),
    },
  ];

  let hardPass = 0;
  let hardTotal = 0;
  let softPass = 0;
  let softTotal = 0;
  const misses: string[] = [];
  for (let r = 0; r < runs; r++) {
    for (const c of cases) {
      // The draft ops are metered per click; an eval is many clicks.
      await db.delete(rateLimitBuckets).where(inArray(rateLimitBuckets.bucket, [`draft:${USER}`, `compose:${USER}`]));
      let d: Draft;
      try {
        d = await c.run();
      } catch (err) {
        misses.push(`${c.name}: threw ${(err as Error).message}`);
        hardTotal++;
        continue;
      }
      const result = checks(c, d);
      console.log(`\n── ${c.name} (${c.kind})${d.subject ? `\nSubject: ${d.subject}` : ""}\n${d.body}`);
      for (const k of result) {
        if (k.hard) {
          hardTotal++;
          if (k.ok) hardPass++;
        } else {
          softTotal++;
          if (k.ok) softPass++;
        }
        if (!k.ok) {
          console.log(`   ${k.hard ? "MISS" : "soft"} ${k.rule}`);
          if (k.hard) misses.push(`${c.name}: ${k.rule}`);
        }
      }
    }
  }

  await db.update(userSettings).set({ openaiApiKeyEncrypted: null }).where(eq(userSettings.userId, USER));
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 100);
  console.log(`\n${model}: hard rules ${hardPass}/${hardTotal} (${pct(hardPass, hardTotal)}%), soft rules ${softPass}/${softTotal} (${pct(softPass, softTotal)}%)`);
  if (misses.length) console.log(`Hard misses:\n  ${misses.join("\n  ")}`);
  process.exit(misses.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
