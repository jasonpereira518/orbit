/**
 * The opening layout, computed ahead in slices (`precomputeSkyLayout`), must be the layout the
 * chart would have computed itself — and the chart must only reuse it where that is true.
 *
 * No DB, no network, no DOM.
 * Run: npx tsx scripts/smoke-sky-layout.ts
 */
import { createHash } from "node:crypto";
import { buildHybridGraphLayout } from "../src/lib/graph-layout";
import { buildSyntheticGraphPayload } from "../src/lib/graph/synthetic-network";
import {
  DEFAULT_SKY_FILTERS,
  cachedSkyLayout,
  filterSkyContacts,
  precomputeSkyLayout,
  skyLayoutFor,
} from "../src/lib/graph/sky-layout";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

function fingerprint(layout: ReturnType<typeof buildHybridGraphLayout>) {
  const h = createHash("sha256");
  for (const n of layout.nodes) h.update(`${n.id}|${n.type}|${n.position.x}|${n.position.y}|${JSON.stringify(n.data)}\n`);
  for (const e of layout.edges) h.update(`${e.id}|${e.source}|${e.target}|${JSON.stringify(e.style)}\n`);
  return h.digest("hex");
}

async function main() {
  const payload = buildSyntheticGraphPayload(2500, { seed: 3 });
  const userName = payload.summary.userName;
  const sync = buildHybridGraphLayout(filterSkyContacts(payload.contacts, DEFAULT_SKY_FILTERS), userName);

  check("nothing cached before the precompute", cachedSkyLayout(payload.contacts, userName) === null);
  const sliced = await precomputeSkyLayout(payload);
  check("the sliced layout is the synchronous layout", fingerprint(sliced) === fingerprint(sync));
  check("it is cached for this payload", cachedSkyLayout(payload.contacts, userName) === sliced);
  check("a second request joins the cache", (await precomputeSkyLayout(payload)) === sliced);

  const filtered = filterSkyContacts(payload.contacts, DEFAULT_SKY_FILTERS);
  check(
    "the chart reuses it under the default filters",
    skyLayoutFor(payload.contacts, filtered, DEFAULT_SKY_FILTERS, userName) === sliced
  );
  check(
    "a blank-but-spaced keyword still counts as default",
    skyLayoutFor(payload.contacts, filtered, { ...DEFAULT_SKY_FILTERS, keyword: "  " }, userName) === sliced
  );
  const someCompany = payload.contacts.find((c) => c.company)!.company!;
  const companyFilters = { ...DEFAULT_SKY_FILTERS, company: someCompany };
  const byCompany = skyLayoutFor(
    payload.contacts,
    filterSkyContacts(payload.contacts, companyFilters),
    companyFilters,
    userName
  );
  check("a filter lays out afresh", byCompany !== sliced && byCompany.nodes.length < sliced.nodes.length);
  check("another user name is a miss", cachedSkyLayout(payload.contacts, `${userName}!`) === null);

  const other = buildSyntheticGraphPayload(2500, { seed: 4 });
  const abort = new AbortController();
  const run = precomputeSkyLayout(other, abort.signal);
  abort.abort();
  let aborted = false;
  await run.catch(() => {
    aborted = true;
  });
  check("an aborted precompute stops", aborted);
  check("and caches nothing", cachedSkyLayout(other.contacts, other.summary.userName) === null);
  const restarted = await precomputeSkyLayout(other);
  check(
    "asking again after an abort starts a live run",
    cachedSkyLayout(other.contacts, other.summary.userName) === restarted
  );

  console.log("\nAll sky-layout smoke checks passed.\n");
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
