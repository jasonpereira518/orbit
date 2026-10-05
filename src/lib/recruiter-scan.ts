import { z } from "zod";
import { parseAiJson } from "@/lib/ai";
import { cachedCompleteJson } from "@/lib/ai-result-cache";
import type { Decider } from "@/lib/decisions/jev";
import { rulesOutRecruiter } from "@/lib/decisions/recruiter";
import { fenceUntrusted } from "@/lib/ai-security";

/**
 * Classification + summarization for one candidate sender found by the Gmail scan.
 *
 * Kept apart from the job runner so the prompt can be tuned without touching queueing,
 * chunking, or continuation logic — the two change for completely different reasons.
 */

const strList = z
  .array(z.string())
  .nullish()
  .transform((v) => (v || []).map((s) => s.trim()).filter(Boolean).slice(0, 8));

export const recruiterScanSchema = z.object({
  is_recruiter: z.boolean(),
  confidence: z.number().min(0).max(1).nullish(),
  full_name: z.string().nullish(),
  firm: z.string().nullish(),
  companies_mentioned: strList,
  roles_discussed: strList,
  summary: z.string().nullish(),
});

export type RecruiterScanResult = {
  isRecruiter: boolean;
  confidence: number;
  fullName: string | null;
  firm: string | null;
  companiesMentioned: string[];
  rolesDiscussed: string[];
  summary: string | null;
};

/**
 * Below this we drop the sender rather than write a low-confidence recruiter into a
 * table that can later be shared. Keyword search plus the regex prefilter is
 * recall-biased on purpose; this is where precision gets restored.
 */
export const RECRUITER_CONFIDENCE_FLOOR = 0.6;

/** Most recent messages only — enough to characterize a relationship, few enough to stay cheap. */
const MAX_MESSAGES_PER_SENDER = 5;

/**
 * The structural minimum the classifier reads from a message: subject, body-or-snippet, and
 * the date for the "(2026-01-04)" tag. Deliberately NOT `GmailMessageContent` — that type
 * carries Gmail's `to` and bulk-mail header fields, and typing the classifier against it
 * forced every other mail provider to invent values for fields this function never touches.
 * Any provider's message content satisfies this by shape.
 */
export type RecruiterScanMessage = {
  subject: string;
  snippet: string;
  body?: string;
  internalDate: number | null;
};

function renderMessages(messages: RecruiterScanMessage[]) {
  return messages
    .slice(0, MAX_MESSAGES_PER_SENDER)
    .map((m, i) => {
      const when = m.internalDate
        ? new Date(m.internalDate).toISOString().slice(0, 10)
        : "unknown date";
      return [
        `--- Message ${i + 1} (${when}) ---`,
        `Subject: ${m.subject || "(none)"}`,
        m.body?.trim() || m.snippet || "(no body)",
      ].join("\n");
    })
    .join("\n\n");
}

export const RECRUITER_SYSTEM = `You classify email senders as recruiters and summarize the user's relationship with them.

A recruiter is someone whose role in these emails is hiring or sourcing candidates: in-house talent acquisition, agency recruiters, headhunters, sourcers, or a hiring manager doing outreach about a specific opening.

NOT recruiters: job-board blasts and newsletters (LinkedIn Jobs, Indeed, Hired, Otta), automated applicant-tracking notifications (Greenhouse, Lever, Workday), colleagues, vendors, sales outreach, and anyone merely discussing employment in passing.

Rules:
- Judge only from the messages provided. Never invent a firm, role, or event.
- "summary" is 2-3 sentences, written to the user in second person, covering what the recruiter wanted, what happened, and where it stands. State the outcome plainly, including rejections and silence.
- "companies_mentioned" are the hiring companies discussed, not the recruiter's agency unless it is also the employer.
- "roles_discussed" are concrete job titles.
- If unsure whether they are a recruiter, set is_recruiter false and confidence low.

Return JSON: {"is_recruiter": boolean, "confidence": number between 0 and 1, "full_name": string|null, "firm": string|null, "companies_mentioned": string[], "roles_discussed": string[], "summary": string|null}`;

export function buildRecruiterUserPrompt(input: {
  senderName: string;
  senderEmail: string;
  firmGuess: string | null;
  messages: RecruiterScanMessage[];
}): string {
  return `Sender: ${input.senderName} <${input.senderEmail}>
Firm guessed from the email domain: ${input.firmGuess || "unknown"}

${fenceUntrusted("EMAILS", renderMessages(input.messages))}`;
}

/** The model's answer as a verdict. Throws when it is not the shape it promised. */
export function recruiterResultFromContent(content: string): RecruiterScanResult {
  const parsed = recruiterScanSchema.parse(parseAiJson(content));
  return {
    isRecruiter: parsed.is_recruiter,
    confidence: parsed.confidence ?? (parsed.is_recruiter ? 0.7 : 0),
    fullName: parsed.full_name?.trim() || null,
    firm: parsed.firm?.trim() || null,
    companiesMentioned: parsed.companies_mentioned,
    rolesDiscussed: parsed.roles_discussed,
    summary: parsed.summary?.trim() || null,
  };
}

/**
 * The verdict for a sender the decision model ruled out before any LLM call. Nothing about
 * them is written anywhere — a rejected sender only ever becomes a skipped row — so there is
 * no summary to invent, and no name or firm to guess.
 */
export const RULED_OUT_VERDICT: RecruiterScanResult = Object.freeze({
  isRecruiter: false,
  confidence: 0,
  fullName: null,
  firm: null,
  companiesMentioned: [],
  rolesDiscussed: [],
  summary: null,
}) as RecruiterScanResult;

export async function classifyRecruiterSender(
  userId: string,
  input: {
    senderName: string;
    senderEmail: string;
    firmGuess: string | null;
    messages: RecruiterScanMessage[];
  },
  opts: {
    /**
     * The account's decision model (`openDecider`), when it has one. A sender it is confident
     * is not a recruiter skips the LLM entirely; anything else is classified as before.
     */
    decider?: Decider | null;
  } = {}
): Promise<RecruiterScanResult> {
  if (opts.decider && (await rulesOutRecruiter(opts.decider, input))) return RULED_OUT_VERDICT;

  // Re-scans see the same senders again, and an overlap window re-reads the last two days of
  // mail on purpose. A sender whose rendered mail is byte-identical gets the verdict it got
  // last time instead of another model call; one new message changes the prompt and the key.
  const content = await cachedCompleteJson(userId, {
    operation: "recruiter.scan",
    // Low temperature: this is an extraction task, and the summary is stored as fact.
    temperature: 0.2,
    maxOutputTokens: 700,
    system: RECRUITER_SYSTEM,
    user: buildRecruiterUserPrompt(input),
  }, {
    ttlDays: 90,
    accept: (raw) => recruiterScanSchema.safeParse(parseAiJson(raw)).success,
  });

  return recruiterResultFromContent(content);
}
