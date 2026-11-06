/**
 * The second half of the email-insights sweep: read the hiring threads ingest set aside
 * (`pending_ai`) and turn each into events. One model call per thread, on the person's own
 * key, so this is the careful half of the pipeline.
 *
 * ## What stops it, and what that costs the thread
 *  - No usable AI, or a key/quota/model problem: the person's, not the thread's. Nothing is
 *    counted and the account's waiting threads are parked for six hours.
 *  - The daily cap: parked until the next UTC midnight.
 *  - The deadline: unstarted claims are handed straight back.
 *  - A thread Gmail cannot return, or an answer that is not the promised shape: a counted
 *    stall. The third ends the thread as `failed`, so one bad thread cannot loop.
 *
 * Auth-free and free of `next/server`: the route wraps it and the smoke drives it on PGlite.
 */
import { userCanUseAi } from "@/lib/ai";
import { isAiAccessError } from "@/lib/ai-access";
import { classifyAiError, ReauthRequiredError } from "@/lib/errors";
import {
  fetchGmailThreadMessages,
  getValidAccessToken,
  type GmailMessageContent,
} from "@/lib/gmail";
import { consumeBucket, isRateLimitedError, RATE_LIMITS } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { utcDayKey } from "@/lib/timeline-cost";
import { extractThread, type ExtractInput } from "./extract";
import {
  accountsWithPendingThreads,
  claimPendingThreads,
  deferPending,
  recoverStalledClaims,
  releaseThread,
  settleExtraction,
} from "./store";
import { loadConnection, planAllows, type EmailIntelConnection } from "./sweep";
import type { EmailIntelMessage, ExtractionRejects, ExtractionResult } from "./types";

const HOUR_MS = 60 * 60_000;
export const EXTRACT_ACCOUNTS_PER_RUN = 4;
export const EXTRACT_CLAIM_PER_ACCOUNT = 5;
export const KEY_PROBLEM_COOLDOWN_MS = 6 * HOUR_MS;
export const NO_AI_COOLDOWN_MS = 6 * HOUR_MS;
export const INELIGIBLE_COOLDOWN_MS = 24 * HOUR_MS;
/** After an unexpected error for a whole account: look again in an hour. */
const ERROR_COOLDOWN_MS = HOUR_MS;
const MESSAGES_PER_THREAD = 4;

export type EmailIntelExtractGmail = {
  accessToken(userId: string): Promise<string>;
  fetchThreadMessages(token: string, threadId: string, max: number): Promise<GmailMessageContent[]>;
};

export type EmailIntelExtractDeps = {
  now?: Date;
  /** Stop STARTING work after this (epoch ms). */
  deadline?: number;
  gmail?: EmailIntelExtractGmail;
  connection?: (userId: string) => Promise<EmailIntelConnection | null>;
  eligible?: (userId: string) => Promise<boolean>;
  canUseAi?: (userId: string) => Promise<boolean>;
  extract?: (userId: string, input: ExtractInput) => Promise<ExtractionResult>;
};

export type EmailIntelExtractStats = {
  accounts: number;
  claimed: number;
  extracted: number;
  events: number;
  released: number;
  failed: number;
  keyProblems: number;
  noAi: number;
  ineligible: number;
  budgetStops: number;
  errors: number;
  recovered: number;
  rejected: ExtractionRejects;
};

const liveGmail: EmailIntelExtractGmail = {
  accessToken: (userId) => getValidAccessToken(userId),
  fetchThreadMessages: (token, threadId, max) => fetchGmailThreadMessages(token, threadId, { max }),
};

function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** The person's key or allowance is the problem, so every later thread would fail the same way. */
function isKeyProblem(err: unknown): boolean {
  if (isAiAccessError(err)) return true;
  const kind = classifyAiError(err);
  return kind === "auth" || kind === "quota" || kind === "model_unavailable";
}

function toIntelMessages(list: GmailMessageContent[]): EmailIntelMessage[] {
  return list.map((m) => ({
    from: m.from,
    to: m.to,
    subject: m.subject,
    date: m.internalDate,
    body: (m.body.trim() || m.snippet).slice(0, 4000),
  }));
}

function addRejects(into: ExtractionRejects, from: ExtractionRejects): void {
  for (const k of Object.keys(into) as Array<keyof ExtractionRejects>) into[k] += from[k];
}

type Resolved = Required<Pick<EmailIntelExtractDeps, "gmail" | "connection" | "eligible" | "canUseAi" | "extract">> &
  Pick<EmailIntelExtractDeps, "deadline">;

async function extractForAccount(userId: string, d: Resolved, now: Date, stats: EmailIntelExtractStats): Promise<void> {
  if (!(await d.canUseAi(userId).catch(() => false))) {
    stats.noAi += 1;
    await deferPending(userId, new Date(now.getTime() + NO_AI_COOLDOWN_MS));
    return;
  }
  const conn = await d.connection(userId);
  if (!conn || !conn.canRead || !(await d.eligible(userId))) {
    stats.ineligible += 1;
    await deferPending(userId, new Date(now.getTime() + INELIGIBLE_COOLDOWN_MS));
    return;
  }
  let token: string;
  try {
    token = await d.gmail.accessToken(userId);
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      stats.ineligible += 1;
      await deferPending(userId, new Date(now.getTime() + INELIGIBLE_COOLDOWN_MS));
      return;
    }
    throw err;
  }

  const claims = await claimPendingThreads(userId, EXTRACT_CLAIM_PER_ACCOUNT, now);
  stats.claimed += claims.length;

  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i]!;
    const handBack = async (from: number, notBefore: Date | null) => {
      for (const rest of claims.slice(from)) {
        await releaseThread(rest, { notBefore, countStall: false });
        stats.released += 1;
      }
    };

    if (d.deadline !== undefined && Date.now() >= d.deadline) {
      await handBack(i, null);
      return;
    }

    try {
      await consumeBucket(
        "email-intel-extract-daily",
        `${userId}:${utcDayKey(now)}`,
        RATE_LIMITS.emailIntelExtractDaily
      );
    } catch (err) {
      if (isRateLimitedError(err)) {
        stats.budgetStops += 1;
        const tomorrow = nextUtcDay(now);
        await handBack(i, tomorrow);
        await deferPending(userId, tomorrow);
        return;
      }
      throw err;
    }

    const list = await d.gmail.fetchThreadMessages(token, claim.threadId, MESSAGES_PER_THREAD);
    if (list.length === 0) {
      await releaseThread(claim, { notBefore: null, countStall: true });
      stats.released += 1;
      continue;
    }
    const messages = toIntelMessages(list);
    const newest = list[list.length - 1]!;

    try {
      const result = await d.extract(userId, {
        subject: claim.subject,
        participants: claim.participants,
        userEmail: conn.email,
        messages,
        anchor: new Date(newest.internalDate ?? now.getTime()),
      });
      addRejects(stats.rejected, result.rejected);
      if (await settleExtraction(userId, claim, result.events)) {
        stats.extracted += 1;
        stats.events += result.events.length;
      }
      // A lost claim (a newer message arrived) is not an error: the thread waits for that mail.
    } catch (err) {
      if (isKeyProblem(err)) {
        stats.keyProblems += 1;
        const until = new Date(now.getTime() + KEY_PROBLEM_COOLDOWN_MS);
        await handBack(i, until);
        await deferPending(userId, until);
        return;
      }
      stats.failed += 1;
      reportError(err, { where: "email-intel.extract", extra: { userId } });
      await releaseThread(claim, { notBefore: null, countStall: true });
    }
  }
}

export async function runEmailIntelExtraction(deps: EmailIntelExtractDeps = {}): Promise<EmailIntelExtractStats> {
  const now = deps.now ?? new Date();
  const d: Resolved = {
    gmail: deps.gmail ?? liveGmail,
    connection: deps.connection ?? loadConnection,
    eligible: deps.eligible ?? planAllows,
    canUseAi: deps.canUseAi ?? userCanUseAi,
    extract: deps.extract ?? ((userId, input) => extractThread(userId, input)),
    deadline: deps.deadline,
  };
  const stats: EmailIntelExtractStats = {
    accounts: 0, claimed: 0, extracted: 0, events: 0, released: 0, failed: 0, keyProblems: 0,
    noAi: 0, ineligible: 0, budgetStops: 0, errors: 0, recovered: 0,
    rejected: { badKind: 0, lowConfidence: 0, unverifiable: 0, empty: 0, suspicious: 0, duplicate: 0, capped: 0 },
  };

  stats.recovered = await recoverStalledClaims(now);
  const accounts = await accountsWithPendingThreads(now, EXTRACT_ACCOUNTS_PER_RUN);
  for (const userId of accounts) {
    if (d.deadline !== undefined && Date.now() >= d.deadline) break;
    stats.accounts += 1;
    try {
      await extractForAccount(userId, d, now, stats);
    } catch (err) {
      stats.errors += 1;
      reportError(err, { where: "email-intel.extract.account", extra: { userId } });
      await deferPending(userId, new Date(now.getTime() + ERROR_COOLDOWN_MS)).catch(() => undefined);
    }
  }
  return stats;
}
