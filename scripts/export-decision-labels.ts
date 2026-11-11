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
 *  - work-history-recheck: web-found moves → "must not skip"; web profiles with no move in the
 *    year before their last check → "may skip" (`--task skip-gates`; see the section below).
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
// Pure: imports `@/db` but never calls it, so nothing here can reconcile the target schema.
import { shapeRecheckGateState } from "../src/lib/work-history-gates";

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

  // ---- work-history re-check gate: past checks, rebuilt as of the day they ran ----
  // Orbit keeps only a contact's LATEST check date, so a past check is reconstructed:
  //  - a web-found move (contact_career_moves, source 'web') → "must not skip", as of the day it
  //    was found, with the role they left as the current one;
  //  - a web profile with no web move in the year before its last check → "may skip", as of
  //    that check, with today's current roles (unchanged by definition).
  // The previous check is taken as RECHECK_LOOKBACK_DAYS before; the relationship digest is
  // left out because it is written today and would leak what happened after the check.
  const RECHECK_LOOKBACK_DAYS = 90;
  const moves = (await sql`
    SELECT m.contact_id::text AS contact_id, m.from_org, m.from_title, m.detected_at,
           c.title, c.company, c.closeness_tier
      FROM contact_career_moves m
      JOIN contacts c ON c.id = m.contact_id AND c.user_id = m.user_id
     WHERE m.user_id = ${userId} AND m.source = 'web' AND m.from_org IS NOT NULL
     ORDER BY m.detected_at DESC
     LIMIT 300
  `) as Array<{ contact_id: string; from_org: string; from_title: string | null; detected_at: string; title: string | null; company: string | null; closeness_tier: string | null }>;
  const steady = (await sql`
    SELECT p.contact_id::text AS contact_id, p.captured_at, c.title, c.company, c.closeness_tier
      FROM contact_profiles p
      JOIN contacts c ON c.id = p.contact_id AND c.user_id = p.user_id
     WHERE p.user_id = ${userId} AND p.source = 'web'
       AND NOT EXISTS (
         SELECT 1 FROM contact_career_moves m
          WHERE m.user_id = p.user_id AND m.contact_id = p.contact_id AND m.source = 'web'
            AND m.detected_at > p.captured_at - interval '365 days')
     ORDER BY p.captured_at DESC
     LIMIT 300
  `) as Array<{ contact_id: string; captured_at: string; title: string | null; company: string | null; closeness_tier: string | null }>;
  const currentRoles = (await sql`
    SELECT contact_id::text AS contact_id, organization, title, start_year, start_month
      FROM contact_experiences
     WHERE user_id = ${userId} AND kind = 'role' AND is_current
  `) as Array<{ contact_id: string; organization: string; title: string | null; start_year: number | null; start_month: number | null }>;
  const notes = (await sql`
    SELECT contact_id::text AS contact_id, interaction_type, interaction_date, ai_summary
      FROM interactions
     WHERE user_id = ${userId} AND ai_summary IS NOT NULL
  `) as Array<{ contact_id: string; interaction_type: string; interaction_date: string; ai_summary: string }>;
  const notesBetween = (contactId: string, from: Date, to: Date) =>
    notes
      .filter((n) => n.contact_id === contactId)
      .map((n) => ({ type: n.interaction_type, date: new Date(n.interaction_date), summary: n.ai_summary }))
      .filter((n) => n.date > from && n.date < to);
  const recheckCases = [
    ...moves.map((m, i) => {
      const checkAt = new Date(m.detected_at);
      const lastCheckedAt = new Date(checkAt.getTime() - RECHECK_LOOKBACK_DAYS * 86_400_000);
      return {
        id: `own-moved-${i + 1}`,
        gate: "workHistoryRecheck",
        state: shapeRecheckGateState({
          roles: [{ organization: m.from_org, title: m.from_title, startYear: null, startMonth: null, isCurrent: true }],
          title: m.title,
          company: m.company,
          closenessTier: m.closeness_tier,
          lastCheckedAt,
          now: checkAt,
          interactions: notesBetween(m.contact_id, lastCheckedAt, checkAt),
          digest: null,
        }),
        skip: false,
        why: "a web search found a move",
      };
    }),
    ...steady.map((p, i) => {
      const checkAt = new Date(p.captured_at);
      const lastCheckedAt = new Date(checkAt.getTime() - RECHECK_LOOKBACK_DAYS * 86_400_000);
      return {
        id: `own-steady-${i + 1}`,
        gate: "workHistoryRecheck",
        state: shapeRecheckGateState({
          roles: currentRoles
            .filter((r) => r.contact_id === p.contact_id)
            .map((r) => ({ organization: r.organization, title: r.title, startYear: r.start_year, startMonth: r.start_month, isCurrent: true })),
          title: p.title,
          company: p.company,
          closenessTier: p.closeness_tier,
          lastCheckedAt,
          now: checkAt,
          interactions: notesBetween(p.contact_id, lastCheckedAt, checkAt),
          digest: null,
        }),
        skip: true,
        why: "no web-found move in the year before the last check",
      };
    }),
  ];

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(outDir, "duplicates.json"), `${JSON.stringify({ pairs }, null, 1)}\n`, { mode: 0o600 });
  writeFileSync(join(outDir, "mentions.json"), `${JSON.stringify({ cases }, null, 1)}\n`, { mode: 0o600 });
  writeFileSync(join(outDir, "work-history-recheck.json"), `${JSON.stringify({ cases: recheckCases }, null, 1)}\n`, { mode: 0o600 });
  console.log(
    `export-decision-labels: ${pairs.filter((p) => !p.same).length} different-people pairs, ` +
      `${pairs.filter((p) => p.same).length} same-person pairs, ${cases.length} mention picks, ` +
      `${moves.length} work-history moves + ${steady.length} steady checks → ${outDir}`
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
