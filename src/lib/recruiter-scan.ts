import { z } from "zod";
import { completeJson, parseAiJson } from "@/lib/ai";
import type { GmailMessageContent } from "@/lib/gmail";

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

function renderMessages(messages: GmailMessageContent[]) {
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

export async function classifyRecruiterSender(
  userId: string,
  input: {
    senderName: string;
    senderEmail: string;
    firmGuess: string | null;
    messages: GmailMessageContent[];
  }
): Promise<RecruiterScanResult> {
  const content = await completeJson(userId, {
    operation: "recruiter.scan",
    // Low temperature: this is an extraction task, and the summary is stored as fact.
    temperature: 0.2,
    maxOutputTokens: 700,
    system: `You classify email senders as recruiters and summarize the user's relationship with them.

A recruiter is someone whose role in these emails is hiring or sourcing candidates: in-house talent acquisition, agency recruiters, headhunters, sourcers, or a hiring manager doing outreach about a specific opening.

NOT recruiters: job-board blasts and newsletters (LinkedIn Jobs, Indeed, Hired, Otta), automated applicant-tracking notifications (Greenhouse, Lever, Workday), colleagues, vendors, sales outreach, and anyone merely discussing employment in passing.

Rules:
- Judge only from the messages provided. Never invent a firm, role, or event.
- "summary" is 2-3 sentences, written to the user in second person, covering what the recruiter wanted, what happened, and where it stands. State the outcome plainly, including rejections and silence.
- "companies_mentioned" are the hiring companies discussed, not the recruiter's agency unless it is also the employer.
- "roles_discussed" are concrete job titles.
- If unsure whether they are a recruiter, set is_recruiter false and confidence low.

Return JSON: {"is_recruiter": boolean, "confidence": number between 0 and 1, "full_name": string|null, "firm": string|null, "companies_mentioned": string[], "roles_discussed": string[], "summary": string|null}`,
    user: `Sender: ${input.senderName} <${input.senderEmail}>
Firm guessed from the email domain: ${input.firmGuess || "unknown"}

${renderMessages(input.messages)}`,
  });

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
