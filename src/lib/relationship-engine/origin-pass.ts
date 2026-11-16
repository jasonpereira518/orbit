/**
 * The one-time origin pass (LinkedIn deep read, launch catch-up).
 *
 * Contacts the engine read before the deep read have a watermark past the opening of their
 * thread, so the normal pass never sees "great meeting you at…" again, nor the invitation notes
 * and recommendations that are older than the watermark. This second, smaller reader looks at
 * exactly that: the opening messages plus the LinkedIn signals, once per contact.
 *
 * "Owed" is a query, never a flag: a digest with a watermark, no origin, and no
 * `ORIGIN_CHECKED` in `sources`. The in-flight marker is the runner's (`batch_job_id`,
 * `batch_pending_until`), so a claimed contact is also out of the normal pending set until its
 * batch lands. It never writes the watermark, the summary, facts, reminders or attempts.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, relationshipDigests, relationshipRuns, userSettings } from "@/db/schema";
import { BATCH_STALE_HOURS, MAX_BATCH_REQUESTS, submitAiBatch, type AiBatchJobRow, type BatchOutcome, type BatchRequest } from "@/lib/ai-batch";
import { loadYouCurrent } from "@/lib/career-profile-server";
import { deepReadOn } from "@/lib/deep-read";
import { reportError } from "@/lib/report-error";
import { applyOriginOnly } from "@/lib/relationship-engine/apply";
import { DIGEST_MAX_OUTPUT_TOKENS, buildDigestPrompt, isTrivialWindow, parseDigestAnswer } from "@/lib/relationship-engine/extract";
import { overlapContext } from "@/lib/relationship-engine/runner";
import type { ValidatedDigest } from "@/lib/relationship-engine/types";
import { validateDigest } from "@/lib/relationship-engine/validate";
import { formatMessageLine, signalSpeaker, speakerFor } from "@/lib/relationship-engine/gather";
import { MESSAGE_INTERACTION_SQL, ORIGIN_CHECKED, SIGNAL_ROW_SQL } from "@/lib/relationship-engine/pending";
import type { MessageWindow, WindowMessage } from "@/lib/relationship-engine/types";

export { ORIGIN_CHECKED };
/** Opening messages, in characters of window text. */
export const ORIGIN_WINDOW_CHARS = 6_000;
/** Invitation notes, recommendations, your LinkedIn notes. */
export const ORIGIN_SIGNAL_LIMIT = 10;
/** Per signal. */
export const ORIGIN_SIGNAL_CHARS = 1_000;
const OPENING_ROW_LIMIT = 60;

/** `d` is relationship_digests. Shared verbatim by the claim, the count and the user list. */
function owedSql(now: Date): SQL {
  return sql`d.watermark_at IS NOT NULL
    AND d.origin IS NULL
    AND NOT (d.sources @> ${JSON.stringify([ORIGIN_CHECKED])}::jsonb)
    AND (d.batch_pending_until IS NULL OR d.batch_pending_until < ${now.toISOString()}::timestamptz)`;
}

/**
 * Signals first (each clipped), then the oldest messages until ORIGIN_WINDOW_CHARS, all in date
 * order. Null when there is nothing to read. `truncatedBefore` is always null: this window is
 * not a pass over the backlog and records no cut.
 */
export function buildOriginWindow(contactId: string, opening: WindowMessage[], signals: WindowMessage[]): MessageWindow | null {
  const byDate = (a: WindowMessage, b: WindowMessage) => a.at.getTime() - b.at.getTime();
  const kept: WindowMessage[] = [...signals]
    .sort(byDate)
    .slice(0, ORIGIN_SIGNAL_LIMIT)
    .map((s) => ({ ...s, text: s.text.slice(0, ORIGIN_SIGNAL_CHARS) }));
  let used = 0;
  for (const m of [...opening].sort(byDate)) {
    const length = formatMessageLine(m).length + 1;
    if (used === 0 && length > ORIGIN_WINDOW_CHARS) {
      kept.push({ ...m, text: m.text.slice(0, ORIGIN_WINDOW_CHARS) });
      break;
    }
    if (used + length > ORIGIN_WINDOW_CHARS) break;
    kept.push(m);
    used += length;
  }
  if (!kept.length) return null;
  // Stable: signals stay ahead of a message of the same instant.
  kept.sort(byDate);
  const last = kept[kept.length - 1];
  return {
    contactId,
    messages: kept,
    text: kept.map(formatMessageLine).join("\n"),
    last: { at: last.at, interactionId: last.interactionId },
    truncatedBefore: null,
    sources: [],
  };
}

type Row = {
  id: string;
  interaction_type: string;
  interaction_date: Date | string;
  direction: "in" | "out" | null;
  raw_notes: string | null;
  external_id: string | null;
};

/**
 * Opening = message rows at or before the watermark, oldest first. Signals = the LinkedIn
 * export's per-person rows, oldest first, whatever their date.
 */
export async function loadOriginWindows(userId: string, contactIds: string[]): Promise<Map<string, MessageWindow>> {
  const windows = new Map<string, MessageWindow>();
  const ids = [...new Set(contactIds)];
  if (!ids.length) return windows;
  const db = await getDb();
  const people = rowsOf<{ id: string; full_name: string }>(
    await db.execute(sql`
      SELECT id, full_name FROM contacts
       WHERE user_id = ${userId} AND id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    `)
  );
  for (const p of people) {
    const [opening, signals] = await Promise.all([
      db.execute(sql`
        SELECT m.id, m.interaction_type, m.interaction_date, m.direction, m.raw_notes, m.external_id
          FROM interactions m
          JOIN relationship_digests d ON d.contact_id = m.contact_id
         WHERE m.user_id = ${userId} AND m.contact_id = ${p.id}::uuid
           AND ${MESSAGE_INTERACTION_SQL}
           AND (date_trunc('milliseconds', m.interaction_date) < d.watermark_at
                OR (date_trunc('milliseconds', m.interaction_date) = d.watermark_at
                    AND (d.watermark_interaction_id IS NULL OR m.id <= d.watermark_interaction_id)))
         ORDER BY m.interaction_date ASC, m.id ASC
         LIMIT ${OPENING_ROW_LIMIT}
      `),
      db.execute(sql`
        SELECT m.id, m.interaction_type, m.interaction_date, m.direction, m.raw_notes, m.external_id
          FROM interactions m
         WHERE m.user_id = ${userId} AND m.contact_id = ${p.id}::uuid
           AND ${SIGNAL_ROW_SQL}
         ORDER BY m.interaction_date ASC, m.id ASC
         LIMIT ${ORIGIN_SIGNAL_LIMIT}
      `),
    ]);
    const firstName = p.full_name.trim().split(/\s+/)[0] || "Them";
    const toMessage = (r: Row): WindowMessage => ({
      interactionId: r.id,
      at: new Date(r.interaction_date),
      direction: r.direction ?? null,
      speaker: signalSpeaker(r.external_id, firstName) ?? speakerFor(r.direction ?? null, p.full_name, r.interaction_type),
      text: r.raw_notes ?? "",
    });
    const window = buildOriginWindow(p.id, rowsOf<Row>(opening).map(toMessage), rowsOf<Row>(signals).map(toMessage));
    if (window) windows.set(p.id, window);
  }
  return windows;
}

/**
 * Atomically marks up to `limit` owed digests in flight (batch_job_id = claimId) and returns
 * their contact ids, longest threads first. The outer predicate is re-checked on the row a
 * concurrent claim just wrote, so one contact goes to one claim.
 */
export async function claimOriginContacts(userId: string, limit: number, claimId: string, now: Date = new Date()): Promise<string[]> {
  if (limit <= 0) return [];
  const db = await getDb();
  const until = new Date(now.getTime() + BATCH_STALE_HOURS * 3_600_000);
  const result = await db.execute(sql`
    UPDATE relationship_digests d
       SET batch_job_id = ${claimId}::uuid, batch_pending_until = ${until.toISOString()}::timestamptz
     WHERE d.user_id = ${userId}
       AND d.contact_id IN (
         SELECT d.contact_id FROM relationship_digests d
          WHERE d.user_id = ${userId} AND ${owedSql(now)}
          ORDER BY d.message_count DESC, d.contact_id
          LIMIT ${limit}
       )
       AND ${owedSql(now)}
    RETURNING d.contact_id
  `);
  return rowsOf<{ contact_id: string }>(result).map((r) => r.contact_id);
}

export async function originPendingCount(userId: string, now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM relationship_digests d WHERE d.user_id = ${userId} AND ${owedSql(now)}`);
  return Number(rowsOf<{ n: number }>(result)[0]?.n ?? 0);
}

/** Users with owed digests and the engine on. `onlyUsers` null = everyone. */
export async function usersWithOriginWork(limit: number, onlyUsers: string[] | null, now: Date = new Date()): Promise<string[]> {
  if (onlyUsers && !onlyUsers.length) return [];
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT DISTINCT d.user_id FROM relationship_digests d
     WHERE ${owedSql(now)}
       ${onlyUsers ? sql`AND d.user_id IN (${sql.join(onlyUsers.map((u) => sql`${u}`), sql`, `)})` : sql``}
       AND EXISTS (
         SELECT 1 FROM user_settings us
          WHERE us.user_id = d.user_id AND us.relationship_engine_enabled = 1
       )
     LIMIT ${limit}
  `);
  return rowsOf<{ user_id: string }>(result).map((r) => r.user_id);
}

export type OriginBatchPayload = { runId: string; items: Array<{ customId: string; contactId: string }> };
export type OriginPassResult = { claimed: number; trivial: number; submitted: number; remaining: number };

/** Hand back everything still held under `holder` (a claim id or a job id), unmarked. */
async function releaseHeld(userId: string, holder: string): Promise<void> {
  const db = await getDb();
  await db
    .update(relationshipDigests)
    .set({ batchJobId: null, batchPendingUntil: null })
    .where(and(eq(relationshipDigests.userId, userId), eq(relationshipDigests.batchJobId, holder)));
}

/**
 * Claim owed contacts, mark the ones with nothing to read, and send the rest as half-price
 * batches. Batch only: when no batch can be submitted (no key, credits low, OpenRouter) the claim
 * is handed back and the next hourly kick tries again. A catch-up is not worth full price.
 * `limit` caps the contacts in all (the pre-launch sample).
 */
export async function runOriginPass(
  userId: string,
  opts: { budgetMs?: number; limit?: number; now?: Date; submit?: typeof submitAiBatch; deepRead?: boolean } = {}
): Promise<OriginPassResult> {
  const result: OriginPassResult = { claimed: 0, trivial: 0, submitted: 0, remaining: 0 };
  if (!(opts.deepRead ?? (await deepReadOn(userId)))) return result;
  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId), columns: { relationshipEngineEnabled: true } });
  if ((settings?.relationshipEngineEnabled ?? 1) !== 1) return result;

  const now = opts.now ?? new Date();
  const submit = opts.submit ?? submitAiBatch;
  const budgetMs = opts.budgetMs ?? 60_000;
  const start = Date.now();
  let left = opts.limit ?? Number.POSITIVE_INFINITY;
  const you = await loadYouCurrent(userId);

  while (left > 0 && Date.now() - start < budgetMs) {
    const size = Math.min(MAX_BATCH_REQUESTS, left);
    const claimId = randomUUID();
    const ids = await claimOriginContacts(userId, size, claimId, now);
    if (!ids.length) break;
    result.claimed += ids.length;
    left -= ids.length;

    const [windows, people] = await Promise.all([
      loadOriginWindows(userId, ids),
      db.select({ id: contacts.id, fullName: contacts.fullName }).from(contacts).where(and(eq(contacts.userId, userId), inArray(contacts.id, ids))),
    ]);
    const nameOf = new Map(people.map((p) => [p.id, p.fullName]));
    const runId = randomUUID();
    const requests: BatchRequest[] = [];
    const items: OriginBatchPayload["items"] = [];
    for (const contactId of ids) {
      const window = windows.get(contactId);
      if (!window || isTrivialWindow(window, { deepRead: true })) {
        // Nothing to understand: checked, with no model call.
        await applyOriginOnly({ userId, runId, contactId, validated: null, now });
        result.trivial += 1;
        continue;
      }
      // ponytail: reuses the full digest prompt and throws most of the answer away. A three-key
      // prompt would cut output tokens; write it (and an eval variant) if the measured cost
      // (scripts/measure-origin-pass.ts) says it matters.
      const prompt = buildDigestPrompt({
        contactName: nameOf.get(contactId) ?? "Contact",
        window,
        previous: null,
        deepRead: true,
        context: await overlapContext(userId, contactId, you, now),
      });
      const customId = `o${items.length}`;
      requests.push({ customId, ...prompt, temperature: 0.1, maxOutputTokens: DIGEST_MAX_OUTPUT_TOKENS });
      items.push({ customId, contactId });
    }

    if (requests.length) {
      const payload: OriginBatchPayload = { runId, items };
      const jobId = await submit(userId, "relationship.origin", requests, payload).catch((err) => {
        reportError(err, { where: "job.relationships.origin.submit", userId, level: "warning" });
        return null;
      });
      if (!jobId) {
        await releaseHeld(userId, claimId);
        break;
      }
      // A real run row, so origin.runId points at something `undoRelationshipRun` can take back.
      await db.insert(relationshipRuns).values({ id: runId, userId, status: "done", finishedAt: now });
      await db
        .update(relationshipDigests)
        .set({ batchJobId: jobId })
        .where(and(eq(relationshipDigests.userId, userId), eq(relationshipDigests.batchJobId, claimId)));
      result.submitted += requests.length;
    }
    if (ids.length < size) break;
  }
  result.remaining = await originPendingCount(userId, now);
  return result;
}

/**
 * A landed origin batch. Only contacts still held by this job are touched; each is read once:
 * an answer that fails to parse or validate (or a request the provider failed) still marks the
 * contact checked. Everything in the answer except origin, relationship and events is discarded.
 */
export async function applyOriginBatch(job: Pick<AiBatchJobRow, "id" | "userId" | "payload">, outcomes: BatchOutcome[]): Promise<void> {
  const db = await getDb();
  const payload = job.payload as unknown as OriginBatchPayload;
  const items = payload.items ?? [];
  if (!items.length) return;
  const held = new Set(
    (
      await db
        .select({ contactId: relationshipDigests.contactId })
        .from(relationshipDigests)
        .where(and(eq(relationshipDigests.userId, job.userId), eq(relationshipDigests.batchJobId, job.id)))
    ).map((r) => r.contactId)
  );
  const contactOf = new Map(items.map((i) => [i.customId, i.contactId]));
  const windows = await loadOriginWindows(job.userId, [...held]);
  const now = new Date();
  for (const outcome of outcomes) {
    const contactId = contactOf.get(outcome.customId);
    if (!contactId || !held.has(contactId)) continue;
    const window = windows.get(contactId);
    let validated: ValidatedDigest | null = null;
    try {
      if (window && outcome.text) validated = validateDigest(parseDigestAnswer(outcome.text), window, new Set(), { deepRead: true });
    } catch {
      validated = null;
    }
    try {
      await applyOriginOnly({ userId: job.userId, runId: payload.runId, contactId, validated, now });
      held.delete(contactId);
    } catch (err) {
      reportError(err, { where: "job.ai-batch.apply.origin", userId: job.userId, level: "warning", extra: { contactId } });
    }
  }
  // Missing from the outcomes, or the write failed: handed back unmarked, so it is tried again.
  await releaseHeld(job.userId, job.id);
}

/** The batch will never answer: its contacts are owed again. */
export async function releaseOriginBatch(job: Pick<AiBatchJobRow, "id" | "userId">): Promise<void> {
  await releaseHeld(job.userId, job.id);
}
