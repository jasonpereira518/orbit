/**
 * Merging the duplicates the app is confident about, without asking.
 *
 * Prevention (`contact_identities`) stops new duplicates. This handles the ones already in
 * the database — from imports that predate it, or from a contact edited after the fact to
 * carry someone else's email.
 *
 * The rule is the same one every write path uses: at or above `DUPLICATE_MERGE_CONFIDENCE`
 * (0.85) the app decides, below it a human does. So a shared email, LinkedIn profile or X
 * handle is merged here, as is a shared name + company (0.90) or name + title (0.85). A bare
 * shared full name (0.60) is not — two different people can be called the same thing, and
 * that is the one case worth interrupting someone for.
 *
 * The tiers are expressed in the SQL below rather than by importing the constant: this
 * selects and scores in one query instead of scoring rows in JS, so the thresholds live
 * where the comparison happens. Keep them in step with `findDuplicateCandidatesIndexed`.
 *
 * Nothing here is destructive. Every merge archives the losing contact whole in
 * `contact_merges`, appears in the recent-merges list, and can be undone.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { duplicateSuggestions } from "@/db/schema";
import {
  invalidateAfterMerges,
  mergeContacts,
  recordDuplicateSuggestions,
  type DuplicateSuggestionPair,
} from "@/lib/contact-merge";
import { DUPLICATE_TUNING } from "@/lib/decisions/catalog";
import { canAct, NO_ENGINES, type Engines } from "@/lib/decisions/engine";
import { DUPLICATE_MERGE_CONFIDENCE } from "@/lib/duplicates";
import { loadPersonCards, nameMergeVetoes, samePersonProbabilities } from "@/lib/decisions/duplicates";

export type SweepResult = {
  merged: number;
  /** Pairs the sweep looked at and deliberately did not merge. */
  leftForReview: number;
  /** Name-evidence merges the decision model stopped (kept apart, queued for review). */
  vetoed?: number;
};

/**
 * Bare shared-name pairs (0.60), for the decision model's autonomous merge. Only read when
 * that merge is enabled (`DUPLICATE_TUNING.jev.act`), which it ships not to be.
 */
async function bareNamePairs(userId: string, limit: number): Promise<Pair[]> {
  const db = await getDb();
  const rows = await db.execute(sql`
    SELECT a.id::text AS a, b.id::text AS b, a.created_at AS a_created, b.created_at AS b_created
      FROM contacts a
      JOIN contacts b
        ON b.user_id = a.user_id AND a.id < b.id
       AND lower(btrim(b.full_name)) = lower(btrim(a.full_name))
     WHERE a.user_id = ${userId}
       AND btrim(coalesce(a.full_name, '')) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM duplicate_suggestions s
          WHERE s.user_id = ${userId} AND s.status = 'dismissed'
            AND s.contact_a_id = a.id AND s.contact_b_id = b.id)
     LIMIT ${limit}
  `);
  const raw = (Array.isArray(rows) ? rows : rows.rows) as {
    a: string;
    b: string;
    a_created: Date | string | null;
    b_created: Date | string | null;
  }[];
  const time = (v: Date | string | null) => (v ? new Date(v).getTime() : 0);
  return raw.map((r) => {
    const aFirst = time(r.a_created) !== time(r.b_created) ? time(r.a_created) < time(r.b_created) : r.a < r.b;
    return { keepId: aFirst ? r.a : r.b, mergeId: aFirst ? r.b : r.a, reason: "Same full name", confidence: 0.6 };
  });
}

type Pair = { keepId: string; mergeId: string; reason: string; confidence: number };

/**
 * Pairs of contacts the app can be sure about, newest evidence first.
 *
 * Two sources, both expressed as a single query so a sweep costs a bounded number of
 * statements rather than one per contact:
 *
 *  - A contact carrying an identifier whose `contact_identities` row belongs to a *different*
 *    contact. By the unique index those are necessarily two rows describing one person — the
 *    loser of a claim, which is exactly the shape a pre-existing duplicate leaves behind.
 *  - Two contacts with the same normalised full name AND the same company or title. Those
 *    clear the confidence line (0.90 / 0.85) the same way they do on a live write.
 *
 * `LEAST`/`GREATEST` on the ids gives each unordered pair one spelling, so a three-way
 * duplicate does not produce the same merge twice in one pass. Dismissed pairs are honoured:
 * if someone has said "not the same person", the sweep must not overrule them.
 */
async function confidentPairs(userId: string, limit: number): Promise<Pair[]> {
  const db = await getDb();
  const rows = await db.execute(sql`
    WITH pairs AS (
      -- Identifier collisions: one contact owns the identity row, another carries the value.
      SELECT LEAST(i.contact_id, c.id) AS a,
             GREATEST(i.contact_id, c.id) AS b,
             CASE i.kind
               WHEN 'email' THEN 'Same email'
               WHEN 'linkedin_slug' THEN 'Same LinkedIn profile'
               WHEN 'x_handle' THEN 'Same X handle'
               ELSE 'Same phone'
             END AS reason,
             0.95::real AS confidence
        FROM contact_identities i
        JOIN contacts c
          ON c.user_id = i.user_id
         AND c.id <> i.contact_id
         AND (
               (i.kind = 'email'         AND lower(btrim(c.email))    = i.value)
            OR (i.kind = 'linkedin_slug' AND c.linkedin_slug          = i.value)
            OR (i.kind = 'x_handle'      AND lower(btrim(c.x_handle)) = i.value)
         )
       WHERE i.user_id = ${userId}

      UNION

      -- Same name, corroborated by employer or role.
      SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id),
             CASE WHEN lower(btrim(a.company)) = lower(btrim(b.company))
                  THEN 'Same name + company' ELSE 'Same name + title' END,
             CASE WHEN lower(btrim(a.company)) = lower(btrim(b.company))
                  THEN 0.90::real ELSE 0.85::real END
        FROM contacts a
        JOIN contacts b
          ON b.user_id = a.user_id
         AND a.id < b.id
         AND lower(btrim(b.full_name)) = lower(btrim(a.full_name))
         AND (
               (btrim(coalesce(a.company, '')) <> ''
                AND lower(btrim(a.company)) = lower(btrim(b.company)))
            OR (btrim(coalesce(a.title, '')) <> ''
                AND lower(btrim(a.title)) = lower(btrim(b.title)))
         )
       WHERE a.user_id = ${userId}
         AND btrim(coalesce(a.full_name, '')) <> ''
    )
    SELECT p.a::text AS a, p.b::text AS b, p.reason, p.confidence,
           ca.created_at AS a_created, cb.created_at AS b_created
      FROM pairs p
      JOIN contacts ca ON ca.id = p.a
      JOIN contacts cb ON cb.id = p.b
     WHERE NOT EXISTS (
       -- A person has already said these are two different people. Never overrule that.
       SELECT 1 FROM duplicate_suggestions s
        WHERE s.user_id = ${userId}
          AND s.status = 'dismissed'
          AND s.contact_a_id = p.a AND s.contact_b_id = p.b)
     ORDER BY p.confidence DESC
     LIMIT ${limit}
  `);

  const raw = (Array.isArray(rows) ? rows : rows.rows) as {
    a: string;
    b: string;
    reason: string;
    confidence: number;
    a_created: Date | string | null;
    b_created: Date | string | null;
  }[];

  const time = (v: Date | string | null) => (v ? new Date(v).getTime() : 0);
  return raw.map((r) => {
    // Older wins, tie-broken on the lower uuid — the same total order `pickWinner` uses on
    // the live write path, so a sweep and a write can never merge in opposite directions.
    const aFirst = time(r.a_created) !== time(r.b_created)
      ? time(r.a_created) < time(r.b_created)
      : r.a < r.b;
    return {
      keepId: aFirst ? r.a : r.b,
      mergeId: aFirst ? r.b : r.a,
      reason: r.reason,
      confidence: r.confidence,
    };
  });
}

/**
 * Merge every duplicate the app is confident about.
 *
 * Idempotent and safe to call repeatedly — a run with nothing to do costs one query. Bounded
 * by `maxMerges` so a deploy hook or a page render cannot turn into an unbounded job on a
 * large account; call again while `merged` keeps coming back non-zero.
 */
export async function mergeConfidentDuplicates(
  userId: string,
  options?: {
    maxMerges?: number;
    /**
     * The account's decision engines (`openEngines`). With Jev, every merge that rests on a
     * NAME — same name + company or title — is checked first, and a confident "different
     * people" keeps the two apart and queues the pair for review instead. Scripts pass none
     * and sweep exactly as before.
     */
    engines?: Engines;
  }
): Promise<SweepResult> {
  const maxMerges = options?.maxMerges ?? 200;
  const engines = options?.engines ?? NO_ENGINES;
  const deadline = Date.now() + DUPLICATE_TUNING.sweepBudgetMs;
  let merged = 0;
  let vetoed = 0;
  const keptApart = new Set<string>();
  const survivors = new Set<string>();

  // Re-read between passes rather than merging a whole snapshot: each merge deletes a
  // contact, so a three-way duplicate's second pair names a row that no longer exists.
  for (let pass = 0; pass < 25 && merged < maxMerges; pass++) {
    const pairs = (await confidentPairs(userId, Math.min(50, maxMerges - merged))).filter(
      (p) => !keptApart.has(`${p.keepId}:${p.mergeId}`)
    );
    if (!pairs.length) break;

    // Name evidence is checked before it merges anything; identifier evidence never is.
    const byName = pairs.filter((p) => p.reason.startsWith("Same name"));
    const remaining = deadline - Date.now();
    if (engines.jev && byName.length && remaining > 150) {
      const cards = await loadPersonCards(userId, byName.flatMap((p) => [p.keepId, p.mergeId]));
      const withCards = byName.filter((p) => cards.has(p.keepId) && cards.has(p.mergeId));
      const vetoes = await nameMergeVetoes(
        engines,
        withCards.map((p) => [cards.get(p.keepId)!, cards.get(p.mergeId)!] as const),
        remaining
      );
      const held: DuplicateSuggestionPair[] = [];
      for (const [i, pair] of withCards.entries()) {
        if (!vetoes[i]) continue;
        keptApart.add(`${pair.keepId}:${pair.mergeId}`);
        vetoed += 1;
        // Recorded just BELOW the confidence line: the review queue only lists pairs under it
        // (`findPendingSuggestions`), and at 0.90 this one would vanish instead of being asked.
        held.push({
          contactIdA: pair.keepId,
          contactIdB: pair.mergeId,
          reason: `${pair.reason} — held for review`,
          confidence: Math.min(pair.confidence, DUPLICATE_MERGE_CONFIDENCE - 0.01),
        });
      }
      // One insert for the pass. Best-effort as before: a failed write must not stop the sweep.
      await recordDuplicateSuggestions(userId, held).catch(() => null);
    }

    let mergedThisPass = 0;
    for (const pair of pairs) {
      if (keptApart.has(`${pair.keepId}:${pair.mergeId}`)) continue;
      if (merged >= maxMerges) break;
      try {
        await mergeContacts(userId, pair.keepId, pair.mergeId, {
          reason: pair.reason,
          confidence: pair.confidence,
          // One recompute at the end rather than per merge: closeness and embeddings are
          // recalculated for the whole account below.
          deferInvalidation: true,
        });
        merged += 1;
        mergedThisPass += 1;
        survivors.add(pair.keepId);
        // A contact merged away cannot also be a survivor of an earlier pair in this sweep.
        survivors.delete(pair.mergeId);
      } catch {
        // The other half was already merged by an earlier pair in this same pass. Skipped
        // rather than fatal — the next pass reads the current truth.
      }
    }
    // A pass that resolved nothing will not resolve anything next time either.
    if (mergedThisPass === 0) break;
  }

  // The decision model's own merges: bare shared-name pairs it is confident about. Off until
  // `DUPLICATE_TUNING.jev.act` is set from the calibration bins; every one is archived,
  // listed with its reason, and undoable (and an undo is remembered — see unmergeContacts).
  const actAbove = DUPLICATE_TUNING.jev.act;
  if (actAbove !== null && engines.jev && merged < maxMerges && deadline - Date.now() > 150) {
    const bare = await bareNamePairs(userId, Math.min(20, maxMerges - merged));
    const cards = await loadPersonCards(userId, bare.flatMap((p) => [p.keepId, p.mergeId]));
    const withCards = bare.filter((p) => cards.has(p.keepId) && cards.has(p.mergeId));
    const answers = await samePersonProbabilities(
      engines,
      withCards.map((p) => [cards.get(p.keepId)!, cards.get(p.mergeId)!] as const),
      { engines: ["jev"], budgetMs: deadline - Date.now() }
    );
    for (const [i, pair] of withCards.entries()) {
      const a = answers[i];
      const p = a?.engine === "jev" ? a.answer.probability : null;
      if (!canAct(a?.engine ?? "rules", p, actAbove)) continue;
      try {
        await mergeContacts(userId, pair.keepId, pair.mergeId, {
          reason: `Decision model: same person (${p!.toFixed(2)})`,
          confidence: p!,
          deferInvalidation: true,
        });
        merged += 1;
        survivors.add(pair.keepId);
        survivors.delete(pair.mergeId);
      } catch {
        // Already merged by an earlier pair.
      }
    }
  }

  // Deferred through the loop, done once here: invalidation marks the closeness cohort dirty
  // and rescores, and doing that per merge would recompute the same account dozens of times
  // during a bulk cleanup. Batched across survivors too (see `invalidateAfterMerges`), rather
  // than a handful of statements per survivor for up to `maxMerges` of them.
  await invalidateAfterMerges(userId, survivors).catch(() => null);

  const db = await getDb();
  const [remaining] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(duplicateSuggestions)
    .where(
      and(eq(duplicateSuggestions.userId, userId), eq(duplicateSuggestions.status, "pending"))
    );

  return { merged, leftForReview: Number(remaining?.n ?? 0), ...(vetoed ? { vetoed } : {}) };
}
