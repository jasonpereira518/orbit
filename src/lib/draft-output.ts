/**
 * The last step every email-shaped draft passes before a person sees (and may one-click
 * send) it: a schema check on the model's JSON, then `guardModelOutput` on each field.
 *
 * Outreach and recruiter drafts used to `JSON.parse` the answer and trust its shape (audit
 * M-11). Their prompts carry text other people wrote — a recruiter row shared across
 * accounts, the scan's summary of an inbox, a prior draft — so the answer is treated like
 * any other model output that crossed untrusted data:
 *   - the shape is `{subject, body}` with string fields, or the draft fails;
 *   - secret-shaped strings are redacted and fence markers removed;
 *   - an answer that quotes the system prompt is refused outright rather than turned into
 *     an email whose body is the refusal sentence.
 *
 * Pure apart from the fire-and-forget audit event.
 */
import { z } from "zod";
import { guardModelOutput, recordAiSecurityEvent, type OutputFinding } from "@/lib/ai-security";

const DraftShape = z.object({
  subject: z.string().nullish(),
  body: z.string(),
});

export class DraftOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftOutputError";
  }
}

export type GuardedDraft = { subject: string | null; body: string; findings: OutputFinding[] };

export function guardDraftOutput(
  parsed: unknown,
  opts: { userId: string; surface: string; system?: string }
): GuardedDraft {
  const shape = DraftShape.safeParse(parsed);
  if (!shape.success) throw new DraftOutputError("The model returned a malformed draft");

  const subject = guardModelOutput(shape.data.subject ?? "", { system: opts.system });
  const body = guardModelOutput(shape.data.body, { system: opts.system });
  const findings = [...new Set([...subject.findings, ...body.findings])];
  if (findings.length) {
    void recordAiSecurityEvent({
      kind: "output_scrubbed",
      userId: opts.userId,
      surface: opts.surface,
      detail: { findings, secretKinds: [...subject.secretKinds, ...body.secretKinds] },
    });
  }
  if (findings.includes("system_prompt_echo")) {
    throw new DraftOutputError("The draft couldn’t be used — try again");
  }
  return { subject: subject.text.trim() || null, body: body.text, findings };
}
