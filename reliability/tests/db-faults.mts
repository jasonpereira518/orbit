// What the app does when the database hangs, errors or refuses, using the real src/db and
// src/lib/health code against the local neon shim's fault injection. Local only.
//
//   npx tsx reliability/lib/with-shim.mts reliability/tests/db-faults.mts
import { sql } from "drizzle-orm";
import fs from "node:fs";
import { getDb } from "../../src/db";
import { checkHealth } from "../../src/lib/health";

const shim = process.env.NEON_SHIM_URL!.replace(/\/sql$/, "");
const HANG_CAP_MS = Number(process.env.HANG_CAP_MS ?? 120_000);

async function fault(body: object) {
  await fetch(`${shim}/__fault`, { method: "POST", body: JSON.stringify(body) });
}
async function shimRequests(): Promise<number> {
  return (await (await fetch(`${shim}/__stats`)).json()).requests;
}

async function timeQuery(label: string, capMs: number) {
  const db = await getDb();
  const before = await shimRequests();
  const started = Date.now();
  let outcome: string;
  try {
    const cap = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`STILL PENDING after ${capMs} ms`)), capMs));
    await Promise.race([db.execute(sql`SELECT count(*) FROM user_settings`), cap]);
    outcome = "ok";
  } catch (err) {
    outcome = String((err as Error).message).slice(0, 160);
  }
  const ms = Date.now() - started;
  const attempts = (await shimRequests()) - before;
  console.log(`${label}: ${ms} ms, attempts reaching the DB=${attempts}, outcome=${outcome}`);
  return { label, ms, attempts, outcome };
}

async function timeHealth(label: string) {
  const started = Date.now();
  const r = await checkHealth({ deep: false });
  const ms = Date.now() - started;
  console.log(`${label}: ${ms} ms -> status=${r.status} reason=${(r as { reason?: string }).reason ?? "-"}`);
  return { label, ms, status: r.status, reason: (r as { reason?: string }).reason ?? null };
}

const results: unknown[] = [];
await fault({ mode: "none" });
results.push(await timeQuery("baseline query", 10_000));
results.push(await timeHealth("baseline health"));

await fault({ mode: "latency", ms: 3000 });
results.push(await timeQuery("DB latency 3s: query", 10_000));
results.push(await timeHealth("DB latency 3s: health"));

await fault({ mode: "latency", ms: 5000 });
results.push(await timeHealth("DB latency 5s: health"));

await fault({ mode: "http", status: 503 });
results.push(await timeQuery("DB answers HTTP 503: query", 10_000));
results.push(await timeHealth("DB answers HTTP 503: health"));

await fault({ mode: "refuse" });
results.push(await timeQuery("DB connection dropped: query", 10_000));

await fault({ mode: "hang" });
results.push(await timeHealth("DB hangs: health"));
results.push(await timeQuery("DB hangs: query (no client timeout)", HANG_CAP_MS));

await fault({ mode: "none" });
fs.writeFileSync("reliability/results/db-faults.json", JSON.stringify(results, null, 2));
process.exit(0);
