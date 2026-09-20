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
 *      `done` finds its own step by kind and never pops someone else's.
 *
 * Labels are written here rather than in the browser so the wire carries finished sentences
 * — the client renders what the server says happened, and cannot invent a stage.
 */

import type { ChatStep, ChatStepKind, ChatStepRef } from "@/lib/chat-stream-protocol";

export type StepPatch = {
  label?: string;
  detail?: string;
  refs?: ChatStepRef[];
};

export type StepEmitter = {
  /** Announce a stage as running. Safe to call for a stage that may later be abandoned. */
  start: (kind: ChatStepKind, label: string, detail?: string) => void;
  /** Mark a stage finished, filling in its real duration and whatever it found. */
  done: (kind: ChatStepKind, patch?: StepPatch) => void;
  /** Every step seen so far, in the order it started — what gets persisted with the turn. */
  snapshot: () => ChatStep[];
};

/** A no-op emitter, so non-streaming callers can share one code path. */
export const NULL_STEPS: StepEmitter = {
  start: () => {},
  done: () => {},
  snapshot: () => [],
};

export function createStepEmitter(onStep: (step: ChatStep) => void): StepEmitter {
  const steps = new Map<ChatStepKind, ChatStep>();
  const startedAt = new Map<ChatStepKind, number>();
  const order: ChatStepKind[] = [];

  return {
    start(kind, label, detail) {
      if (!steps.has(kind)) order.push(kind);
      startedAt.set(kind, Date.now());
      const step: ChatStep = { id: kind, kind, label, detail, status: "active" };
      steps.set(kind, step);
      onStep(step);
    },
    done(kind, patch) {
      const began = startedAt.get(kind);
      const prior = steps.get(kind);
      // A `done` without a `start` still reports, rather than being dropped silently —
      // better a step with no duration than a stage the user never hears about.
      if (!prior && !order.includes(kind)) order.push(kind);
      const step: ChatStep = {
        id: kind,
        kind,
        label: patch?.label ?? prior?.label ?? kind,
        detail: patch?.detail ?? prior?.detail,
        status: "done",
        ms: began === undefined ? undefined : Date.now() - began,
        refs: patch?.refs ?? prior?.refs,
      };
      steps.set(kind, step);
      onStep(step);
    },
    snapshot() {
      return order.flatMap((kind) => {
        const step = steps.get(kind);
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
