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
import { join } from "node:path";

const BILLABLE = [
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "WISPR_API_KEY",
  "ORBIT_MANAGED_GEMINI_API_KEY",
  "ORBIT_MANAGED_OPENAI_API_KEY",
  "ORBIT_MANAGED_ANTHROPIC_API_KEY",
  "ORBIT_MANAGED_WISPR_API_KEY",
  "APOLLO_API_KEY",
  "RESEND_API_KEY",
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
  const probe = spawnSync(
    join("node_modules", ".bin", "tsx"),
    ["-e", `import "./scripts/smoke/_env"; console.log(JSON.stringify(Object.keys(process.env)));`],
    {
      encoding: "utf8",
      env: { ...process.env, SMOKE_ALLOW_PROVIDER_KEYS: "1", GEMINI_API_KEY: "smoke-fake-opt-in" },
    },
  );
  check("the opt-in probe ran", probe.status === 0, probe.stderr);
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
