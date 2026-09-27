import { looksLikeRecruiter, parseFromHeader } from "@/lib/recruiter-detect";
import { askPerItem, mapPool, type Decider } from "@/lib/decisions/jev";
import {
  RECRUITER_TUNING,
  recruiterGateQuestions,
  recruiterPrefilterQuestion,
} from "@/lib/decisions/catalog";

/**
 * The recruiter scan's two decisions, shared by the Gmail and Outlook runners so the two
 * mailboxes cannot drift into judging senders differently.
 *
 *  1. PREFILTER (discovery): which senders become candidates at all. The keyword test
 *     (`looksLikeRecruiter`) misses most real recruiters on snippet-length text — 11 of the
 *     18 in `scripts/eval-fixtures/ai-recruiter-eval.json`, every hiring manager among them —
 *     and a sender it drops is never looked at again. Jev wins those back.
 *  2. GATE (classification): which candidates need the LLM. A sender Jev is confident is not
 *     a recruiter skips the call; the LLM still writes the summary for everyone else.
 *
 * Both are no-ops without a decider, and a missing answer always resolves to what the scan
 * did before Jev: not admitted by the prefilter, not ruled out by the gate.
 */

/** The fields both mail providers normalize a header line into. */
export type RecruiterHeaderLine = { id: string; from: string; subject: string; snippet: string };

/**
 * The ids of the header lines on this page that become recruiter candidates.
 *
 * A keyword yes always stands. With a decider, each sender the keywords said no to is asked
 * about once — on the first line seen from them this page — and a yes admits every line from
 * that sender. Senders who are already candidates are not asked again: their lines are
 * handled exactly as before.
 */
export async function admitRecruiterCandidates<H extends RecruiterHeaderLine>(
  headers: readonly H[],
  decider: Decider | null,
  opts: { alreadyCandidate: (email: string) => boolean },
): Promise<Set<string>> {
  const admitted = new Set<string>();
  const toAsk = new Map<string, H>();
  for (const line of headers) {
    if (looksLikeRecruiter(line)) {
      admitted.add(line.id);
      continue;
    }
    if (!decider) continue;
    const sender = parseFromHeader(line.from);
    if (!sender || opts.alreadyCandidate(sender.email) || toAsk.has(sender.email)) continue;
    toAsk.set(sender.email, line);
  }
  if (!decider || toAsk.size === 0) return admitted;

  const asked = [...toAsk.entries()];
  const answers = await askPerItem(
    decider,
    {
      operation: "recruiter.prefilter",
      items: asked,
      chunkSize: RECRUITER_TUNING.prefilterChunkSize,
      concurrency: RECRUITER_TUNING.concurrency,
      state: (chunk) => ({
        messages: Object.fromEntries(
          chunk.map(({ key, item: [, line] }) => [key, { from: line.from, subject: line.subject, snippet: line.snippet }]),
        ),
      }),
      question: recruiterPrefilterQuestion,
    },
    { timeoutMs: RECRUITER_TUNING.timeoutMs },
  );

  const yes = new Set(
    asked
      .filter((_, i) => (answers[i]?.probability ?? 0) >= RECRUITER_TUNING.prefilterAdmit)
      .map(([email]) => email),
  );
  if (yes.size === 0) return admitted;
  for (const line of headers) {
    const sender = parseFromHeader(line.from);
    if (sender && yes.has(sender.email)) admitted.add(line.id);
  }
  return admitted;
}

/** What the gate reads — the same sender and messages the LLM classifier would. */
export type RecruiterGateInput = {
  senderName: string;
  senderEmail: string;
  firmGuess: string | null;
  messages: ReadonlyArray<{ subject: string; snippet: string; body?: string; internalDate: number | null }>;
};

/** The most recent messages only, as the LLM classifier reads them. */
const GATE_MESSAGES = 5;
/** Per message. The mail fetchers already cap a body near this. */
const GATE_MESSAGE_CHARS = 4000;

export function recruiterGateState(input: RecruiterGateInput) {
  return {
    sender: { name: input.senderName, email: input.senderEmail, firm_guessed_from_domain: input.firmGuess },
    messages: input.messages.slice(0, GATE_MESSAGES).map((m) => ({
      date: m.internalDate ? new Date(m.internalDate).toISOString().slice(0, 10) : null,
      subject: m.subject || "(none)",
      text: (m.body?.trim() || m.snippet || "(no body)").slice(0, GATE_MESSAGE_CHARS),
    })),
  };
}

/**
 * True only when Jev is confident this sender is NOT a recruiter, so the LLM call can be
 * skipped. False means "ask the LLM" — including every case where no answer came back.
 */
export async function rulesOutRecruiter(decider: Decider, input: RecruiterGateInput): Promise<boolean> {
  const result = await decider.ask(
    { operation: "recruiter.gate", state: recruiterGateState(input), questions: recruiterGateQuestions },
    { timeoutMs: RECRUITER_TUNING.timeoutMs, cacheDays: RECRUITER_TUNING.cacheDays },
  );
  return result !== null && result.answers.recruiter.probability <= RECRUITER_TUNING.gateReject;
}

/** `rulesOutRecruiter` for a batch of senders, a few calls at a time. */
export function ruleOutRecruiters(decider: Decider, inputs: readonly RecruiterGateInput[]): Promise<boolean[]> {
  return mapPool(inputs, RECRUITER_TUNING.concurrency, (input) => rulesOutRecruiter(decider, input));
}
