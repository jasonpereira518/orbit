/**
 * The narration behind a chat answer: which stage is running, what it touched, how long it
 * took — and, once the answer lands, what to ask next.
 *
 * Two rules keep this honest, and both are the whole point of the feature:
 *
 *   1. **A step is only emitted for work that actually ran.** The conditional stages (org
 *      rosters, the attention brief, recruiters, the hallucination filter) emit nothing when
 *      their branch is skipped, rather than reporting a step that did no work. Counts and
 *      names come from real results, never from an estimate or a timer.
 *   2. **Completions arrive out of order,** because retrieval, rosters, attention and
 *      recruiters all run inside one `Promise.all`. So this is a keyed map, not a stack: a
 *      `done` finds its own step by id (its kind, unless the kind runs more than once) and
 *      never pops someone else's.
 *
 * Labels are written here rather than in the browser so the wire carries finished sentences
 * — the client renders what the server says happened, and cannot invent a stage.
 */

import type { ChatStep, ChatStepKind, ChatStepRef } from "@/lib/chat-stream-protocol";
import type { ParsedQuery } from "@/lib/chat-retrieval";
import { sanitizeProfileLine } from "@/lib/contact-profile-format";

export type StepPatch = {
  label?: string;
  detail?: string;
  refs?: ChatStepRef[];
  /**
   * Which step of this kind, when a kind runs more than once — each research lookup is its
   * own `gather:N` step, so the trail keeps every one instead of relabelling one line.
   * Defaults to the kind itself, the one-step-per-kind case every other stage is.
   */
  id?: string;
};

export type StepEmitter = {
  /** Announce a stage as running. Safe to call for a stage that may later be abandoned. */
  start: (kind: ChatStepKind, label: string, detail?: string, id?: string) => void;
  /** Mark a stage finished, filling in its real duration and whatever it found. */
  done: (kind: ChatStepKind, patch?: StepPatch) => void;
  /**
   * Re-send a stage with extra detail, leaving its status and duration exactly as they were.
   *
   * For facts that arrive after the stage itself finished — a contact's photo, looked up off
   * the critical path. Deliberately not `done`: calling that again would re-stamp `ms` with
   * the time since `start`, quietly inflating the duration the user is shown.
   */
  update: (kind: ChatStepKind, patch: StepPatch) => void;
  /** Every step seen so far, in the order it started — what gets persisted with the turn. */
  snapshot: () => ChatStep[];
};

/** A no-op emitter, so non-streaming callers can share one code path. */
export const NULL_STEPS: StepEmitter = {
  start: () => {},
  done: () => {},
  update: () => {},
  snapshot: () => [],
};

export function createStepEmitter(onStep: (step: ChatStep) => void): StepEmitter {
  const steps = new Map<string, ChatStep>();
  const startedAt = new Map<string, number>();
  const order: string[] = [];
  // Steps run in parallel, so their durations cannot be summed into "how long this took".
  // Each records when it began, relative to this, and the answer's real elapsed time is the
  // latest `at + ms`.
  const origin = Date.now();

  return {
    start(kind, label, detail, id = kind) {
      if (!steps.has(id)) order.push(id);
      const now = Date.now();
      startedAt.set(id, now);
      const step: ChatStep = { id, kind, label, detail, status: "active", at: now - origin };
      steps.set(id, step);
      onStep(step);
    },
    done(kind, patch) {
      const id = patch?.id ?? kind;
      const began = startedAt.get(id);
      const prior = steps.get(id);
      // A `done` without a `start` still reports, rather than being dropped silently —
      // better a step with no duration than a stage the user never hears about.
      if (!prior && !order.includes(id)) order.push(id);
      const step: ChatStep = {
        id,
        kind,
        label: patch?.label ?? prior?.label ?? kind,
        detail: patch?.detail ?? prior?.detail,
        status: "done",
        at: prior?.at,
        ms: began === undefined ? undefined : Date.now() - began,
        refs: patch?.refs ?? prior?.refs,
      };
      steps.set(id, step);
      onStep(step);
    },
    update(kind, patch) {
      const prior = steps.get(patch.id ?? kind);
      // Nothing to add to a stage that never reported: better silent than a step with no
      // status. The late arrival can only enrich a stage the user has already been told about.
      if (!prior) return;
      const step: ChatStep = {
        ...prior,
        label: patch.label ?? prior.label,
        detail: patch.detail ?? prior.detail,
        refs: patch.refs ?? prior.refs,
      };
      steps.set(prior.id, step);
      // Fire-and-forget callers reach this after the stream may have closed (the client
      // left, or the answer already landed); a throw here would be an unhandled rejection
      // for something the user cannot see and does not need.
      try {
        onStep(step);
      } catch {
        // The stream is gone; the enrichment has nowhere to go.
      }
    },
    snapshot() {
      return order.flatMap((id) => {
        const step = steps.get(id);
        return step ? [step] : [];
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Label helpers                                                               */
/* -------------------------------------------------------------------------- */

/** "1 contact" / "412 contacts" — counts are always real, so they are always shown. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * A count that may have hit the limit it was fetched with: "60+ possible matches" rather than
 * "60", which would read as the size of the answer when it is only the size of the page.
 */
export function countFound(n: number, cap: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()}${n >= cap ? "+" : ""} ${n === 1 ? one : many}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** "Stripe", "Stripe or Plaid", "Stripe, Plaid or Ramp" — values cleaned for one line. */
function either(values: readonly string[]): string {
  const clean = values.map((v) => sanitizeProfileLine(v)).filter(Boolean);
  if (clean.length <= 1) return clean.join("");
  return `${clean.slice(0, -1).join(", ")} or ${clean[clean.length - 1]}`;
}

const TIER_WORDS: Record<string, string> = {
  inner: "inner circle",
  mid: "middle ring",
  outer: "outer ring",
};

/**
 * The question as the parser read it, so the steps can talk about what was asked rather than
 * about "your network" in general.
 *
 * `interpreted` is false when the parser added nothing — no key, a question too short to
 * parse, a timeout. Its fallback is exactly the question with no filters, so that is what is
 * checked; the steps then say the words were used as written instead of claiming a reading.
 */
export function describeQuestion(
  parsed: Pick<ParsedQuery, "semanticQuery" | "filters" | "expansionTerms">,
  question: string
): { subject: string; interpreted: boolean; detail?: string } {
  const f = parsed.filters ?? {};
  const filters: string[] = [];
  if (f.companies?.length) filters.push(`at ${either(f.companies)}`);
  if (f.industries?.length) filters.push(`in ${either(f.industries)}`);
  if (f.schools?.length) filters.push(`from ${either(f.schools)}`);
  if (f.locations?.length) filters.push(`in ${either(f.locations)}`);
  if (f.tags?.length) filters.push(`tagged ${either(f.tags)}`);
  if (f.closenessTiers?.length) {
    filters.push(`in your ${either(f.closenessTiers.map((t) => TIER_WORDS[t] ?? t))}`);
  }
  const expansions = parsed.expansionTerms ?? [];
  const rewritten = parsed.semanticQuery.trim() !== question.trim();
  const interpreted = rewritten || filters.length > 0 || expansions.length > 0;

  const subject =
    rewritten || filters.length === 0
      ? `“${clip(sanitizeProfileLine(parsed.semanticQuery), 60)}”`
      : clip(`people ${filters.join(" ")}`, 80);
  const detail = [...filters, ...(expansions.length ? [`also matching ${either(expansions.slice(0, 4))}`] : [])];
  return { subject, interpreted, ...(detail.length ? { detail: detail.join(" · ") } : {}) };
}

/** The arms that actually matched something, named the way a person would say them. */
const ARM_LABELS: Record<string, string> = {
  fts: "name and notes",
  trigram: "fuzzy name",
  semantic: "meaning",
  experience: "past employers",
};

export function describeArms(arms: Iterable<string>): string | undefined {
  const seen = new Set<string>();
  for (const arm of arms) {
    const label = ARM_LABELS[arm];
    if (label) seen.add(label);
  }
  if (seen.size === 0) return undefined;
  return Array.from(seen).join(", ");
}

/** Trim a ref list to something a person will actually read. */
export function toRefs(
  items: Array<{ id: string; name: string }>,
  kind: ChatStepRef["kind"],
  limit = 8
): ChatStepRef[] | undefined {
  if (items.length === 0) return undefined;
  return items.slice(0, limit).map((item) => ({ id: item.id, name: item.name, kind }));
}

/* -------------------------------------------------------------------------- */
/* Follow-ups                                                                  */
/* -------------------------------------------------------------------------- */

export type FollowUpSource = {
  question: string;
  topRosterCompany?: string | null;
  firstOverdueName?: string | null;
  topContactName?: string | null;
};

/**
 * The next questions worth asking, derived from what retrieval already found.
 *
 * Deliberately rule-based rather than model-generated: these cost no tokens, add no latency,
 * and can only name a company or person the retrieval pass actually returned — so a
 * follow-up can never invite the user to ask about someone who is not in their network.
 */
export function deriveFollowUps(source: FollowUpSource, limit = 3): string[] {
  const asked = source.question.trim().toLowerCase();
  const out: string[] = [];

  const add = (candidate: string) => {
    const normalised = candidate.trim();
    if (!normalised) return;
    if (normalised.toLowerCase() === asked) return;
    if (out.some((existing) => existing.toLowerCase() === normalised.toLowerCase())) return;
    out.push(normalised);
  };

  if (source.topRosterCompany) add(`Who else do I know at ${source.topRosterCompany}?`);
  if (source.firstOverdueName) add(`Draft a note to ${source.firstOverdueName}`);
  if (source.topContactName) add(`Tell me more about ${source.topContactName}`);

  return out.slice(0, limit);
}
