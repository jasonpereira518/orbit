/**
 * The Outreach pages and the new-campaign form: what they must keep doing, read from source.
 *
 * Pure and structural, like smoke-events-page. A page that forgets its gate, or an action that
 * quietly grows an LLM call again, would degrade without any test going red, so each rule is
 * pinned here:
 *
 *   - every page under /outreach awaits `pageVisibilityGate("page.outreach")` before anything
 *     else, in its DEFAULT export (`[id]/page.tsx`'s `generateMetadata` awaits earlier, and
 *     that is fine);
 *   - `createCampaign` takes no model call and is a guarded, wrapped action;
 *   - the form is a client component that never reaches the database.
 *
 * Run: npx tsx scripts/smoke-outreach-page.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  discoverExclusions,
  requestBrief,
} from "../src/components/find/request-brief";
import {
  hasBeenContacted,
  hasBeenContactedOnLinkedin,
  hasBeenEmailed,
  isInNetwork,
} from "../src/lib/outreach-metrics";
import { asLinkedInProfile } from "../src/lib/outreach-channels";
import {
  CONTACTED_STATUSES,
  EMAIL_SHAPE,
  EMAILED_STATUSES,
  LINKEDIN_CONTACTED_STATUSES,
  OUTREACH_REPLY_CTAS,
  OUTREACH_TONES,
  REPLY_CTA_LABELS,
  readEnrichment,
} from "../src/lib/outreach-types";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A module with its comments stripped, so prose describing a rule is not read as code. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

/** From `marker` to the next top-level declaration (column 0), exclusive. */
function declaration(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const rest = source.slice(start + marker.length);
  const next = rest.search(/\n(?=(?:export |async function |function |const |let |type )\b)/);
  return source.slice(start, next < 0 ? undefined : start + marker.length + next);
}

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === "page.tsx" ? [path] : [];
  });
}

const OUTREACH_DIR = "src/app/(clerk)/(app)/(main)/outreach";

/** Runs `fn` with `fetch` answering `status` and `body` once, and returns what was asked. */
async function withFetch<T>(
  status: number,
  body: unknown,
  fn: () => Promise<T>
): Promise<{ result: PromiseSettledResult<T>; request: { url: string; init: RequestInit } | null }> {
  const real = globalThis.fetch;
  let request: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    request = { url: String(url), init: init ?? {} };
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  try {
    const [result] = await Promise.allSettled([fn()]);
    return { result, request };
  } finally {
    globalThis.fetch = real;
  }
}

async function main() {
  console.log("\nthe pages are gated, in order");
  {
    const files = pages(OUTREACH_DIR);
    check("finds the outreach pages", files.length >= 3, files.join(", "));
    for (const file of files) {
      const source = code(file);
      const at = source.indexOf("export default async function");
      const body = at < 0 ? "" : source.slice(at);
      const label = file.slice(OUTREACH_DIR.length);
      check(`${label} has a default async page`, at >= 0);
      const firstAwait = body.match(/await\s+([^;]*)/)?.[1]?.trim() ?? "";
      check(
        `${label} awaits the visibility gate first`,
        firstAwait === 'pageVisibilityGate("page.outreach")',
        firstAwait
      );
      const entitlement = body.indexOf("canUseOutreach");
      check(
        `${label} checks the plan after the gate`,
        entitlement > body.indexOf("pageVisibilityGate"),
        "canUseOutreach must come after the gate"
      );
      check(`${label} renders the stamp`, body.includes("<RenderStamp />"));
    }
  }

  console.log("\nnew campaign page");
  {
    const page = code(`${OUTREACH_DIR}/new/page.tsx`);
    check("renders the new form", /import\s*\{\s*NewCampaignForm\s*\}\s*from/.test(page) && page.includes("<NewCampaignForm"));
    check("and not the wizard", !page.includes("OutreachWizard"));
    check("the wizard file is gone", !existsSync("src/components/outreach/outreach-wizard.tsx"));
  }

  console.log("\ncreateCampaign");
  {
    const actions = code("src/actions/outreach.ts");
    const body = declaration(actions, "export async function createCampaign");
    check("is found", body.length > 0);
    check("takes no model call", !body.includes("parseAudienceToFilters"));
    check("is wrapped, so a refusal reaches the form as data", body.includes("asActionResult"));
    const guard = body.indexOf("requireOutreachUser()");
    check("checks the plan before anything else", guard > 0 && !body.slice(0, guard).includes("getDb"));
    check("bounds the audience at 3 to 300", /audienceQuery[\s\S]*?\b3\b[\s\S]*?\b300\b/.test(body));
    check("bounds the reason at 3 to 1000", /messageIntent[\s\S]*?\b3\b[\s\S]*?(?:1000|1_000)\b/.test(body));
    check("names the campaign from the audience, cut to 60", /slice\(0,\s*60\)/.test(body));
    check("returns the id", /\{\s*id:/.test(body));
  }

  console.log("\nthe form");
  {
    const file = "src/components/outreach/new-campaign-form.tsx";
    const source = code(file);
    check('is a client component', readFileSync(file, "utf8").startsWith('"use client"'));
    check("never value-imports the database", !/import\s+(?!type\b)[^;]*from\s+["']@\/db/.test(source));
    check("calls createCampaign and goes to the campaign", source.includes("createCampaign(") && /router\.push\(`\/outreach\/\$\{/.test(source));
    check("shows a refusal inline, not only in a toast", source.includes("<FormError"));
    check("the asks are a radio group", source.includes('role="radiogroup"') && source.includes('type="radio"'));
    check("the audience placeholder is the example", source.includes("UNC alumni doing health-economics consulting in RTP"));
    check("tones come from the shared list", source.includes("OUTREACH_TONES"));
    check("the name sits under a disclosure", source.includes("<details") && source.includes("<summary"));
    check("no escaped apostrophes", !/\\u2019|&rsquo;|&#8217;/.test(source));
  }

  console.log("\nlabels and copy");
  {
    check("every ask has a label", OUTREACH_REPLY_CTAS.every((k) => REPLY_CTA_LABELS[k]));
    check("book_intro reads A short chat", REPLY_CTA_LABELS.book_intro === "A short chat");
    check("ask_referral reads A referral", REPLY_CTA_LABELS.ask_referral === "A referral");
    check("get_feedback reads Advice on a question", REPLY_CTA_LABELS.get_feedback === "Advice on a question");
    check(
      "explore_partnership reads Exploring working together",
      REPLY_CTA_LABELS.explore_partnership === "Exploring working together"
    );
    check("other reads Something else", REPLY_CTA_LABELS.other === "Something else");
    check("there is a default tone to start from", OUTREACH_TONES.includes("professional"));

    const layout = code(`${OUTREACH_DIR}/layout.tsx`);
    check("the locked copy no longer sells SMS or Apollo", !/\bSMS\b|Apollo/i.test(layout));

    const list = code(`${OUTREACH_DIR}/page.tsx`);
    check(
      "the list header says who this is for",
      list.includes("Reach people you don’t know yet — from your own email"),
    );

    const card = code("src/components/outreach/outreach-campaign-card.tsx");
    check("the card shows the reply rate", /formatReplyRate\([^)]*replyRate\)/.test(card));
    check("and the channel, people, sent and replied", /defaultChannel/.test(card) && /prospectCount/.test(card) && /sentCount/.test(card) && /replyCount/.test(card));
  }


  console.log("\nthe people tab");
  {
    const peopleFiles = [
      "src/components/outreach/campaign-people.tsx",
      "src/components/outreach/find-candidates.tsx",
      "src/components/outreach/warm-path-note.tsx",
      "src/components/find/request-brief.ts",
    ];
    for (const file of peopleFiles) check(`${file} exists`, existsSync(file));
    const read = (file: string) => (existsSync(file) ? code(file) : "");
    const raw = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

    const finder = read("src/components/outreach/find-candidates.tsx");
    const people = read("src/components/outreach/campaign-people.tsx");
    const note = read("src/components/outreach/warm-path-note.tsx");
    const table = read("src/components/outreach/prospect-table.tsx");
    const find = read("src/components/find/find-people.tsx");
    const page = read(`${OUTREACH_DIR}/[id]/page.tsx`);

    console.log("  the brief request is shared");
    check("/find imports it", /from\s+["']@\/components\/find\/request-brief["']/.test(find));
    check("and no longer owns a copy", !/function requestBrief/.test(find));
    check("the candidate finder imports it", /from\s+["']@\/components\/find\/request-brief["']/.test(finder));
    check("the finder passes exclude to Find more", /\bexclude\b/.test(finder) && finder.includes("discoverExclusions("));
    check("people research uses it too", /requestBrief(<[^>]*>)?\(/.test(people));

    const noAi = await withFetch(402, { error: "Add an AI key first", reason: "no_ai" }, () =>
      requestBrief({ kind: "discover", query: "x" })
    );
    const noAiErr = noAi.result.status === "rejected" ? (noAi.result.reason as Error & { status?: number; reason?: string }) : null;
    check("a 402 carries its status and reason", noAiErr?.status === 402 && noAiErr?.reason === "no_ai", noAiErr?.message);
    check("and the server's words", noAiErr?.message === "Add an AI key first");
    const limited = await withFetch(429, { error: "That’s today’s limit", reason: "rate_limited" }, () =>
      requestBrief({ kind: "person", fullName: "Jane Doe", company: "Stripe" })
    );
    const limitedErr = limited.result.status === "rejected" ? (limited.result.reason as Error & { status?: number; reason?: string }) : null;
    check("a 429 carries its status and reason", limitedErr?.status === 429 && limitedErr?.reason === "rate_limited");
    const broken = await withFetch(502, "<html>bad gateway</html>", () => requestBrief({ kind: "discover", query: "x" }));
    const brokenErr = broken.result.status === "rejected" ? (broken.result.reason as Error & { status?: number; reason?: string }) : null;
    check("an unreadable answer still has a status and a plain message", brokenErr?.status === 502 && brokenErr?.reason === undefined && /try again/.test(brokenErr?.message ?? ""));
    const ok = await withFetch(200, { key: "k".repeat(64), dossier: { kind: "discover", query: "q", candidates: [], sources: [] } }, () =>
      requestBrief({ kind: "discover", query: "q", exclude: ["A B"] })
    );
    check("a good answer comes back as key and dossier", ok.result.status === "fulfilled" && ok.result.value.key === "k".repeat(64));
    const headers = (ok.request?.init.headers ?? {}) as Record<string, string>;
    check("it posts to the research route with the CSRF header", ok.request?.url === "/api/research" && headers["x-orbit-research"] === "1");
    check("and sends the body as given", JSON.parse(String(ok.request?.init.body)).exclude?.[0] === "A B");

    check(
      "Find more excludes what is shown first, then what the campaign knows",
      JSON.stringify(discoverExclusions(["Ann Lee", "Bo Chen"], ["Cy Park", "ann lee", "Di Roy"])) ===
        JSON.stringify(["Ann Lee", "Bo Chen", "Cy Park", "Di Roy"])
    );
    check("blank names are not sent", discoverExclusions(["  ", "Ann Lee"], [""]).length === 1);
    const many = Array.from({ length: 80 }, (_, i) => `Person ${i}`);
    check(
      "no more than the route keeps, with the shown ones first",
      discoverExclusions(many.slice(0, 5), many).length === 60 && discoverExclusions(many.slice(0, 5), many)[0] === "Person 0"
    );

    console.log("  what is typed or found becomes a LinkedIn link, or nothing");
    check("a bare profile path gets https", asLinkedInProfile("linkedin.com/in/jane-doe") === "https://linkedin.com/in/jane-doe");
    check("www and a trailing slash are kept", asLinkedInProfile("https://www.linkedin.com/in/jane-doe/") === "https://www.linkedin.com/in/jane-doe/");
    check("http is upgraded and tracking dropped", asLinkedInProfile("http://uk.linkedin.com/in/jane-doe?trk=abc#x") === "https://uk.linkedin.com/in/jane-doe");
    check("a company page is not a person", asLinkedInProfile("https://www.linkedin.com/company/stripe") === null);
    check("a search page is not a person", asLinkedInProfile("https://www.linkedin.com/search/results/people/?keywords=jane") === null);
    check("a plain company is not a link", asLinkedInProfile("Stripe") === null);
    check("another site is not LinkedIn", asLinkedInProfile("https://example.com/in/jane-doe") === null);
    check("empty is nothing", asLinkedInProfile("  ") === null && asLinkedInProfile(null) === null);

    console.log("  what a stored enrichment may show");
    const fromProvider = readEnrichment({ url: "javascript:alert(1)", whyMatches: "  Runs health economics ", researchKey: "", emailSource: "apollo", apolloBlob: { phone: "+1" } });
    check("a link that is not http(s) is dropped", fromProvider.url === null);
    check("text is trimmed, an empty key is nothing", fromProvider.whyMatches === "Runs health economics" && fromProvider.researchKey === null);
    check("an unknown email source is nothing", fromProvider.emailSource === null);
    check("and nothing else comes through", JSON.stringify(Object.keys(fromProvider).sort()) === JSON.stringify(["emailSource", "origin", "researchKey", "url", "whyMatches"]));
    const ours = readEnrichment({ origin: "find", url: "https://example.org/team", whyMatches: "x", researchKey: "ab", emailSource: "contact" });
    check("what Orbit stored is read back", ours.origin === "find" && ours.url === "https://example.org/team" && ours.emailSource === "contact" && ours.researchKey === "ab");
    check("null and junk are empty", readEnrichment(null).url === null && readEnrichment("x").whyMatches === null);

    console.log("  the warm-path note");
    check("lives in its own file", /export function WarmPathNote/.test(note));
    check("which the prospect table imports", /import\s*\{\s*WarmPathNote\s*\}\s*from\s*["']@\/components\/outreach\/warm-path-note["']/.test(table));
    check("and no longer defines", !/function WarmPathNote/.test(table));
    check("the people list shows it", people.includes("<WarmPathNote"));
    check("so does each found candidate", finder.includes("<WarmPathNote"));

    console.log("  finding people");
    check("Find people searches the audience", /kind:\s*"discover"/.test(finder) && finder.includes("audienceQuery"));
    check("rows can be added and skipped", finder.includes("addProspects(") && finder.includes("skipCandidate("));
    check("warm paths are looked up once per result", finder.includes("warmPathsForCompanies("));
    check("a ticket drops a stale response", /mine !== ticket\.current/.test(finder));
    check("says what it is doing", finder.includes("Searching the web — this can take a minute"));
    check("sends a missing key to Settings", finder.includes("/settings?section=ai") && /402/.test(finder));
    check("shows the server's words when rate limited", /429/.test(finder));
    check("an added person who was already there reads On the list", finder.includes("On the list"));

    console.log("  each person");
    check("email saves through setProspectEmail", people.includes("setProspectEmail("));
    check("a LinkedIn link saves through setProspectLinkedin", people.includes("setProspectLinkedin("));
    check("a person with no link is offered Add LinkedIn link", people.includes("Add LinkedIn link"));
    check("…beside the search for them on LinkedIn", people.includes("Find on LinkedIn"));
    check("the action is guarded and wrapped like setProspectEmail", (() => {
      const action = declaration(code("src/actions/outreach-people.ts"), "export async function setProspectLinkedin");
      return action.includes("asActionResult") && action.indexOf("requireOutreachUser()") > 0 && action.includes("setProspectLinkedinUrlForUser(");
    })());
    check("Research attaches the brief", people.includes("attachBrief(") && /kind:\s*"person"/.test(people));
    check("Remove calls removeProspect", people.includes("removeProspect("));
    check("the readiness cell reads the pipeline bucket", people.includes("prospectPipelineBucket("));
    check("the network badge is there", people.includes("Already in your network") && people.includes("isInNetwork("));
    check("Research is off without AI", /canUseAi/.test(people) && people.includes("Researching…"));
    check("the manual form checks the email with the server’s shape", people.includes("EMAIL_SHAPE.test(") && people.includes("That address doesn’t look right"));
    check("…and that shape is the server’s own, not a copy", /EMAIL_SHAPE/.test(code("src/lib/outreach-people.ts")) && !/const EMAIL_RE/.test(code("src/lib/outreach-people.ts")));
    check("the manual form adds with origin manual", /origin:\s*"manual"/.test(people));
    check("a person put back reads as on the list", people.includes("is on the list"));

    console.log("  who counts as contacted");
    check("the statuses are shared with the server", /CONTACTED_STATUSES/.test(code("src/lib/outreach-people.ts")) && /EMAILED_STATUSES/.test(code("src/lib/outreach-people.ts")));
    check("contacted includes queued, sent, copied, opened, unsure", ["queued", "sent", "copied", "opened", "unsure"].every((s) => CONTACTED_STATUSES.includes(s)));
    check("emailed is queued, sent, unsure", JSON.stringify([...EMAILED_STATUSES].sort()) === JSON.stringify(["queued", "sent", "unsure"]));
    check("a draft has not been emailed", !hasBeenEmailed([{ status: "generated", channel: "email" }]));
    check("a queued email has", hasBeenEmailed([{ status: "queued", channel: "email" }]));
    check("a sent LinkedIn note has not been emailed", !hasBeenEmailed([{ status: "sent", channel: "linkedin" }]));
    check("an unsure email has", hasBeenEmailed([{ status: "unsure", channel: "email" }]));
    check("LinkedIn keeps the link once a note is copied, sent or opened", ["copied", "sent", "opened"].every((x) => LINKEDIN_CONTACTED_STATUSES.includes(x)) && LINKEDIN_CONTACTED_STATUSES.length === 3);
    check("a LinkedIn draft does not", !hasBeenContactedOnLinkedin([{ status: "generated", channel: "linkedin" }]));
    check("a copied LinkedIn note does", hasBeenContactedOnLinkedin([{ status: "copied", channel: "linkedin" }]));
    check("a sent email does not lock the LinkedIn link", !hasBeenContactedOnLinkedin([{ status: "sent", channel: "email" }]));
    check("the email shape takes an address and refuses a name or a stray symbol", EMAIL_SHAPE.test("jane@zs.com") && !EMAIL_SHAPE.test("jane") && !EMAIL_SHAPE.test("Jane <jane@zs.com>") && !EMAIL_SHAPE.test("a b@zs.com") && !EMAIL_SHAPE.test("jane@"));
    check("a copied note has been contacted", hasBeenContacted([{ status: "copied" }]));
    check("a draft has not", !hasBeenContacted([{ status: "draft" }, { status: "generated" }]));
    check("emailSource contact is in the network", isInNetwork({ contactId: null, enrichment: { emailSource: "contact" }, messages: [{ status: "sent" }] }));
    check("a linked contact is, before any send", isInNetwork({ contactId: "c1", enrichment: null, messages: [{ status: "generated" }] }));
    check("but a contact made at send time is not", !isInNetwork({ contactId: "c1", enrichment: { emailSource: "user" }, messages: [{ status: "sent" }] }));
    check("nor someone with no contact", !isInNetwork({ contactId: null, enrichment: { emailSource: "user" }, messages: [] }));

    console.log("  the campaign page");
    check("reads warm paths", /import\s*\{[^}]*\bfindWarmPaths\b[^}]*\}\s*from/.test(page) && page.includes("findWarmPaths("));
    check("reads the names Find more skips", page.includes("campaignKnownNamesForUser("));
    check("asks whether AI is available", page.includes("userCanUseAi("));
    check("renders the people list", page.includes("<CampaignPeople"));
    check("has a tablist", page.includes('role="tablist"'));
    check("with a People link", page.includes("?tab=${value}") && page.includes('value: "people"'));
    check("and a Messages link", page.includes('value: "messages"'));
    check("people is the default tab", /=== "messages" \? "messages" : "people"/.test(page));
    check("Messages says what is coming", page.includes("Drafting and sending arrive here next."));
    check("the legacy editor and workspace are not rendered", !page.includes("<CampaignEditor") && !page.includes("<CampaignWorkspace"));
    check("the legacy files are still there for Task 14", existsSync("src/components/outreach/campaign-editor.tsx") && existsSync("src/components/outreach/campaign-workspace.tsx"));
    check("people who were removed are not shown", /excluded/.test(page));

    console.log("  client rules");
    for (const file of [
      "src/components/outreach/campaign-people.tsx",
      "src/components/outreach/find-candidates.tsx",
    ]) {
      check(`${file} is a client component`, raw(file).startsWith('"use client"'));
    }
    for (const file of peopleFiles) {
      const source = read(file);
      check(`${file} never value-imports the database`, !/import\s+(?!type\b)[^;]*from\s+["']@\/db/.test(source));
      check(`${file} has no escaped apostrophes`, !/\\u2019|&rsquo;|&#8217;/.test(source));
      check(`${file} has no control bytes`, !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(raw(file)));
      const links = [...source.matchAll(/target="_blank"[^>]*>/g)];
      check(
        `${file} opens every external link safely`,
        links.every((m) => m[0].includes('rel="noopener noreferrer nofollow"')),
        `${links.length} link(s)`
      );
    }
    check("the moved note keeps its control-byte-free source too", !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(raw("src/components/outreach/prospect-table.tsx")));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll outreach page checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
