import { completeJson, parseAiJson } from "@/lib/ai";

/**
 * Intent-shaped email drafting for recruiters.
 *
 * Structurally the same as `outreach-drafts.ts` — `completeJson`, placeholder scrubbing,
 * a bounded worker pool — but the context is different: an outreach prospect is a cold
 * stranger, whereas a recruiter here usually has a real history with the user that the
 * Gmail scan already summarized. Drafts should read as continuations, not cold opens.
 *
 * The `guidance` strings below are the tuning surface. They are intentionally the only
 * thing in this file that encodes tone or strategy, so they can be rewritten without
 * touching generation, batching, or sending.
 */

export const RECRUITER_INTENTS = {
  set_up_chat: {
    label: "Set up a chat",
    guidance:
      "Ask for a short call. Propose a concrete, low-friction next step (a 15-minute call this week or next) and make saying yes easy. Do not restate a full résumé.",
  },
  route_to_person: {
    label: "Route me to the right person",
    guidance:
      "Ask to be pointed to whoever owns the roles the user actually wants. Be explicit that you are asking for a redirect or introduction, not for this recruiter's own pipeline. Make it easy to forward.",
  },
  upcoming_drops: {
    label: "Upcoming job/internship drops",
    guidance:
      "Ask what is opening soon and when. Reference the timing of any role previously discussed. Ask to be told when reqs post rather than asking them to create an opening.",
  },
  interview_resources: {
    label: "Interview resources",
    guidance:
      "Ask what the interview process looks like and what preparation material they recommend. Assume the user is already in or near a process; do not ask to start one.",
  },
} as const;

export type RecruiterIntent = keyof typeof RECRUITER_INTENTS;

export function isRecruiterIntent(value: string): value is RecruiterIntent {
  return Object.prototype.hasOwnProperty.call(RECRUITER_INTENTS, value);
}

export type RecruiterDraftInput = {
  intent: RecruiterIntent;
  recruiter: {
    fullName: string;
    firm: string | null;
    specialty: string[];
  };
  /** The scan's private summary — the single most useful piece of context available. */
  history: string | null;
  companiesMentioned: string[];
  rolesDiscussed: string[];
  lastEmailAt: Date | null;
  userGoals: string[];
  senderName: string | null;
  /** Distinguishes drafts within a batch so a run of emails doesn't read as a mail merge. */
  variationHint?: string;
};

export type GeneratedRecruiterDraft = { subject: string; body: string };

function scrubPlaceholders(text: string) {
  return text
    .replace(/\[Your Name\]/gi, "")
    .replace(/\[My Name\]/gi, "")
    .replace(/\[Name\]/gi, "")
    .replace(/\[Company\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function describeGap(lastEmailAt: Date | null) {
  if (!lastEmailAt) return "You have no recorded email history with them.";
  const days = Math.floor((Date.now() - lastEmailAt.getTime()) / 86_400_000);
  if (days <= 14) return `You last emailed about ${days} day(s) ago.`;
  if (days <= 60) return `You last emailed about ${Math.round(days / 7)} weeks ago.`;
  return `You last emailed about ${Math.round(days / 30)} months ago — acknowledge the gap without apologizing for it.`;
}

export async function generateRecruiterDraft(
  userId: string,
  input: RecruiterDraftInput
): Promise<GeneratedRecruiterDraft> {
  const intent = RECRUITER_INTENTS[input.intent];

  const context = [
    `Recruiter: ${input.recruiter.fullName}`,
    `Firm: ${input.recruiter.firm || "unknown"}`,
    input.recruiter.specialty.length
      ? `Specialties: ${input.recruiter.specialty.join(", ")}`
      : null,
    input.companiesMentioned.length
      ? `Companies previously discussed: ${input.companiesMentioned.join(", ")}`
      : null,
    input.rolesDiscussed.length
      ? `Roles previously discussed: ${input.rolesDiscussed.join(", ")}`
      : null,
    describeGap(input.lastEmailAt),
    input.history ? `History with them:\n${input.history}` : "No prior history recorded.",
    input.userGoals.length
      ? `What the sender is looking for: ${input.userGoals.join("; ")}`
      : null,
    input.senderName ? `Sender's name: ${input.senderName}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const content = await completeJson(userId, {
    operation: "recruiter.draft",
    temperature: 0.55,
    maxOutputTokens: 600,
    system: `You write short emails from a candidate to a recruiter they already know.

Goal for this message: ${intent.guidance}

Rules:
- Under 120 words. One clear ask. Plain sentences.
- Ground the opener in the actual history when there is any. Never invent a meeting, referral, interview, or outcome that is not in the context.
- If the history records a rejection or a frozen role, acknowledge it plainly and move forward. Do not pretend it went well.
- No flattery, no "I hope this finds you well", no exaggerated enthusiasm.
- Never leave placeholders like [Your Name] or [Company]. If the sender's name is unknown, end without a signature line.
- The subject line must be specific to this conversation, not generic ("Following up" is not acceptable).

Return JSON: {"subject": string, "body": string}`,
    user: `${context}

${input.variationHint ? `Vary phrasing from other drafts in this batch: ${input.variationHint}` : ""}`,
  });

  const parsed = parseAiJson<{ subject?: string; body?: string }>(content);
  const subject = scrubPlaceholders(parsed.subject?.trim() || "");
  const body = scrubPlaceholders(parsed.body?.trim() || "");
  if (!body) throw new Error("The model returned an empty draft");
  return { subject: subject || `Following up — ${input.recruiter.fullName}`, body };
}

/**
 * Draft for many recruiters at once with bounded concurrency.
 *
 * Each input gets a distinct `variationHint`: bulk-sending near-identical AI text from
 * one address is exactly what gets a sending address flagged, so divergence is a
 * deliverability requirement, not a stylistic nicety.
 */
export async function generateRecruiterDraftsBatch(
  userId: string,
  inputs: RecruiterDraftInput[],
  concurrency = 4
): Promise<Array<GeneratedRecruiterDraft | { error: string }>> {
  const results: Array<GeneratedRecruiterDraft | { error: string }> = new Array(
    inputs.length
  );
  let index = 0;

  async function worker() {
    while (index < inputs.length) {
      const current = index++;
      const input = {
        ...inputs[current],
        variationHint:
          inputs[current].variationHint ||
          `draft ${current + 1} of ${inputs.length} — use a different opening move than the others`,
      };
      try {
        results[current] = await generateRecruiterDraft(userId, input);
      } catch (err) {
        // One bad draft must not lose the rest of the batch.
        results[current] = {
          error: err instanceof Error ? err.message : "Draft failed",
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker())
  );
  return results;
}
