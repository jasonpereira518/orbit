/**
 * Re-prices an export of `usage_events` with today's price table, per operation and model.
 *
 * WHY. Every row stores the cost estimated at write time, and until Sep 19 2026 the table
 * had Gemini 3.5 Flash at $0.30/$2.50 (Google charges $1.50/$9.00). This turns an export of
 * the last 30 days into the real picture: which features actually spend the money, and by
 * how much the managed allowance was under-metered.
 *
 * It never touches a database. Run the query below read-only in the Neon console, export the
 * result as CSV, and pass the file:
 *
 *   SELECT operation, provider, model, key_owner,
 *          count(*)                              AS calls,
 *          coalesce(sum(input_tokens), 0)        AS input_tokens,
 *          coalesce(sum(output_tokens), 0)       AS output_tokens,
 *          coalesce(sum(cached_input_tokens), 0) AS cached_input_tokens,
 *          coalesce(sum(estimated_cost_micros), 0) AS recorded_micros
 *   FROM usage_events
 *   WHERE created_at > now() - interval '30 days' AND success = 1
 *   GROUP BY 1, 2, 3, 4;
 *
 *   npx tsx scripts/reprice-usage.ts usage.csv
 *
 * Gemini rows written before the fix carry no thinking tokens, so their re-priced cost is a
 * FLOOR, not an estimate — the real bill was higher still.
 */
import { readFileSync } from "node:fs";
import { estimateCostMicros, formatCostMicros } from "../src/lib/ai-pricing";
import { aiOperationLabel } from "../src/lib/ai-operations";
import { MANAGED_AI_BUDGET } from "../src/lib/managed-ai-policy";

type Row = {
  operation: string;
  provider: string;
  model: string;
  keyOwner: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  recordedMicros: number;
};

/** Minimal CSV: header row, comma-separated, optional double quotes (no embedded commas). */
function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`CSV is missing the "${name}" column (have: ${header.join(", ")})`);
    return i;
  };
  const idx = {
    operation: col("operation"),
    provider: col("provider"),
    model: col("model"),
    keyOwner: col("key_owner"),
    calls: col("calls"),
    input: col("input_tokens"),
    output: col("output_tokens"),
    cached: col("cached_input_tokens"),
    recorded: col("recorded_micros"),
  };
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    return {
      operation: cells[idx.operation],
      provider: cells[idx.provider],
      model: cells[idx.model],
      keyOwner: cells[idx.keyOwner],
      calls: Number(cells[idx.calls]),
      inputTokens: Number(cells[idx.input]),
      outputTokens: Number(cells[idx.output]),
      cachedInputTokens: Number(cells[idx.cached]),
      recordedMicros: Number(cells[idx.recorded]),
    };
  });
}

const usd = (micros: number) => formatCostMicros(micros) ?? "—";
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: npx tsx scripts/reprice-usage.ts <export.csv>  (see the header for the query)");
    process.exit(2);
  }
  const rows = parseCsv(readFileSync(path, "utf8"));

  type Agg = { calls: number; recorded: number; repriced: number; unpriced: number };
  const byOp = new Map<string, Agg>();
  const byOwner = new Map<string, Agg>();
  const add = (m: Map<string, Agg>, key: string, r: Row, repriced: number | null) => {
    const a = m.get(key) ?? { calls: 0, recorded: 0, repriced: 0, unpriced: 0 };
    a.calls += r.calls;
    a.recorded += r.recordedMicros;
    if (repriced === null) a.unpriced += r.calls;
    else a.repriced += repriced;
    m.set(key, a);
  };

  for (const r of rows) {
    const repriced = estimateCostMicros({
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cachedInputTokens: r.cachedInputTokens,
    });
    add(byOp, r.operation, r, repriced);
    add(byOwner, r.keyOwner, r, repriced);
  }

  const total = [...byOp.values()].reduce((n, a) => n + a.repriced, 0);
  console.log("\nSpend by operation, last 30 days, at today's prices (successful calls)\n");
  console.log(
    `${pad("operation", 38)}${lpad("calls", 8)}${lpad("recorded", 11)}${lpad("repriced", 11)}${lpad("share", 7)}${lpad("$/call", 10)}`
  );
  for (const [op, a] of [...byOp].sort((x, y) => y[1].repriced - x[1].repriced)) {
    const share = total > 0 ? `${Math.round((a.repriced / total) * 100)}%` : "—";
    const perCall = a.calls > a.unpriced ? a.repriced / (a.calls - a.unpriced) : 0;
    console.log(
      `${pad(`${aiOperationLabel(op)}`, 38)}${lpad(a.calls.toLocaleString("en-US"), 8)}${lpad(usd(a.recorded), 11)}${lpad(usd(a.repriced), 11)}${lpad(share, 7)}${lpad(`$${(perCall / 1_000_000).toFixed(4)}`, 10)}${a.unpriced ? `  (${a.unpriced} unpriced)` : ""}`
    );
  }

  console.log("\nBy whose key paid\n");
  for (const [owner, a] of byOwner) {
    const ratio = a.recorded > 0 ? a.repriced / a.recorded : null;
    console.log(
      `${pad(owner, 8)} recorded ${lpad(usd(a.recorded), 9)}  repriced ${lpad(usd(a.repriced), 9)}  ratio ${ratio === null ? "—" : `${ratio.toFixed(2)}×`}`
    );
  }

  const orbit = byOwner.get("orbit");
  if (orbit && orbit.recorded > 0) {
    const ratio = orbit.repriced / orbit.recorded;
    const sameCallCount = Math.ceil((1_000_000 * ratio) / 250_000) * 250_000;
    console.log(
      `\nManaged keys were under-metered ${ratio.toFixed(2)}×. Keeping the Sep 16 call count means a cap of about ${usd(sameCallCount)} (currently ${usd(MANAGED_AI_BUDGET.monthlyCostMicros)}) — before thinking tokens, which old Gemini rows never recorded.`
    );
  }
  process.exit(0);
}

main();
