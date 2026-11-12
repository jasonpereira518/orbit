/**
 * The admin LinkedIn photo queue (`src/lib/linkedin-photo-queue.ts`): order, outcomes, the
 * durable LinkedIn pause and its backoff, the one-tick lease, Stop, and draining to `ok`.
 * LinkedIn is stubbed; Unavatar and Microlink always miss. No Blob store, so a found photo is
 * pooled as its https URL.
 *
 * Run: npx tsx scripts/smoke-linkedin-photo-queue.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
// A real Blob token in .env.local would send every found photo through the stubbed fetch.
delete process.env.BLOB_READ_WRITE_TOKEN;
import { eq, like, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, cronRuns, linkedinAvatars } from "../src/db/schema";
import { resetLinkedInDirectCooldownForTesting, setLinkedInScrapeFetchForTests } from "../src/lib/linkedin-scraper";
import {
  getLinkedInPhotoQueueMetrics,
  nextPendingSlugs,
  pauseMsFor,
  runLinkedInPhotoQueueTick,
  startLinkedInPhotoQueue,
  stopLinkedInPhotoQueue,
} from "../src/lib/linkedin-photo-queue";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const P = "smoke-lpq-";
const photo = (slug: string) => `https://media.licdn.com/dms/image/v2/${slug}/profile-displayphoto-shrink_200_200/0/1?e=1&t=x`;
const html = (img: string | null) =>
  `<html><head>${img ? `<meta property="og:image" content="${img}">` : ""}</head></html>`;

/** Per-slug LinkedIn behaviour; anything unlisted is a miss. */
let behaviour: Record<string, "hit" | "429" | "stop"> = {};
let fetched: string[] = [];
const noKick = async () => {};

run(async () => {
  const db = await getDb();
  const realFetch = globalThis.fetch;
  // Unavatar / Microlink: always a miss, never a network call.
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
  setLinkedInScrapeFetchForTests(async (url) => {
    const slug = decodeURIComponent(url.split("/in/")[1] ?? "");
    fetched.push(slug);
    const b = behaviour[slug];
    if (b === "429") return new Response("", { status: 429 });
    if (b === "stop") await stopLinkedInPhotoQueue();
    return new Response(html(b === "hit" ? photo(slug) : null), { status: 200 });
  });

  const cleanup = async () => {
    await db.delete(contacts).where(like(contacts.userId, `${P}%`));
    await db.delete(linkedinAvatars).where(like(linkedinAvatars.slug, `${P}%`));
    await db.delete(cronRuns).where(eq(cronRuns.job, "avatars.linkedin-queue"));
  };
  await cleanup();

  // a: 3 accounts, b: 2, c and d: 1 each (tie broken by slug). e already has a photo,
  // f was blocked, g has a fresh negative row, h a stale one (so it is due again).
  const seed = { a: 3, b: 2, d: 1, c: 1, e: 1, f: 1, g: 1, h: 1 };
  for (const [k, n] of Object.entries(seed)) {
    for (let i = 0; i < n; i++) {
      await db.insert(contacts).values({ userId: `${P}u${i}`, fullName: k, linkedinUrl: `https://www.linkedin.com/in/${P}${k}` });
    }
  }
  await db.insert(linkedinAvatars).values([
    { slug: `${P}e`, imageUrl: photo("e"), source: "unavatar" },
    { slug: `${P}f`, imageUrl: null, source: "unavatar", blockedAt: new Date(), blockedBy: "admin" },
    { slug: `${P}g`, imageUrl: null, source: "unavatar" },
    { slug: `${P}h`, imageUrl: null, source: "unavatar", resolvedAt: new Date(Date.now() - 40 * 86_400_000) },
  ]);

  console.log("Order...");
  const order = await nextPendingSlugs();
  check("most-shared first, ties by slug, done/blocked/fresh-negative left out",
    JSON.stringify(order) === JSON.stringify(["a", "b", "c", "d", "h"].map((k) => P + k)), JSON.stringify(order));

  console.log("\nA LinkedIn refusal pauses the run...");
  behaviour = { [`${P}a`]: "hit", [`${P}b`]: "429" };
  const runId = await startLinkedInPhotoQueue(noKick);
  let res = await runLinkedInPhotoQueueTick(runId, { paceMs: 0, kick: noKick });
  let row = (await db.select().from(cronRuns).where(eq(cronRuns.id, runId)))[0];
  check("tick paused", res === "paused", res);
  check("a found and pooled", (await db.select().from(linkedinAvatars).where(eq(linkedinAvatars.slug, `${P}a`)))[0]?.imageUrl === photo(`${P}a`));
  check("nothing fetched after the refusal", JSON.stringify(fetched) === JSON.stringify([`${P}a`, `${P}b`]), JSON.stringify(fetched));
  check("b left pending (no row)", (await db.select().from(linkedinAvatars).where(eq(linkedinAvatars.slug, `${P}b`))).length === 0);
  const pause1 = Number(row.stats.resumeAt) - Date.now();
  check("first pause is ~30 min", pause1 > 29 * 60_000 && pause1 <= 30 * 60_000, String(pause1));
  check("still running, one strike", row.status === "running" && row.stats.strikes === 1 && row.stats.found === 1);
  check("metrics say paused", (await getLinkedInPhotoQueueMetrics()).state === "paused");

  console.log("\nA paused run does not tick; the lease keeps ticks single...");
  fetched = [];
  check("paused run is not claimed", (await runLinkedInPhotoQueueTick(runId, { paceMs: 0, kick: noKick })) === "not-claimed");
  await db.execute(sql`UPDATE cron_runs SET stats = stats || ${JSON.stringify({ resumeAt: 0, leaseUntil: Date.now() + 60_000 })}::jsonb WHERE id = ${runId}`);
  check("held lease is not claimed", (await runLinkedInPhotoQueueTick(runId, { paceMs: 0, kick: noKick })) === "not-claimed");
  check("neither fetched anything", fetched.length === 0, JSON.stringify(fetched));

  console.log("\nSecond refusal in a row doubles the pause...");
  await db.execute(sql`UPDATE cron_runs SET stats = stats || '{"leaseUntil":0}'::jsonb WHERE id = ${runId}`);
  resetLinkedInDirectCooldownForTesting();
  res = await runLinkedInPhotoQueueTick(runId, { paceMs: 0, kick: noKick });
  row = (await db.select().from(cronRuns).where(eq(cronRuns.id, runId)))[0];
  const pause2 = Number(row.stats.resumeAt) - Date.now();
  check("paused again, 2 strikes, ~60 min", res === "paused" && row.stats.strikes === 2 && pause2 > 59 * 60_000, `${res} ${row.stats.strikes} ${pause2}`);
  check("backoff caps at 6 h", pauseMsFor(10) === 6 * 3_600_000);

  console.log("\nResume now, then Stop lands within one person...");
  resetLinkedInDirectCooldownForTesting();
  behaviour = { [`${P}b`]: "stop" };
  fetched = [];
  check("Start on a running run resumes it, same id", (await startLinkedInPhotoQueue(noKick)) === runId);
  res = await runLinkedInPhotoQueueTick(runId, { paceMs: 0, kick: noKick });
  row = (await db.select().from(cronRuns).where(eq(cronRuns.id, runId)))[0];
  check("tick stopped", res === "stopped", res);
  check("only b was fetched", JSON.stringify(fetched) === JSON.stringify([`${P}b`]), JSON.stringify(fetched));
  check("run is partial + stopped, strikes reset", row.status === "partial" && row.stats.stopped === true && row.stats.strikes === 0);
  check("b got its negative row", (await db.select().from(linkedinAvatars).where(eq(linkedinAvatars.slug, `${P}b`)))[0]?.imageUrl === null);

  console.log("\nA fresh run drains to ok and hands over between ticks...");
  behaviour = { [`${P}d`]: "hit" };
  fetched = [];
  let kicks = 0;
  const run2 = await startLinkedInPhotoQueue(noKick);
  check("a new run after a stopped one", run2 !== runId);
  res = await runLinkedInPhotoQueueTick(run2, { paceMs: 0, budgetMs: -1, kick: async () => { kicks++; } });
  check("out of budget: hands over to the next tick", res === "continue" && kicks === 1 && fetched.length === 0, `${res} ${kicks}`);
  res = await runLinkedInPhotoQueueTick(run2, { paceMs: 0, kick: noKick });
  row = (await db.select().from(cronRuns).where(eq(cronRuns.id, run2)))[0];
  check("drained", res === "done" && row.status === "ok", `${res} ${row.status}`);
  check("c, d, h each looked up once", JSON.stringify(fetched) === JSON.stringify(["c", "d", "h"].map((k) => P + k)), JSON.stringify(fetched));
  check("counts: d found, c and h missed", row.stats.found === 1 && row.stats.missed === 2, JSON.stringify(row.stats));
  check("h's stale negative was renewed", (await nextPendingSlugs()).length === 0);
  const m = await getLinkedInPhotoQueueMetrics();
  check("metrics: done, nothing left, no ETA", m.state === "done" && m.pending === 0 && m.etaMs === null);

  globalThis.fetch = realFetch;
  setLinkedInScrapeFetchForTests(null);
  await cleanup();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll LinkedIn photo queue checks passed.");
});
