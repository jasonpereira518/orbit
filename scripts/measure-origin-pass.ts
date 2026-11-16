/**
 * What the LinkedIn deep read's launch catch-up would cost one account, without a model call.
 *
 *   npx tsx scripts/measure-origin-pass.ts --user <user id>              # read-only estimate
 *   npx tsx scripts/measure-origin-pass.ts --user <user id> --sample 500 # measure more contacts
 *   npx tsx scripts/measure-origin-pass.ts --user <user id> --run 10     # really send 10 (one half-price batch)
 *
 * The estimate lists the contacts owed an origin check (never claiming them), builds each
 * window and prompt exactly as `runOriginPass` does, and prices the ones that need a model call
 * at the batch rate. It prints the same for contacts that become pending only because the deep
 * read also reads invitation notes and recommendations.
 *
 * `--run N` is not read-only: it calls `runOriginPass` capped at N contacts. It needs the deep
 * read on for the user (an admin id before launch) and a key that can batch. The answers land
 * with the next hourly sweep; real tokens and cost then show under Settings → Integrations →
 * AI provider as "Relationship analysis (how you met, one-time)".
 *
 * Reads the database `.env.local` points at.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { getAiConfig } from "../src/lib/ai";
import { loadYouCurrent } from "../src/lib/career-profile-server";
import { buildDigestPrompt, isTrivialWindow } from "../src/lib/relationship-engine/extract";
import { loadMessageWindows } from "../src/lib/relationship-engine/gather";
import { originPassEstimate, previewOriginPass, runOriginPass } from "../src/lib/relationship-engine/origin-pass";
import { claimPendingContacts, pendingRelationshipContactCount } from "../src/lib/relationship-engine/pending";
import { overlapContext } from "../src/lib/relationship-engine/runner";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dollars = (micros: number | null) => (micros === null ? "no known price for this model" : `$${(micros / 1_000_000).toFixed(2)}`);
const scale = (micros: number | null, contacts: number) => (micros === null ? null : (micros * contacts) / 1_000);

function report(title: string, total: number, sampled: number, trivial: number, prompts: Array<{ system: string; user: string }>, model: string) {
  const e = originPassEstimate(prompts, model);
  // The sample is the longest threads first, so the projection leans high.
  const sendShare = sampled ? prompts.length / sampled : 0;
  const projected = Math.round(total * sendShare);
  console.log(`\n${title}`);
  console.log(`  contacts                       ${total}`);
  console.log(`  measured                       ${sampled}${sampled < total ? ` (the first ${sampled}; pass --sample to measure more)` : ""}`);
  console.log(`  …nothing to read (free)        ${trivial}`);
  console.log(`  …sent to the model             ${prompts.length}`);
  console.log(`  input tokens per 1,000 sent    ${e.inputTokensPer1000.toLocaleString("en-US")}`);
  console.log(`  output tokens per 1,000 sent   ${e.outputTokensPer1000.toLocaleString("en-US")} typical, ${(2_000_000).toLocaleString("en-US")} at the cap`);
  console.log(`  cost per 1,000 sent            ${dollars(e.microsPer1000)} typical, ${dollars(e.microsPer1000Max)} worst case`);
  console.log(`  projected for this account     ~${projected} sent: ${dollars(scale(e.microsPer1000, projected))} typical, ${dollars(scale(e.microsPer1000Max, projected))} worst case`);
}

async function main() {
  const userId = arg("user");
  if (!userId) {
    console.error("usage: npx tsx scripts/measure-origin-pass.ts --user <user id> [--sample 300] [--run 10]");
    process.exit(2);
  }
  const run = arg("run");
  if (run !== undefined) {
    const limit = Number(run);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      console.error("--run takes a whole number from 1 to 100");
      process.exit(2);
    }
    const result = await runOriginPass(userId, { limit });
    console.log(`origin pass, capped at ${limit}:`, result);
    if (!result.claimed) console.log("Nothing was claimed: the deep read is off for this user (not an admin id?), the engine is off, or nothing is owed.");
    else if (!result.submitted && result.claimed > result.trivial) console.log("Nothing was submitted: no key that can batch right now. The claim was handed back.");
    return;
  }

  const sample = Number(arg("sample") ?? 300);
  const now = new Date();
  const model = await getAiConfig(userId, "relationship.digest").then((c) => c.model).catch(() => "unknown (no usable AI key)");
  console.log(`user   ${userId}\nmodel  ${model} (batch price: half)`);

  const preview = await previewOriginPass(userId, { sample, now });
  report("One-time origin pass (conversations already read)", preview.owed, preview.sampled, preview.trivial, preview.prompts, model);

  // Contacts that become pending only because the deep read reads signals too: a normal first read.
  const [withSignals, without] = await Promise.all([
    pendingRelationshipContactCount(userId, now, { deepRead: true }),
    pendingRelationshipContactCount(userId, now),
  ]);
  const plain = new Set(await claimPendingContacts(userId, 5_000, new Set(), now));
  const signalOnly = (await claimPendingContacts(userId, 5_000, new Set(), now, { deepRead: true })).filter((id) => !plain.has(id)).slice(0, sample);
  const db = await getDb();
  const [windows, people, you] = await Promise.all([
    loadMessageWindows(userId, signalOnly, { deepRead: true }),
    signalOnly.length
      ? db.select({ id: contacts.id, fullName: contacts.fullName }).from(contacts).where(and(eq(contacts.userId, userId), inArray(contacts.id, signalOnly)))
      : Promise.resolve([]),
    loadYouCurrent(userId),
  ]);
  const nameOf = new Map(people.map((p) => [p.id, p.fullName]));
  const prompts: Array<{ system: string; user: string }> = [];
  let trivial = 0;
  for (const id of signalOnly) {
    const window = windows.get(id);
    if (!window || isTrivialWindow(window, { deepRead: true })) {
      trivial += 1;
      continue;
    }
    prompts.push(buildDigestPrompt({ contactName: nameOf.get(id) ?? "Contact", window, previous: null, deepRead: true, context: await overlapContext(userId, id, you, now) }));
  }
  report("First read of contacts with only an invitation note or a recommendation", Math.max(0, withSignals - without), signalOnly.length, trivial, prompts, model);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
