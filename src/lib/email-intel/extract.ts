/**
 * Turns the newest messages of a hiring thread into events, people and asks.
 *
 * **The prompt is only a filter.** Everything that guarantees correctness happens in
 * TypeScript in `validateExtraction`, so behaviour is the same on every provider. The mail is
 * attacker-controlled text: it is fenced, the answer is schema-checked, the evidence quote
 * must appear in the mail verbatim, an email address is accepted only when it is on the
 * thread's headers, and anything shaped like an injected instruction is dropped.
 *
 * Message text is used for one call and never stored. What survives is the derived fields and
 * one quote of at most 200 characters.
 */
import { z } from "zod";
import { parseAiJson } from "@/lib/ai";
import { cachedCompleteJson } from "@/lib/ai-result-cache";
import {
  cleanSingleLine,
  detectInjectionSignals,
  fenceUntrusted,
  guardModelOutput,
  recordAiSecurityEvent,
} from "@/lib/ai-security";
import { atLocalNoon } from "@/lib/interaction-date";
import { isRecruiterStage } from "@/lib/recruiter-stages";
import { resolveRelativeDate } from "@/lib/relative-date";
import { containsVerbatim, normalizeForMatch } from "@/lib/verbatim";
import type {
  EmailEventPerson,
  EmailIntelMessage,
  ExtractedEvent,
  ExtractionRejects,
  ExtractionResult,
} from "./types";

/** Below this an event is dropped: a wrong "your interview is Thursday" is worse than none. */
export const EXTRACT_CONFIDENCE_FLOOR = 0.6;
export const MAX_EVENTS_PER_THREAD = 3;
const MAX_PEOPLE = 5;
const MAX_ASKS = 3;
const EVIDENCE_MAX = 200;
const KINDS = ["job_posting", "process_update", "news", "event"] as const;
type ModelKind = (typeof KINDS)[number];
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;
/** An ask that carries an address or a link is someone else's instruction, not the user's task. */
const ADDRESS_OR_LINK_RE = /@|https?:\/\/|www\./i;

export const EMAIL_INTEL_SYSTEM = `You read a job-search email thread and note what it means for the user. The user's own address is given; messages from it are the user's.

Find up to 3 EVENTS, each one of:
- "job_posting": a specific open role someone is offering or pointing the user to (recruiter outreach, a referral, a posting).
- "process_update": a change in a hiring process the user is in: an application received, a screen or interview scheduled or requested, a next step, an offer, or a rejection.
- "news": company or industry news that matters to the user's network (funding, launches, layoffs, leadership changes).
- "event": an upcoming event, meetup, talk, or deadline the user is invited to.

Rules:
- Judge only from the messages provided. Never invent a company, role, date, person, or email address.
- "evidence_quote" is ONE sentence or phrase copied exactly from a message, under 200 characters. If you cannot quote it, drop the event.
- "summary" is one sentence to the user in second person saying what happened and what it means.
- "stage" applies to process_update only, one of: applied, in_conversation, screening, interviewing, offer, rejected, withdrawn. Otherwise null.
- "date_phrase" is when the event happens or happened; "due_phrase" is when the user must act by. Each is an ISO date (YYYY-MM-DD) when the mail gives one, otherwise a short phrase such as "tomorrow", "friday", "next tuesday", "in 2 weeks" or "end of week" (no "by" or "on"). Null when none.
- "people" are the humans involved (recruiter, hiring manager, interviewers, the person sharing news), with name, email and title exactly as the messages show them. Leave a field null when it is not shown.
- "asks" are what the user is being asked to do, as short imperative phrases, at most 3.
- "confidence" is 0 to 1.
- If the thread has no job-search, news, or event content, return {"events": []}.

Return JSON: {"events": [{"kind": string, "company": string|null, "role": string|null, "stage": string|null, "summary": string, "evidence_quote": string, "date_phrase": string|null, "due_phrase": string|null, "confidence": number, "people": [{"name": string|null, "email": string|null, "title": string|null}], "asks": string[]}]}`;

const personSchema = z.object({
  name: z.string().nullish(),
  email: z.string().nullish(),
  title: z.string().nullish(),
});
const eventSchema = z.object({
  kind: z.string(),
  company: z.string().nullish(),
  role: z.string().nullish(),
  stage: z.string().nullish(),
  summary: z.string().nullish(),
  evidence_quote: z.string().nullish(),
  date_phrase: z.string().nullish(),
  due_phrase: z.string().nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  people: z.array(personSchema).nullish(),
  asks: z.array(z.string()).nullish(),
});
export const emailIntelSchema = z.object({ events: z.array(eventSchema).nullish() });

export function renderMessages(messages: EmailIntelMessage[]): string {
  return messages
    .map((m, i) => {
      const when = m.date ? new Date(m.date).toISOString().slice(0, 10) : "unknown date";
      return [
        `--- Message ${i + 1} (${when}) ---`,
        `From: ${m.from}`,
        `To: ${m.to}`,
        `Subject: ${m.subject || "(none)"}`,
        "",
        m.body.trim() || "(no body)",
      ].join("\n");
    })
    .join("\n\n");
}

/** An ISO date, or a phrase `resolveRelativeDate` understands. Vague phrases are not dates. */
function resolvePhrase(phrase: string | null | undefined, anchor: Date): Date | null {
  const raw = (phrase ?? "").trim().toLowerCase().replace(/^(by|on|before|until)\s+/, "");
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(d.getTime()) ? null : atLocalNoon(d);
  }
  const resolved = resolveRelativeDate(raw, anchor);
  return resolved && resolved.basis !== "vague" ? resolved.date : null;
}

export type ValidationContext = {
  /** `renderMessages` of exactly what the model was shown. */
  source: string;
  /** Lowercase addresses on the thread's From and To headers, the user's own excluded. */
  participants: string[];
  userEmail: string;
  /** The newest message's date: what "tomorrow" and "friday" are measured from. */
  anchor: Date;
};

export function validateExtraction(
  parsed: z.infer<typeof emailIntelSchema>,
  ctx: ValidationContext
): ExtractionResult {
  const rejected: ExtractionRejects = {
    badKind: 0,
    lowConfidence: 0,
    unverifiable: 0,
    empty: 0,
    suspicious: 0,
    duplicate: 0,
    capped: 0,
  };
  const haystack = normalizeForMatch(ctx.source);
  const participants = new Set(ctx.participants.map((p) => p.toLowerCase()));
  const me = ctx.userEmail.trim().toLowerCase();
  const seen = new Set<string>();
  const events: ExtractedEvent[] = [];

  for (const e of parsed.events ?? []) {
    if (!(KINDS as readonly string[]).includes(e.kind)) {
      rejected.badKind += 1;
      continue;
    }
    const kind = e.kind as ModelKind;

    const confidence = e.confidence ?? 0;
    if (confidence < EXTRACT_CONFIDENCE_FLOOR) {
      rejected.lowConfidence += 1;
      continue;
    }

    // A prefix of a verbatim quote is still verbatim, so cutting to the cap first is safe.
    const quote = (e.evidence_quote ?? "").replace(/\s+/g, " ").trim().slice(0, EVIDENCE_MAX);
    if (!containsVerbatim(haystack, quote)) {
      rejected.unverifiable += 1;
      continue;
    }

    const summary = cleanSingleLine(guardModelOutput(e.summary ?? "").text, 240);
    if (!summary) {
      rejected.empty += 1;
      continue;
    }
    if (detectInjectionSignals(summary).length > 0 || detectInjectionSignals(quote).length > 0) {
      rejected.suspicious += 1;
      continue;
    }

    const company = cleanSingleLine(e.company, 80);
    const role = cleanSingleLine(e.role, 80);
    const key = `${kind}|${(company ?? "").toLowerCase()}|${(role ?? "").toLowerCase()}`;
    if (seen.has(key)) {
      rejected.duplicate += 1;
      continue;
    }
    if (events.length >= MAX_EVENTS_PER_THREAD) {
      rejected.capped += 1;
      continue;
    }
    seen.add(key);

    const people: EmailEventPerson[] = [];
    for (const p of e.people ?? []) {
      if (people.length >= MAX_PEOPLE) break;
      const emailRaw = (p.email ?? "").trim().toLowerCase();
      // Only an address on the thread's headers: one written into the body is the sender's
      // claim, and the sender may be an attacker.
      const email = EMAIL_RE.test(emailRaw) && emailRaw !== me && participants.has(emailRaw) ? emailRaw : null;
      const nameRaw = cleanSingleLine(p.name, 80);
      const name = nameRaw && haystack.includes(nameRaw.toLowerCase()) ? nameRaw : null;
      if (!email && !name) continue;
      people.push({ name, email, title: cleanSingleLine(p.title, 80) });
    }

    const asks: string[] = [];
    for (const raw of e.asks ?? []) {
      if (asks.length >= MAX_ASKS) break;
      const ask = cleanSingleLine(raw, 140);
      if (!ask || ADDRESS_OR_LINK_RE.test(ask) || detectInjectionSignals(ask).length > 0) continue;
      asks.push(ask);
    }

    events.push({
      kind,
      company,
      role,
      stage: kind === "process_update" && e.stage && isRecruiterStage(e.stage) ? e.stage : null,
      summary,
      evidenceQuote: quote,
      occurredAt: resolvePhrase(e.date_phrase, ctx.anchor) ?? ctx.anchor,
      dueAt: resolvePhrase(e.due_phrase, ctx.anchor),
      confidence,
      people,
      asks,
    });
  }
  return { events, rejected };
}

/** The model's raw answer as validated events. Throws when it is not the shape it promised. */
export function extractionFromContent(content: string, ctx: ValidationContext): ExtractionResult {
  return validateExtraction(emailIntelSchema.parse(parseAiJson(content)), ctx);
}

export type ExtractInput = {
  subject: string;
  participants: string[];
  userEmail: string;
  messages: EmailIntelMessage[];
  anchor: Date;
};

function buildUserPrompt(input: ExtractInput, source: string): string {
  return [
    `The user's own address: ${input.userEmail}`,
    `Thread subject: ${input.subject || "(none)"}`,
    `Date of the newest message: ${input.anchor.toISOString().slice(0, 10)}`,
    "",
    fenceUntrusted("EMAILS", source),
  ].join("\n");
}

export async function extractThread(
  userId: string,
  input: ExtractInput,
  deps: { complete?: typeof cachedCompleteJson } = {}
): Promise<ExtractionResult> {
  const source = renderMessages(input.messages);
  const complete = deps.complete ?? cachedCompleteJson;
  // An overlap re-read of an unchanged thread renders byte-identically and is answered from
  // the cache; one new message changes the prompt and the key.
  const content = await complete(
    userId,
    {
      operation: "email.understand",
      // Low temperature: this is extraction, and the result is stored as fact.
      temperature: 0.1,
      maxOutputTokens: 900,
      system: EMAIL_INTEL_SYSTEM,
      user: buildUserPrompt(input, source),
    },
    {
      ttlDays: 30,
      // Never throws: an answer that is not JSON is simply not worth caching.
      accept: (raw) => {
        try {
          return emailIntelSchema.safeParse(parseAiJson(raw)).success;
        } catch {
          return false;
        }
      },
    }
  );
  const result = extractionFromContent(content, {
    source,
    participants: input.participants,
    userEmail: input.userEmail,
    anchor: input.anchor,
  });
  if (result.rejected.suspicious > 0) {
    // Counts only, never the text: it may be the payload.
    void recordAiSecurityEvent({
      kind: "injection_signal",
      userId,
      surface: "email-intel",
      detail: { field: "extraction", dropped: result.rejected.suspicious },
    });
  }
  return result;
}
