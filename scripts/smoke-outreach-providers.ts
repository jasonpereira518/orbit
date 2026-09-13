/**
 * Provider adapters against a stubbed fetch: the exact request each provider receives, how each
 * failure class is reported, and the two ways Apollo can hand back an email that is not one
 * (a missing reveal, and its `email_not_unlocked@domain.com` placeholder). No network.
 *
 * Run: npx tsx scripts/smoke-outreach-providers.ts
 */
import { createApolloEnrichment, mapApolloEmailStatus, verifyApolloKey } from "../src/lib/outreach/providers/apollo";
import { createBraveSearch, verifyBraveKey } from "../src/lib/outreach/providers/brave";
import { createDemoEnrichment, createDemoSearch } from "../src/lib/outreach/providers/demo";
import { isProviderError, type FetchLike } from "../src/lib/outreach/providers/types";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const noSleep = async () => {};

function scripted(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra call");
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

async function main() {
  console.log("Brave...");
  {
    const { calls, fetchImpl } = scripted([
      json(200, {
        query: { more_results_available: true },
        web: { results: [{ url: "https://www.linkedin.com/in/jane", title: "Jane - Ramp | LinkedIn", description: "Fintech", extra_snippets: ["NYC"] }] },
      }),
    ]);
    const brave = createBraveSearch("brv_key", { fetch: fetchImpl, sleep: noSleep });
    const page = await brave.search('site:linkedin.com/in "cfo"', { count: 50, offset: 30 });
    const url = new URL(calls[0].url);
    check("hits the web search endpoint", url.origin + url.pathname === "https://api.search.brave.com/res/v1/web/search");
    check("sends the key header", new Headers(calls[0].init?.headers).get("X-Subscription-Token") === "brv_key");
    check("count is clamped to 20", url.searchParams.get("count") === "20");
    check("offset is clamped to 9", url.searchParams.get("offset") === "9");
    check("maps results", page.results[0]?.title === "Jane - Ramp | LinkedIn" && page.results[0]?.extraSnippets[0] === "NYC");
    check("reports more results", page.moreAvailable === true);
  }
  {
    const { calls, fetchImpl } = scripted([json(401, { error: "bad key" })]);
    let kind = "";
    try {
      await createBraveSearch("bad", { fetch: fetchImpl, sleep: noSleep }).search("q", { count: 20, offset: 0 });
    } catch (err) {
      kind = isProviderError(err) ? err.kind : "other";
    }
    check("401 is an auth error, not retried", kind === "auth" && calls.length === 1);
  }
  {
    const { calls, fetchImpl } = scripted([json(429, {}, { "retry-after": "1" }), json(200, { web: { results: [] } })]);
    const page = await createBraveSearch("k", { fetch: fetchImpl, sleep: noSleep }).search("q", { count: 20, offset: 0 });
    check("429 then success is retried", calls.length === 2 && page.results.length === 0 && page.moreAvailable === false);
  }
  {
    const { fetchImpl } = scripted([json(500, {}), json(502, {}), json(503, {})]);
    let kind = "";
    try {
      await createBraveSearch("k", { fetch: fetchImpl, sleep: noSleep }).search("q", { count: 20, offset: 0 });
    } catch (err) {
      kind = isProviderError(err) ? err.kind : "other";
    }
    check("three 5xx in a row is unavailable", kind === "unavailable");
  }
  {
    const { fetchImpl } = scripted([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
    let kind = "";
    try {
      await createBraveSearch("k", { fetch: fetchImpl, sleep: noSleep }).search("q", { count: 20, offset: 0 });
    } catch (err) {
      kind = isProviderError(err) ? err.kind : "other";
    }
    check("network errors become unavailable", kind === "unavailable");
  }
  check("verifyBraveKey: valid", (await verifyBraveKey("k", { fetch: scripted([json(200, { web: { results: [] } })]).fetchImpl, sleep: noSleep })) === "valid");
  check("verifyBraveKey: invalid", (await verifyBraveKey("k", { fetch: scripted([json(403, {})]).fetchImpl, sleep: noSleep })) === "invalid");
  check("verifyBraveKey: unverified", (await verifyBraveKey("k", { fetch: scripted([json(500, {}), json(500, {}), json(500, {})]).fetchImpl, sleep: noSleep })) === "unverified");

  console.log("Apollo...");
  check("verified maps to verified", mapApolloEmailStatus("verified") === "verified");
  check("guessed maps to unverified", mapApolloEmailStatus("guessed") === "unverified");
  check("extrapolated maps to unverified", mapApolloEmailStatus("extrapolated") === "unverified");
  check("unavailable maps to unavailable", mapApolloEmailStatus("unavailable") === "unavailable");
  check("bounced maps to bounced", mapApolloEmailStatus("bounced") === "bounced");
  check("missing maps to null", mapApolloEmailStatus(undefined) === null);
  {
    const { calls, fetchImpl } = scripted([
      json(200, {
        person: {
          id: "ap_1", name: "Jane Doe", title: "Head of Partnerships", email: "Jane@Ramp.com", email_status: "verified",
          linkedin_url: "http://www.linkedin.com/in/jane", city: "New York", state: "NY", country: "United States",
          organization: { name: "Ramp", primary_domain: "ramp.com" },
          employment_history: [{ organization_name: "Ramp", title: "Head of Partnerships", current: true, start_date: "2022-01-01" }],
        },
      }),
    ]);
    const apollo = createApolloEnrichment("ap_key", { fetch: fetchImpl, sleep: noSleep });
    const person = await apollo.match({ linkedinUrl: "https://www.linkedin.com/in/jane", fullName: "Jane Doe" });
    const body = JSON.parse(String(calls[0].init?.body));
    check("matches by LinkedIn URL when present", body.linkedin_url === "https://www.linkedin.com/in/jane" && body.name === undefined);
    check("never asks Apollo to reveal personal emails", body.reveal_personal_emails === false);
    check("sends the key header", new Headers(calls[0].init?.headers).get("X-Api-Key") === "ap_key");
    check("maps the person", person?.apolloId === "ap_1" && person?.company === "Ramp" && person?.organizationDomain === "ramp.com");
    check("email is normalized with its status", person?.email === "jane@ramp.com" && person?.emailStatus === "verified");
    check("location is joined", person?.location === "New York, NY, United States");
    check("employment is mapped", person?.employment[0]?.current === true);
  }
  {
    const { calls, fetchImpl } = scripted([json(200, { person: { id: "ap_2", name: "Sam", email: "email_not_unlocked@domain.com", email_status: "verified" } })]);
    const person = await createApolloEnrichment("k", { fetch: fetchImpl, sleep: noSleep }).match({ fullName: "Sam Lee", organization: "Brex" });
    const body = JSON.parse(String(calls[0].init?.body));
    check("falls back to name + organization", body.name === "Sam Lee" && body.organization_name === "Brex");
    check("Apollo's locked-email placeholder is never an email", person?.email === null && person?.emailStatus === null);
  }
  {
    const { fetchImpl } = scripted([json(200, { person: null })]);
    check("no match is null", (await createApolloEnrichment("k", { fetch: fetchImpl, sleep: noSleep }).match({ linkedinUrl: "https://linkedin.com/in/x" })) === null);
  }
  check("nothing to match on makes no call",
    (await createApolloEnrichment("k", { fetch: scripted([]).fetchImpl, sleep: noSleep }).match({})) === null);
  check("verifyApolloKey: valid", (await verifyApolloKey("k", { fetch: scripted([json(200, { is_logged_in: true })]).fetchImpl, sleep: noSleep })) === "valid");
  check("verifyApolloKey: invalid", (await verifyApolloKey("k", { fetch: scripted([json(401, {})]).fetchImpl, sleep: noSleep })) === "invalid");

  console.log("Demo...");
  const demo = createDemoSearch();
  const first = await demo.search('site:linkedin.com/in "cfo"', { count: 20, offset: 0 });
  const again = await demo.search('site:linkedin.com/in "cfo"', { count: 20, offset: 0 });
  check("demo search is deterministic", JSON.stringify(first) === JSON.stringify(again) && first.results.length > 0);
  check("demo profiles are clearly demo", first.results.every((r) => r.url.includes("/in/demo-")));
  const demoPerson = await createDemoEnrichment().match({ linkedinUrl: first.results[0].url, fullName: "Demo Person" });
  check("demo emails use the reserved example.com domain", Boolean(demoPerson?.email?.endsWith("@example.com")));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll outreach provider checks passed.");
}

main();
