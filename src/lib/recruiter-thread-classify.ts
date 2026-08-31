import { z } from "zod";
import { completeJson, parseAiJson } from "@/lib/ai";
import type { GmailMessageContent } from "@/lib/gmail";
import { RECRUITER_STAGES, isRecruiterStage, type RecruiterStage } from "@/lib/recruiter-stages";

/**
 * Reads whole threads and says what hiring process, if any, they belong to.
 *
 * Replaces the per-sender classifier this feature started with. A hiring process routinely
 * spans a recruiter, a coordinator, and a hiring manager, so a sender-keyed answer could
 * never express "where am I with Stripe" — only "who is Sarah".
 *
 * Kept apart from the job runner so the prompt can be tuned without touching queueing,
 * chunking, or continuation logic; the two change for entirely different reasons.
 */

/** Most recent messages per thread. Enough to see the arc, few enough to stay cheap. */
const MAX_MESSAGES_PER_THREAD = 6;

/**
 * Threads per call. The system prompt dominates the input, so amortizing it across several
 * threads is most of the saving; going much wider starts to cost accuracy as the model tracks
 * more transcripts at once.
 */
export const THREADS_PER_CALL = 4;

/**
 * Below this a thread is dropped rather than written into tables that feed a shared pool.
 * The Gmail query and the triage scorer are both allowed to be loose; this is where precision
 * is restored.
 */
export const RECRUITER_THREAD_CONFIDENCE_FLOOR = 0.6;

/** At or above this a finding is applied without review — see the hybrid policy in the spec. */
export const AUTO_APPLY_CONFIDENCE = 0.85;

const strList = z
  .array(z.string())
  .nullish()
  .transform((v) => (v || []).map((s) => s.trim()).filter(Boolean).slice(0, 8));

const threadResultSchema = z.object({
  thread_id: z.string(),
  is_recruiting: z.boolean(),
  confidence: z.number().min(0).max(1).nullish(),
  direction: z.enum(["inbound", "outbound"]).nullish(),
  recruiter_name: z.string().nullish(),
  recruiter_firm: z.string().nullish(),
  hiring_company: z.string().nullish(),
  roles: strList,
  stage: z.string().nullish(),
  stage_evidence: z.string().nullish(),
  summary: z.string().nullish(),
  next_step: z.string().nullish(),
});

export const threadBatchSchema = z.object({
  results: z.array(threadResultSchema),
});

export type ThreadClassification = {
  threadId: string;
  isRecruiting: boolean;
  confidence: number;
  direction: "inbound" | "outbound" | null;
  recruiterName: string | null;
  recruiterFirm: string | null;
  hiringCompany: string | null;
  roles: string[];
  stage: RecruiterStage | null;
  stageEvidence: string | null;
  summary: string | null;
  nextStep: string | null;
};

export type ThreadForClassification = {
  threadId: string;
  subject: string;
  correspondentName: string;
  correspondentEmail: string;
  firmGuess: string | null;
  userEmail: string;
  messages: GmailMessageContent[];
};

function renderThread(thread: ThreadForClassification, index: number): string {
  const mine = thread.userEmail.toLowerCase();
  const lines = thread.messages
    .slice(-MAX_MESSAGES_PER_THREAD)
    .map((m) => {
      const when = m.internalDate
        ? new Date(m.internalDate).toISOString().slice(0, 10)
        : "unknown date";
      const who = m.from.toLowerCase().includes(mine) ? "YOU" : m.from;
      return [`[${when}] ${who}`, m.body?.trim() || m.snippet || "(no body)"].join("\n");
    })
    .join("\n\n");

  return [
    `=== THREAD ${index + 1} ===`,
    `thread_id: ${thread.threadId}`,
    `subject: ${thread.subject || "(none)"}`,
    `correspondent: ${thread.correspondentName} <${thread.correspondentEmail}>`,
    `firm guessed from the email domain: ${thread.firmGuess || "unknown"}`,
    "",
    lines,
  ].join("\n");
}

const SYSTEM = `You read email threads and identify hiring processes.

A recruiting thread is one where the user is a candidate: a recruiter or hiring manager reaching out, the user applying or following up, an interview being scheduled, an assessment sent, an offer made, or a rejection delivered.

NOT recruiting threads: newsletters and job digests, sales or vendor outreach, colleagues discussing work, networking chat with no specific opening, and event invitations with no application attached.

Rules:
- Judge only from the messages provided. Never invent a company, role, stage, or date.
- "hiring_company" is the company doing the hiring, never the recruiting agency — unless the agency is itself the employer. This is the key by which threads are grouped into one process, so prefer the plain company name ("Stripe", not "Stripe Inc. Talent Team").
- "recruiter_name"/"recruiter_firm" describe a PERSON the user could contact. Leave both null for automated mail sent by an applicant-tracking system.
- "stage" must be exactly one of: ${RECRUITER_STAGES.join(", ")}.
- "stage_evidence" is a short quote from the thread that justifies the stage. If you cannot quote one, lower your confidence.
- "direction" is "outbound" if the user started the thread, "inbound" otherwise.
- "summary" is 1-2 sentences in second person, saying where this stands. State outcomes plainly, including rejections and silence.
- "next_step" is what the user should do next, or null if nothing is pending.
- If unsure whether a thread is a hiring process, set is_recruiting false and confidence low.

Return JSON: {"results": [{"thread_id": string, "is_recruiting": boolean, "confidence": number 0..1, "direction": "inbound"|"outbound"|null, "recruiter_name": string|null, "recruiter_firm": string|null, "hiring_company": string|null, "roles": string[], "stage": string|null, "stage_evidence": string|null, "summary": string|null, "next_step": string|null}]}

Return exactly one result object per thread given, echoing its thread_id.`;

function toClassification(
  raw: z.infer<typeof threadResultSchema>
): ThreadClassification {
  const stage = raw.stage?.trim().toLowerCase() ?? "";
  return {
    threadId: raw.thread_id,
    isRecruiting: raw.is_recruiting,
    confidence: raw.confidence ?? (raw.is_recruiting ? 0.7 : 0),
    direction: raw.direction ?? null,
    recruiterName: raw.recruiter_name?.trim() || null,
    recruiterFirm: raw.recruiter_firm?.trim() || null,
    hiringCompany: raw.hiring_company?.trim() || null,
    roles: raw.roles,
    stage: isRecruiterStage(stage) ? stage : null,
    stageEvidence: raw.stage_evidence?.trim() || null,
    summary: raw.summary?.trim() || null,
    nextStep: raw.next_step?.trim() || null,
  };
}

/**
 * Classifies a batch of threads in one call.
 *
 * Returns a map keyed by thread id rather than an array: the model does not reliably return
 * results in the order given, and pairing positionally would attach one company's stage to
 * another company's process. Threads the model omits are simply absent, which the caller
 * retries singly rather than guessing at.
 */
export async function classifyThreadBatch(
  userId: string,
  threads: ThreadForClassification[]
): Promise<Map<string, ThreadClassification>> {
  const out = new Map<string, ThreadClassification>();
  if (threads.length === 0) return out;

  const content = await completeJson(userId, {
    operation: "recruiter.scan",
    // Extraction, not composition — and the summary is stored as fact.
    temperature: 0.2,
    maxOutputTokens: 400 * threads.length + 400,
    system: SYSTEM,
    user: threads.map(renderThread).join("\n\n"),
  });

  const parsed = threadBatchSchema.parse(parseAiJson(content));
  const requested = new Set(threads.map((t) => t.threadId));

  for (const row of parsed.results) {
    // Ignore ids the model invented; a hallucinated thread id must not become a row.
    if (!requested.has(row.thread_id)) continue;
    out.set(row.thread_id, toClassification(row));
  }
  return out;
}

/**
 * Classifies threads, batching where possible and falling back to single calls for any thread
 * a batch dropped. `onCall` counts calls actually issued so the scan can report its real cost
 * rather than an assumed one.
 */
export async function classifyThreads(
  userId: string,
  threads: ThreadForClassification[],
  opts: { onCall?: () => void } = {}
): Promise<Map<string, ThreadClassification>> {
  const out = new Map<string, ThreadClassification>();

  for (let i = 0; i < threads.length; i += THREADS_PER_CALL) {
    const batch = threads.slice(i, i + THREADS_PER_CALL);
    let batched = new Map<string, ThreadClassification>();
    try {
      opts.onCall?.();
      batched = await classifyThreadBatch(userId, batch);
    } catch {
      // A malformed batch response must not lose the whole group.
      batched = new Map();
    }
    for (const [id, result] of batched) out.set(id, result);

    const missing = batch.filter((t) => !out.has(t.threadId));
    // Only worth retrying singly when the batch mostly worked; a wholesale failure is usually
    // a provider or key problem that a retry would only bill for again.
    if (missing.length > 0 && missing.length < batch.length) {
      for (const thread of missing) {
        try {
          opts.onCall?.();
          const single = await classifyThreadBatch(userId, [thread]);
          for (const [id, result] of single) out.set(id, result);
        } catch {
          // Leave it out; the caller records the thread as unclassified.
        }
      }
    }
  }
  return out;
}
