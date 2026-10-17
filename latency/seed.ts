/**
 * Seed one account at one data tier into a throwaway PGlite directory, deterministically.
 *
 *   ORBIT_PGLITE_DIR=latency/.data/tier-5000 npx tsx latency/seed.ts --tier 5000
 *
 * Tiers (contacts): new (0), 500, 5000, 50000. Everything else scales with the contact
 * count so the account has the shape of a real one, not a table of names:
 *
 *   interactions      ~3 per contact (0..6, deterministic), 40% carry raw notes
 *   memory_chunks     one per interaction that carries notes (what chat retrieval reads)
 *   contact_embeddings one "profile" row per contact for `--embed-share` of contacts
 *   reminders         2% of contacts have a pending reminder, half of them overdue
 *   tags              8 tags, 30% of contacts tagged
 *   notes / avatars   50% long notes, 30% inline base64 avatars (scripts/lib/scale-fixture.ts)
 *   demo workspace    the 25-person demo network on top (rich briefs, timelines, reminders),
 *                     so chat, capture and profiles have real prose to find
 *
 * Embeddings are deterministic pseudo-random unit vectors (1,536 dims, the production
 * dimension). They are not semantically meaningful, which is fine for latency: the cost of
 * the semantic arm is a function of row count and vector width, not of what the vectors
 * mean. Locally PGlite has no pgvector, so the semantic arm takes the JS fallback
 * (`src/lib/hybrid-search.ts`); the HNSW path is measured on Neon — see latency/README.md.
 *
 * `--embed-share` defaults to 1 up to 5,000 contacts and 0.2 at 50,000 (jsonb vectors are
 * ~12 KB each; 50,000 of them is 600 MB of PGlite, more than the point of the tier).
 *
 * The user is `demo-user`: the id every request resolves to on a local server without
 * Clerk keys, so the same directory serves both the in-process ops and the browser runs.
 */
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db";
import {
  contactEmbeddings,
  contactTags,
  contacts,
  interactions,
  memoryChunks,
  reminders,
  tags,
  userSettings,
} from "../src/db/schema";
import { recalibrateCloseness } from "../src/lib/closeness-cohort";
import { seedDemoWorkspace } from "../src/lib/demo-data/seed";
import { ensureUserSettings } from "../src/lib/user-settings";
import { scaleContactRows } from "../scripts/lib/scale-fixture";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV ||= "development";
env.ORBIT_DEMO_DATA = "off";
if (!env.ORBIT_PGLITE_DIR) {
  console.error("Refusing to seed without ORBIT_PGLITE_DIR: this script writes a throwaway database, never .data/pglite.");
  process.exit(1);
}
if (env.DATABASE_URL) {
  console.error("Refusing to seed with DATABASE_URL set: the harness only ever seeds local PGlite.");
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const TIER = flag("tier", "500");
const USER = flag("user", "demo-user");
const N = TIER === "new" ? 0 : Number(TIER);
if (!Number.isFinite(N)) throw new Error(`bad --tier ${TIER}`);
const EMBED_SHARE = Number(flag("embed-share", N >= 50000 ? "0.2" : "1"));
const DIMS = 1536;
const DAY = 86_400_000;
const TYPES = ["email", "meeting", "note", "linkedin_message", "call"];
const TAGS = ["mentor", "investor", "alum", "conference", "warm intro", "hiring", "advisor", "friend"];
/** Fixed "now" so every tier and every rerun produce the same due/overdue split. */
const NOW = new Date("2026-10-17T12:00:00Z");

/** Deterministic unit vector: every (row, dim) is a hash of its coordinates, never Math.random. */
function fakeEmbedding(seed: number): number[] {
  const out = new Array<number>(DIMS);
  let x = (seed * 2654435761 + 12345) >>> 0;
  let norm = 0;
  for (let d = 0; d < DIMS; d++) {
    // xorshift32
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    const v = (x / 0xffffffff) * 2 - 1;
    out[d] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  for (let d = 0; d < DIMS; d++) out[d] = Math.round((out[d] / norm) * 1e4) / 1e4;
  return out;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

/**
 * A read/write API key for the HTTP benchmarks (/api/mcp, /api/v1). The token is written
 * beside the database, never printed: `latency/api.mjs` reads it from there.
 */
async function mintApiKey(db: Awaited<ReturnType<typeof getDb>>) {
  const { generateApiKey } = await import("../src/lib/api/keys");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  await db.execute(sql`DELETE FROM api_keys WHERE user_id = ${USER} AND name = 'latency-harness'`);
  const key = generateApiKey("api");
  await db.execute(sql`
    INSERT INTO api_keys (user_id, name, kind, prefix, key_hash, scopes)
    VALUES (${USER}, 'latency-harness', 'api', ${key.prefix}, ${key.keyHash}, '["read","write"]'::jsonb)
  `);
  writeFileSync(join(env.ORBIT_PGLITE_DIR!, "..", `${env.ORBIT_PGLITE_DIR!.split("/").pop()}.api-key`), key.token, { mode: 0o600 });
}

async function insertChunked<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

async function main() {
  const started = performance.now();
  const db = await getDb();

  // Start clean: the directory is throwaway, but a rerun must not double the account.
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.execute(sql`DELETE FROM tags WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM companies WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM memory_chunks WHERE user_id = ${USER}`);

  await ensureUserSettings(USER);
  // A paid plan so no contact cap trims the tier (lifted on localhost anyway; explicit here
  // so the same directory also behaves under NODE_ENV=test scripts).
  await db.update(userSettings).set({ compedPlan: "orbit" }).where(eq(userSettings.userId, USER));

  if (N === 0) {
    await mintApiKey(db);
    console.log(`tier=new user=${USER}: empty account`);
    await closeDb();
    return;
  }

  await seedDemoWorkspace(USER);

  const rows = scaleContactRows(USER, N, {
    inlineAvatarShare: 0.3,
    longNotesShare: 0.5,
    dueFollowUpRows: Array.from({ length: Math.max(1, Math.floor(N * 0.01)) }, (_, k) => Math.floor((k + 1) * (N / Math.max(1, Math.floor(N * 0.01) + 1)))),
  });
  const ids: string[] = [];
  await insertChunked(rows, 250, async (chunk) => {
    const inserted = await db.insert(contacts).values(chunk).returning({ id: contacts.id });
    ids.push(...inserted.map((r) => r.id));
  });
  console.log(`contacts: ${ids.length}`);

  // Interactions: i % 7 touches per contact (mean 3), spread over 400 days, 40% with notes.
  const touches = ids.flatMap((contactId, i) =>
    Array.from({ length: i % 7 }, (_, k) => {
      const withNotes = (i * 7 + k) % 5 < 2;
      return {
        userId: USER,
        contactId,
        interactionType: TYPES[(i + k) % TYPES.length],
        interactionDate: new Date(NOW.getTime() - ((i * 13 + k * 29) % 400) * DAY),
        externalId: `lat-${i}-${k}`,
        aiSummary: `Touch ${k} with contact ${i}: caught up on hiring and a possible intro.`,
        rawNotes: withNotes
          ? `Met contact ${i} for coffee (touch ${k}). They are weighing a move to a new team, asked about our roadmap, and offered an intro to a recruiter at ${rows[i].company ?? "their company"}. Follow up in two weeks with the deck. `.repeat(3)
          : null,
      };
    })
  );
  const interactionIds: Array<{ id: string; contactId: string; rawNotes: string | null; interactionDate: Date }> = [];
  await insertChunked(touches, 500, async (chunk) => {
    const inserted = await db
      .insert(interactions)
      .values(chunk)
      .returning({ id: interactions.id, contactId: interactions.contactId, rawNotes: interactions.rawNotes, interactionDate: interactions.interactionDate });
    interactionIds.push(...inserted);
  });
  console.log(`interactions: ${interactionIds.length}`);

  // Reminders: 2% of contacts, half overdue, half due within 14 days.
  const reminderRows = ids
    .filter((_, i) => i % 50 === 0)
    .map((contactId, k) => ({
      userId: USER,
      contactId,
      title: `Follow up with contact ${k * 50}`,
      status: "pending",
      reminderType: "manual",
      actionKind: "follow_up" as const,
      dueDate: new Date(NOW.getTime() + (k % 2 === 0 ? -1 : 1) * ((k % 14) + 1) * DAY),
    }));
  await insertChunked(reminderRows, 500, (chunk) => db.insert(reminders).values(chunk));
  console.log(`reminders: ${reminderRows.length}`);

  // Tags: 8 tags, 30% of contacts carry one.
  const tagRows = await db
    .insert(tags)
    .values(TAGS.map((name) => ({ userId: USER, name, nameNormalized: name.toLowerCase() })))
    .returning({ id: tags.id });
  const links = ids
    .map((contactId, i) => ({ contactId, i }))
    .filter(({ i }) => i % 10 < 3)
    .map(({ contactId, i }) => ({ contactId, tagId: tagRows[i % tagRows.length].id }));
  await insertChunked(links, 500, (chunk) => db.insert(contactTags).values(chunk));
  console.log(`contact_tags: ${links.length}`);

  // Contact embeddings: one profile row per contact for the embedded share.
  const embedEvery = EMBED_SHARE >= 1 ? 1 : Math.round(1 / EMBED_SHARE);
  const embedRows = ids
    .map((contactId, i) => ({ contactId, i }))
    .filter(({ i }) => i % embedEvery === 0)
    .map(({ contactId, i }) => {
      const content = `${rows[i].fullName} — ${rows[i].title ?? ""} at ${rows[i].company ?? ""}, ${rows[i].location ?? ""}`;
      return {
        userId: USER,
        contactId,
        sourceType: "profile",
        sourceId: null,
        embedding: fakeEmbedding(i),
        content,
        contentHash: sha256(content),
      };
    });
  await insertChunked(embedRows, 50, (chunk) => db.insert(contactEmbeddings).values(chunk));
  console.log(`contact_embeddings: ${embedRows.length} (share ${EMBED_SHARE})`);

  // Memory chunks: one per interaction that has notes, embedded for the same share.
  const chunkRows = interactionIds
    .filter((r) => r.rawNotes)
    .map((r, k) => {
      const content = r.rawNotes!;
      const hash = sha256(content);
      return {
        userId: USER,
        sourceKind: "interaction" as const,
        sourceId: r.id,
        contactId: r.contactId,
        contactIds: [r.contactId],
        occurredAt: r.interactionDate,
        chunkIndex: 0,
        content,
        contentHash: hash,
        sourceHash: md5(content),
        embeddedHash: k % embedEvery === 0 ? hash : null,
        embedding: k % embedEvery === 0 ? fakeEmbedding(1_000_000 + k) : null,
      };
    });
  await insertChunked(chunkRows, 50, (chunk) => db.insert(memoryChunks).values(chunk));
  console.log(`memory_chunks: ${chunkRows.length}`);

  await recalibrateCloseness(USER);
  await db.execute(sql`ANALYZE`);
  await mintApiKey(db);

  const counts = await db.execute<{ t: string; n: number }>(sql`
    select 'contacts' as t, count(*)::int as n from contacts where user_id = ${USER}
    union all select 'interactions', count(*)::int from interactions where user_id = ${USER}
    union all select 'memory_chunks', count(*)::int from memory_chunks where user_id = ${USER}
    union all select 'contact_embeddings', count(*)::int from contact_embeddings where user_id = ${USER}
    union all select 'reminders', count(*)::int from reminders where user_id = ${USER}
  `);
  const rowsOut = Array.isArray(counts) ? counts : (counts as { rows: Array<{ t: string; n: number }> }).rows;
  console.table(rowsOut);
  console.log(`tier=${TIER} seeded in ${((performance.now() - started) / 1000).toFixed(1)}s into ${env.ORBIT_PGLITE_DIR}`);
  await closeDb();
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
