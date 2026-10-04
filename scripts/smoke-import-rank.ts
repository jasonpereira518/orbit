import { rankCandidates } from "@/lib/imports/rank-candidates";
import type { Detected } from "@/lib/imports/detect-import-file";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
}

const NOW = Date.UTC(2026, 8, 30);
function d(name: string, target: Detected["target"], bytes: number, confidence: Detected["confidence"], modifiedDaysAgo = 10): Detected {
  const file = new File(["x"], name, { lastModified: NOW - modifiedDaysAgo * 86_400_000 });
  return { file, path: "Downloads", target, confidence, reason: "a contacts file", displayName: name, bytes };
}

console.log("\nrankCandidates");
const ranked = rankCandidates(
  [
    d("contacts backup.csv", "contacts_file", 900_000, "likely", 400),
    d("google-contacts.csv", "contacts_file", 40_000, "guess", 20),
    d("Connections.csv", "linkedin_connections", 300_000, "certain"),
    d("Connections (1).csv", "linkedin_connections", 310_000, "certain"),
    d("empty.vcf", "contacts_file", 20, "certain"),
    d("Messages.csv", "linkedin_messages", 50_000, "certain"),
  ],
  NOW
);
const suggested = ranked.filter((r) => r.suggested).map((r) => r.detected.displayName).sort();
check("one suggestion per kind", suggested.length === 3, suggested);
check("the real Connections.csv beats its bigger '(1)' copy", suggested.includes("Connections.csv"), suggested);
check("a recent contacts file beats a bigger old backup", suggested.includes("google-contacts.csv"), suggested);
check("an almost-empty file is never suggested", !ranked.find((r) => r.detected.displayName === "empty.vcf")!.suggested);
check("every candidate is still listed", ranked.length === 6, ranked.length);
check("best comes first", ranked[0]!.score >= ranked[ranked.length - 1]!.score);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nimport rank smoke tests passed");
process.exit(0);
