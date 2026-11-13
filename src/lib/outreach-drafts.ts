import { LOCAL_TIME_RULE, promptNow } from "@/lib/user-clock";
import { viewerTimeZone } from "@/lib/viewer-time-zone";
import { z } from "zod";
import { completeJson } from "@/lib/ai";
import { AI_INCOMPLETE_MESSAGE } from "@/lib/errors";
import { classifyAiError } from "@/lib/errors";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import { fenceUntrusted } from "@/lib/ai-security";
import { guardDraftOutput } from "@/lib/draft-output";
import { senderProfileBlock } from "@/lib/sender-profile";
import { loadSenderBio, loadSenderName } from "@/lib/sender-profile-server";
import { FALLBACK_VOICE, draftWithFormat, formatRules, toneNudge, type MessageKind } from "@/lib/message-format";
import { withWritingPreferences } from "@/lib/writing-instructions";
import type { OutreachChannel } from "@/lib/outreach-types";
import { freeWindows } from "@/lib/calendar-free-windows";

export type DraftInput = {
  channel: OutreachChannel;
  tone: string;
  messageIntent: string;
  audienceQuery?: string | null;
  replyCta?: string | null;
  userGoals: string[];
  prospect: {
    fullName: string;
    title: string | null;
    company: string | null;
    location: string | null;
    enrichmentSummary?: string | null;
    priorNotes?: string | null;
  };
  templateSeed?: string;
  stepIndex?: number;
  /** The sequence's last step: the follow-up offers an easy out. */
  lastStep?: boolean;
  previousBody?: string | null;
  /**
   * The user's two real free times for a meeting ask (`freeWindows`); a batch reads them once
   * and passes them. Undefined: read here. Null: none (no calendar, or no two free slots).
   */
  timeWindows?: string[] | null;
  /** The earlier message's subject: an email follow-up replies under it ("Re: …"). */
  previousSubject?: string | null;
  variationHint?: string;
  /**
   * The sender's own style notes (`user_settings.writing_instructions`), loaded by whoever
   * owns the request — never here, so a batch loads them once and no other caller inherits
   * them by accident.
   */
  writingInstructions?: string | null;
};

export type GeneratedDraft = {
  subject: string | null;
  body: string;
};

/** "Re: <subject>" once, however many replies deep; null when there is no subject to reply to. */
export function replySubject(previous: string | null | undefined): string | null {
  const base = previous?.trim().replace(/^(re:\s*)+/i, "").trim();
  return base ? `Re: ${base}` : null;
}

/** Which house format a campaign message follows (`@/lib/message-format`). */
export function outreachKind(channel: OutreachChannel, stepIndex = 0): MessageKind {
  if (channel === "email") return stepIndex > 0 ? "email_followup" : "email_cold";
  // A first LinkedIn touch is a connection note; a later one goes to someone who accepted.
  if (channel === "linkedin") return stepIndex > 0 ? "linkedin_dm" : "linkedin_note";
  return "sms";
}

function replyCtaGuidance(replyCta?: string | null) {
  switch (replyCta) {
    case "book_intro":
      return "Desired reply: agreement to a short intro call or suggested times.";
    case "ask_referral":
      return "Desired reply: a warm referral or intro to the right person for the campaign intent (e.g. the right recruiter or hiring process) — not a product sales pitch.";
    case "get_feedback":
      return "Desired reply: candid feedback on a specific idea or question.";
    case "explore_partnership":
      return "Desired reply: interest in exploring a partnership next step.";
    default:
      return "Desired reply: an engaged, specific response to the campaign ask.";
  }
}

function scrubPlaceholders(text: string) {
  return text
    .replace(/\[Your Name\]/gi, "")
    .replace(/\[My Name\]/gi, "")
    .replace(/\[Name\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The reply's shape on the wire (every field present), and what we accept back. */
const outreachDraftWire = z.object({ subject: z.string().nullable(), body: z.string() });
const outreachDraftReply = z.object({ subject: z.string().nullish(), body: z.string() });

/**
 * One outreach draft: one model call, one unit of the `draft` bucket (audit M-07). A
 * campaign's bulk generation goes through `generateOutreachDraftsBatch` instead, which is
 * charged per ten drafts.
 */
export async function generateOutreachDraft(
  userId: string,
  input: DraftInput
): Promise<GeneratedDraft> {
  await consumeBucket("draft", userId, RATE_LIMITS.draft);
  return draftOutreachMessage(userId, input);
}

async function draftOutreachMessage(
  userId: string,
  input: DraftInput
): Promise<GeneratedDraft> {
  // These two were one block until now: the user's GOALS were being labelled "Sender
  // background", because that is the slot the prompt wanted and goals were the only thing
  // available to fill it. They are different things — a goal is what the user is trying to
  // achieve, a bio is who is asking — and conflating them is part of why drafts reached for
  // "[Your Name]". The "secondary context" guard stays on both: it is what stops the model
  // turning either into a product pitch.
  const goalsBlock =
    input.userGoals.length > 0
      ? `Sender goals (secondary context only — do not invent a product pitch from these): ${input.userGoals.join("; ")}`
      : "Sender goals: (not specified)";

  const step0 = input.stepIndex ?? 0;
  const wantsWindows = input.channel === "email" && step0 === 0;
  const [senderBio, senderFullName, windows] = await Promise.all([
    loadSenderBio(userId),
    loadSenderName(userId),
    !wantsWindows ? null : input.timeWindows !== undefined ? input.timeWindows : freeWindows(userId),
  ]);
  const senderBlock = senderProfileBlock(senderBio);

  const prospectBlock = [
    `Name: ${input.prospect.fullName}`,
    `Title: ${input.prospect.title || "unknown"}`,
    `Company: ${input.prospect.company || "unknown"}`,
    `Location: ${input.prospect.location || "unknown"}`,
    input.prospect.enrichmentSummary
      ? `Enrichment: ${input.prospect.enrichmentSummary}`
      : null,
    input.prospect.priorNotes
      ? `Prior context: ${input.prospect.priorNotes}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const step = input.stepIndex ?? 0;
  const kind = outreachKind(input.channel, step);
  const stepBlock =
    step > 0
      ? `This is follow-up #${step}. Reference the prior note lightly; do not repeat it. Prior message:\n${
          // The prior draft may have been edited, or written from a prospect row someone else
          // shaped — data to build on, never instructions (audit M-11).
          input.previousBody ? fenceUntrusted("PRIOR", input.previousBody) : "(none)"
        }`
      : "This is the first touch.";

  const audienceBlock = input.audienceQuery?.trim()
    ? `Audience / ICP: ${input.audienceQuery.trim()}`
    : "";

  const system = `You write personalized outreach optimized for a successful reply.
Primary campaign intent (must drive the message): ${input.messageIntent}
${audienceBlock}
${replyCtaGuidance(input.replyCta)}

House rules for the message (strict):
${formatRules(kind, { senderFullName, lastStep: input.lastStep, windows })}
- ${FALLBACK_VOICE}
${toneNudge(input.tone) ? `- ${toneNudge(input.tone)}\n` : ""}
Critical rules:
- Write as the sender pursuing the campaign intent above.
- Do NOT invent a SaaS/product pitch unless the campaign intent explicitly is selling a product.
- If the audience is recruiters / internships / jobs, ask about the hiring process, the right recruiter, internship timeline, or a referral into that process — not engineering tooling or onboarding software.
- Prefer campaign intent over sender background when they conflict.
- Include one specific "why this person" detail when role/company context exists.
- Prefer specificity over length. Avoid spammy language, fake familiarity, and exaggerated claims.
- Never leave placeholders like [My Name] or [Your Name].
- Do not use identical phrasing across people — vary openers and hooks.
Return JSON: { "subject": string|null, "body": string }`;

  const userMessage = `${withWritingPreferences(goalsBlock, input.writingInstructions)}
${senderBlock ? `${senderBlock}\n` : ""}
Prospect:
${fenceUntrusted("PROSPECT", prospectBlock)}

${stepBlock}

${input.variationHint ? `Variation hint: ${input.variationHint}` : ""}

${input.templateSeed ? `Template seed (a starting point for structure and wording):\n${fenceUntrusted("TEMPLATE", input.templateSeed)}` : ""}`;
  const dated = `${promptNow(await viewerTimeZone(userId))} ${LOCAL_TIME_RULE}\n\n${system}`;

  // Dashes and "!" are scrubbed in code; a hype word or a note over the limit buys one retry.
  return draftWithFormat(kind, async (retry) => {
    const content = await completeJson(userId, {
      operation: "outreach.draft",
      schema: { name: "outreach_draft", zod: outreachDraftWire },
      temperature: 0.55,
      system: dated,
      user: retry ? `${userMessage}\n\n${retry}` : userMessage,
    });

    // Was a bare cast: a reply with no `body`, or a non-string one, crashed on `.trim()` further
    // down with nothing the person could read.
    const reply = outreachDraftReply.safeParse(JSON.parse(content));
    if (!reply.success) throw new Error(AI_INCOMPLETE_MESSAGE);
    // Scrubbed, and refused if it quotes the system prompt, before anyone can send it (audit M-11).
    const draft = guardDraftOutput(reply.data, { userId, surface: "outreach.draft", system });
    // A follow-up email stays in the first one's thread, so it keeps that subject.
    const threadSubject = kind === "email_followup" ? replySubject(input.previousSubject) : null;
    return {
      subject: threadSubject ?? (scrubPlaceholders(draft.subject?.trim() || "") || null),
      body: scrubPlaceholders(draft.body.trim()),
    };
  }, { senderFullName });
}

/** How many drafts of a bulk run count as one unit of the `draft` bucket. */
const DRAFTS_PER_UNIT = 10;

/**
 * One draft per input; a draft that failed is `null`, not a failure of the batch.
 *
 * It used to be `Promise.all` over the workers, so the first bad reply rejected the whole
 * call while the other workers kept generating (and billing) drafts nobody would receive.
 * Now each draft stands alone. A failure that every remaining draft would repeat (no key, an
 * exhausted quota, a rate limit) stops new drafts being started, and when NOTHING was drafted
 * the first error is thrown so the person is told why instead of seeing an empty result.
 */
export async function generateOutreachDraftsBatch(
  userId: string,
  inputs: DraftInput[],
  concurrency = 5
): Promise<Array<GeneratedDraft | null>> {
  const results: Array<GeneratedDraft | null> = new Array(inputs.length).fill(null);
  // One click drafts the whole selection, so it is charged as a click per ten drafts rather
  // than per draft: a 50-prospect campaign is 5 units of `draft`, not a refusal (M-07).
  if (inputs.length) {
    await consumeBucket("draft", userId, RATE_LIMITS.draft, Math.ceil(inputs.length / DRAFTS_PER_UNIT));
  }
  // One calendar read for the whole batch, not one per prospect.
  const timeWindows = inputs.some((i) => i.channel === "email") ? await freeWindows(userId) : null;
  let index = 0;
  let halted = false;
  let firstError: unknown = null;

  async function worker() {
    while (!halted && index < inputs.length) {
      const current = index++;
      const input = {
        timeWindows,
        ...inputs[current],
        variationHint:
          inputs[current].variationHint ||
          `Variant ${current + 1} of ${inputs.length}`,
      };
      try {
        results[current] = await draftOutreachMessage(userId, input);
      } catch (err) {
        firstError ??= err;
        const kind = classifyAiError(err);
        if (kind === "auth" || kind === "quota" || kind === "rate_limit") halted = true;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    () => worker()
  );
  await Promise.all(workers);
  if (inputs.length > 0 && firstError && results.every((r) => r === null)) throw firstError;
  return results;
}
