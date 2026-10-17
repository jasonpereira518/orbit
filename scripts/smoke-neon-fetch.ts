/**
 * The Neon driver's fetch: a deadline on every statement, one retry of a plain read on a
 * connection failure or 502/503/504, and never a retry of a write, a batch, a lock or a
 * timeout. Driven against a local HTTP server, no database.
 *
 * Run: npx tsx scripts/smoke-neon-fetch.ts
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createResilientFetch, dbQueryTimeoutMs, isRetryableRead } from "../src/db/neon-fetch";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const body = (query: string) => JSON.stringify({ query, params: [] });

console.log("which statements may be sent twice");
check("select", isRetryableRead(body("SELECT 1")));
check("show", isRetryableRead(body("  show statement_timeout")));
check("insert is not", !isRetryableRead(body("INSERT INTO t VALUES (1)")));
check("update is not", !isRetryableRead(body("UPDATE t SET a = 1")));
check("a CTE is not", !isRetryableRead(body("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x")));
check("select ... for update is not", !isRetryableRead(body("SELECT id FROM t FOR UPDATE SKIP LOCKED")));
check("a batch is not", !isRetryableRead(JSON.stringify({ queries: [{ query: "SELECT 1" }] })));
check("junk is not", !isRetryableRead("not json") && !isRetryableRead(undefined));
check("timeout env: default and floor",
  dbQueryTimeoutMs({} as NodeJS.ProcessEnv) === 30_000 &&
  dbQueryTimeoutMs({ DB_QUERY_TIMEOUT_MS: "5000" } as unknown as NodeJS.ProcessEnv) === 5_000 &&
  dbQueryTimeoutMs({ DB_QUERY_TIMEOUT_MS: "5" } as unknown as NodeJS.ProcessEnv) === 30_000);

async function main() {
  let mode: "ok" | "503" | "hang" | "drop-once" = "ok";
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    req.resume();
    if (mode === "hang") return;
    if (mode === "503") { res.writeHead(503); return res.end("down"); }
    if (mode === "drop-once" && hits === 1) return req.socket.destroy();
    res.writeHead(200); res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sql`;
  const f = createResilientFetch(undefined, { timeoutMs: 400, retryDelayMs: () => 5 });
  const post = (query: string) => f(url, { method: "POST", body: body(query) });

  async function run(m: typeof mode, query: string) {
    mode = m; hits = 0;
    const started = Date.now();
    let outcome = "ok";
    try { outcome = String((await post(query)).status); } catch (e) { outcome = (e as Error).name; }
    return { outcome, hits, ms: Date.now() - started };
  }

  console.log("\nbehaviour");
  let r = await run("ok", "SELECT 1");
  check("a healthy read is one request", r.outcome === "200" && r.hits === 1);
  r = await run("503", "SELECT 1");
  check("a read answered 503 is retried once, then returns the 503", r.outcome === "503" && r.hits === 2, JSON.stringify(r));
  r = await run("503", "UPDATE t SET a = 1");
  check("a write answered 503 is NOT retried", r.outcome === "503" && r.hits === 1, JSON.stringify(r));
  r = await run("drop-once", "SELECT 1");
  check("a read whose connection drops is retried and succeeds", r.outcome === "200" && r.hits === 2, JSON.stringify(r));
  r = await run("drop-once", "UPDATE t SET a = 1");
  check("a write whose connection drops is NOT retried", r.outcome !== "200" && r.hits === 1, JSON.stringify(r));
  r = await run("hang", "SELECT 1");
  check("a hung read fails at the deadline, not after minutes, and is not retried",
    r.outcome === "TimeoutError" && r.hits === 1 && r.ms >= 350 && r.ms < 1500, JSON.stringify(r));
  r = await run("hang", "UPDATE t SET a = 1");
  check("a hung write fails at the deadline", r.outcome === "TimeoutError" && r.hits === 1 && r.ms < 1500, JSON.stringify(r));


  server.close();

  console.log(failures === 0 ? "\nAll neon-fetch checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
