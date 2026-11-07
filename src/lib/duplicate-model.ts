/**
 * Learning from the duplicates page.
 *
 * Every merge and every "not the same person" a human decides becomes one labelled example in
 * `duplicate_decisions`: a vector of NUMBERS describing how the two records compared (same
 * company, different school, 3 shared events, ...), never the records themselves. A small
 * logistic regression is fitted to those examples, pooled across accounts, and used to order
 * the review queue and to explain a pair in words. It never merges or dismisses anything.
 *
 * Why numbers only: the model is trained on every account's decisions together, so an example
 * must carry no name, email, employer or note text. `DuplicateSignals` is the whole schema.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { duplicateDecisions, duplicateModel } from "@/db/schema";
import { nameSimilarity, linkedinSlug } from "@/lib/duplicates";

/** What the comparison reads off one contact. Every field is something the page already loads. */
export type SignalSide = {
  fullName: string;
  email: string | null;
  company: string | null;
  title: string | null;
  school: string | null;
  location: string | null;
  source: string | null;
  linkedinUrl: string | null;
  interactionCount: number;
  createdAt: Date | null;
  tags: string[];
  eventIds: string[];
};

/** Fixed order: the model's weight vector is keyed by these names. */
export const SIGNAL_KEYS = [
  "nameExact",
  "nameSimilarity",
  "sameCompany",
  "sameTitle",
  "sameSchool",
  "sameLocation",
  "sameSource",
  "emailDomain",
  "linkedin",
  "interactionsMin",
  "interactionsMax",
  "createdGap",
  "sharedTags",
  "sharedEvents",
  "engineScore",
] as const;

export type SignalKey = (typeof SIGNAL_KEYS)[number];
export type DuplicateSignals = Record<SignalKey, number>;

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** 1 = both known and equal, -1 = both known and different, 0 = one or both unknown. */
function tri(a: string | null, b: string | null): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  return x === y ? 1 : -1;
}

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
]);

function domainOf(email: string | null): string {
  const at = (email ?? "").lastIndexOf("@");
  return at < 0 ? "" : email!.slice(at + 1).toLowerCase().trim();
}

/** A shared work domain is evidence; a shared gmail.com is not. */
function emailDomainSignal(a: string | null, b: string | null): number {
  const x = domainOf(a);
  const y = domainOf(b);
  if (!x || !y || FREE_MAIL.has(x) || FREE_MAIL.has(y)) return 0;
  return x === y ? 1 : -1;
}

const bucketCount = (n: number) => (n <= 0 ? 0 : n <= 2 ? 1 : n <= 9 ? 2 : 3);

function createdGap(a: Date | null, b: Date | null): number {
  if (!a || !b) return 0;
  const days = Math.abs(a.getTime() - b.getTime()) / 86_400_000;
  return days < 1 ? 1 : days < 30 ? 2 : days < 365 ? 3 : 4;
}

function overlap(a: string[], b: string[]): number {
  const set = new Set(a);
  return Math.min(3, b.filter((x) => set.has(x)).length);
}

/** How two records compare, as numbers. The only thing a training example stores. */
export function compareSignals(a: SignalSide, b: SignalSide, engineScore: number): DuplicateSignals {
  const slugA = linkedinSlug(a.linkedinUrl);
  const slugB = linkedinSlug(b.linkedinUrl);
  const counts = [a.interactionCount, b.interactionCount];
  return {
    nameExact: norm(a.fullName) === norm(b.fullName) ? 1 : 0,
    nameSimilarity: Math.round(nameSimilarity(a.fullName, b.fullName) * 100) / 100,
    sameCompany: tri(a.company, b.company),
    sameTitle: tri(a.title, b.title),
    sameSchool: tri(a.school, b.school),
    sameLocation: tri(a.location, b.location),
    sameSource: tri(a.source, b.source),
    emailDomain: emailDomainSignal(a.email, b.email),
    linkedin: slugA && slugB ? (slugA === slugB ? 1 : -1) : 0,
    interactionsMin: bucketCount(Math.min(...counts)),
    interactionsMax: bucketCount(Math.max(...counts)),
    createdGap: createdGap(a.createdAt, b.createdAt),
    sharedTags: overlap(a.tags, b.tags),
    sharedEvents: overlap(a.eventIds, b.eventIds),
    engineScore: Math.round(engineScore * 100) / 100,
  };
}

export type SignalNote = { kind: "match" | "differ"; text: string };

/** The signals in words, for the strip above a pair. Strongest evidence first. */
export function describeSignals(s: DuplicateSignals): SignalNote[] {
  const out: SignalNote[] = [];
  const add = (kind: SignalNote["kind"], text: string) => out.push({ kind, text });
  if (s.linkedin === 1) add("match", "Same LinkedIn profile");
  if (s.linkedin === -1) add("differ", "Different LinkedIn profiles");
  if (s.emailDomain === 1) add("match", "Same work email domain");
  if (s.emailDomain === -1) add("differ", "Different work email domains");
  if (s.sameCompany === 1) add("match", "Same company");
  if (s.sameCompany === -1) add("differ", "Different companies");
  if (s.sameTitle === 1) add("match", "Same title");
  if (s.sameTitle === -1) add("differ", "Different titles");
  if (s.sameSchool === 1) add("match", "Same school");
  if (s.sameSchool === -1) add("differ", "Different schools");
  if (s.sameLocation === 1) add("match", "Same location");
  if (s.sameLocation === -1) add("differ", "Different locations");
  if (s.sharedEvents > 0) add("match", `${s.sharedEvents === 3 ? "3+" : s.sharedEvents} shared event${s.sharedEvents === 1 ? "" : "s"}`);
  if (s.sharedTags > 0) add("match", `${s.sharedTags === 3 ? "3+" : s.sharedTags} shared tag${s.sharedTags === 1 ? "" : "s"}`);
  if (s.createdGap === 1) add("match", "Added within a day of each other");
  if (s.createdGap === 4) add("differ", "Added over a year apart");
  if (s.sameSource === -1) add("differ", "Came from different sources");
  return out;
}

// ---------------------------------------------------------------------------------------------
// The model

export type DuplicateModelState = {
  weights: Record<string, number>;
  bias: number;
  sampleCount: number;
  accuracy: number | null;
  baselineAccuracy: number | null;
  active: boolean;
};

/** Examples needed (and per class) before a model is even fitted. */
export const MIN_EXAMPLES = 50;
export const MIN_PER_CLASS = 10;
/** Margin over "always guess the commoner answer" a model must clear to be switched on. */
const REQUIRED_EDGE = 0.02;
const MAX_TRAIN_ROWS = 5000;

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const vec = (f: Record<string, number>) => SIGNAL_KEYS.map((k) => Number(f[k]) || 0);

/** P(same person) under a fitted model. */
export function scoreWithModel(model: Pick<DuplicateModelState, "weights" | "bias">, f: Record<string, number>): number {
  const x = vec(f);
  let z = model.bias;
  SIGNAL_KEYS.forEach((k, i) => {
    z += (model.weights[k] ?? 0) * x[i];
  });
  return sigmoid(z);
}

type Example = { f: Record<string, number>; y: 0 | 1 };

/**
 * Fit by batch gradient descent with L2 regularisation. Pure, deterministic, dependency-free:
 * at the 5,000-example cap this is a few tens of milliseconds.
 */
export function fitLogistic(examples: Example[], epochs = 300, rate = 0.3, l2 = 0.01) {
  const n = examples.length;
  const w = new Array(SIGNAL_KEYS.length).fill(0);
  let b = 0;
  const xs = examples.map((e) => vec(e.f));
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gw = new Array(w.length).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < w.length; j++) z += w[j] * xs[i][j];
      const err = sigmoid(z) - examples[i].y;
      for (let j = 0; j < w.length; j++) gw[j] += err * xs[i][j];
      gb += err;
    }
    for (let j = 0; j < w.length; j++) w[j] -= rate * (gw[j] / n + l2 * w[j]);
    b -= rate * (gb / n);
  }
  return {
    weights: Object.fromEntries(SIGNAL_KEYS.map((k, j) => [k, Math.round(w[j] * 1e4) / 1e4])),
    bias: Math.round(b * 1e4) / 1e4,
  };
}

/**
 * Fit and judge a model on labelled examples. Every fifth example is held out; the model is
 * `active` only if it beats guessing the commoner label on those, so a handful of lopsided
 * decisions cannot reorder anyone's queue.
 */
export function trainFromExamples(examples: Example[]): DuplicateModelState | null {
  const yes = examples.filter((e) => e.y === 1).length;
  if (examples.length < MIN_EXAMPLES || yes < MIN_PER_CLASS || examples.length - yes < MIN_PER_CLASS) {
    return null;
  }
  const train = examples.filter((_, i) => i % 5 !== 0);
  const hold = examples.filter((_, i) => i % 5 === 0);
  const fit = fitLogistic(train);
  const correct = hold.filter((e) => (scoreWithModel(fit, e.f) >= 0.5 ? 1 : 0) === e.y).length;
  const accuracy = hold.length ? correct / hold.length : 0;
  const holdYes = hold.filter((e) => e.y === 1).length;
  const baseline = hold.length ? Math.max(holdYes, hold.length - holdYes) / hold.length : 0;
  // Ship the weights fitted to everything; the held-out score is the evidence for them.
  const final = fitLogistic(examples);
  return {
    ...final,
    sampleCount: examples.length,
    accuracy,
    baselineAccuracy: baseline,
    active: accuracy >= baseline + REQUIRED_EDGE,
  };
}

// ---------------------------------------------------------------------------------------------
// Persistence

export type DecisionSource = (typeof duplicateDecisions.$inferInsert)["source"];

/** Keep one example. A logging failure must never fail a merge, so this swallows errors. */
export async function recordDuplicateDecision(
  userId: string,
  d: {
    label: "same" | "different";
    source: DecisionSource;
    signals: DuplicateSignals;
    modelProbability?: number | null;
    refId?: string | null;
  }
): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(duplicateDecisions).values({
      userId,
      label: d.label,
      source: d.source,
      engineScore: d.signals.engineScore,
      modelProbability: d.modelProbability ?? null,
      features: d.signals,
      refId: d.refId ?? null,
    });
  } catch (err) {
    console.error("[duplicate-model] could not record a decision", err);
  }
}

/** A merge was undone: that example was wrong. Flip it rather than leave two that disagree. */
export async function flipDecisionToDifferent(userId: string, refId: string): Promise<void> {
  try {
    const db = await getDb();
    await db
      .update(duplicateDecisions)
      .set({ label: "different", source: "undo_merge" })
      .where(and(eq(duplicateDecisions.userId, userId), eq(duplicateDecisions.refId, refId)));
  } catch (err) {
    console.error("[duplicate-model] could not flip a decision", err);
  }
}

/** A dismissal was reversed: the person wasn't sure after all, so the example is withdrawn. */
export async function retractDecision(userId: string, refId: string): Promise<void> {
  try {
    const db = await getDb();
    await db
      .delete(duplicateDecisions)
      .where(and(eq(duplicateDecisions.userId, userId), eq(duplicateDecisions.refId, refId)));
  } catch (err) {
    console.error("[duplicate-model] could not retract a decision", err);
  }
}

/** Fit to every pooled example and store the result (`id = 1`). */
export async function trainDuplicateModel(): Promise<DuplicateModelState | null> {
  const db = await getDb();
  const rows = await db
    .select({ label: duplicateDecisions.label, features: duplicateDecisions.features })
    .from(duplicateDecisions)
    .orderBy(desc(duplicateDecisions.decidedAt))
    .limit(MAX_TRAIN_ROWS);
  const model = trainFromExamples(
    rows.map((r) => ({ f: r.features, y: r.label === "same" ? 1 : 0 }))
  );
  if (!model) return null;
  const values = {
    weights: model.weights,
    bias: model.bias,
    sampleCount: model.sampleCount,
    accuracy: model.accuracy,
    baselineAccuracy: model.baselineAccuracy,
    active: model.active,
    trainedAt: new Date(),
  };
  await db
    .insert(duplicateModel)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: duplicateModel.id, set: values });
  return model;
}

const RETRAIN_AFTER_MS = 10 * 60_000;
let memo: { at: number; model: DuplicateModelState | null } | null = null;

/**
 * The active model, retrained first when examples have grown by a fifth since the last fit.
 * Cheap on the common path: one row read and one `count(*)` at most every ten minutes per
 * instance. Never throws: with no model the page orders pairs exactly as it did before.
 */
export async function activeDuplicateModel(): Promise<DuplicateModelState | null> {
  if (memo && Date.now() - memo.at < RETRAIN_AFTER_MS) return memo.model;
  try {
    const db = await getDb();
    const [row] = await db.select().from(duplicateModel).where(eq(duplicateModel.id, 1)).limit(1);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(duplicateDecisions);
    let model: DuplicateModelState | null = row
      ? {
          weights: row.weights,
          bias: row.bias,
          sampleCount: row.sampleCount,
          accuracy: row.accuracy,
          baselineAccuracy: row.baselineAccuracy,
          active: row.active,
        }
      : null;
    const grown = !model || Number(n) >= model.sampleCount * 1.2;
    if (grown && Number(n) >= MIN_EXAMPLES) model = (await trainDuplicateModel()) ?? model;
    const active = model?.active ? model : null;
    memo = { at: Date.now(), model: active };
    return active;
  } catch (err) {
    console.error("[duplicate-model] could not load the model", err);
    return null;
  }
}

/** For tests: forget the instance memo so the next call reads the database. */
export function forgetDuplicateModel() {
  memo = null;
}
