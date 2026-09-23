/**
 * The Deepgram request shape, as pure data. No network, no env.
 * Run: npx tsx scripts/smoke-deepgram-params.ts
 */
import { keytermsFor, listenParams, MAX_KEYTERMS } from "../src/lib/deepgram-params";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

console.log("\nkeytermsFor");
check("no terms is an empty list", keytermsFor([]).length === 0);
check("keeps order", keytermsFor(["Priya Raman", "Stripe"])[0] === "Priya Raman");
check("caps the count", keytermsFor(Array.from({ length: 200 }, (_, i) => `Person${i}`)).length === MAX_KEYTERMS);
{
  const long = Array.from({ length: 50 }, () => "x".repeat(80));
  const out = keytermsFor(long);
  const tokens = out.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
  check("stays inside the token budget", tokens <= 500, `${tokens} tokens`);
  check("cuts whole terms", out.every((t) => t.length === 80));
}
check("drops blanks", keytermsFor(["", "  ", "Sara"]).length === 1);

console.log("\nlistenParams");
{
  const p = listenParams({ live: false });
  check("model is nova-3", p.get("model") === "nova-3");
  check("16k linear16 mono", p.get("encoding") === "linear16" && p.get("sample_rate") === "16000" && p.get("channels") === "1");
  check("smart formatting on", p.get("smart_format") === "true");
  check("a file request asks for no interim results", p.get("interim_results") === null);
  check("no diarization unless asked", p.get("diarize") === null);
}
{
  const p = listenParams({ live: true, diarize: true, keyterms: ["Priya Raman"], tag: "meeting:abc" });
  check("live asks for interim results", p.get("interim_results") === "true");
  check("live asks for utterance ends", p.get("utterance_end_ms") === "1000" && p.get("vad_events") === "true");
  check("diarization on", p.get("diarize") === "true");
  check("keyterms are repeated params", p.getAll("keyterm").join("|") === "Priya Raman");
  check("the tag rides along", p.get("tag") === "meeting:abc");
}
{
  const p = listenParams({ live: true, keyterms: ["A", "B"] });
  check("every keyterm gets its own param", p.getAll("keyterm").length === 2);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll Deepgram parameter checks passed");
process.exit(0);
