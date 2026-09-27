/**
 * How the backfill slices embedding work, and how it isolates a row the provider refuses.
 * Run: npx tsx scripts/smoke-embedding-batches.ts
 */
import {
  EMBED_BATCH_MAX_TOKENS,
  embedWithBisect,
  estimateEmbeddingTokens,
  planEmbeddingBatches,
} from "../src/lib/embedding-batches";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const id = (s: string) => s;
const sizes = (b: string[][]) => b.map((x) => x.length).join(",");

async function main() {
  console.log("planEmbeddingBatches");
  check("item cap", sizes(planEmbeddingBatches(["a", "b", "c"], id, { maxItems: 2, maxTokens: 1e9 })) === "2,1");
  const long = "x".repeat(8_000);
  check("tokens are estimated on the 8,000-char cut", estimateEmbeddingTokens("x".repeat(20_000)) === 2_000);
  check("token cap", sizes(planEmbeddingBatches(Array(5).fill(long), id, { maxItems: 200, maxTokens: 5_000 })) === "2,2,1");
  check("an oversize text still gets a batch of its own", sizes(planEmbeddingBatches([long, "a"], id, { maxItems: 200, maxTokens: 1_000 })) === "1,1");
  const defaults = planEmbeddingBatches(Array(200).fill(long), id);
  check(
    "200 long contacts no longer go out as one ~400k-token request",
    defaults.length === 2 && defaults.every((b) => b.length * 2_000 <= EMBED_BATCH_MAX_TOKENS),
    sizes(defaults)
  );
  check("order is preserved", planEmbeddingBatches(["a", "b", "c"], id, { maxItems: 2, maxTokens: 1e9 }).flat().join("") === "abc");

  console.log("embedWithBisect");
  const vec = [0.1, 0.2];
  const poisonAware = async (texts: string[]) => {
    if (texts.includes("POISON")) throw new Error("Invalid input at index 3");
    return texts.map(() => vec);
  };
  const items = ["a", "b", "c", "d", "e", "POISON", "g", "h"];
  const out = await embedWithBisect(items, id, poisonAware, () => false);
  check("everything else is embedded", out.embedded.map((e) => e.item).join("") === "abcdegh", out.embedded.map((e) => e.item).join(""));
  check("the poison row is isolated", out.failed.length === 1 && out.failed[0].item === "POISON");
  check("in O(log n) extra calls", out.calls <= 7, String(out.calls));

  let fatalCalls = 0;
  let thrown: unknown = null;
  try {
    await embedWithBisect(items, id, async () => { fatalCalls++; throw new Error("401 Unauthorized"); }, (err) => /401/.test(String(err)));
  } catch (err) {
    thrown = err;
  }
  check("a key-level error is rethrown without bisecting", thrown instanceof Error && fatalCalls === 1, `${fatalCalls} calls`);

  const short = await embedWithBisect(["a", "b"], id, async (texts) => (texts.length > 1 ? [vec] : [vec]), () => false);
  check("a short response is a failure that bisects, then succeeds per row", short.embedded.length === 2 && short.failed.length === 0);

  const empty = await embedWithBisect([], id, async () => { throw new Error("must not call"); }, () => false);
  check("no items, no calls", empty.calls === 0);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => { console.error(err); process.exit(1); });
