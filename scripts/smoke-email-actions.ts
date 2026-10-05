/**
 * The email actions' shape: every export async (a non-async export kills the whole "use
 * server" file), cancel scoped to the caller, and schedule.ts the only next/server importer
 * under src/lib/email. Run: npx tsx scripts/smoke-email-actions.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const actions = readFileSync("src/actions/email-sends.ts", "utf8");
check("use server file", actions.startsWith('"use server"'));
const runtimeExports = [...actions.matchAll(/^export (?!type )(\w+(?: \w+)?)/gm)].map((m) => m[1]);
check("every runtime export is an async function", runtimeExports.every((e) => e === "async function"), runtimeExports.join());
check("cancel is scoped to the caller", /cancelEmailSend\(\s*userId/.test(actions));

const libFiles = (readdirSync("src/lib/email", { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
const importers = libFiles.filter((f) => /from "next\/server"/.test(readFileSync(join("src/lib/email", f), "utf8")));
check("only schedule.ts imports next/server", importers.join() === "schedule.ts", importers.join());

console.log("\nAll email-action checks passed.");
