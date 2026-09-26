/**
 * The demo's "chat with your network": a keyword router over the made-up cast, so any
 * question gets a grounded-looking answer with sources and, where it makes sense, a draft.
 * Pure — no model, no network. `smoke-waitlist-copy.ts` drives it directly.
 */
import {
  CLUSTERS,
  DEMO_PEOPLE,
  DEMO_SUGGESTIONS,
  daysLabel,
  firstName,
  personById,
  type DemoPerson,
  type TimelineSource,
} from "./demo-cast";

export type ChatSource = { label: string; source: TimelineSource; personId: string };
export type ChatDraft = { personId: string; body: string };
export type ChatAnswer = { kind: string; text: string; sources: ChatSource[]; draft?: ChatDraft };

/** One stage of the answer's narration, as the real chat's step stream reports it. */
export type DemoStep = { kind: string; label: string; detail?: string; ms: number; refs?: string[] };
export type NarratedAnswer = ChatAnswer & { steps: DemoStep[] };

/** The canned questions on the chat's suggestion cards, with the reason line under each. */
export const CHAT_SUGGESTIONS = [
  { q: "What did I promise Maya?", why: "Follow-up gone quiet 46 days" },
  { q: "Who do I know at Stripe?", why: "3 people · 1 inner orbit" },
  { q: "Who should I follow up with this week?", why: "From your reminders and suggestions" },
  { q: "Who should meet Grace Liu?", why: "Met at SaaStr 5 days ago" },
];

/** Hand-picked "who should meet whom", with the reason the answer gives. */
const INTROS: Record<string, { to: string; why: string }> = {
  grace: { to: "elena", why: "Elena runs logistics partnerships at Stripe and asked you for founders scaling ops." },
  elena: { to: "grace", why: "Grace is evaluating payments partners for Northwind's ops team." },
  sofia: { to: "maya", why: "Maya made the jump from consulting to product and is building a team." },
  maya: { to: "priya", why: "Priya runs research at Figma — Maya's new team will lean on her." },
  ben: { to: "aisha", why: "Aisha recruits platform PMs at Stripe; Ben knows the senior PM market." },
  jordan: { to: "hannah", why: "Hannah scaled engineering at Notion — exactly what Loop needs next." },
};

const DRAFTS: Record<string, string> = {
  maya:
    "Hi Maya — sorry this took a while! Here's the deck from the design offsite we talked about over coffee. Happy to walk you through how we ran discovery on Atlas — would a call next week work?",
  grace:
    "Hi Grace — great meeting you after the ops panel at SaaStr. You mentioned you're evaluating payments partners; I'd love to introduce you to Elena Rossi, who leads logistics partnerships at Stripe. Open to it?",
  elena:
    "Hi Elena — as promised, I'd love to connect you with Grace Liu, Head of Operations at Northwind Logistics. She's scaling ops and looking at payments partners. Mind if I start a thread?",
  tom:
    "Hi Tom — congratulations on the move to the AI strategy practice! Would love to hear what you'll be working on. Coffee in the next couple of weeks?",
  jordan: "Hey Jordan — deck comments coming your way tomorrow night. Quick one: is the pilot data final?",
  robert:
    "Hi Robert — my quarterly update: shipped the new onboarding, grew the team to six, and I'm starting to think about what's next. Would love your take.",
};

function sourcesFor(p: DemoPerson, n = 2): ChatSource[] {
  return p.timeline.slice(0, n).map((t) => ({
    label: `${t.type} · ${daysLabel(t.daysAgo)}`,
    source: t.source,
    personId: p.id,
  }));
}

function draftFor(p: DemoPerson): ChatDraft {
  return {
    personId: p.id,
    body: DRAFTS[p.id] ?? `Hi ${firstName(p)} — it's been a little while! ${p.nextStep} Free for a quick catch-up soon?`,
  };
}

/** A person named in the question, by full name first, then first name. */
function findPerson(q: string): DemoPerson | undefined {
  return (
    DEMO_PEOPLE.find((p) => q.includes(p.name.toLowerCase())) ??
    DEMO_PEOPLE.find((p) => new RegExp(`\\b${firstName(p).toLowerCase()}\\b`).test(q))
  );
}

function findCompany(q: string): string | undefined {
  const companies = [...new Set(DEMO_PEOPLE.map((p) => p.company)), CLUSTERS.michigan.label];
  return companies.find((c) => q.includes(c.toLowerCase()) || (c === CLUSTERS.michigan.label && /\bmichigan\b/.test(q)));
}

const byCloseness = (a: DemoPerson, b: DemoPerson) => b.closeness - a.closeness;

function routeQuestion(question: string): ChatAnswer {
  const q = question.toLowerCase().replace(/[’']/g, "'").trim();
  const person = findPerson(q);
  const company = findCompany(q);

  if (/promis|\bowe\b|said i'?d|told .* i'?d/.test(q)) {
    if (person?.promise) {
      return {
        kind: "promise",
        text: `You told ${firstName(person)} you'd ${person.promise.text} — ${person.promise.when}. It hasn't gone out yet, and your last touch was ${daysLabel(person.lastTouchDays)}.\n\n${person.standing}`,
        sources: sourcesFor(person),
        draft: draftFor(person),
      };
    }
    if (person) {
      return {
        kind: "promise-none",
        text: `Nothing you've promised ${firstName(person)} is on record. Where things stand: ${person.standing}`,
        sources: sourcesFor(person, 1),
      };
    }
    const owed = DEMO_PEOPLE.filter((p) => p.promise).sort(byCloseness).slice(0, 4);
    return {
      kind: "promise-all",
      text: `Open promises across your network:\n${owed.map((p) => `• ${p.name} — ${p.promise!.text}`).join("\n")}`,
      sources: owed.slice(0, 3).map((p) => sourcesFor(p, 1)[0]!),
      draft: draftFor(owed[0]!),
    };
  }

  if (/should meet|\bintro/.test(q) && person) {
    const match = INTROS[person.id];
    const other = personById(match?.to) ?? DEMO_PEOPLE.filter((p) => p.id !== person.id).sort(byCloseness)[0]!;
    return {
      kind: "intro",
      text: `${other.name} (${other.title}, ${other.company}). ${match?.why ?? `You're close to both, and ${firstName(other)} knows the space.`}\n\nYou're in touch with both — ${firstName(person)} ${daysLabel(person.lastTouchDays)}, ${firstName(other)} ${daysLabel(other.lastTouchDays)}.`,
      sources: [...sourcesFor(person, 1), ...sourcesFor(other, 1)],
      draft: draftFor(person),
    };
  }

  if (!person && /follow ?up|reach out|gone quiet|drift|this week|who should i (talk|call|email|contact|ping)/.test(q)) {
    const people = DEMO_SUGGESTIONS.slice(0, 3).map((s) => ({ p: personById(s.personId)!, why: s.why }));
    return {
      kind: "follow-up",
      text: `Three people worth reaching out to this week:\n${people.map(({ p, why }) => `• ${p.name} — ${why.toLowerCase()}`).join("\n")}\n\nStart with ${firstName(people[0]!.p)}: you still owe her the offsite deck.`,
      sources: people.map(({ p }) => sourcesFor(p, 1)[0]!),
      draft: draftFor(people[0]!.p),
    };
  }

  if (company) {
    const atCompany = DEMO_PEOPLE.filter(
      (p) => p.company === company || (company === CLUSTERS.michigan.label && p.cluster === "michigan")
    ).sort(byCloseness);
    const top = atCompany[0]!;
    return {
      kind: "company",
      text: `You know ${atCompany.length} ${atCompany.length === 1 ? "person" : "people"} ${company === CLUSTERS.michigan.label ? "from" : "at"} ${company}:\n${atCompany.map((p) => `• ${p.name} — ${p.title}, ${p.closeness}% closeness`).join("\n")}\n\n${firstName(top)} is your strongest tie there.`,
      sources: atCompany.slice(0, 3).map((p) => sourcesFor(p, 1)[0]!),
      draft: draftFor(top),
    };
  }

  const unknownCompany = q.match(/\bat ([a-z0-9&.\- ]{2,30}?)\??$/)?.[1];
  if (unknownCompany && /who (do i know|knows)/.test(q)) {
    const paths = DEMO_PEOPLE.slice().sort(byCloseness).slice(0, 2);
    return {
      kind: "company-none",
      text: `No one at ${unknownCompany.replace(/\b\w/g, (c) => c.toUpperCase())} yet. Your warmest paths in: ${paths.map((p) => `${p.name} (${p.company})`).join(" and ")} — both are well connected and close to you.`,
      sources: paths.map((p) => sourcesFor(p, 1)[0]!),
    };
  }

  if (person) {
    return {
      kind: "person",
      text: `Where things stand with ${person.name}: ${person.standing}\n\nNext step: ${person.nextStep}\nLast touch ${daysLabel(person.lastTouchDays)} · ${person.closeness}% closeness.`,
      sources: sourcesFor(person),
      draft: draftFor(person),
    };
  }

  const tagged = DEMO_PEOPLE.filter((p) => p.tags.some((t) => t.split(" ").some((w) => w.length > 3 && q.includes(w))));
  if (tagged.length > 0) {
    const list = tagged.sort(byCloseness).slice(0, 4);
    return {
      kind: "tag",
      text: `From your notes, these people fit:\n${list.map((p) => `• ${p.name} — ${p.title}, ${p.company}`).join("\n")}`,
      sources: list.slice(0, 3).map((p) => sourcesFor(p, 1)[0]!),
      draft: draftFor(list[0]!),
    };
  }

  const closest = DEMO_PEOPLE.slice().sort(byCloseness).slice(0, 3);
  return {
    kind: "fallback",
    text: `Orbit searches your notes, emails and meetings for questions like that. In this preview's made-up network, the people most likely to help are:\n${closest.map((p) => `• ${p.name} — ${p.title}, ${p.company}`).join("\n")}`,
    sources: closest.map((p) => sourcesFor(p, 1)[0]!),
  };
}

const INTENT: Record<string, string> = {
  promise: "a promise you made",
  "promise-none": "a promise you made",
  "promise-all": "promises you've made",
  intro: "who should meet whom",
  "follow-up": "who needs attention",
  company: "people at a company",
  "company-none": "people at a company",
  person: "where things stand with someone",
  tag: "people who match your notes",
  fallback: "an open question",
};

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The stages the real chat narrates — understand, search, rank, read, write — filled in
 * from the people this answer actually used, so the counts and names add up.
 */
function stepsFor(answer: ChatAnswer): DemoStep[] {
  const used = [...new Set(answer.sources.map((s) => s.personId))];
  const candidates = [
    ...used,
    ...DEMO_PEOPLE.slice().sort(byCloseness).map((p) => p.id).filter((id) => !used.includes(id)),
  ].slice(0, Math.max(used.length + 5, 7));
  const reads = used.flatMap((id) => personById(id)!.timeline);
  const count = (pred: (t: (typeof reads)[number]) => boolean) => reads.filter(pred).length;
  const emails = count((t) => t.source === "Gmail");
  const meetings = count((t) => t.source === "Google Calendar");
  const linkedin = count((t) => t.source === "LinkedIn");
  const readDetail = [
    emails && plural(emails, "email"),
    meetings && plural(meetings, "meeting"),
    linkedin && `${linkedin} LinkedIn`,
  ]
    .filter(Boolean)
    .join(", ");

  const steps: DemoStep[] = [
    { kind: "understand", label: "Working out what you're asking for", detail: INTENT[answer.kind], ms: 650 },
    {
      kind: "search",
      label: "Searching your network",
      detail: answer.kind.startsWith("company") ? "past employers, name and notes" : "name and notes, meaning",
      ms: 900,
      refs: candidates,
    },
  ];
  if (answer.kind === "follow-up") {
    steps.push({ kind: "attention", label: "Checking who is overdue", detail: "3 follow-ups due", ms: 500 });
  }
  steps.push({ kind: "rank", label: `Ranking ${candidates.length} people`, ms: 450 });
  if (used.length > 0) {
    steps.push({
      kind: "read",
      label: `Reading notes on ${plural(used.length, "contact")}`,
      detail: readDetail || undefined,
      ms: 800,
      refs: used,
    });
  }
  steps.push({ kind: "answer", label: "Writing the answer", ms: 0, refs: used });
  return steps;
}

export function answerQuestion(question: string): NarratedAnswer {
  const answer = routeQuestion(question);
  return { ...answer, steps: stepsFor(answer) };
}
