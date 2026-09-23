/**
 * Pins the provider-key half of the smoke preamble (`scripts/smoke/_env.ts`): after it is
 * imported, no billable provider key survives — whether it came from the shell or from a
 * developer's `.env.local` — unless `SMOKE_ALLOW_PROVIDER_KEYS=1` says so.
 *
 * Without it, a real `GEMINI_API_KEY` in `.env.local` made every "no AI key" case in the
 * suite a live, billed Gemini call (the AI gate honours local key names off Vercel).
 *
 * The key list below is written out independently of `PROVIDER_KEY_ENV`, so dropping a name
 * from the preamble fails here instead of quietly re-arming it.
 *
 * Pure: no database, no network. Run: npx tsx scripts/smoke-provider-keys-stripped.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * tsx's own CLI entry point, run under this process's Node.
 *
 * NOT `node_modules/.bin/tsx`. That shim comes in three flavours on Windows and none of them
 * spawns: the extensionless file is a shell script `spawnSync` cannot execute, and `.cmd` is
 * refused with EINVAL because Node stopped spawning batch files without an explicit shell.
 * Both fail with `status: null` and no stderr, so the probe below reported "the opt-in probe
 * ran FAILED" with nothing to go on.
 *
 * `scripts/run-smoke.ts` learned this first and says so at more length; this is the same
 * answer, and the comment is here as well because the next script to spawn tsx will be
 * written by somebody reading this one.
 */
const TSX_CLI = join("node_modules", "tsx", "dist", "cli.mjs");

const BILLABLE = [
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ORBIT_MANAGED_GEMINI_API_KEY",
  "ORBIT_MANAGED_OPENAI_API_KEY",
  "ORBIT_MANAGED_ANTHROPIC_API_KEY",
  "APOLLO_API_KEY",
  "RESEND_API_KEY",
  "DEEPGRAM_API_KEY",
  "ORBIT_DEEPGRAM",
];

function check(label: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${label} FAILED${detail ? `: ${detail}` : ""}`);
  console.log("  ok  " + label);
}

async function main() {
  console.log("Smoke preamble strips provider keys...");

  // Set BEFORE the preamble loads — a static import would hoist above these lines. dotenv
  // never overwrites a set variable, so these stand in for a shell export AND a .env.local.
  delete process.env.SMOKE_ALLOW_PROVIDER_KEYS;
  for (const name of BILLABLE) process.env[name] = `smoke-fake-${name.toLowerCase()}`;

  const { PROVIDER_KEY_ENV } = await import("./smoke/_env");

  const survivors = BILLABLE.filter((name) => process.env[name] !== undefined);
  check("no billable provider key survives the preamble", survivors.length === 0, survivors.join(", "));
  const unlisted = BILLABLE.filter((name) => !(PROVIDER_KEY_ENV as readonly string[]).includes(name));
  check("the preamble's list names every billable key", unlisted.length === 0, unlisted.join(", "));

  // The opt-in, in a fresh process: the preamble runs once per module graph.
  if (!existsSync(TSX_CLI)) {
    check(`${TSX_CLI} exists`, false, "run npm ci first");
    return;
  }
  const probe = spawnSync(
    process.execPath,
    [TSX_CLI, "-e", `import "./scripts/smoke/_env"; console.log(JSON.stringify(Object.keys(process.env)));`],
    {
      encoding: "utf8",
      env: { ...process.env, SMOKE_ALLOW_PROVIDER_KEYS: "1", GEMINI_API_KEY: "smoke-fake-opt-in" },
    },
  );
  // `status` is null rather than a number when the spawn itself failed, which is the shape
  // the `.bin` shim produced — so the error is reported rather than read as a plain failure.
  check(
    "the opt-in probe ran",
    probe.status === 0,
    probe.error ? String(probe.error) : probe.stderr || `status ${probe.status}`
  );
  const kept: string[] = JSON.parse(probe.stdout.trim().split("\n").pop() ?? "[]");
  check("SMOKE_ALLOW_PROVIDER_KEYS=1 keeps an explicitly set key", kept.includes("GEMINI_API_KEY"));

  console.log("\nAll provider-key checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
