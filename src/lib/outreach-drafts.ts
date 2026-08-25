import { completeJson } from "@/lib/ai";
import type { OutreachChannel } from "@/lib/outreach-types";

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

export async function generateOutreachDraft(
  userId: string,
  input: DraftInput
): Promise<GeneratedDraft> {
  const goalsBlock =
    input.userGoals.length > 0
      ? `Sender background (secondary context only — do not invent a product pitch from these): ${input.userGoals.join("; ")}`
      : "Sender background: (not specified)";

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

  const audienceBlock = input.audienceQuery?.trim()
    ? `Audience / ICP: ${input.audienceQuery.trim()}`
    : "";

  const content = await completeJson(userId, {
    operation: "outreach.draft",
    temperature: 0.55,
    system: `You write personalized outreach optimized for a successful reply.
Primary campaign intent (must drive the message): ${input.messageIntent}
${audienceBlock}
${replyCtaGuidance(input.replyCta)}
${channelRules(input.channel)}
Tone: ${input.tone}

Critical rules:
- Write as the sender pursuing the campaign intent above.
- Do NOT invent a SaaS/product pitch unless the campaign intent explicitly is selling a product.
- If the audience is recruiters / internships / jobs, ask about the hiring process, the right recruiter, internship timeline, or a referral into that process — not engineering tooling or onboarding software.
- Prefer campaign intent over sender background when they conflict.
- Include one specific "why this person" detail when role/company context exists.
- Prefer specificity over length. Avoid spammy language, fake familiarity, and exaggerated claims.
- Never leave placeholders like [My Name] or [Your Name].
- Do not use identical phrasing across people — vary openers and hooks.
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
    subject: scrubPlaceholders(parsed.subject?.trim() || "") || null,
    body: scrubPlaceholders(parsed.body?.trim() || ""),
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
