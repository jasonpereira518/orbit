import { completeJson } from "@/lib/ai";
import type { OutreachChannel } from "@/lib/outreach-types";

export type DraftInput = {
  channel: OutreachChannel;
  tone: string;
  messageIntent: string;
  userGoals: string[];
  prospect: {
    fullName: string;
    title: string | null;
    company: string | null;
    location: string | null;
  };
  templateSeed?: string;
};

export type GeneratedDraft = {
  subject: string | null;
  body: string;
};

function channelRules(channel: OutreachChannel) {
  if (channel === "email") {
    return "Write a cold email under 150 words with a clear subject line and one specific CTA.";
  }
  if (channel === "linkedin") {
    return "Write a short LinkedIn connection note or InMail under 300 characters. No subject line.";
  }
  return "Write a conversational SMS under 160 characters. No subject line.";
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
  ].join("\n");

  const content = await completeJson(userId, {
    temperature: 0.5,
    system: `You write personalized cold outreach messages.
Tone: ${input.tone}
Intent: ${input.messageIntent}
${channelRules(input.channel)}
Avoid spammy language, fake familiarity, and exaggerated claims.
Return JSON: { "subject": string|null, "body": string }`,
    user: `${goalsBlock}

Prospect:
${prospectBlock}

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
      results[current] = await generateOutreachDraft(userId, inputs[current]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
