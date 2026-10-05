/**
 * ONE account's own decisions, exported as PRIVATE eval labels for the decision-model tasks
 * (`scripts/eval-ai.ts --task duplicates,mentions --labels-dir <dir>`).
 *
 *   npx tsx scripts/export-decision-labels.ts --user <user id> --database-url "<url>" [--out-dir ~/.orbit-private-labels]
 *
 * What becomes a label:
 *  - duplicates: pairs the person DISMISSED (including undone merges) → different people;
 *    merges the person made by hand (`contact_merges.confidence IS NULL`) → the same person.
 *  - mentions: names the person picked with `@` (`interaction_mentions.matched_by = 'user_pick'`)
 *    → which contact the name meant, among the contacts sharing its first name.
 *
 * SAFETY — this reads a real database, so:
 *  - READ-ONLY by construction: a raw `@neondatabase/serverless` client and SELECTs only.
 *    Never `getDb()`, which reconciles the schema on first connect — pointed at production
 *    from a branch, it would migrate production.
 *  - ONE account (`--user`), and the URL must be passed explicitly: `.env.local`'s
 *    `DATABASE_URL` is the shared remote database and is never picked up implicitly.
 *  - The output holds real contacts. It is written OUTSIDE the repo (default
 *    `~/.orbit-private-labels`) and must never be committed; eval reports keep only ids.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { neon } from "@neondatabase/serverless";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Card = { fullName: string; title?: string; company?: string; school?: string; location?: string; email?: string; aiSummary?: string };

function card(row: Record<string, unknown>, prefix = ""): Card {
  const pick = (k: string) => {
    const v = row[`${prefix}${k}`];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const c: Card = { fullName: pick("full_name") ?? "" };
  for (const [key, col] of [
    ["title", "title"],
    ["company", "company"],
    ["school", "school"],
    ["location", "location"],
    ["email", "email"],
    ["aiSummary", "ai_summary"],
  ] as const) {
    const v = pick(col);
    if (v) c[key] = key === "aiSummary" ? v.slice(0, 300) : v;
  }
  return c;
}

async function main() {
  const userId = arg("--user");
  const url = arg("--database-url");
  const outDir = resolve((arg("--out-dir") ?? join(homedir(), ".orbit-private-labels")).replace(/^~(?=\/)/, homedir()));
  if (!userId || !url) {
    throw new Error("Pass --user <id> and --database-url <url> explicitly. Nothing is read from the environment.");
  }
  if (outDir.startsWith(process.cwd())) {
    throw new Error(`Refusing to write real contacts inside the repo (${outDir}). Choose a folder outside it.`);
  }
  const sql = neon(url);

  // ---- duplicates: dismissed pairs are different people ----
  const dismissed = (await sql`
    SELECT s.reason,
           a.full_name AS a_full_name, a.title AS a_title, a.company AS a_company, a.school AS a_school,
           a.location AS a_location, a.email AS a_email, a.ai_summary AS a_ai_summary,
           b.full_name AS b_full_name, b.title AS b_title, b.company AS b_company, b.school AS b_school,
           b.location AS b_location, b.email AS b_email, b.ai_summary AS b_ai_summary
      FROM duplicate_suggestions s
      JOIN contacts a ON a.id = s.contact_a_id AND a.user_id = s.user_id
      JOIN contacts b ON b.id = s.contact_b_id AND b.user_id = s.user_id
     WHERE s.user_id = ${userId} AND s.status = 'dismissed'
  `) as Record<string, unknown>[];

  // ---- duplicates: merges made by hand are the same person ----
  const merged = (await sql`
    SELECT m.loser_snapshot AS snapshot,
           w.full_name, w.title, w.company, w.school, w.location, w.email, w.ai_summary
      FROM contact_merges m
      JOIN contacts w ON w.id = m.winner_contact_id AND w.user_id = m.user_id
     WHERE m.user_id = ${userId} AND m.confidence IS NULL AND m.status = 'done'
  `) as Array<Record<string, unknown> & { snapshot: Record<string, unknown> }>;

  const pairs = [
    ...dismissed.map((r, i) => ({
      id: `dismissed-${i + 1}`,
      a: card(r, "a_"),
      b: card(r, "b_"),
      same: false,
      why: String(r.reason ?? "dismissed"),
    })),
    ...merged.map((r, i) => ({
      id: `merged-${i + 1}`,
      a: card(r),
      b: card(r.snapshot ?? {}),
      same: true,
      why: "merged by hand",
    })),
  ].filter((p) => p.a.fullName && p.b.fullName);

  // ---- mentions: @-picks are gold links ----
  const picks = (await sql`
    SELECT m.mention_text, m.contact_id::text AS contact_id, i.raw_notes
      FROM interaction_mentions m
      JOIN interactions i ON i.id = m.interaction_id AND i.user_id = m.user_id
     WHERE m.user_id = ${userId} AND m.matched_by = 'user_pick'
     LIMIT 200
  `) as Array<{ mention_text: string; contact_id: string; raw_notes: string | null }>;

  const cases = [];
  for (const [i, p] of picks.entries()) {
    const first = p.mention_text.trim().split(/\s+/)[0]?.toLowerCase();
    if (!first) continue;
    const candidates = (await sql`
      SELECT id::text AS id, full_name, title, company, school, location, email, ai_summary
        FROM contacts
       WHERE user_id = ${userId}
         AND (id = ${p.contact_id}::uuid OR lower(split_part(btrim(full_name), ' ', 1)) = ${first})
       ORDER BY (id = ${p.contact_id}::uuid) DESC, full_name
       LIMIT 8
    `) as Array<Record<string, unknown> & { id: string }>;
    const expect = candidates.findIndex((c) => c.id === p.contact_id);
    if (expect < 0) continue;
    // The candidate order must not give the answer away: rotate so the pick is not always first.
    const shift = i % candidates.length;
    const rotated = [...candidates.slice(shift), ...candidates.slice(0, shift)];
    const notes = (p.raw_notes ?? "").replace(/\s+/g, " ");
    const at = notes.toLowerCase().indexOf(p.mention_text.toLowerCase());
    const sentence = at >= 0 ? notes.slice(Math.max(0, at - 160), at + 240) : notes.slice(0, 400);
    cases.push({
      id: `pick-${i + 1}`,
      sentence,
      mention: p.mention_text,
      candidates: rotated.map((c) => card(c)),
      expect: rotated.findIndex((c) => c.id === p.contact_id),
    });
  }

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(outDir, "duplicates.json"), `${JSON.stringify({ pairs }, null, 1)}\n`, { mode: 0o600 });
  writeFileSync(join(outDir, "mentions.json"), `${JSON.stringify({ cases }, null, 1)}\n`, { mode: 0o600 });
  console.log(
    `export-decision-labels: ${pairs.filter((p) => !p.same).length} different-people pairs, ` +
      `${pairs.filter((p) => p.same).length} same-person pairs, ${cases.length} mention picks → ${outDir}`
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
