import { completeJson } from "@/lib/ai";
import type { OutreachChannel } from "@/lib/outreach-types";

export type DraftInput = {
  channel: OutreachChannel;
  tone: string;
  messageIntent: string;
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
  previousBody?: string | null;
  variationHint?: string;
};

export type GeneratedDraft = {
  subject: string | null;
  body: string;
};

function channelRules(channel: OutreachChannel) {
  if (channel === "email") {
    return "Write a cold email under 120 words with a clear subject line and exactly one reply-seeking CTA (a question or soft ask).";
  }
  if (channel === "linkedin") {
    return "Write a short LinkedIn connection note or InMail under 280 characters with one clear reply ask. No subject line.";
  }
  return "Write a conversational SMS under 160 characters with one clear reply ask. No subject line.";
}

function replyCtaGuidance(replyCta?: string | null) {
  switch (replyCta) {
    case "book_intro":
      return "Desired reply: agreement to a short intro call or suggested times.";
    case "ask_referral":
      return "Desired reply: a warm referral or intro to the right person.";
    case "get_feedback":
      return "Desired reply: candid feedback on a specific idea or question.";
    case "explore_partnership":
      return "Desired reply: interest in exploring a partnership next step.";
    default:
      return "Desired reply: an engaged, specific response to the ask.";
  }
}

export async function generateOutreachDraft(
  userId: string,
  input: DraftInput
): Promise<GeneratedDraft> {
  const goalsBlock =
    input.userGoals.length > 0
      ? `Sender goals: ${input.userGoals.join("; ")}`
      : "Sender goals: (not specified)";

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
  const stepBlock =
    step > 0
      ? `This is follow-up #${step}. Reference the prior note lightly; do not repeat it. Prior message:\n${input.previousBody || "(none)"}`
      : "This is the first touch.";

  const content = await completeJson(userId, {
    temperature: 0.55,
    system: `You write personalized cold outreach optimized for a successful reply.
Tone: ${input.tone}
Intent: ${input.messageIntent}
${replyCtaGuidance(input.replyCta)}
${channelRules(input.channel)}
Include one specific "why this person" detail when enrichment or role/company context exists.
Prefer specificity over length. Avoid spammy language, fake familiarity, and exaggerated claims.
Do not use identical phrasing across people — vary openers and hooks.
Return JSON: { "subject": string|null, "body": string }`,
    user: `${goalsBlock}

Prospect:
${prospectBlock}

${stepBlock}

${input.variationHint ? `Variation hint: ${input.variationHint}` : ""}

${input.templateSeed ? `Template seed:\n${input.templateSeed}` : ""}`,
  });

  const parsed = JSON.parse(content) as GeneratedDraft;
  return {
    subject: parsed.subject?.trim() || null,
    body: parsed.body?.trim() || "",
  };
}

export async function generateOutreachDraftsBatch(
  userId: string,
  inputs: DraftInput[],
  concurrency = 5
): Promise<GeneratedDraft[]> {
  const results: GeneratedDraft[] = new Array(inputs.length);
  let index = 0;

  async function worker() {
    while (index < inputs.length) {
      const current = index++;
      const input = {
        ...inputs[current],
        variationHint:
          inputs[current].variationHint ||
          `Variant ${current + 1} of ${inputs.length}`,
      };
      results[current] = await generateOutreachDraft(userId, input);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
