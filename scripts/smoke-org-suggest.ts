/**
 * Onboarding's organization suggestions (`src/lib/org-suggest.ts`): curated names come back
 * with a logo domain and no network, Wikidata fills the rest (organizations with a website
 * only), sources dedupe, and a failing or slow Wikidata never costs the local results.
 * Pure: the database read and fetch are injected.
 *
 * Run: npx tsx scripts/smoke-org-suggest.ts
 */
import { forgetOrgSuggestCache, suggestOrgs, type SuggestOpts } from "../src/lib/org-suggest";
import { isBareDomain } from "../src/lib/wikidata";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const site = (url: string) => ({ P856: [{ mainsnak: { datavalue: { value: url } } }] });

const SEARCH = {
  search: [
    { id: "Q1", label: "Goodyear", description: "American multinational tire manufacturing company" },
    { id: "Q2", label: "Goodwill Industries", description: "American nonprofit organization" },
    { id: "Q3", label: "Goodwin University", description: "private university in Connecticut" },
    { id: "Q4", label: "Gooch", description: "family name" },
    { id: "Q5", label: "Goole", description: "town in the East Riding of Yorkshire, England" },
    { id: "Q6", label: "Goodman Theatre", description: "theatre in Chicago" },
    { id: "Q7", label: "Google", description: "American technology company" },
  ],
};
const ENTITIES = {
  entities: {
    Q1: { claims: site("https://www.goodyear.com/") },
    Q2: { claims: site("https://www.goodwill.org") },
    Q3: { claims: site("https://goodwin.edu/") },
    Q6: { claims: {} }, // no website: dropped
    Q7: { claims: site("https://www.google.com") },
  },
};

function fakeFetch() {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return json(url.includes("wbsearchentities") ? SEARCH : ENTITIES);
  }) as typeof fetch;
  return { calls, impl };
}
const throwing = (async () => {
  throw new Error("network down");
}) as typeof fetch;
const hanging = ((_: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
const noYours: SuggestOpts["loadYours"] = async () => [];

async function main() {
  console.log("curated");
  {
    forgetOrgSuggestCache();
    const goo = await suggestOrgs("u", "Goo", { fetch: throwing, loadYours: noYours });
    check("'Goo' -> Google first, from the curated table, with its domain", goo[0]?.name === "Google" && goo[0]?.domain === "google.com" && goo[0]?.source === "curated", goo);
    const unc = await suggestOrgs("u", "UNC", { fetch: throwing, loadYours: noYours });
    check("'UNC' -> a school", unc[0]?.kind === "school" && unc[0]?.domain === "unc.edu", unc);
    const f = fakeFetch();
    const uni = await suggestOrgs("u", "University of", { fetch: f.impl, loadYours: noYours });
    check("a full curated list makes no Wikidata call", uni.length === 6 && f.calls.length === 0, { uni, calls: f.calls });
  }

  console.log("wikidata");
  {
    forgetOrgSuggestCache();
    const f = fakeFetch();
    const res = await suggestOrgs("u", "Goo", { fetch: f.impl, loadYours: noYours });
    const by = (name: string) => res.find((s) => s.name === name);
    check("one search and one batched entity read", f.calls.length === 2 && f.calls[1]!.includes("ids=Q1|Q2|Q3|Q6|Q7"), f.calls);
    check("a company parses with its domain", by("Goodyear")?.kind === "company" && by("Goodyear")?.domain === "goodyear.com", by("Goodyear"));
    check("a nonprofit is an organization", by("Goodwill Industries")?.kind === "org" && by("Goodwill Industries")?.domain === "goodwill.org");
    check("a university is a school", by("Goodwin University")?.kind === "school");
    check("names and places are dropped", !by("Gooch") && !by("Goole"));
    check("no website, no suggestion", !by("Goodman Theatre"));
    check("Google appears once, the curated row first", res.filter((s) => s.name === "Google").length === 1 && res[0]?.source === "curated", res);
    check("at most six", res.length <= 6);
    await suggestOrgs("u", "goo", { fetch: f.impl, loadYours: noYours });
    check("the same query is answered from cache", f.calls.length === 2, f.calls.length);
    const user = await suggestOrgs("u", "Goo", { fetch: throwing, loadYours: noYours, localOnly: true });
    check("localOnly never calls Wikidata", user.every((s) => s.source !== "wikidata"));
  }

  console.log("yours + dedupe");
  {
    forgetOrgSuggestCache();
    const res = await suggestOrgs("u", "goo", { fetch: throwing, loadYours: async (_u, q) => (q === "goo" ? ["Google", "Goodnotes"] : []) });
    const google = res.filter((s) => s.name === "Google");
    check("your own Google and the curated one are one row", google.length === 1 && google[0]?.source === "yours", res);
    check("…which borrows the curated logo domain", google[0]?.domain === "google.com", google[0]);
    check("your other companies come back too", res.some((s) => s.name === "Goodnotes" && s.source === "yours"));
    const contains = await suggestOrgs("u", "chapel", { fetch: throwing, loadYours: async () => [] });
    check("a word match ('chapel' -> UNC) still suggests", contains.some((s) => s.domain === "unc.edu"), contains);
  }

  console.log("failure");
  {
    forgetOrgSuggestCache();
    const res = await suggestOrgs("u", "Goo", { fetch: throwing, loadYours: noYours });
    check("a thrown fetch -> local results only", res.length >= 1 && res.every((s) => s.source !== "wikidata"), res);
    forgetOrgSuggestCache();
    const started = Date.now();
    // AbortSignal.timeout's timer is unref'd: hold the loop open or the script just exits.
    const keepAlive = setInterval(() => {}, 1_000);
    const slow = await suggestOrgs("u", "Goo", { fetch: hanging, loadYours: noYours });
    clearInterval(keepAlive);
    const took = Date.now() - started;
    check("a hung Wikidata gives up inside ~1.5s", took < 2_500, took);
    check("…and still returns the local results", slow[0]?.name === "Google", slow);
    const broken = await suggestOrgs("u", "Goo", { fetch: throwing, loadYours: async () => { throw new Error("db down"); } });
    check("a failed database read never throws", broken[0]?.name === "Google");
  }

  console.log("guards");
  {
    let loaded = false;
    const one = await suggestOrgs("u", "G", { fetch: throwing, loadYours: async () => ((loaded = true), []) });
    check("under 2 characters -> nothing, nothing read", one.length === 0 && !loaded);
    check("'  ' -> nothing", (await suggestOrgs("u", "  ", { fetch: throwing, loadYours: noYours })).length === 0);
    check("bare domains pass the logo route's check", ["google.com", "ox.ac.uk", "aws.amazon.com"].every(isBareDomain));
    check(
      "anything else fails it",
      ["", "localhost", "127.0.0.1", "google.com/evil", "a@b.com", "https://google.com", "google.com:443", "goo gle.com", "GOOGLE.COM", `${"a".repeat(250)}.com`].every((d) => !isBareDomain(d))
    );
  }

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\norg-suggest: ok");
  process.exit(0);
}

void main();
