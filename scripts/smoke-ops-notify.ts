/**
 * Slack delivery for the ops sweep: each channel is attempted on its own, so a dead main
 * webhook cannot stop the critical (phone-push) post, a dead critical webhook cannot make the
 * sweep re-send the same message every tick, and a delivery fails only when every channel it
 * was meant for refused it.
 *
 * Run: npx tsx scripts/smoke-ops-notify.ts
 */
import { deliverToSlack } from "../src/lib/ops-notify";
import type { OpsCondition } from "../src/lib/ops-alerts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const MAIN = "https://hooks.example/main";
const CRIT = "https://hooks.example/critical";

function cond(severity: OpsCondition["severity"]): OpsCondition {
  return { id: "test.condition", severity, title: "Test", detail: "detail" } as OpsCondition;
}

/** A fake fetch: which URLs answer ok, and which were tried. */
function fake(down: string[]) {
  const tried: string[] = [];
  const impl = (async (url: string) => {
    tried.push(url);
    return { ok: !down.includes(url), status: down.includes(url) ? 500 : 200 } as Response;
  }) as unknown as typeof fetch;
  return { impl, tried };
}

async function attempt(kind: "open" | "recover", severity: OpsCondition["severity"], down: string[]) {
  const f = fake(down);
  const err = await deliverToSlack({ kind, condition: cond(severity) }, f.impl).then(() => null, (e: Error) => e);
  return { err, tried: f.tried };
}

async function main() {
  process.env.SLACK_OPS_WEBHOOK_URL = MAIN;
  process.env.SLACK_OPS_CRITICAL_WEBHOOK_URL = CRIT;

  console.log("critical, both channels configured");
  let r = await attempt("open", "critical", []);
  check("both channels are posted", !r.err && r.tried.includes(MAIN) && r.tried.includes(CRIT));
  r = await attempt("open", "critical", [MAIN]);
  check("a dead main webhook still reaches the critical channel, and counts as delivered",
    !r.err && r.tried.includes(CRIT));
  r = await attempt("open", "critical", [CRIT]);
  check("a dead critical webhook counts as delivered when main took it (no ten-minute re-send)", !r.err);
  r = await attempt("open", "critical", [MAIN, CRIT]);
  check("both dead: the delivery fails so the sweep retries", r.err !== null);

  console.log("\nwarning and recovery");
  r = await attempt("open", "warning", []);
  check("a warning goes to main only", !r.err && r.tried.length === 1 && r.tried[0] === MAIN);
  r = await attempt("open", "warning", [MAIN]);
  check("a warning with a dead main webhook fails", r.err !== null);
  r = await attempt("recover", "critical", []);
  check("a recovery never pages the critical channel", !r.err && r.tried.length === 1 && r.tried[0] === MAIN);

  console.log("\nmain webhook unset");
  delete process.env.SLACK_OPS_WEBHOOK_URL;
  r = await attempt("open", "critical", []);
  check("a critical still reaches the critical channel", !r.err && r.tried.length === 1 && r.tried[0] === CRIT);
  r = await attempt("open", "warning", []);
  check("a warning has nowhere to go and says why", r.err !== null && /SLACK_OPS_WEBHOOK_URL/.test(r.err.message));

  console.log(failures === 0 ? "\nAll ops-notify checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
