/**
 * PROBE: "Download my data", against a seeded throwaway PGlite database.
 *
 *   E1  Shape: 16 categories, machine-readable JSON, which tables each holds.
 *   E2  Isolation: user A's export contains nothing of user B's.
 *   E3  Completeness: which user-scoped tables (and which of A's seeded rows) are absent.
 *   E4  Redaction: no credential/hash columns leak.
 *   E5  Scale: time to stream a large account (synthetic 20k contacts / 60k interactions /
 *       60k passages). PGlite on a laptop is not Neon over HTTP, so this is a lower bound.
 *
 * Fake data only. Run: npx tsx privacy/probe-export.ts
 */
import "../scripts/smoke/_env";
import { mkdirSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { collectUserExport, userExportChunks } from "../src/lib/data-export";
import { readCatalog } from "./lib/catalog";
import { seedEverything } from "./lib/seed-everything";
import { run } from "../scripts/smoke/_env";

const A = "user_privExpA01";
const B = "user_privExpB02";
const BIG = "user_privExpBig";

run(async () => {
  const cat = await readCatalog();
  const db = await getDb();
  const out: Record<string, unknown> = {};
  await seedEverything(cat, A);
  await seedEverything(cat, B);

  // E1 shape
  const exp = await collectUserExport(A);
  const categories = Object.keys(exp.categories);
  const tablesInExport = new Set<string>([...Object.values(exp.categories).flatMap((c) => Object.keys(c)), ...Object.keys(exp.account)]);
  const nonEmpty = [...Object.entries(exp.categories)].flatMap(([cat_, ds]) => Object.entries(ds).filter(([, rows]) => rows.length).map(([t]) => `${cat_}.${t}`));
  out.E1 = { format: exp.format, categoryCount: categories.length, categories, datasets: tablesInExport.size };
  console.log(`[E1] format=${exp.format} categories=${categories.length} datasets=${tablesInExport.size} non-empty=${nonEmpty.length}`);

  // E2 isolation
  const text = JSON.stringify(exp);
  const leaks = (text.match(new RegExp(B, "g")) ?? []).length;
  out.E2 = { occurrencesOfOtherUser: leaks };
  console.log(`[E2] occurrences of user B in A's export: ${leaks}`);

  // E3 completeness — which tables hold A's data but are not in the export at all?
  const missing: Array<{ table: string; rows: number }> = [];
  for (const t of cat.tables) {
    const n = Number(
      ((await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} x WHERE x::text LIKE ${"%" + A + "%"}`)) as unknown as { rows: Array<{ n: number }> }).rows?.[0]?.n ?? 0
    );
    if (n > 0 && !tablesInExport.has(t)) missing.push({ table: t, rows: n });
  }
  out.E3 = { tablesHoldingUserDataButNotExported: missing };
  console.log(`[E3] tables holding A's data that the export omits (${missing.length}):`);
  for (const m of missing) console.log(`       ${m.table} (${m.rows})`);

  // E4 redaction
  const badKeys = new Set<string>();
  for (const ds of [...Object.values(exp.categories), exp.account])
    for (const rows of Object.values(ds)) for (const r of rows) for (const k of Object.keys(r)) if (/(_encrypted|secret|_hash|token)$/i.test(k)) badKeys.add(k);
  out.E4 = { credentialLikeKeysPresent: [...badKeys] };
  console.log(`[E4] credential-like keys present: ${[...badKeys].join(", ") || "none"}`);

  // E5 scale
  const NC = 20000, NI = 60000;
  await db.execute(sql`INSERT INTO contacts (user_id, full_name, email, notes)
    SELECT ${BIG}, 'Person ' || g, 'p' || g || '@example.test', repeat('note text ', 30) FROM generate_series(1, ${NC}) g`);
  await db.execute(sql`INSERT INTO interactions (user_id, contact_id, interaction_type, raw_notes, interaction_date)
    SELECT ${BIG}, c.id, 'note', repeat('we talked about things ', 20), now()
      FROM (SELECT id, row_number() OVER () AS rn FROM contacts WHERE user_id = ${BIG}) c, generate_series(1, 3) k`);
  await db.execute(sql`INSERT INTO memory_chunks (user_id, source_kind, source_id, contact_id, content, content_hash)
    SELECT user_id, 'interaction', id, contact_id, raw_notes, md5(raw_notes) FROM interactions WHERE user_id = ${BIG}`);
  const t0 = Date.now();
  let bytes = 0;
  for await (const chunk of userExportChunks(BIG)) bytes += chunk.length;
  const ms = Date.now() - t0;
  out.E5 = { contacts: NC, interactions: NI, passages: NI, seconds: ms / 1000, megabytes: +(bytes / 1e6).toFixed(1), routeMaxDurationSeconds: 300 };
  console.log(`[E5] ${NC} contacts / ${NI} interactions / ${NI} passages: ${(ms / 1000).toFixed(1)}s, ${(bytes / 1e6).toFixed(1)} MB (route maxDuration 300s)`);

  mkdirSync("privacy/out", { recursive: true });
  writeFileSync("privacy/out/export.json", JSON.stringify(out, null, 2));
});
