/**
 * `relatedSqlLower` gives exactly the string the previous `translate()` gave (LATENCY_PLAN
 * DB-8), over the characters that make lowering interesting, and is much faster on a big corpus.
 *
 * Related contacts finds who mentions the person by matching every contact's notes, summary
 * and facts against `mentionLikePatterns`, after lowering them the way JS `toLowerCase()`
 * lowers ASCII. That lowering was `translate(text, 'A..Z' || U+212A, 'a..z' || 'k')` plus a
 * U+0130 replace, and translate cost ~1 s per profile at 5,000 contacts. It is now
 * `lower(text COLLATE "C")` (ASCII only) plus two replaces; this pins the two to each other.
 *
 * Runs against a throwaway PGlite. Run: npx tsx scripts/smoke-related-sql-lower.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { RELATED_SQL_LOWER } from "../src/lib/related-contacts";
import { relatedSqlLower } from "../src/lib/related-contacts-sql";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const SAMPLES = [
  "Sarah CHEN met Grace Hopper",
  "Kelvin (KELVIN SIGN) and K",
  "İstanbul, ıstanbul, ISTANBUL", // dotted capital I, dotless i
  "ÉCOLE Normale, Ærøskøbing, ÅSA",
  "STRASSE Straße ẞ",
  "ΣΙΣΥΦΟΣ σίσυφος",
  "ДМИТРИЙ Дмитрий",
  "emoji 👋 Zoë O'NEIL_100% \\ back",
  "",
  "   MiXeD   CaSe   ",
];

const before = (text: ReturnType<typeof sql>) =>
  sql`replace(translate(${text}, ${RELATED_SQL_LOWER.from}::text, ${RELATED_SQL_LOWER.to}::text), chr(304), chr(105) || chr(775))`;

run(async () => {
  const db = await getDb();

  console.log("The new lowering equals the old one character for character...");
  for (const s of SAMPLES) {
    const [row] = rowsOf<{ a: string; b: string; js: string }>(
      await db.execute(sql`SELECT ${relatedSqlLower(sql`${s}::text`)} AS a, ${before(sql`${s}::text`)} AS b, ${s}::text AS js`)
    );
    check(JSON.stringify(s), row!.a === row!.b, `${JSON.stringify(row!.a)} vs ${JSON.stringify(row!.b)}`);
  }

  console.log("\nAnd agrees with JS toLowerCase wherever the JS result is ASCII...");
  for (const s of SAMPLES) {
    const [row] = rowsOf<{ a: string }>(await db.execute(sql`SELECT ${relatedSqlLower(sql`${s}::text`)} AS a`));
    const js = [...s.toLowerCase()];
    const sqlChars = [...row!.a];
    const aligned = js.length === sqlChars.length && js.every((c, i) => c.codePointAt(0)! >= 0x80 || c === sqlChars[i]);
    check(JSON.stringify(s), aligned, `${JSON.stringify(row!.a)} vs ${JSON.stringify(s.toLowerCase())}`);
  }

  console.log("\nOver a large corpus it is several times faster...");
  {
    const corpus = sql`(SELECT string_agg('Met SARAH Chen at the ACME offsite, talked hiring ' || g, ' ') AS t FROM generate_series(1, 40000) g)`;
    const time = async (expr: (t: ReturnType<typeof sql>) => ReturnType<typeof sql>) => {
      const t = performance.now();
      await db.execute(sql`SELECT length(${expr(sql`c.t`)}) FROM ${corpus} c`);
      return performance.now() - t;
    };
    await time(relatedSqlLower); // warm
    const oldMs = await time(before);
    const newMs = await time(relatedSqlLower);
    check("faster than translate() by at least 3x", newMs * 3 < oldMs, `${Math.round(newMs)} ms vs ${Math.round(oldMs)} ms`);
  }

  console.log(failures === 0 ? "\nAll related SQL lowering checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures) process.exit(1);
});
