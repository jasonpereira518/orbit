/**
 * The tasks `scripts/eval-ai.ts` runs. Each calls the PRODUCTION entry point a user's
 * action reaches — `runCaptureParse`, `classifyRecruiterSender`, `parseProfileFields`,
 * `transcribeImagePages`, `transcribeAudioWithAI`, the chat pipeline, the meeting digest —
 * so the eval measures the code that ships, prompts and post-processing included, not a
 * copy of a prompt.
 *
 * Every task returns metrics where each is either a rate in [0, 1] or a count; the gate's
 * rules (`scripts/eval-fixtures/ai-eval-thresholds.json`) say which direction is worse.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../src/db";
import { chatMessages, chatThreads, contactTags, contacts, interactions, memoryChunks, tags } from "../../src/db/schema";
import { runCaptureParse } from "../../src/lib/capture-parse";
import { classifyRecruiterSender, RECRUITER_CONFIDENCE_FLOOR } from "../../src/lib/recruiter-scan";
import { parseProfileFields } from "../../src/lib/extension/parse-profile";
import type { PageContext } from "../../src/lib/extension/contract";
import {
  chatWithNetwork,
  completeJson,
  parseAiJson,
  transcribeAudioWithAI,
  transcribeImagePages,
} from "../../src/lib/ai";
import { prepareChatContext } from "../../src/lib/chat-context";
import { maybeGather } from "../../src/lib/chat-gather";
import { runEmbeddingBackfill } from "../../src/lib/embedding-backfill";
import { loadPassageFixture, seedPassageNotes } from "./eval-passage-notes";
import { rebuildContactEmbeddingsBatch } from "../../src/lib/search";
import { analyzeMeetingTranscript } from "../../src/lib/meeting-digest";
import type {
  CaptureEvalFixture,
  ChatEvalFixture,
  DigestEvalFixture,
  ExtensionEvalFixture,
  OcrEvalFixture,
  RecruiterEvalFixture,
  ResearchEvalFixture,
  TranscribeEvalFixture,
} from "./eval-ai-fixtures";
import {
  characterErrorRate,
  count,
  mean,
  mentions,
  rate,
  sameField,
  scoreResearchAnswer,
  sameName,
  tally,
  wordErrorRate,
  type TaskMetrics,
} from "./eval-ai-score";

export type TaskResult = {
  metrics: TaskMetrics;
  cases: number;
  /** Case ids that failed outright (threw) or missed something the gate cares about. */
  misses: string[];
  latenciesMs: number[];
};

export type TaskName = "capture" | "recruiter" | "extension" | "ocr" | "transcribe" | "chat" | "research" | "digest";

export const TASK_NAMES: TaskName[] = ["capture", "recruiter", "extension", "ocr", "transcribe", "chat", "research", "digest"];

/** Overridable so the harness itself can be exercised on throwaway fixtures. */
export const FIXTURE_DIR = process.env.ORBIT_EVAL_FIXTURE_DIR || join(process.cwd(), "scripts", "eval-fixtures");

function fixture<T>(file: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as T;
}

async function timed<T>(latencies: number[], run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await run();
  } finally {
    latencies.push(Date.now() - started);
  }
}

type RunOpts = { userId: string; limit?: number; log: (line: string) => void };

/* ------------------------------------------------------------------------ capture ----- */

export async function runCaptureTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<CaptureEvalFixture>("ai-capture-eval.json").cases.slice(0, limit);
  const people = tally();
  const precision = tally();
  const fields = tally();
  const opportunities = tally();
  const referrals = tally();
  const reminders = tally();
  let phantomParticipants = 0;
  let forbiddenHits = 0;
  const misses: string[] = [];
  const latenciesMs: number[] = [];

  for (const c of cases) {
    try {
      const result = await timed(latenciesMs, () =>
        runCaptureParse(userId, c.notes, c.hints ?? null, {
          // Noon local, so a relative phrase can never slip a day on a timezone edge.
          now: new Date(`${c.today}T12:00:00`),
          goals: [],
        })
      );
      const cards = result.items.map((i) => i.parsed);
      let missed = false;

      for (const want of c.expect.people) {
        const idx = result.items.findIndex((i) => sameName(want.name, i.parsed.name));
        count(people, idx >= 0);
        if (idx < 0) {
          missed = true;
          continue;
        }
        const item = result.items[idx];
        for (const key of ["company", "role", "email"] as const) {
          const expected = want[key];
          if (expected) count(fields, sameField(expected, item.parsed[key]));
        }
        for (const kind of want.opportunityKinds ?? []) {
          const found = item.opportunities.some((o) => o.kind === kind);
          count(opportunities, found);
          if (kind === "referral") count(referrals, found);
          if (!found) missed = true;
        }
      }
      for (const card of cards) {
        count(precision, c.expect.people.some((p) => sameName(p.name, card.name)));
      }
      for (const name of c.expect.notParticipants ?? []) {
        if (cards.some((card) => sameName(name, card.name))) {
          phantomParticipants += 1;
          missed = true;
        }
      }
      for (const want of c.expect.reminders ?? []) {
        const found = result.suggestedReminders.some(
          (r) =>
            r.dueDateIso === want.dueDate &&
            (!want.person || !r.personName || sameName(want.person, r.personName))
        );
        count(reminders, found);
        if (!found) missed = true;
      }
      const blob = JSON.stringify({ items: result.items, reminders: result.suggestedReminders });
      for (const word of c.expect.forbidden ?? []) {
        if (mentions(blob, word)) {
          forbiddenHits += 1;
          missed = true;
        }
      }
      if (missed) misses.push(c.id);
      log(`  ${missed ? "MISS" : "ok  "} capture/${c.id} — ${cards.length} card(s)`);
    } catch (err) {
      misses.push(c.id);
      count(people, false);
      log(`  FAIL capture/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: {
      personRecall: rate(people),
      personPrecision: rate(precision),
      fieldAccuracy: rate(fields),
      opportunityRecall: rate(opportunities),
      referralRecall: rate(referrals),
      reminderRecall: rate(reminders),
      phantomParticipants,
      forbiddenHits,
    },
  };
}

/* ---------------------------------------------------------------------- recruiter ----- */

export async function runRecruiterTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<RecruiterEvalFixture>("ai-recruiter-eval.json").cases.slice(0, limit);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const details = tally();
  const misses: string[] = [];
  const latenciesMs: number[] = [];

  for (const c of cases) {
    try {
      const result = await timed(latenciesMs, () =>
        classifyRecruiterSender(userId, {
          senderName: c.senderName,
          senderEmail: c.senderEmail,
          firmGuess: c.firmGuess,
          messages: c.messages.map((m, i) => ({
            id: `${c.id}-${i}`,
            threadId: c.id,
            from: `${c.senderName} <${c.senderEmail}>`,
            to: "me@example.com",
            subject: m.subject,
            snippet: m.body.slice(0, 120),
            internalDate: Date.parse(m.date),
            listUnsubscribe: "",
            listId: "",
            precedence: "",
            body: m.body,
          })),
        })
      );
      // Production keeps a sender only above the confidence floor, so the eval does too.
      const said = result.isRecruiter && result.confidence >= RECRUITER_CONFIDENCE_FLOOR;
      const want = c.expect.isRecruiter;
      if (said && want) tp += 1;
      else if (said && !want) fp += 1;
      else if (!said && want) fn += 1;
      else tn += 1;
      let missed = said !== want;
      if (said && want) {
        for (const company of c.expect.companies ?? []) {
          const ok = result.companiesMentioned.some((m) => sameField(company, m)) || sameField(company, result.firm);
          count(details, ok);
          missed ||= !ok;
        }
        for (const role of c.expect.roles ?? []) {
          const ok = result.rolesDiscussed.some((r) => sameField(role, r));
          count(details, ok);
          missed ||= !ok;
        }
      }
      if (missed) misses.push(c.id);
      log(`  ${missed ? "MISS" : "ok  "} recruiter/${c.id} — said ${said ? "recruiter" : "not"} (${result.confidence.toFixed(2)})`);
    } catch (err) {
      misses.push(c.id);
      if (c.expect.isRecruiter) fn += 1;
      else tn += 1;
      log(`  FAIL recruiter/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: {
      precision: tp + fp === 0 ? null : tp / (tp + fp),
      recall: tp + fn === 0 ? null : tp / (tp + fn),
      accuracy: cases.length === 0 ? null : (tp + tn) / cases.length,
      detailRecall: rate(details),
    },
  };
}

/* ---------------------------------------------------------------------- extension ----- */

const field = (value: string | null) =>
  value ? { value, source: "eval", confidence: "medium" as const } : null;

export async function runExtensionTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<ExtensionEvalFixture>("ai-extension-eval.json").cases.slice(0, limit);
  const fields = tally();
  const nulls = tally();
  let forbiddenHits = 0;
  const misses: string[] = [];
  const latenciesMs: number[] = [];

  for (const c of cases) {
    const page: PageContext = {
      schemaVersion: 1,
      site: "linkedin",
      adapterVersion: "eval",
      kind: "person",
      url: `https://www.linkedin.com/in/${c.id}/`,
      sourceUrl: `https://www.linkedin.com/in/${c.id}/`,
      capturedAt: new Date().toISOString(),
      identity: {
        name: field(c.identityName),
        headline: null,
        title: null,
        company: null,
        location: null,
        school: null,
        email: null,
        handle: field(c.id),
        profileUrl: field(`https://www.linkedin.com/in/${c.id}/`),
        photoUrl: null,
      },
      text: { blob: c.pageText, truncated: false, charCount: c.pageText.length, fromSelection: false },
      warnings: [],
    };
    try {
      const parsed = await timed(latenciesMs, () => parseProfileFields(userId, page));
      if (parsed.degraded) throw new Error(`degraded: ${parsed.degradedReason ?? "unknown"}`);
      let missed = false;
      const pairs: Array<[string | undefined, string | null]> = [
        [c.expect.fullName, parsed.fullName],
        [c.expect.title, parsed.title],
        [c.expect.company, parsed.company],
        [c.expect.location, parsed.location],
        [c.expect.school, parsed.school],
      ];
      for (const [want, got] of pairs) {
        if (!want) continue;
        const ok = sameField(want, got);
        count(fields, ok);
        missed ||= !ok;
      }
      for (const key of c.expect.mustBeNull ?? []) {
        const ok = !parsed[key];
        count(nulls, ok);
        missed ||= !ok;
      }
      const blob = JSON.stringify(parsed);
      for (const word of c.expect.forbidden ?? []) {
        if (mentions(blob, word)) {
          forbiddenHits += 1;
          missed = true;
        }
      }
      if (missed) misses.push(c.id);
      log(`  ${missed ? "MISS" : "ok  "} extension/${c.id}`);
    } catch (err) {
      misses.push(c.id);
      count(fields, false);
      log(`  FAIL extension/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: { fieldAccuracy: rate(fields), nullAccuracy: rate(nulls), forbiddenHits },
  };
}

/* ---------------------------------------------------------------------------- ocr ----- */

/**
 * A photographed notebook page, drawn from the fixture's lines. Handwriting uses the macOS
 * handwriting faces, so on a machine without them it degrades to print — the report prints
 * which font rendered, and a baseline and candidate always render on the same machine.
 */
async function renderNotePage(lines: string[], style: "print" | "hand"): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const font = style === "hand" ? "Bradley Hand, Noteworthy, Marker Felt, cursive" : "Helvetica, Arial, sans-serif";
  const lineHeight = style === "hand" ? 72 : 60;
  const width = 1400;
  const height = 140 + lines.length * lineHeight;
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const text = lines
    .map(
      (line, i) =>
        // A little drift per line, the way a hand never writes on the rule.
        `<text x="${90 + ((i * 7) % 13)}" y="${110 + i * lineHeight}" transform="rotate(${style === "hand" ? ((i % 3) - 1) * 0.6 : 0} 700 ${110 + i * lineHeight})">${escape(line)}</text>`
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#fbf8ef"/>
    ${lines.map((_, i) => `<line x1="60" x2="${width - 60}" y1="${122 + i * lineHeight}" y2="${122 + i * lineHeight}" stroke="#c9d6e8" stroke-width="2"/>`).join("")}
    <g font-family="${font}" font-size="${style === "hand" ? 46 : 40}" fill="#1f2a44">${text}</g>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

export async function runOcrTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<OcrEvalFixture>("ai-ocr-eval.json").cases.slice(0, limit);
  const names = tally();
  const cers: number[] = [];
  const misses: string[] = [];
  const latenciesMs: number[] = [];

  for (const c of cases) {
    try {
      const image = await renderNotePage(c.lines, c.style);
      const [page] = await timed(latenciesMs, () =>
        transcribeImagePages(userId, [{ mimeType: "image/jpeg", base64: image.toString("base64") }])
      );
      if (!page?.ok) throw new Error(`page not read: ${page?.error ?? "no result"}`);
      const text = page.text;
      const cer = characterErrorRate(c.lines.join("\n"), text);
      cers.push(cer);
      let missed = false;
      for (const name of c.names) {
        const ok = mentions(text, name);
        count(names, ok);
        missed ||= !ok;
      }
      if (missed) misses.push(c.id);
      log(`  ${missed ? "MISS" : "ok  "} ocr/${c.id} (${c.style}) — CER ${(cer * 100).toFixed(1)}%`);
    } catch (err) {
      misses.push(c.id);
      for (let i = 0; i < c.names.length; i++) count(names, false);
      log(`  FAIL ocr/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { cases: cases.length, misses, latenciesMs, metrics: { nameRecall: rate(names), cer: mean(cers) } };
}

/* --------------------------------------------------------------------- transcribe ----- */

/** Speaks the script with macOS `say` as 16 kHz mono WAV — the recorder's own format. */
function speak(script: string): Buffer | null {
  const dir = mkdtempSync(join(tmpdir(), "orbit-eval-say-"));
  const file = join(dir, "memo.wav");
  try {
    execFileSync("say", ["-o", file, "--file-format=WAVE", "--data-format=LEI16@16000", script], {
      stdio: "ignore",
    });
    return readFileSync(file);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runTranscribeTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<TranscribeEvalFixture>("ai-transcribe-eval.json").cases.slice(0, limit);
  const names = tally();
  const wers: number[] = [];
  const misses: string[] = [];
  const latenciesMs: number[] = [];

  for (const c of cases) {
    const audio = speak(c.script);
    if (!audio) {
      log(`  skip transcribe/${c.id} — macOS \`say\` is not available here`);
      continue;
    }
    try {
      const result = await timed(latenciesMs, () =>
        transcribeAudioWithAI(userId, { mimeType: "audio/wav", base64: audio.toString("base64"), filename: "memo.wav" })
      );
      const wer = wordErrorRate(c.script, result.text);
      wers.push(wer);
      let missed = false;
      for (const name of c.names) {
        const ok = mentions(result.text, name);
        count(names, ok);
        missed ||= !ok;
      }
      if (missed) misses.push(c.id);
      log(`  ${missed ? "MISS" : "ok  "} transcribe/${c.id} (${result.engine}) — WER ${(wer * 100).toFixed(1)}%`);
    } catch (err) {
      misses.push(c.id);
      for (let i = 0; i < c.names.length; i++) count(names, false);
      log(`  FAIL transcribe/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { cases: cases.length, misses, latenciesMs, metrics: { nameRecall: rate(names), wer: mean(wers) } };
}

/* --------------------------------------------------------------------------- chat ----- */

type SearchFixture = {
  contacts: Array<{
    email: string; fullName: string; company: string; title: string; school: string;
    industry: string; location: string; notes: string; tags: string[];
  }>;
};

/** Seeds `contact-search-eval.json`'s network for the eval user, embeddings included. */
async function seedNetwork(userId: string): Promise<Map<string, { id: string; fullName: string }>> {
  const network = fixture<SearchFixture>("contact-search-eval.json");
  const db = await getDb();
  const byEmail = new Map<string, { id: string; fullName: string }>();
  for (const c of network.contacts) {
    const [row] = await db
      .insert(contacts)
      .values({
        userId, fullName: c.fullName, company: c.company, title: c.title, school: c.school,
        industry: c.industry, location: c.location, notes: c.notes, email: c.email,
      })
      .returning();
    byEmail.set(c.email, { id: row.id, fullName: c.fullName });
    for (const name of c.tags) {
      let tag = await db.query.tags.findFirst({ where: and(eq(tags.userId, userId), eq(tags.name, name)) });
      if (!tag) [tag] = await db.insert(tags).values({ userId, name }).returning();
      await db.insert(contactTags).values({ contactId: row.id, tagId: tag.id });
    }
  }
  // The semantic arm needs vectors; without an embedding key the chat eval still runs on
  // the lexical arms, and says so.
  await rebuildContactEmbeddingsBatch(userId, [...byEmail.values()].map((c) => c.id)).catch((err) =>
    console.warn(`  (embeddings unavailable: ${err instanceof Error ? err.message : String(err)})`)
  );
  return byEmail;
}

export async function runChatTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<ChatEvalFixture>("ai-chat-eval.json").cases.slice(0, limit);
  const network = await seedNetwork(userId);
  const answered = tally();
  const retrieved = tally();
  const misses: string[] = [];
  const latenciesMs: number[] = [];

  for (const c of cases) {
    try {
      const { ctx, result } = await timed(latenciesMs, async () => {
        const ctx = await prepareChatContext(userId, c.question, {});
        const result = await chatWithNetwork(
          userId,
          ctx.scopedQuestion,
          ctx.modelContacts,
          ctx.priorTurns,
          ctx.orgRosters,
          ctx.attention,
          ctx.modelRecruiters,
          ctx.focusProfile,
          ctx.attachedContext,
          ctx.goals,
          ctx.attentionLite
        );
        return { ctx, result };
      });
      const recommended = new Set(
        ((result.recommendations ?? []) as Array<{ contact_id?: string | null }>).map((r) => r.contact_id)
      );
      const shown = new Set(ctx.modelContacts.map((m) => m.id));
      let missed = false;
      for (const email of c.mustMention) {
        const person = network.get(email);
        if (!person) throw new Error(`fixture names ${email}, which contact-search-eval.json does not have`);
        const ok = mentions(result.answer ?? "", person.fullName) || recommended.has(person.id);
        count(answered, ok);
        count(retrieved, shown.has(person.id));
        missed ||= !ok;
      }
      if (missed) misses.push(c.id);
      log(`  ${missed ? "MISS" : "ok  "} chat/${c.id}`);
    } catch (err) {
      misses.push(c.id);
      for (let i = 0; i < c.mustMention.length; i++) count(answered, false);
      log(`  FAIL chat/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: { mentionRecall: rate(answered), retrievalRecall: rate(retrieved) },
  };
}

/* ----------------------------------------------------------------------- research ----- */

/** Everything the research task seeds, removed — before it runs and after. */
async function clearResearchUser(userId: string) {
  const db = await getDb();
  await db.delete(memoryChunks).where(eq(memoryChunks.userId, userId));
  await db.delete(interactions).where(eq(interactions.userId, userId));
  await db.delete(chatMessages).where(eq(chatMessages.userId, userId));
  await db.delete(chatThreads).where(eq(chatThreads.userId, userId));
  await db.delete(contacts).where(eq(contacts.userId, userId));
  await db.delete(tags).where(eq(tags.userId, userId));
}

/**
 * Whole answers to questions one retrieval cannot answer — the research step's job.
 *
 * Runs the production path end to end, in order: retrieval, the depth decision, the research
 * loop, the answer, the recommendation filter. Routing is scored the moment it is decided,
 * so a case whose answer then fails still says whether it went to the right path.
 *
 * Clears its user before AND after: the chat task seeds the same network into the same user,
 * and neither may see the other's rows when both run in one invocation.
 */
export async function runResearchTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<ResearchEvalFixture>("ai-research-eval.json").cases.slice(0, limit);
  await clearResearchUser(userId);
  const network = await seedNetwork(userId);
  await seedPassageNotes(
    userId,
    loadPassageFixture(FIXTURE_DIR),
    new Map([...network].map(([email, c]) => [email, c.id]))
  );
  // Passages embedded through the real drain, so the research step's search_notes has its
  // meaning arm. Without an embedding key it runs on words, and says so.
  await runEmbeddingBackfill(userId).catch((err) =>
    log(`  (passage embeddings unavailable: ${err instanceof Error ? err.message : String(err)})`)
  );
  const known = new Set([...network.values()].map((c) => c.id));

  const mentioned = tally();
  const said = tally();
  const routed = tally();
  let forbiddenHits = 0;
  let inventedContactIds = 0;
  let filteredRecommendations = 0;
  const lookups: number[] = [];
  const rounds: number[] = [];
  const misses: string[] = [];
  const latenciesMs: number[] = [];
  const db = await getDb();

  for (const c of cases) {
    let routedOk: boolean | null = null;
    try {
      let threadId: string | null = null;
      if (c.priorTurns?.length) {
        const [thread] = await db.insert(chatThreads).values({ userId }).returning();
        threadId = thread.id;
        for (const turn of c.priorTurns) {
          await db.insert(chatMessages).values({ threadId, userId, role: turn.role, content: turn.content });
        }
      }

      const { ctx, gathered, result } = await timed(latenciesMs, async () => {
        const ctx = await prepareChatContext(userId, c.question, { threadId });
        const gathered = await maybeGather(userId, ctx, { requestStartedAt: Date.now() });
        routedOk = gathered.depth.depth === c.expectDepth;
        const result = await chatWithNetwork(
          userId,
          ctx.scopedQuestion,
          ctx.modelContacts,
          ctx.priorTurns,
          ctx.orgRosters,
          ctx.attention,
          ctx.modelRecruiters,
          ctx.focusProfile,
          ctx.attachedContext,
          ctx.goals,
          ctx.attentionLite,
          gathered.evidence
        );
        return { ctx, gathered, result };
      });

      const raw = (result.recommendations ?? []) as Array<{ contact_id?: string | null } & Record<string, unknown>>;
      const kept = ctx.filterRecommendations(raw as never);
      const people = c.mustMention.map((email) => {
        const person = network.get(email);
        if (!person) throw new Error(`fixture names ${email}, which contact-search-eval.json does not have`);
        return person;
      });
      const score = scoreResearchAnswer({
        answer: result.answer ?? "",
        rawRecommendationIds: raw.map((r) => r.contact_id),
        keptRecommendationIds: kept.map((r) => r.contact_id),
        mustMention: people,
        mustSay: c.mustSay,
        forbidden: c.forbidden ?? [],
        knownContactIds: known,
      });

      score.mentioned.forEach((ok) => count(mentioned, ok));
      score.said.forEach((ok) => count(said, ok));
      forbiddenHits += score.forbiddenHits;
      inventedContactIds += score.inventedIds;
      filteredRecommendations += score.filteredOut;
      if (gathered.research) {
        lookups.push(gathered.research.lookups);
        rounds.push(gathered.research.rounds);
      }

      const missed =
        !routedOk ||
        score.mentioned.includes(false) ||
        score.said.includes(false) ||
        score.forbiddenHits > 0 ||
        score.inventedIds > 0;
      if (missed) misses.push(c.id);
      const research = gathered.research
        ? ` — ${gathered.research.lookups} lookup(s), ${gathered.research.rounds} round(s), stopped: ${gathered.research.stoppedBy}`
        : "";
      log(`  ${missed ? "MISS" : "ok  "} research/${c.id} [${gathered.depth.depth}]${research}`);
    } catch (err) {
      misses.push(c.id);
      c.mustMention.forEach(() => count(mentioned, false));
      c.mustSay.forEach(() => count(said, false));
      log(`  FAIL research/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Scored even when the answer failed: routing is decided before any answer is written.
      if (routedOk !== null) count(routed, routedOk);
    }
  }

  await clearResearchUser(userId);
  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: {
      mentionRecall: rate(mentioned),
      factRecall: rate(said),
      routingAccuracy: rate(routed),
      forbiddenHits,
      inventedContactIds,
      // Informational, not gated: what the filter caught, and what research cost in lookups.
      filteredRecommendations,
      meanLookups: mean(lookups),
      meanRounds: mean(rounds),
    },
  };
}

/* ------------------------------------------------------------------------- digest ----- */

export async function runDigestTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<DigestEvalFixture>("ai-digest-eval.json").cases.slice(0, limit);
  const attendees = tally();
  const attendeePrecision = tally();
  const actions = tally();
  const misses: string[] = [];
  const latenciesMs: number[] = [];

  for (const c of cases) {
    try {
      const digest = await timed(latenciesMs, () =>
        analyzeMeetingTranscript(
          userId,
          {
            paragraphs: c.transcript,
            title: c.title,
            startedAtIso: "2026-09-15T15:00:00.000Z",
            userName: c.userName,
            attendees: c.calendarAttendees,
          },
          { complete: completeJson, parseJson: parseAiJson }
        )
      );
      const present = digest.participants.filter((p) => p.present && !sameName(c.userName, p.name));
      let missed = false;
      for (const name of c.expect.attendees) {
        const ok = present.some((p) => sameName(name, p.name));
        count(attendees, ok);
        missed ||= !ok;
      }
      for (const p of present) count(attendeePrecision, c.expect.attendees.some((name) => sameName(name, p.name)));
      for (const phrase of c.expect.actionItems) {
        const ok = digest.actionItems.some((a) => mentions(a.text, phrase));
        count(actions, ok);
        missed ||= !ok;
      }
      if (missed) misses.push(c.id);
      const chars = c.transcript.join("\n\n").length;
      log(`  ${missed ? "MISS" : "ok  "} digest/${c.id} (${chars.toLocaleString("en-US")} chars)`);
    } catch (err) {
      misses.push(c.id);
      count(attendees, false);
      log(`  FAIL digest/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: {
      attendeeRecall: rate(attendees),
      attendeePrecision: rate(attendeePrecision),
      actionItemRecall: rate(actions),
    },
  };
}

export const TASKS: Record<TaskName, (opts: RunOpts) => Promise<TaskResult>> = {
  capture: runCaptureTask,
  recruiter: runRecruiterTask,
  extension: runExtensionTask,
  ocr: runOcrTask,
  transcribe: runTranscribeTask,
  chat: runChatTask,
  research: runResearchTask,
  digest: runDigestTask,
};
