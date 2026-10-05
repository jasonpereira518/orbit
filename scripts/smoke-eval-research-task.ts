/**
 * The research eval's plumbing, with no AI key.
 *
 * The eval itself needs a key — it scores whole answers — so the only place it would
 * otherwise run is someone's machine with credentials, where a broken harness is discovered
 * after the money is spent. This runs the task on a throwaway database with no key at all and
 * checks everything that does not need one:
 *
 *  - the network and the notes seed, and the notes index through the real sweep;
 *  - routing is scored for EVERY case even though every answer fails — it is decided before
 *    any answer is written, and the fixture's expectations must match the router exactly;
 *  - a case with no grant fails as a scored miss, not as a crash that loses the whole run;
 *  - the task leaves its user empty, so the chat task in the same invocation starts clean.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-eval-research-task.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { chatThreads, contacts, interactions, memoryChunks } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { runResearchTask } from "./lib/eval-ai-tasks";

const USER = "smoke-eval-research-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  await ensureUserSettings(USER);
  const lines: string[] = [];
  const result = await runResearchTask({ userId: USER, log: (l) => lines.push(l) });

  check("every fixture case ran", result.cases === 10, String(result.cases));
  check(
    "routing was scored for every case, and matches the fixture exactly",
    result.metrics.routingAccuracy === 1,
    `${result.metrics.routingAccuracy} — ${lines.filter((l) => l.includes("research/")).join(" | ")}`
  );
  check(
    "with no key every answer fails as a scored miss, not a crash",
    result.misses.length === result.cases && lines.every((l) => !l.includes("TypeError")),
    lines.join("\n")
  );
  // "Every case failed" would also be true if seeding or retrieval broke. Each failure must be
  // the one expected here — no AI grant — and nothing else.
  const failed = lines.filter((l) => l.includes("FAIL research/"));
  check(
    "and every failure is the missing key, not something the harness broke",
    failed.length === result.cases && failed.every((l) => /API key/i.test(l)),
    failed.join("\n")
  );
  check(
    "and the misses count against recall rather than vanishing from it",
    result.metrics.mentionRecall === 0 && result.metrics.factRecall === 0,
    JSON.stringify(result.metrics)
  );
  check(
    "no invented ids are reported when no answer was written",
    result.metrics.inventedContactIds === 0 && result.metrics.forbiddenHits === 0,
    JSON.stringify(result.metrics)
  );

  const db = await getDb();
  const left = {
    contacts: (await db.query.contacts.findMany({ where: eq(contacts.userId, USER), columns: { id: true } })).length,
    interactions: (await db.query.interactions.findMany({ where: eq(interactions.userId, USER), columns: { id: true } })).length,
    chunks: (await db.query.memoryChunks.findMany({ where: eq(memoryChunks.userId, USER), columns: { id: true } })).length,
    threads: (await db.query.chatThreads.findMany({ where: eq(chatThreads.userId, USER), columns: { id: true } })).length,
  };
  check(
    "the task leaves its user empty, so a chat run in the same invocation starts clean",
    Object.values(left).every((n) => n === 0),
    JSON.stringify(left)
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll research-eval harness checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
