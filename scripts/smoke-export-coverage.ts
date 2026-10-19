/**
 * "Download my data" includes every table that holds the account's data — or says why not.
 *
 * `privacy/probe-export.ts` found 17 tables holding a user's data that the export never read
 * (the credit ledger, AI-suggested opportunities, the waitlist row, the operator's actions on
 * the account…). This seeds one row in every table for a fake account
 * (privacy/lib/seed-everything: every text value carries the account id), exports it, and
 * requires each table that holds the account to appear in the export — under its own name or
 * an alias below — or in EXCLUDED with a reason. A new table that stores user data without an
 * export source fails here.
 *
 * Also: the file is v3, ends with `"complete":true`, and carries nothing of a second account.
 *
 * Run: npx tsx scripts/smoke-export-coverage.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { collectUserExport } from "../src/lib/data-export";
import { readCatalog } from "../privacy/lib/catalog";
import { scanFor, seedEverything } from "../privacy/lib/seed-everything";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Tables exported under a dataset name of their own. */
const ALIASES: Record<string, string> = {
  recruiters: "recruiters_created",
  broadcast_recipients: "broadcasts_received",
  admin_audit_log: "operator_actions_on_account",
  webhook_deliveries: "account_events",
};

/** Tables that may hold the account's id but are deliberately not exported. */
const EXCLUDED: Record<string, string> = {
  data_purge_runs: "the progress log of a deletion this account asked for — operational, and empty for a live account",
  rate_limit_buckets: "request counters keyed by the account, gone within two days",
  linkedin_avatars: "a shared cache of public profile photos keyed by LinkedIn slug, not by account (the seeder put the id in it)",
  waitlist_poll_votes: "anonymous poll votes keyed by a cookie or a waitlist row, not the account (the seeder put the id in it)",
};

const ME = "user_export_cov_me";
const OTHER = "user_export_cov_other";

async function main() {
  const cat = await readCatalog();
  await seedEverything(cat, ME);
  await seedEverything(cat, OTHER);

  const exp = await collectUserExport(ME);
  check("the format is orbit-export/3", exp.format === "orbit-export/3", exp.format);
  check("the file says it is complete", exp.complete === true);
  check("16 categories", Object.keys(exp.categories).length === 16);

  const datasets = new Set<string>([...Object.values(exp.categories).flatMap((c) => Object.keys(c)), ...Object.keys(exp.account)]);
  const holding = await scanFor(cat, ME);
  const missing: string[] = [];
  for (const table of holding.keys()) {
    if (datasets.has(table) || datasets.has(ALIASES[table] ?? "") || EXCLUDED[table]) continue;
    missing.push(table);
  }
  check("every table holding the account is exported or excluded with a reason", missing.length === 0, missing.join(", "));
  const unused = Object.keys(EXCLUDED).filter((t) => !holding.has(t));
  check("no stale exclusions", unused.length === 0, unused.join(", "));

  const empty = [...holding.keys()].filter((t) => {
    const name = ALIASES[t] ?? t;
    if (!datasets.has(name)) return false;
    const rows = [...Object.values(exp.categories), exp.account].flatMap((c) => c[name] ?? []);
    return rows.length === 0;
  });
  check("each exported table actually carries the account's row", empty.length === 0, empty.join(", "));

  check("nothing of another account is in it", !JSON.stringify(exp).includes(OTHER));
  const ops = exp.account.operator_actions_on_account?.[0] ?? {};
  check("operator entries carry the action, not the operator or their notes", "action" in ops && !("admin_user_id" in ops) && !("reason" in ops) && !("detail" in ops), JSON.stringify(ops));

  if (failures > 0) throw new Error(`${failures} export-coverage check(s) failed`);
  console.log("\nAll export-coverage checks passed.");
}

run(main);
