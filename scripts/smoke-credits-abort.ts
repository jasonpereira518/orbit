/**
 * An aborted or timed-out managed call is not free (audit H-02).
 *
 * A stream reports its token usage only in its final chunk. A client that read the whole
 * answer and aborted before `done` therefore produced a usage row with no counts, which
 * `settleManagedUsage` charged at zero while the provider billed Orbit in full. The charge
 * now falls back to the operation's hold estimate for exactly the failure kinds the caller
 * owns; a provider-side failure (auth, quota, an empty response) stays free.
 *
 * Pure: `managedChargeMicros` takes a usage row and returns micros. Run:
 * npx tsx scripts/smoke-credits-abort.ts
 */
import { managedChargeMicros } from "../src/lib/credits/ledger";
import { holdEstimateMicros } from "../src/lib/managed-ai-policy";
import { AI_OPERATIONS } from "../src/lib/ai-operations";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const chatOp = "chat.answer";
const chatTier = (AI_OPERATIONS as Record<string, { tier?: string }>)[chatOp]?.tier;
const row = (over: Partial<Parameters<typeof managedChargeMicros>[0]>) => ({
  operation: chatOp,
  kind: "completion",
  success: 0,
  estimatedCostMicros: null,
  errorKind: null,
  ...over,
});

console.log("Managed charge on failure...");
check("a cancelled stream with no token counts charges the hold estimate",
  managedChargeMicros(row({ errorKind: "cancelled" })) === holdEstimateMicros(chatTier),
  String(managedChargeMicros(row({ errorKind: "cancelled" }))));
check("a timed-out call with no token counts charges the hold estimate",
  managedChargeMicros(row({ errorKind: "timeout" })) === holdEstimateMicros(chatTier));
check("the estimate is positive (the whole point)", holdEstimateMicros(chatTier) > 0);
check("a cancelled call that DID report tokens is charged its real cost, not the estimate",
  managedChargeMicros(row({ errorKind: "cancelled", estimatedCostMicros: 1234 })) === 1234);
check("an unknown operation still charges the default tier estimate when cancelled",
  managedChargeMicros(row({ operation: "no.such.op", errorKind: "cancelled" })) === holdEstimateMicros(undefined));

console.log("\nProvider-side failures stay free...");
for (const kind of ["auth", "quota", "rate_limit", "empty_response", "model_unavailable", "other", null]) {
  check(`${kind ?? "no error kind"} → 0`, managedChargeMicros(row({ errorKind: kind })) === 0);
}

console.log("\nSuccess paths are unchanged...");
check("a successful priced call charges its cost", managedChargeMicros(row({ success: 1, estimatedCostMicros: 777 })) === 777);
check("a successful unpriced completion charges the stand-in", managedChargeMicros(row({ success: 1 })) > 0);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll managed-charge checks passed.");
