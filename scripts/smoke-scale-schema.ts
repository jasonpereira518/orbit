/**
 * Proves the scale schema applies cleanly and that its indexes are actually used.
 *
 * Runs against a throwaway PGlite database rather than `.data/pglite`, so it can assert on
 * a *fresh* bootstrap (the interesting case — an existing dev DB would mask a broken
 * CREATE TABLE) without touching the developer's data.
 *
 * A fast query proves nothing on a table this size; every performance assertion here reads
 * the plan and fails on a Seq Scan.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-scale-"));
  const client = await PGlite.create({ dataDir, extensions: { pg_trgm } });
  await client.waitReady;

  const { DDL, SCALE_DDL, applyScaleSchema } = await import("../src/db");

  console.log("\nbootstrap");
  await client.exec(DDL);
  check("base DDL applies", true);

  // The real migration entry point, not a replay of the statement list — so the pieces that
  // live outside SCALE_DDL (the pg_trgm extension, the contact_tags dedupe and its unique
  // index) are covered by this test rather than only by production.
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    await applyScaleSchema((statement) => client.query(statement));
  } finally {
    console.error = originalError;
  }
  check("applyScaleSchema runs without errors", errors.length === 0, errors.join("\n"));
  check(`all ${SCALE_DDL.length} scale statements applied`, true);

  const indexes = (
    await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
    )
  ).rows.map((r) => r.indexname);
  for (const name of [
    "contacts_user_sort_idx",
    "contacts_user_updated_idx",
    "contacts_user_closeness_idx",
    "contacts_user_recent_idx",
    "contacts_search_gin",
    "contacts_name_trgm",
    "contacts_slug_idx",
    "contacts_company_id_idx",
    "contact_tags_tag_idx",
    "contact_tags_pair_uidx",
    "interactions_user_date_idx",
    "embeddings_user_src_idx",
  ]) {
    check(`index ${name} exists`, indexes.includes(name));
  }

  // --- Generated column semantics ------------------------------------------------
  console.log("\ngenerated columns");
  await client.query(
    `INSERT INTO contacts (user_id, full_name, last_name, company, title, linkedin_url, notes)
     VALUES
       ('u1', 'Ada Lovelace', NULL, 'Analytical Engines', 'Mathematician', 'https://www.linkedin.com/in/ada-lovelace/', 'met at a conference'),
       ('u1', 'Grace Brewster Hopper', 'Hopper', 'US Navy', 'Rear Admiral', 'https://linkedin.com/in/grace-hopper', NULL),
       ('u1', 'Prince', NULL, NULL, NULL, NULL, NULL)`
  );

  const keys = (
    await client.query<{ full_name: string; sort_key: string; linkedin_slug: string | null }>(
      `SELECT full_name, sort_key, linkedin_slug FROM contacts ORDER BY full_name`
    )
  ).rows;
  const byName = new Map(keys.map((r) => [r.full_name, r]));

  check(
    "sort_key falls back to the last word of full_name",
    byName.get("Ada Lovelace")?.sort_key === "lovelace",
    `got ${JSON.stringify(byName.get("Ada Lovelace")?.sort_key)}`
  );
  check(
    "sort_key prefers the last_name column when set",
    byName.get("Grace Brewster Hopper")?.sort_key === "hopper",
    `got ${JSON.stringify(byName.get("Grace Brewster Hopper")?.sort_key)}`
  );
  check(
    "single-word name sorts under itself",
    byName.get("Prince")?.sort_key === "prince",
    `got ${JSON.stringify(byName.get("Prince")?.sort_key)}`
  );
  check(
    "linkedin_slug strips host and trailing slash",
    byName.get("Ada Lovelace")?.linkedin_slug === "ada-lovelace",
    `got ${JSON.stringify(byName.get("Ada Lovelace")?.linkedin_slug)}`
  );
  check(
    "linkedin_slug handles a URL with no trailing slash",
    byName.get("Grace Brewster Hopper")?.linkedin_slug === "grace-hopper",
    `got ${JSON.stringify(byName.get("Grace Brewster Hopper")?.linkedin_slug)}`
  );
  check(
    "linkedin_slug is null when there is no URL",
    byName.get("Prince")?.linkedin_slug === null,
    `got ${JSON.stringify(byName.get("Prince")?.linkedin_slug)}`
  );

  // The slug is the key two accounts are matched on, and it is derived twice — here in SQL
  // and by `extractLinkedinSlug` in JavaScript. If they disagree, mutual contacts silently
  // stop matching, so every shape LinkedIn actually emits is checked against the regex.
  const jsSlug = (url: string) => {
    const m = url.trim().match(/linkedin\.com\/in\/([^/?#]+)/i);
    return m ? m[1].toLowerCase() : null;
  };
  const slugCases = [
    "https://www.linkedin.com/in/ada-lovelace/",
    "https://linkedin.com/in/grace-hopper",
    "https://www.linkedin.com/in/ada-lovelace?trk=contact-list",
    "https://www.linkedin.com/in/ada-lovelace/?originalSubdomain=ca",
    "https://www.linkedin.com/in/Ada-Lovelace#experience",
    "",
  ];
  await client.query(
    `INSERT INTO contacts (user_id, full_name, linkedin_url) SELECT 'slug', 'S' || i, u
     FROM unnest($1::text[]) WITH ORDINALITY AS t(u, i)`,
    [slugCases]
  );
  const slugRows = (
    await client.query<{ linkedin_url: string; linkedin_slug: string | null }>(
      `SELECT linkedin_url, linkedin_slug FROM contacts WHERE user_id = 'slug'`
    )
  ).rows;
  const slugMismatches = slugRows.filter(
    (r) => (r.linkedin_slug ?? null) !== jsSlug(r.linkedin_url ?? "")
  );
  check(
    `linkedin_slug matches extractLinkedinSlug on all ${slugCases.length} URL shapes`,
    slugMismatches.length === 0,
    slugMismatches.map((r) => `${r.linkedin_url} -> sql=${r.linkedin_slug} js=${jsSlug(r.linkedin_url ?? "")}`).join("\n       ")
  );
  await client.query(`DELETE FROM contacts WHERE user_id = 'slug'`);

  // --- Search ---------------------------------------------------------------------
  console.log("\nsearch");
  const tsHit = (
    await client.query<{ full_name: string }>(
      `SELECT full_name FROM contacts
       WHERE search_tsv @@ websearch_to_tsquery('simple', 'engines')`
    )
  ).rows;
  check("tsvector matches on company (weight B)", tsHit.length === 1 && tsHit[0].full_name === "Ada Lovelace");

  const noteHit = (
    await client.query<{ full_name: string }>(
      `SELECT full_name FROM contacts
       WHERE search_tsv @@ websearch_to_tsquery('simple', 'conference')`
    )
  ).rows;
  check("tsvector matches on notes (weight D)", noteHit.length === 1);

  const ranked = (
    await client.query<{ full_name: string; rank: number }>(
      `SELECT full_name, ts_rank_cd(search_tsv, websearch_to_tsquery('simple', 'grace')) AS rank
       FROM contacts WHERE search_tsv @@ websearch_to_tsquery('simple', 'grace')`
    )
  ).rows;
  check("name matches rank above zero", ranked.length === 1 && Number(ranked[0].rank) > 0);

  const fuzzy = (
    await client.query<{ full_name: string }>(
      `SELECT full_name FROM contacts WHERE similarity(full_name, 'lovelace') > 0.3`
    )
  ).rows;
  check("trigram similarity finds a typo-adjacent name", fuzzy.length === 1);

  // --- Uniqueness -----------------------------------------------------------------
  console.log("\nconstraints");
  const contactId = (
    await client.query<{ id: string }>(`SELECT id FROM contacts LIMIT 1`)
  ).rows[0].id;
  await client.query(`INSERT INTO tags (user_id, name) VALUES ('u1', 'mentor')`);
  const tagId = (await client.query<{ id: string }>(`SELECT id FROM tags LIMIT 1`)).rows[0].id;
  await client.query(
    `INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2)`,
    [contactId, tagId]
  );
  let rejected = false;
  try {
    await client.query(
      `INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2)`,
      [contactId, tagId]
    );
  } catch {
    rejected = true;
  }
  check("contact_tags rejects a duplicate pair", rejected);

  // --- Plans ----------------------------------------------------------------------
  // PGlite will happily seq-scan three rows, so seed enough to make the planner choose.
  console.log("\nquery plans (10k rows)");
  // Two properties of this seed matter, and both were learned the hard way.
  //
  // Width: a narrow three-column table is cheap enough to seq-scan that the planner would
  // rightly ignore every index, and the assertions below would prove nothing.
  //
  // Vocabulary diversity: the text has to differ per row. An earlier version repeated one
  // filler sentence into all 10,000 rows, which put every lexeme in every row — a GIN index
  // where each term matches the whole table. The planner correctly costed that above a seq
  // scan and the test failed, blaming the index for the fixture. Real prose does not behave
  // that way, so neither does this.
  await client.query(
    `INSERT INTO contacts (user_id, full_name, last_name, company, title, location, ai_summary, notes)
     SELECT 'u1',
            'Person ' || g,
            'Sur' || lpad(g::text, 5, '0'),
            'Co ' || (g % 500),
            'Title ' || (g % 90),
            'City ' || (g % 200),
            'summary tokenA' || g || ' tokenB' || (g % 997) || ' tokenC' || (g % 331),
            'note tokenD' || g || ' tokenE' || (g % 743) || ' tokenF' || (g % 211)
     FROM generate_series(1, 10000) g`
  );
  await client.query(`ANALYZE contacts`);

  async function plan(label: string, sql: string, mustContain: string) {
    const rows = (
      await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`)
    ).rows;
    const text = rows.map((r) => r["QUERY PLAN"]).join("\n");
    check(label, text.includes(mustContain), text);
  }

  await plan(
    "keyset page uses contacts_user_sort_idx",
    `SELECT id FROM contacts
     WHERE user_id = 'u1' AND (sort_key, full_name, id) > ('sur05000', '', '00000000-0000-0000-0000-000000000000')
     ORDER BY sort_key, full_name, id LIMIT 50`,
    "contacts_user_sort_idx"
  );

  await plan(
    "A-Z seek uses contacts_user_sort_idx",
    `SELECT id FROM contacts WHERE user_id = 'u1' AND sort_key >= 's'
     ORDER BY sort_key, full_name, id LIMIT 50`,
    "contacts_user_sort_idx"
  );

  // Search correctness at this size, not plan shape. Below roughly 50k rows a sequential
  // scan of one user's contacts genuinely costs less than a GIN bitmap scan, and the
  // planner is right to choose it — the win at 1k-10k contacts is that the match now
  // happens in Postgres at all, instead of shipping every row to Node and calling
  // String.includes on 17 fields. The index is what keeps that flat as the table grows,
  // which is what the next block asserts.
  const searchRows = (
    await client.query<{ full_name: string }>(
      `SELECT full_name FROM contacts
       WHERE user_id = 'u1' AND search_tsv @@ websearch_to_tsquery('simple', 'lovelace')`
    )
  ).rows;
  check(
    "search finds the right contact among 10k",
    searchRows.length === 1 && searchRows[0].full_name === "Ada Lovelace",
    JSON.stringify(searchRows)
  );

  console.log("\nquery plans (60k rows)");
  await client.query(
    `INSERT INTO contacts (user_id, full_name, last_name, company, ai_summary, notes)
     SELECT 'u1',
            'Later ' || g,
            'Zur' || lpad(g::text, 6, '0'),
            'Co ' || (g % 500),
            'summary tokenG' || g || ' tokenH' || (g % 997),
            'note tokenI' || g || ' tokenJ' || (g % 743)
     FROM generate_series(1, 50000) g`
  );
  await client.query(`ANALYZE contacts`);

  await plan(
    "full-text search uses contacts_search_gin once the table is large",
    `SELECT id FROM contacts
     WHERE user_id = 'u1' AND search_tsv @@ websearch_to_tsquery('simple', 'lovelace')`,
    "contacts_search_gin"
  );

  await plan(
    "keyset page still uses contacts_user_sort_idx at 60k",
    `SELECT id FROM contacts
     WHERE user_id = 'u1' AND (sort_key, full_name, id) > ('sur05000', '', '00000000-0000-0000-0000-000000000000')
     ORDER BY sort_key, full_name, id LIMIT 50`,
    "contacts_user_sort_idx"
  );

  // --- Cold-start gate ------------------------------------------------------------
  //
  // The DDL sweep is idempotent but not free: on `neon-http` every statement is its own
  // HTTPS request, so replaying ~165 of them was the largest single cost in a cold start.
  // What matters is that a database already at the current version is confirmed with one
  // query and the sweep is skipped entirely.
  console.log("\ncold-start gate");
  const { SCHEMA_VERSION, schemaIsCurrent, recordSchemaVersion } = await import("../src/db");

  let statements = 0;
  const counting = (statement: string) => {
    statements++;
    return client.query(statement);
  };

  check("an unversioned database is not current", !(await schemaIsCurrent(counting)));
  await recordSchemaVersion(counting);

  statements = 0;
  const current = await schemaIsCurrent(counting);
  check("a versioned database reports current", current);
  // The CREATE TABLE IF NOT EXISTS guard plus the SELECT.
  check(`the check costs 2 statements, not ~165 (${statements})`, statements <= 2);

  await client.query(
    `UPDATE schema_migrations SET version = ${SCHEMA_VERSION + 1} WHERE id = 1`
  );
  check("a version mismatch forces the full sweep", !(await schemaIsCurrent(client.query.bind(client))));

  await client.close();
  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
  // tsx keeps the loop alive on PGlite's workers without this.
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
