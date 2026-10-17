// A local stand-in for Neon's HTTP SQL endpoint, backed by a real Postgres, with fault
// injection. It lets the app's unmodified neon-http code path (src/db/index.ts) run against a
// scratch database so migrations, restores and failure modes can be exercised locally.
//
// LOCAL ONLY. It refuses to start unless SHIM_PGHOST is localhost/127.0.0.1.
//
//   SHIM_PORT=4444 SHIM_PGHOST=127.0.0.1 SHIM_PGUSER=orbit SHIM_PGPASSWORD=... node lib/neon-shim.mjs
//
// Protocol (mirrors @neondatabase/serverless 1.x, see its index.mjs `execute`):
//   POST /sql  {query, params}             -> {fields, rows, rowCount, command}
//   POST /sql  {queries: [{query, params}]} -> {results: [...]}, run in one transaction
//   400 {message, code, ...} on a Postgres error
// The database is the pathname of the Neon-Connection-String header.
//
// Fault injection (POST /__fault with JSON):
//   {"mode":"none"} | {"mode":"hang"} | {"mode":"latency","ms":2000} | {"mode":"http","status":503}
//   {"mode":"refuse"} closes the socket without answering.
import http from "node:http";
import pg from "pg";

const host = process.env.SHIM_PGHOST ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(`neon-shim: refusing non-local Postgres host ${host}`);
  process.exit(1);
}

const pools = new Map();
function poolFor(database) {
  if (!pools.has(database)) {
    pools.set(
      database,
      new pg.Pool({
        host,
        port: Number(process.env.SHIM_PGPORT ?? 5432),
        user: process.env.SHIM_PGUSER ?? "orbit",
        password: process.env.SHIM_PGPASSWORD,
        database,
        max: Number(process.env.SHIM_POOL_MAX ?? 20),
      })
    );
  }
  return pools.get(database);
}

// Neon returns raw text; the driver parses types itself.
const rawTypes = { getTypeParser: () => (v) => v };

let fault = { mode: "none" };
const stats = { requests: 0, errors: 0 };

function shape(result) {
  const r = Array.isArray(result) ? result[result.length - 1] : result;
  return {
    fields: (r.fields ?? []).map((f) => ({
      name: f.name,
      dataTypeID: f.dataTypeID,
      tableID: f.tableID,
      columnID: f.columnID,
      dataTypeSize: f.dataTypeSize,
      dataTypeModifier: f.dataTypeModifier,
      format: "text",
    })),
    rows: r.rows ?? [],
    rowCount: r.rowCount,
    command: r.command,
    rowAsArray: true,
  };
}

function pgError(err) {
  const out = { message: err.message };
  for (const k of [
    "severity", "code", "detail", "hint", "position", "internalPosition", "internalQuery",
    "where", "schema", "table", "column", "dataType", "constraint", "file", "line", "routine",
  ]) {
    if (err[k] !== undefined) out[k] = err[k];
  }
  return out;
}

function q(client, { query, params }) {
  return client.query({ text: query, values: params ?? [], rowMode: "array", types: rawTypes });
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");

  if (req.url === "/__fault") {
    fault = JSON.parse(body || '{"mode":"none"}');
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, fault }));
  }
  if (req.url === "/__stats") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(stats));
  }

  stats.requests++;
  if (fault.mode === "hang") return; // never answer; the socket stays open
  if (fault.mode === "refuse") return req.socket.destroy();
  if (fault.mode === "http") {
    stats.errors++;
    res.writeHead(fault.status ?? 503, { "content-type": "text/plain" });
    return res.end("injected fault");
  }
  if (fault.mode === "latency") await new Promise((r) => setTimeout(r, fault.ms ?? 1000));

  let database = "postgres";
  try {
    database = new URL(req.headers["neon-connection-string"]).pathname.replace(/^\//, "") || "postgres";
  } catch {}

  const payload = JSON.parse(body);
  const pool = poolFor(database);
  try {
    if (Array.isArray(payload.queries)) {
      const client = await pool.connect();
      try {
        const iso = req.headers["neon-batch-isolation-level"];
        const ro = req.headers["neon-batch-read-only"] === "true";
        await client.query(
          `BEGIN${iso ? ` ISOLATION LEVEL ${iso.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase()}` : ""}${ro ? " READ ONLY" : ""}`
        );
        const results = [];
        for (const item of payload.queries) results.push(shape(await q(client, item)));
        await client.query("COMMIT");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results }));
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } else {
      const result = await q(pool, payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(shape(result)));
    }
  } catch (err) {
    stats.errors++;
    if (err.code) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(pgError(err)));
    } else {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(String(err?.message ?? err));
    }
  }
});

const port = Number(process.env.SHIM_PORT ?? 4444);
server.listen(port, "127.0.0.1", () => console.log(`neon-shim: listening on 127.0.0.1:${port} -> ${host}`));
