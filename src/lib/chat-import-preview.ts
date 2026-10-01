/**
 * Server side of a WhatsApp / iMessage import. The browser parses the export (media never
 * leaves the device), asks `buildChatPreview` who each participant is, then uploads the
 * rows it built in chunks: `beginStaging` → `appendStagedRows` × n → `startStaged`. The
 * job sits in status `staging` until the last chunk lands, so the engine, the stall cron
 * and the import history never see half an upload; `sweepAbandonedStaging` deletes one
 * whose last chunk never came.
 *
 * Plain functions taking `userId`, so the smoke can drive them without a request; the auth
 * lives in `src/actions/chat-imports.ts`. Every refusal is a `UserFacingError`, which the
 * action returns as `{ error }` data (a thrown message does not survive production).
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  contacts,
  imports,
  importJobRows,
  userSettings,
  type ChatConversationRowPayload,
} from "@/db/schema";
import { getAiConfig } from "@/lib/ai";
import { estimateCostMicros } from "@/lib/ai-pricing";
import { findIdentityOwners } from "@/lib/contact-identity";
import {
  DUPLICATE_MERGE_CONFIDENCE,
  buildDuplicateIndex,
  findDuplicateCandidatesIndexed,
  identityKeysFor,
  type IdentityKey,
} from "@/lib/duplicates";
import { UserFacingError } from "@/lib/errors";
import { IMESSAGE_CHAT_IMPORT_TYPE, WHATSAPP_CHAT_IMPORT_TYPE } from "@/lib/import-adapters/chat";
import { stageImportRows } from "@/lib/import-job-rows";
import { isImportId } from "@/lib/imports/import-ids";
import { isSelf } from "@/lib/meeting-digest";
import { loadMeetingSelf } from "@/lib/meeting-sessions";
import { CHAT_IMPORTS_SURFACE_KEY } from "@/lib/surfaces";
import { isSurfaceLive } from "@/lib/surface-visibility";
import { ensureUserSettings } from "@/lib/user-settings";
import { MAX_APPEND_ROWS, SESSION_MAX_CHARS } from "@/lib/conversations/types";
import type { ChatConversationRow } from "@/lib/conversations/to-rows";

/** The browser-side row type and the stored payload type must not drift apart. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const ROW_TYPES_MATCH: Same<ChatConversationRow, ChatConversationRowPayload> = true;
void ROW_TYPES_MATCH;

export type ChatPreviewParticipant = { key: string; displayName: string; phoneE164: string | null; email: string | null };
export type ChatPreviewConversation = {
  key: string;
  source: "whatsapp" | "imessage";
  title: string;
  isGroup: boolean;
  participants: ChatPreviewParticipant[];
  messageCount: number;
  chars: number;
  firstAt: string;
  lastAt: string;
};
export type ChatCandidate = { contactId: string; fullName: string; confidence: number; reason: string };
export type ChatPreviewResult = {
  conversations: Array<{
    key: string;
    /** The label the owner most likely is, or null → ask. iMessage: "Me". */
    suggestedSelfKey: string | null;
    participants: Array<{ key: string; autoContactId: string | null; candidates: ChatCandidate[] }>;
  }>;
  estimate: { micros: number; model: string } | null;
};
/** Test seam: the smoke passes the gate's answer. The actions never pass it. */
type Gate = { surfaceLive?: boolean };

type ChatSource = "whatsapp" | "imessage";

const TYPE_BY_SOURCE: Record<ChatSource, string> = {
  whatsapp: WHATSAPP_CHAT_IMPORT_TYPE,
  imessage: IMESSAGE_CHAT_IMPORT_TYPE,
};

/** Name candidates below this are noise; 0.6 is a bare full-name match. */
const CANDIDATE_FLOOR = 0.6;
const MAX_CANDIDATES = 3;
/** Participants priced at the full rate; the rest go through the Batch API at half. */
const FULL_RATE_PARTICIPANTS = 25;
const OUTPUT_TOKENS_PER_PARTICIPANT = 600;
/** Saved owner labels: the most recently given few. */
const MAX_SELF_NAMES = 5;
/** Abandoned uploads: a staging import older than this never got its last chunk. */
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

// ── Gate ─────────────────────────────────────────────────────────────────────────────

/**
 * Rule: every entry point except the sweep refuses unless `feature.chat-imports` is live
 * for this user (it ships coming-soon, which is closed even for admins).
 */
async function requireLive(userId: string, gate?: Gate) {
  const live = gate?.surfaceLive ?? (await isSurfaceLive(userId, CHAT_IMPORTS_SURFACE_KEY));
  if (!live) throw new UserFacingError("Chat imports aren’t available yet");
}

// ── Input validation ─────────────────────────────────────────────────────────────────
// Everything below arrives from the browser and is checked here, not trusted.

const isoDate = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), "not a date");

/** Generous: preview labels are raw export text; `conversationToRows` trims them for staging. */
const previewSchema = z
  .array(
    z.object({
      key: z.string().max(300),
      source: z.enum(["whatsapp", "imessage"]),
      title: z.string().max(1_000),
      isGroup: z.boolean(),
      participants: z
        .array(
          z.object({
            key: z.string().max(1_000),
            displayName: z.string().max(1_000),
            phoneE164: z.string().max(20).nullable(),
            email: z.string().max(254).nullable(),
          }),
        )
        .max(1_100),
      messageCount: z.number().int().nonnegative(),
      chars: z.number().int().nonnegative(),
      firstAt: z.string().max(40),
      lastAt: z.string().max(40),
    }),
  )
  .max(5_000);

const beginSchema = z.object({
  source: z.enum(["whatsapp", "imessage"]),
  fileName: z.string().trim().min(1).max(255),
  selfNames: z.array(z.string().max(200)).max(20),
});

/**
 * Rule: mirrors `ChatConversationRowPayload`. Strict, so nothing beyond the payload's own
 * fields is stored in the job row's jsonb.
 */
function rowSchema(source: ChatSource) {
  return z.strictObject({
    kind: z.literal("chat_conversation"),
    source: z.literal(source),
    conversationKey: z.string().min(1).max(300),
    isGroup: z.boolean(),
    title: z.string().max(200),
    participant: z.strictObject({
      key: z.string().min(1).max(300),
      displayName: z.string().max(200),
      phoneE164: z.string().regex(/^\+\d{7,15}$/).nullable(),
      email: z.string().max(254).nullable(),
    }),
    resolvedContactId: z.uuid().nullable().optional(),
    createIfUnmatched: z.boolean(),
    sessions: z
      .array(
        z.strictObject({
          startAt: isoDate,
          endAt: isoDate,
          messageCount: z.number().int().nonnegative(),
          direction: z.enum(["in", "out"]).nullable(),
          transcript: z.string().max(SESSION_MAX_CHARS),
        }),
      )
      .max(5_000),
  });
}

// ── Preview ──────────────────────────────────────────────────────────────────────────

function normLabel(s: string) {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function identityId(k: IdentityKey) {
  return `${k.kind}\u001f${k.value}`;
}

export async function buildChatPreview(
  userId: string,
  convs: ChatPreviewConversation[],
  gate?: Gate,
): Promise<ChatPreviewResult> {
  await requireLive(userId, gate);
  const parsed = previewSchema.safeParse(convs);
  if (!parsed.success) throw new UserFacingError("Couldn’t read those chats — try exporting them again");
  const list = parsed.data;

  const db = await getDb();
  const [settings, meetingSelf, existing] = await Promise.all([
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { chatSelfNames: true },
    }),
    loadMeetingSelf(userId),
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: { id: true, fullName: true, email: true, linkedinUrl: true, xHandle: true, company: true, title: true },
    }),
  ]);
  const savedSelf = new Set((settings?.chatSelfNames ?? []).map(normLabel));
  const contactById = new Map(existing.map((c) => [c.id, c]));
  // Rule: the name index is built once per call, never per participant.
  const index = buildDuplicateIndex(existing);

  /**
   * Rule (self): the owner is a saved self name (case-insensitive), the person's own name
   * per `isSelf`, or the export's own owner label — "Me" (iMessage) / "You" (WhatsApp).
   */
  const ownerLabel = (p: ChatPreviewParticipant) =>
    [p.key, p.displayName].some(
      (label) => label === "Me" || label === "You" || savedSelf.has(normLabel(label)) || isSelf(label, meetingSelf),
    );

  // Every identifier in the whole preview, looked up in ONE query.
  const keysOf = new Map<ChatPreviewParticipant, IdentityKey[]>();
  const allKeys = new Map<string, IdentityKey>();
  for (const c of list) {
    for (const p of c.participants) {
      if (ownerLabel(p)) continue;
      const keys = identityKeysFor({ phone: p.phoneE164, email: p.email });
      keysOf.set(p, keys);
      for (const k of keys) allKeys.set(identityId(k), k);
    }
  }
  const ownersById = new Map<string, Set<string>>();
  for (const o of await findIdentityOwners(userId, [...allKeys.values()])) {
    const id = identityId(o.key);
    const set = ownersById.get(id) ?? new Set<string>();
    set.add(o.contactId);
    ownersById.set(id, set);
  }

  const nonOwnerShares: Array<{ inputTokens: number }> = [];
  const conversations: ChatPreviewResult["conversations"] = list.map((c) => {
    let suggestedSelfKey: string | null = null;
    const owners = new Set<string>();
    for (const p of c.participants) {
      if (!ownerLabel(p)) continue;
      owners.add(p.key);
      // Rule: the first owner label found is the suggestion.
      suggestedSelfKey ??= p.key;
    }
    const nonOwnerCount = c.participants.filter((p) => !owners.has(p.key)).length;
    const conversationTokens = Math.ceil(c.chars / 4);

    const participants = c.participants.map((p) => {
      // Rule: owners get no candidates.
      if (owners.has(p.key)) return { key: p.key, autoContactId: null, candidates: [] as ChatCandidate[] };
      // Rule (estimate): the conversation's input tokens split evenly across non-owners.
      nonOwnerShares.push({ inputTokens: Math.ceil(conversationTokens / Math.max(1, nonOwnerCount)) });

      const identityOwners = new Map<string, string>();
      for (const k of keysOf.get(p) ?? []) {
        for (const contactId of ownersById.get(identityId(k)) ?? []) {
          if (!identityOwners.has(contactId)) {
            identityOwners.set(contactId, k.kind === "phone_e164" ? "Same phone number" : "Same email");
          }
        }
      }
      // Rule (auto-link): exactly one identifier owner links outright.
      if (identityOwners.size === 1) {
        return { key: p.key, autoContactId: [...identityOwners.keys()][0], candidates: [] as ChatCandidate[] };
      }

      const candidates: ChatCandidate[] = [];
      // Two contacts each holding one of this participant's identifiers is a conflict for a
      // person to settle: they are offered first, and no name match can auto-link past them.
      for (const [contactId, reason] of identityOwners) {
        const contact = contactById.get(contactId);
        if (contact) candidates.push({ contactId, fullName: contact.fullName, confidence: 0.95, reason });
      }
      const matches = findDuplicateCandidatesIndexed(index, { fullName: p.displayName, email: p.email });
      // Rule (auto-link): otherwise the best name-index match links at or above the merge bar.
      if (identityOwners.size === 0 && matches[0] && matches[0].confidence >= DUPLICATE_MERGE_CONFIDENCE) {
        return { key: p.key, autoContactId: matches[0].contact.id, candidates: [] as ChatCandidate[] };
      }
      for (const m of matches) {
        if (m.confidence < CANDIDATE_FLOOR) continue;
        if (candidates.some((c) => c.contactId === m.contact.id)) continue;
        candidates.push({ contactId: m.contact.id, fullName: m.contact.fullName, confidence: m.confidence, reason: m.reason });
      }
      // Rule: up to 3 candidates, best first.
      candidates.sort((a, b) => b.confidence - a.confidence);
      return { key: p.key, autoContactId: null, candidates: candidates.slice(0, MAX_CANDIDATES) };
    });

    return { key: c.key, suggestedSelfKey, participants };
  });

  return { conversations, estimate: await estimateFor(userId, nonOwnerShares) };
}

/**
 * Rule (estimate): input `ceil(chars / 4)` per conversation split across its non-owners,
 * 600 output tokens per non-owner, the first 25 at full rate and the rest batched, priced on
 * the model `relationship.digest` would use. No usable key (getAiConfig throws) or an
 * unpriced model → null, and the UI says to add a key.
 */
async function estimateFor(
  userId: string,
  shares: Array<{ inputTokens: number }>,
): Promise<ChatPreviewResult["estimate"]> {
  let model: string;
  try {
    model = (await getAiConfig(userId, "relationship.digest")).model;
  } catch {
    return null;
  }
  const buckets = [
    { batch: false, part: shares.slice(0, FULL_RATE_PARTICIPANTS) },
    { batch: true, part: shares.slice(FULL_RATE_PARTICIPANTS) },
  ];
  let micros = 0;
  for (const { batch, part } of buckets) {
    if (part.length === 0) continue;
    const cost = estimateCostMicros({
      model,
      inputTokens: part.reduce((n, s) => n + s.inputTokens, 0),
      outputTokens: part.length * OUTPUT_TOKENS_PER_PARTICIPANT,
      batch,
    });
    if (cost == null) return null;
    micros += cost;
  }
  return { micros, model };
}

// ── Staging ──────────────────────────────────────────────────────────────────────────

/**
 * Rule: inserts the job in `staging` (invisible to the engine, the stall cron and the
 * history list) and remembers the owner labels the person confirmed.
 */
export async function beginStaging(
  userId: string,
  input: { source: ChatSource; fileName: string; selfNames: string[] },
  gate?: Gate,
): Promise<{ importId: string }> {
  await requireLive(userId, gate);
  const parsed = beginSchema.safeParse(input);
  if (!parsed.success) throw new UserFacingError("Couldn’t start that import — try again");
  const { source, fileName, selfNames } = parsed.data;

  const db = await getDb();
  const [row] = await db
    .insert(imports)
    .values({
      userId,
      importType: TYPE_BY_SOURCE[source],
      fileName,
      status: "staging",
      totalRows: 0,
      stats: {},
    })
    .returning();

  await saveSelfNames(userId, selfNames);
  return { importId: row.id };
}

/**
 * Rule (self names): merged with the saved ones, deduped case-insensitively, the 5 most
 * recently given kept. Stored newest first.
 */
async function saveSelfNames(userId: string, given: string[]) {
  const fresh = given.map((n) => n.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (fresh.length === 0) return;
  await ensureUserSettings(userId);
  const db = await getDb();
  const current = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { chatSelfNames: true },
  });
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const name of [...fresh, ...(current?.chatSelfNames ?? [])]) {
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(name);
  }
  await db
    .update(userSettings)
    .set({ chatSelfNames: merged.slice(0, MAX_SELF_NAMES), updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}

/** The caller's own chat import, still staging — or a refusal. */
async function ownStagingImport(userId: string, importId: string) {
  if (!isImportId(importId)) throw new UserFacingError("That import wasn’t found");
  const db = await getDb();
  const row = await db.query.imports.findFirst({
    where: and(eq(imports.id, importId), eq(imports.userId, userId)),
    columns: { id: true, importType: true, status: true, totalRows: true },
  });
  if (!row) throw new UserFacingError("That import wasn’t found");
  const source = (Object.keys(TYPE_BY_SOURCE) as ChatSource[]).find((s) => TYPE_BY_SOURCE[s] === row.importType);
  if (!source) throw new UserFacingError("That import wasn’t found");
  if (row.status !== "staging") throw new UserFacingError("That import has already started");
  return { ...row, source };
}

/**
 * Rule: the import must be the caller's, in `staging`, of a chat type; at most
 * MAX_APPEND_ROWS rows, each passing the row schema for that import's source.
 *
 * `startIndex` must equal the rows already staged. The slot is claimed with a conditional
 * counter bump BEFORE the rows are written, so two overlapping calls for one chunk cannot
 * both stage it, and a refused chunk leaves no gap in `row_index`.
 */
export async function appendStagedRows(
  userId: string,
  importId: string,
  startIndex: number,
  rows: unknown[],
  gate?: Gate,
): Promise<{ appended: number }> {
  await requireLive(userId, gate);
  const job = await ownStagingImport(userId, importId);
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_APPEND_ROWS) {
    throw new UserFacingError("That upload chunk was the wrong size — start the import again");
  }
  if (!Number.isInteger(startIndex) || startIndex !== (job.totalRows ?? 0)) {
    throw new UserFacingError("That upload got out of step — start the import again");
  }
  const schema = rowSchema(job.source);
  const payloads: ChatConversationRowPayload[] = [];
  for (const r of rows) {
    const parsed = schema.safeParse(r);
    if (!parsed.success) throw new UserFacingError("Part of that chat couldn’t be read — try exporting it again");
    payloads.push(parsed.data);
  }

  const db = await getDb();
  const claimed = await db
    .update(imports)
    .set({ totalRows: sql`${imports.totalRows} + ${payloads.length}`, updatedAt: new Date() })
    .where(
      and(
        eq(imports.id, job.id),
        eq(imports.userId, userId),
        eq(imports.status, "staging"),
        eq(imports.totalRows, startIndex),
      ),
    )
    .returning();
  if (claimed.length === 0) throw new UserFacingError("That upload got out of step — start the import again");

  try {
    await stageImportRows(
      payloads.map((payload, i) => ({ importId: job.id, userId, rowIndex: startIndex + i, payload })),
    );
  } catch (err) {
    // Give the slot back so a retry of this chunk lines up again.
    await db
      .update(imports)
      .set({ totalRows: sql`${imports.totalRows} - ${payloads.length}` })
      .where(and(eq(imports.id, job.id), eq(imports.status, "staging")))
      .catch(() => {});
    throw err;
  }
  return { appended: payloads.length };
}

/**
 * Rule: requires `staging`; flips to `processing` with `totalRows` = the staged row count.
 * The action then hands the job to the engine in `after()`.
 */
export async function startStaged(userId: string, importId: string, gate?: Gate): Promise<{ totalRows: number }> {
  await requireLive(userId, gate);
  const job = await ownStagingImport(userId, importId);
  const db = await getDb();
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(importJobRows)
    .where(and(eq(importJobRows.importId, job.id), eq(importJobRows.userId, userId)));
  const totalRows = Number(n);
  if (totalRows === 0) throw new UserFacingError("Pick at least one chat to import");
  const updated = await db
    .update(imports)
    .set({ status: "processing", totalRows, updatedAt: new Date() })
    .where(and(eq(imports.id, job.id), eq(imports.userId, userId), eq(imports.status, "staging")))
    .returning();
  if (updated.length === 0) throw new UserFacingError("That import has already started");
  return { totalRows };
}

/**
 * Rule: deletes staging imports created over 24 h ago — an upload whose last chunk never
 * came. Their job rows go with them (`import_job_rows.import_id` is ON DELETE CASCADE).
 * Not gated: it is the cron's housekeeping, across every user.
 */
export async function sweepAbandonedStaging(now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const gone = await db
    .delete(imports)
    .where(and(eq(imports.status, "staging"), lt(imports.createdAt, new Date(now.getTime() - STAGING_TTL_MS))))
    .returning();
  return gone.length;
}

