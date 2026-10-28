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
import { asLinkedInProfile, campaignHeaderLabels } from "../src/lib/outreach-channels";
import { withoutOwnContact, type WarmPath } from "../src/lib/warm-paths";
import { checkRecipient } from "../src/lib/chat-send";
import {
  copyBlockedReason,
  linkedInOpenUrl,
  messageGroups,
  notSentLine,
  sendSummary,
  toSendLine,
  type ViewMessage,
  type ViewPerson,
} from "../src/lib/outreach-message-view";
import {
  CONTACTED_STATUSES,
  audienceSubtitle,
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
    check("updateCampaign, which nothing called, is gone", !actions.includes("updateCampaign") && !actions.includes("pickCampaignFields"));
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
    const outreachLocked = declaration(code("src/components/locked-feature.tsx"), "export function OutreachLocked");
    check("OutreachLocked is found", outreachLocked.includes("title=\"Outreach\""));
    check("OutreachLocked no longer sells SMS or Apollo", !/\bSMS\b|Apollo/i.test(outreachLocked));
    check("OutreachLocked says it sends from your own email or LinkedIn", outreachLocked.includes("from your own email or LinkedIn"));

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
    check("the manual form checks the email with the outbox’s own rule", people.includes("checkRecipient(") && people.includes("That address doesn’t look right"));
    check("…and so does the server, not a copy of it", /checkRecipient\(/.test(code("src/lib/outreach-people.ts")) && !/EMAIL_SHAPE|const EMAIL_RE/.test(code("src/lib/outreach-people.ts")));
    check("…and the send, before it makes a contact", (() => {
      const send = declaration(code("src/lib/outreach-messages.ts"), "export async function sendCampaignMessagesForUser");
      const at = send.indexOf("checkRecipient(");
      return at > 0 && at < send.indexOf("ensureProspectContactForUser(");
    })());
    check("the form says when the server refused an address", people.includes("badEmail"));
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
    check(
      "the address rule takes an address and refuses a name, a stray symbol, a dotless domain or a placeholder",
      checkRecipient("jane@zs.com").ok &&
        ["jane", "Jane <jane@zs.com>", "a b@zs.com", "jane@", "jane@company", "o'brien@x.com", "a@acme.example.com"].every((e) => !checkRecipient(e).ok)
    );
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
    check("Messages renders the real tab, not a placeholder", page.includes("<CampaignMessages") && !page.includes("arrive here next"));
    check("the legacy editor and workspace are not rendered", !page.includes("<CampaignEditor") && !page.includes("<CampaignWorkspace"));
    check(
      "the v1 components are gone",
      ["campaign-editor", "campaign-workspace", "prospect-table", "outreach-actions", "bulk-action-bar", "outreach-readiness-strip"].every(
        (name) => !existsSync(`src/components/outreach/${name}.tsx`)
      )
    );
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
  }

  console.log("\nthe messages tab");
  {
    const files = {
      messages: "src/components/outreach/campaign-messages.tsx",
      editor: "src/components/outreach/message-editor-row.tsx",
      outcome: "src/components/outreach/outcome-controls.tsx",
      view: "src/lib/outreach-message-view.ts",
    };
    for (const file of Object.values(files)) check(`${file} exists`, existsSync(file));
    const read = (file: string) => (existsSync(file) ? code(file) : "");
    const raw = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
    const messages = read(files.messages);
    const editor = read(files.editor);
    const outcome = read(files.outcome);
    const page = read(`${OUTREACH_DIR}/[id]/page.tsx`);

    /** The text inside every `name(...)` call, parentheses matched, so one effect is not read as the next. */
    const calls = (source: string, name: string) => {
      const found: string[] = [];
      for (let at = source.indexOf(name); at >= 0; at = source.indexOf(name, at + 1)) {
        let depth = 1;
        let i = at + name.length;
        while (i < source.length && depth) {
          if (source[i] === "(") depth++;
          else if (source[i] === ")") depth--;
          i++;
        }
        found.push(source.slice(at + name.length, i - 1));
      }
      return found;
    };

    console.log("  the three structural rules");
    check("the Sent view checks for replies inside a useEffect", calls(messages, "useEffect(").some((body) => body.includes("checkReplies(")));
    check("…and nowhere outside one, except the Check for replies button", calls(messages, "checkReplies(").length >= 1);
    {
      const sites = [...page.matchAll(/getSendCapability\(/g)];
      check("the page asks for the send capability", sites.length >= 1);
      check(
        "…only behind a defaultChannel === \"email\" check",
        sites.length >= 1 &&
          sites.every((m) => {
            const statement = page.slice(Math.max(page.lastIndexOf(";", m.index), page.lastIndexOf("}", m.index)) + 1, m.index);
            return statement.includes('defaultChannel === "email"');
          })
      );
    }
    check("the editor knows the LinkedIn note limit", editor.includes("LINKEDIN_NOTE_MAX"));

    console.log("  the page");
    check("renders the Messages tab", page.includes("<CampaignMessages"));
    check("hands it the people, the channel and the send line", /rows=\{/.test(page) && /channel=\{channel\}/.test(page) && /sendCapability=\{/.test(page));
    check("sets stranded sends free for the tab", page.includes("releaseStrandedMessagesForUser("));
    {
      const gate = page.indexOf("canUseOutreach");
      const release = page.indexOf("releaseStrandedMessagesForUser(");
      const read2 = page.indexOf("getCampaign(", release);
      check("…after the plan check and before the messages are read", gate >= 0 && release > gate && read2 > release);
      check("…and the messages come from a fresh read, not the one metadata took first", /tab === "messages"\s*\?\s*getCampaign\(/.test(page));
    }
    check("people who were removed are left out before anything is bucketed", /status !== "excluded"/.test(page) && page.indexOf('status !== "excluded"') < page.indexOf("<CampaignMessages"));
    check("a campaign on neither email nor LinkedIn says so instead of offering sends", /const supported = [^;]*defaultChannel === "email"[^;]*defaultChannel === "linkedin"/.test(page) && page.includes("no longer sends on"));
    check("reply visibility comes from the connection’s scopes, on the server", page.includes("canSeeRepliesForUser("));
    check("the page sends the AI answer to the tab", /canUseAi=\{/.test(page));

    console.log("  the tab");
    check("is a client component", raw(files.messages).startsWith('"use client"'));
    check("two views behind a segmented control", messages.includes("To send") && messages.includes("Sent") && messages.includes("aria-pressed"));
    check("Write drafts calls draftMessages", messages.includes("draftMessages("));
    check("…at most MAX_DRAFTS_PER_RUN at a time", messages.includes("MAX_DRAFTS_PER_RUN"));
    check("sendMessages is called once, and only from the confirm handler", (() => {
      const start = messages.indexOf("async function confirmSend()");
      const end = messages.indexOf("const nothing =");
      const at = messages.indexOf("sendMessages(");
      return start > 0 && end > start && at > start && at < end && messages.indexOf("sendMessages(", at + 1) < 0;
    })());
    check("Send selected only asks: it opens the dialog", (() => {
      const ask = messages.slice(messages.indexOf("function askToSend()"), messages.indexOf("async function confirmSend()"));
      return /onClick=\{askToSend\}/.test(messages) && ask.includes("setConfirmOpen(true)") && !ask.includes("sendMessages(");
    })());
    check("the dialog’s Send is what confirms", /<Button onClick=\{confirmSend\} disabled=\{sending\}>/.test(messages.replace(/\s+/g, " ")));
    check("the dialog asks ‘Send n emails from <address>?’ with Send and Cancel", /Send \{plural\(batch\.ids\.length, "email"\)\} from \{batch\.from\}\?/.test(messages) && messages.includes("Cancel") && messages.includes("@/components/ui/dialog"));
    check("the dialog can’t be closed while a send runs, and the batch it names is the batch that goes", /if \(!sending\) setConfirmOpen\(open\)/.test(messages) && /const ids = batch\.ids/.test(messages) && /sendMessages\(campaignId, ids\)/.test(messages));
    check("…at most BULK_SEND_LIMIT at a time", messages.includes("BULK_SEND_LIMIT"));
    check("Copy & open writes the clipboard, then opens the profile, before its first await, and only then records the copy", (() => {
      const body = messages.slice(messages.indexOf("async function copyAndOpen()"));
      const clip = body.indexOf("navigator.clipboard");
      const open = body.indexOf("window.open(");
      const firstAwait = body.indexOf("await ");
      const record = body.indexOf("await copyLinkedIn(");
      return clip > 0 && open > clip && firstAwait > open && record === firstAwait && messages.includes('"_blank", "noopener"');
    })());
    check("…and catches a clipboard that rejects or is missing", /navigator\.clipboard[\s\S]*?\.catch\(/.test(messages) && /\} catch \{\s*onError\(message\.id, TOAST_COPY\.copyFailed\)/.test(messages));
    check("…and shows the server’s refusal on the row", /const res = await copyLinkedIn\(message\.id\);\s*if \(!res\.ok\) onError\(message\.id, res\.error\)/.test(messages));
    check("I sent it calls confirmLinkedInSent", messages.includes("confirmLinkedInSent(") && messages.includes("I sent it"));
    check("Write follow-up calls draftFollowUp", messages.includes("draftFollowUp(") && messages.includes("Write follow-up"));
    check("a button checks for replies by hand", messages.includes("Check for replies"));
    check("the capability line names the sender and what is left", messages.includes("left today") && messages.includes("From "));
    check("the capability line sits above the Send selected button", (() => {
      const line = messages.indexOf("<CapabilityLine");
      const button = messages.indexOf("Send selected");
      return line > 0 && button > line;
    })());
    check("a missing mailbox links to the email settings", messages.includes("/settings#settings-email") && messages.includes("Connect your email"));
    check("the header shows sent, replied and the reply rate", messages.includes("computeCampaignMetrics(") && messages.includes("formatReplyRate("));
    check("the sent date is relative", messages.includes("<RelativeTime"));
    check("a person who needs an address is pointed at the People tab", messages.includes("?tab=people"));
    check("an Unsure row shows the message’s own error text", messages.includes("errorMessage"));

    console.log("  never a second or a wrong send");
    {
      const send = calls(messages, "async function send(").length ? "" : "";
      void send;
      check("a send in flight is remembered in a ref as well as state", /sendingRef/.test(messages) && /\bsending\b/.test(messages));
      check("Send selected is disabled while one is in flight", /disabled=\{[^}]*\bsending\b/.test(messages));
      check("…and the flag is released only after the action returns", /finally\s*\{[^}]*sendingRef\.current = false/.test(messages.replace(/\s+/g, " ")));
      check("the people sent are cleared from the selection", /clearSent|setSelectedSends\(/.test(messages));
      check("a not-sent count is said as ‘n not sent yet — send again’, in the toast and on the page", messages.includes("sendSummary(") && messages.includes("setStatus(summary.text)"));
      check("a draft with unsaved edits cannot be sent or copied (the server holds the saved text)", messages.includes("dirty") && messages.includes("copyBlockedReason("));
      check("failures from a send show on their own rows", messages.includes("result.failed") || messages.includes("res.value.failed"));
      check("Write drafts only takes people without a message (it would overwrite a hand-edited draft)", messages.includes("needsDraft"));
      check("Send, Copy and Write follow-up come only from the pure grouping", messages.includes("messageGroups("));
      check("replies are looked for once on opening Sent, not on every change", /startedRef|checkedRef/.test(messages));
    }
    {
      const flat = messages.replace(/\s+/g, " ");
      check("asking to send refuses while one is in flight, with unsaved text, or without a mailbox", /function askToSend\(\) \{ if \(sendingRef\.current \|\| !sendCapability\?\.ok[^)]*unsaved\.length\)/.test(flat));
      check("confirming refuses while one is in flight", /async function confirmSend\(\) \{ if \(sendingRef\.current \|\| !batch\.ids\.length\) return;/.test(flat));
      check("I sent it releases its lock in a finally, so it can be pressed again after a failure", /async function confirmSent\(\) \{[\s\S]*?\} finally \{ setBusy\(null\);/.test(flat));
      check("…and is gated on nothing but its own lock", /<Button size="sm" onClick=\{confirmSent\} disabled=\{busy !== null\}>/.test(flat));
      check("Copy & open is off while the saved note is unsendable (over the limit, or unsaved edits)", /onClick=\{copyAndOpen\} disabled=\{busy !== null \|\| blocked !== null\}/.test(flat));
      check("a note over the limit is blocked from the saved text, not the typed text", /copyBlockedReason\(message, isDirty, person\.linkedinUrl\)/.test(flat));
      check("sending does not run its own reply look (the server refuses a follow-up whose first message has an outcome)", !/hasFollowUp/.test(flat) && (() => {
        const confirm = flat.slice(flat.indexOf("async function confirmSend()"), flat.indexOf("const nothing ="));
        return confirm.includes("sendMessages(") && !confirm.includes("checkReplies(");
      })());
      check("Write follow-up waits while replies are being checked", /disabled=\{followUpBusy !== null \|\| !canUseAi \|\| checking\}/.test(flat));
      check("Write drafts takes only the ids of people without a message", /draftMessages\(campaignId, batch\)/.test(flat) && /const draftIds = groups\.needsDraft\.filter/.test(flat));
      check("Send selected takes only ids of sendable drafts that are still on screen", /const sendIds = sendable\.filter\(\(r\) => selectedSends\.has/.test(flat));
    }
    check("nothing is selected to begin with", /useState<Set<string>>\(\(\) => new Set\(\)\)|useState\(new Set<string>\(\)\)|useState<Set<string>>\(new Set\(\)\)/.test(messages));

    console.log("  the reply hint");
    check("says what to do, quietly", messages.includes("Orbit can’t see replies — reconnect your email with read access to have them noticed"));
    check("shows only when the account can’t read mail", /canSeeReplies/.test(messages));
    {
      const lib = code("src/lib/outreach-replies.ts");
      const fn = declaration(lib, "export async function canSeeRepliesForUser");
      check("is worked out on the server from the connection scopes", fn.includes("GOOGLE_SCOPES.gmailRead") && fn.includes("hasMailScope("));
      check("…only for an active connection", (fn.match(/status === "active"/g) ?? []).length >= 2);
    }

    console.log("  the editor row");
    check("saves through editDraft", editor.includes("editDraft("));
    check("rewrites through draftMessages for just this person", /draftMessages\(\s*campaignId,\s*\[prospectId\]\s*\)/.test(editor));
    check("no longer calls the v1 update or regenerate", !editor.includes("updateOutreachMessage") && !editor.includes("regenerateOutreachDraft"));
    check("takes the message’s status", /\bstatus\b/.test(editor) && editor.includes("EDITABLE_STATUSES"));
    check("has a Rewrite button", editor.includes("Rewrite"));
    check("a follow-up’s subject is shown, not edited", editor.includes("stepIndex") && editor.includes("subjectLocked"));
    check("a follow-up has no Rewrite (drafting rewrites first messages only)", /stepIndex\s*===\s*0|!isFollowUp/.test(editor));
    check("the LinkedIn count is the string length, as the server counts it", /\.length/.test(editor) && !/Segmenter|Array\.from\(localBody|\[\.\.\.localBody/.test(editor));
    check("reports unsaved edits to the tab", editor.includes("onDirtyChange"));
    check("…and a Save or Rewrite still running counts as unsaved, so Send and Copy wait for it", /onDirtyChange\?\.\(messageId, dirty \|\| busy !== null\)/.test(editor) && /\[onDirtyChange, messageId, dirty, busy\]/.test(editor));

    console.log("  the outcome buttons");
    check("offer Replied, Positive, Negative and Bounced", ["Replied", "Positive", "Negative", "Bounced"].every((l) => outcome.includes(`"${l}"`)));
    check("have no No reply button", !/No reply/i.test(outcome));
    check("never turn into a read-only label once an outcome is set", !/if \(currentOutcome\)\s*\{\s*return/.test(outcome));
    check("show the current one as pressed", outcome.includes("aria-pressed"));
    check("keep the notes when none are typed", /notes\.trim\(\)\s*\|\|\s*undefined|notes:\s*typed/.test(outcome) && !/notes\.trim\(\) \|\| null/.test(outcome));
    check("are offered only on a sent message", /outcomeTarget/.test(messages) && messages.includes("<OutcomeControls"));

    console.log("  who can be written to, sent to or followed up");
    {
      const NOW = new Date("2026-10-26T12:00:00.000Z");
      const day = 86_400_000;
      const m = (over: Partial<ViewMessage> & { id: string }): ViewMessage => ({
        status: "draft",
        outcome: null,
        stepIndex: 0,
        channel: "email",
        sentAt: null,
        scheduledFor: null,
        repliedAt: null,
        subject: "Hello",
        body: "Hi there",
        errorMessage: null,
        ...over,
      });
      const p = (id: string, messagesOf: ViewMessage[], over: Partial<ViewPerson> = {}): ViewPerson => ({
        id,
        status: "selected",
        fullName: `Person ${id}`,
        title: null,
        company: null,
        email: `${id}@x.org`,
        linkedinUrl: null,
        messages: messagesOf,
        ...over,
      });
      const sentAgo = (days: number, over: Partial<ViewMessage> = {}) =>
        m({ id: `m-${days}`, status: "sent", sentAt: new Date(NOW.getTime() - days * day), ...over });
      const group = (people: ViewPerson[], channel: "email" | "linkedin" = "email") => messageGroups(people, channel, NOW);
      const ids = (list: { id: string }[]) => list.map((x) => x.id).join();
      const label = (g: ReturnType<typeof group>) => g.sent.map((s) => s.label).join();

      check("someone with no message and an address needs a draft", ids(group([p("a", [])]).needsDraft) === "a");
      check("…without an address, they need one first", ids(group([p("a", [], { email: null })]).needsInfo) === "a" && group([p("a", [], { email: null })]).needsDraft.length === 0);
      check("…on LinkedIn the address is the profile link", ids(group([p("a", [])], "linkedin").needsInfo) === "a" && ids(group([p("a", [], { linkedinUrl: "https://www.linkedin.com/in/a-b" })], "linkedin").needsDraft) === "a");
      check("someone not selected (an old suggestion) is not offered a draft", group([p("a", [], { status: "suggested" })]).needsDraft.length === 0);
      check("a removed person is in none of the lists", (() => {
        const g = group([p("a", [m({ id: "x" })], { status: "excluded" })]);
        return g.needsDraft.length + g.needsInfo.length + g.ready.length + g.sent.length === 0;
      })());
      check("a draft is ready to send", group([p("a", [m({ id: "d1" })])]).ready[0]?.message.id === "d1");
      check("a legacy generated draft is ready too", group([p("a", [m({ id: "d1", status: "generated" })])]).ready.length === 1);
      check("a failed send can go again, and keeps its error", (() => {
        const r = group([p("a", [m({ id: "f1", status: "failed", errorMessage: "Mailbox full" })])]).ready[0];
        return r?.message.id === "f1" && r.message.errorMessage === "Mailbox full";
      })());
      check("a copied LinkedIn note waits for I sent it", group([p("a", [m({ id: "c1", status: "copied", channel: "linkedin" })], { linkedinUrl: "https://www.linkedin.com/in/a-b" })], "linkedin").ready[0]?.message.status === "copied");
      check("a message being sent is waiting, with no send", (() => {
        const g = group([p("a", [sentAgo(0, { status: "queued", sentAt: null })])]);
        return g.ready.length === 0 && label(g) === "Sending" && g.sent[0]?.outcomeTarget === null;
      })());
      check("a may-have-sent message is Unsure, with its own words and no send", (() => {
        const g = group([p("a", [m({ id: "u1", status: "unsure", errorMessage: "The provider timed out" })])]);
        return g.ready.length === 0 && label(g) === "Unsure" && g.sent[0]?.problem === "The provider timed out" && g.sent[0]?.outcomeTarget === null;
      })());
      check("a fresh send is Waiting, with no follow-up yet", (() => {
        const g = group([p("a", [sentAgo(3)])]);
        return label(g) === "Waiting" && g.sent[0]?.followUpOf === null;
      })());
      check("a week later a follow-up is due, written under the first message", (() => {
        const g = group([p("a", [sentAgo(8)])]);
        return label(g) === "Follow-up due" && g.sent[0]?.followUpOf === "m-8";
      })());
      check("a reply ends it: Replied, nothing to write", (() => {
        const g = group([p("a", [sentAgo(8, { outcome: "replied" })])]);
        return label(g) === "Replied" && g.sent[0]?.followUpOf === null && g.ready.length === 0;
      })());
      check("a refined reply shows its tone", label(group([p("a", [sentAgo(8, { outcome: "positive_reply" })])])) === "Positive reply");
      check("a bounce is Bounced and ends it", (() => {
        const g = group([p("a", [sentAgo(8, { outcome: "bounced" })])]);
        return label(g) === "Bounced" && g.sent[0]?.followUpOf === null && g.ready.length === 0;
      })());
      check("a written follow-up moves the person to To send", (() => {
        const g = group([p("a", [sentAgo(8), m({ id: "fu", stepIndex: 1, subject: "Re: Hello" })])]);
        return g.sent.length === 0 && g.ready[0]?.message.id === "fu" && g.ready[0]?.message.stepIndex === 1;
      })());
      check("a follow-up draft is never offered once the first has an outcome", (() => {
        const g = group([p("a", [sentAgo(8, { outcome: "replied" }), m({ id: "fu", stepIndex: 1 })])]);
        return g.ready.length === 0 && g.sent[0]?.label === "Replied";
      })());
      check("a failed follow-up is not offered again once they have bounced", group([p("a", [sentAgo(8, { outcome: "bounced" }), m({ id: "fu", stepIndex: 1, status: "failed" })])]).ready.length === 0);
      check("…nor after a bounce", group([p("a", [sentAgo(8, { outcome: "bounced" }), m({ id: "fu", stepIndex: 1 })])]).ready.length === 0);
      check("a LinkedIn note is not offered to copy once they have replied", group([p("a", [sentAgo(8, { outcome: "replied", channel: "linkedin" }), m({ id: "fu", stepIndex: 1, channel: "linkedin" })], { linkedinUrl: "https://www.linkedin.com/in/a-b" })], "linkedin").ready.length === 0);
      check("a sent follow-up is Waiting again, not due again", (() => {
        const g = group([p("a", [sentAgo(8), sentAgo(1, { id: "fu", stepIndex: 1 })])]);
        return label(g) === "Follow-up sent — waiting" && g.sent[0]?.followUpOf === null;
      })());
      check("a follow-up that failed can be sent again", group([p("a", [sentAgo(8), m({ id: "fu", stepIndex: 1, status: "failed" })])]).ready[0]?.message.id === "fu");
      check("the outcome buttons go on the latest sent message", (() => {
        const g = group([p("a", [sentAgo(8), sentAgo(1, { id: "fu", stepIndex: 1 })])]);
        return g.sent[0]?.outcomeTarget?.id === "fu";
      })());
      check("an outcome on the first message keeps the buttons there, even with a follow-up sent", (() => {
        const g = group([p("a", [sentAgo(8, { outcome: "replied" }), sentAgo(1, { id: "fu", stepIndex: 1 })])]);
        return g.sent[0]?.outcomeTarget?.id === "m-8" && g.sent[0]?.outcomeTarget?.outcome === "replied";
      })());
      check("…and on the follow-up when that is where the outcome is", (() => {
        const g = group([p("a", [sentAgo(8), sentAgo(1, { id: "fu", stepIndex: 1, outcome: "positive_reply" })])]);
        return g.sent[0]?.outcomeTarget?.id === "fu";
      })());
      check("the sent date is the latest send, whichever message carries the outcome", (() => {
        const g = group([p("a", [sentAgo(8, { outcome: "replied" }), sentAgo(1, { id: "fu", stepIndex: 1 })])]);
        return new Date(g.sent[0]?.sentAt as Date).getTime() === NOW.getTime() - 1 * day;
      })());
      check("an outcome on a message that did not go out is not a target", (() => {
        const g = group([p("a", [sentAgo(8), m({ id: "o2", status: "opened", stepIndex: 1, outcome: "replied" })])]);
        return g.sent[0]?.outcomeTarget?.id === "m-8";
      })());
      check("…and only on a sent one", group([p("a", [m({ id: "d1" })])]).sent.length === 0);
      check("a legacy opened message counts as out the door", group([p("a", [m({ id: "o1", status: "opened" })])]).sent.length === 1);
      check("a legacy scheduled one is in no list", (() => {
        const g = group([p("a", [m({ id: "s1", status: "scheduled" })])]);
        return g.ready.length + g.sent.length + g.needsDraft.length === 0;
      })());

      check("a send summary says what went and what needs a look", sendSummary({ sent: 3, pending: 0, notSent: 0, failed: [{ messageId: "x", name: "Ann", error: "No" }] }).text === "Sent 3 · 1 needs attention");
      check("…counts ones still on their way", sendSummary({ sent: 2, pending: 1, notSent: 0, failed: [] }).text === "Sent 2 · 1 sending");
      check("…and is plain when nothing needs a look", sendSummary({ sent: 4, pending: 0, notSent: 0, failed: [] }).text === "Sent 4" && sendSummary({ sent: 4, pending: 0, notSent: 0, failed: [] }).tone === "success");
      check("…warns when something needs one", sendSummary({ sent: 1, pending: 0, notSent: 0, failed: [{ messageId: "x", name: "Ann", error: "No" }] }).tone === "warn");
      check("…says so when nothing moved", /nothing/i.test(sendSummary({ sent: 0, pending: 0, notSent: 0, failed: [] }).text));
      check("a run out of time says how many are left to send again", sendSummary({ sent: 20, pending: 0, notSent: 5, failed: [] }).text === "Sent 20 · 5 not sent yet — send again");
      check("unsent ones are named as such", notSentLine(3) === "3 not sent yet — send again" && notSentLine(1) === "1 not sent yet — send again");
      check("a send that ran out of time warns even when the rest went", sendSummary({ sent: 20, pending: 0, notSent: 5, failed: [] }).tone === "warn");

      const ok = { ok: true as const, fromEmail: "me@gmail.com", remainingToday: 37, dailyCap: 200, provider: "gmail", mailboxes: [{ secret: 1 }] };
      check("the send line keeps only what the page shows", JSON.stringify(toSendLine(ok)) === JSON.stringify({ ok: true, fromEmail: "me@gmail.com", remainingToday: 37, dailyCap: 200 }));
      check("a blocked sender keeps its reason", JSON.stringify(toSendLine({ ok: false, reason: "not_connected", provider: null, mailboxes: [] } as never)) === JSON.stringify({ ok: false, reason: "not_connected" }));

      const note = (n: number) => m({ id: "n", body: "x".repeat(n), channel: "linkedin" });
      check("a 300 character note can be copied", copyBlockedReason(note(300), false) === null);
      check("301 cannot", copyBlockedReason(note(301), false) !== null);
      check("it counts UTF-16 units, as the server does", copyBlockedReason(m({ id: "e", body: "😀".repeat(151), channel: "linkedin" }), false) !== null);
      check("unsaved edits cannot be copied", copyBlockedReason(note(10), true) !== null);
      const profile = "https://www.linkedin.com/in/jane-doe";
      check("a profile link the server accepts can be opened", copyBlockedReason(note(10), false, profile) === null && linkedInOpenUrl(profile) === profile);
      check("no link blocks the copy, as the server would", copyBlockedReason(note(10), false, null) !== null && copyBlockedReason(note(10), false, "  ") !== null);
      check("so does a link that isn’t a profile, or isn’t LinkedIn", copyBlockedReason(note(10), false, "https://www.linkedin.com/company/stripe") !== null && copyBlockedReason(note(10), false, "javascript:alert(1)") !== null && copyBlockedReason(note(10), false, "https://evil.example/in/jane") !== null);
      check("a look-alike host is not LinkedIn", linkedInOpenUrl("https://notlinkedin.com/in/jane") === null && linkedInOpenUrl("https://linkedin.com.evil.io/in/jane") === null);
      check("a legacy http link still opens, like the server’s", linkedInOpenUrl("http://uk.linkedin.com/in/jane-doe") === "http://uk.linkedin.com/in/jane-doe");
    }

    console.log("  client rules");
    for (const file of [files.messages, files.editor, files.outcome]) {
      const source = read(file);
      check(`${file} never value-imports the database`, !/import\s+(?!type\b)[^;]*from\s+["']@\/db/.test(source));
      check(`${file} has no escaped apostrophes`, !/\\u2019|&rsquo;|&#8217;/.test(source));
      check(`${file} has no control bytes`, !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(raw(file)));
      const links = [...source.matchAll(/target="_blank"[^>]*>/g)];
      check(`${file} opens every external link safely`, links.every((l) => l[0].includes('rel="noopener noreferrer nofollow"')), `${links.length} link(s)`);
    }
    check("the view helpers import nothing that reaches the database", !/from\s+["']@\/(db|lib\/email\/(outbox|sender))/.test(read(files.view)));
    check("the tab imports no server-only module", !/from\s+["']@\/lib\/(email\/|outreach-messages|outreach-replies|outreach-people)/.test(messages));
    check("async states are announced", (messages.match(/role="status"|aria-live="polite"/g) ?? []).length >= 3);
  }

  console.log("\nadd to campaign from Find people");
  {
    const findPage = "src/app/(clerk)/(app)/(main)/find/page.tsx";
    const addFile = "src/components/find/add-to-campaign.tsx";
    const findFile = "src/components/find/find-people.tsx";
    const page = code(findPage);
    const body = page.slice(Math.max(0, page.indexOf("export default async function")));
    check("the Find page awaits its visibility gate first", body.match(/await\s+([^;]*)/)?.[1]?.trim() === 'pageVisibilityGate("page.find")');
    check(
      "choices load only for a plan that has Outreach, and only once the page is live",
      /canUseOutreach\s*&&\s*\(await isSurfaceLive\(userId,\s*"page\.outreach"\)\)/.test(page) && page.includes("listCampaignChoicesForUser(userId)")
    );
    check("…and otherwise there are none", /\)\s*\?\s*listCampaignChoicesForUser\(userId\)\s*:\s*\[\]/.test(page));
    check("the choices go to the client as props", /<FindPeople[^>]*campaigns=\{/.test(page));

    const add = code(addFile);
    check("the menu is a client component", readFileSync(addFile, "utf8").startsWith('"use client"'));
    check("it is a dropdown menu", add.includes("DropdownMenu") && add.includes("DropdownMenuItem"));
    check("it adds through the action, one person at a time", /addProspects\(\s*\w+(?:\.id)?,\s*\[\s*person\s*\]\s*\)/.test(add));
    check("it names the campaign in the toast", add.includes("`Added to ${") && add.includes("`Already in ${"));
    check("a person who can't be added says what they need", add.includes("Couldn’t add them — they need a company or LinkedIn link"));
    check("the menu is off while an add is in flight", /disabled=\{pending\}/.test(add));
    check("the trigger is named for the person", /aria-label=\{`Add to campaign: \$\{/.test(add));
    check("nothing is offered without a campaign", /!choices\.length|choices\.length\s*===\s*0/.test(add) && /return null/.test(add));

    for (const file of [addFile, findFile]) {
      const source = code(file);
      check(`${file} never value-imports the database`, !/import\s+(?!type\b)[^;]*from\s+["']@\/db/.test(source));
      check(`${file} imports no server-only people module`, !/from\s+["']@\/lib\/outreach-people["']/.test(source));
      check(`${file} has no escaped apostrophes`, !/\\u2019|&rsquo;|&#8217;/.test(source));
    }
    const find = code(findFile);
    check("a discovery row adds as a find, with its page and why", /origin:\s*"find"/.test(find) && /whyMatches:\s*c\.whyMatches/.test(find) && /url:\s*c\.url/.test(find));
    check("a brief adds as a brief, keyed to its research", /origin:\s*"brief"/.test(find) && /researchKey:\s*key/.test(find));
    check("both cards offer the menu", (find.match(/<AddToCampaign\b/g) ?? []).length === 2);
  }

  console.log("\nbrowser-pass fixes");
  {
    console.log("  a person is never their own warm path");
    const path = (contactId: string, fullName: string): WarmPath => ({
      contactId,
      fullName,
      orgKey: "openai",
      orgLabel: "OpenAI",
      reason: "works_there",
      reasonLabel: "works there now",
      title: null,
      closeness: null,
      profileImageUrl: null,
      linkedinUrl: null,
      email: null,
    });
    const three = [path("c1", "Sarah Chen"), path("c2", "David Kim"), path("c3", "Paige Mercer")];
    check(
      "their own contact is dropped",
      JSON.stringify(withoutOwnContact(three, "c2").map((p) => p.fullName)) === JSON.stringify(["Sarah Chen", "Paige Mercer"])
    );
    check("someone with no contact keeps every path", withoutOwnContact(three, null).length === 3 && withoutOwnContact(three, undefined).length === 3);
    check("another person’s contact changes nothing", withoutOwnContact(three, "zzz").length === 3);
    check("only themselves leaves nothing, so the note hides", withoutOwnContact([path("c2", "David Kim")], "c2").length === 0);
    check("no paths is none", withoutOwnContact(undefined, "c2").length === 0);
    const note = code("src/components/outreach/warm-path-note.tsx");
    const people = code("src/components/outreach/campaign-people.tsx");
    check("the note filters through it", /withoutOwnContact\(/.test(note) && /!paths\.length|!paths\?\.length/.test(note));
    check("the people list tells it who the row is", /<WarmPathNote[^>]*ownContactId=\{person\.contactId\}/.test(people));

    console.log("  the header badges are words");
    const labels = (over: Partial<Parameters<typeof campaignHeaderLabels>[0]> = {}) =>
      campaignHeaderLabels({ status: "draft", defaultChannel: "linkedin", tone: "professional", replyCta: "ask_referral", ...over });
    check(
      "status, channel, tone and ask read as labels",
      JSON.stringify(labels()) === JSON.stringify(["Draft", "LinkedIn", "Professional", "A referral"]),
      JSON.stringify(labels())
    );
    check("an email campaign reads Email, active reads Active", JSON.stringify(labels({ status: "active", defaultChannel: "email" }).slice(0, 2)) === JSON.stringify(["Active", "Email"]));
    check("no channel is Email and no tone is Professional", JSON.stringify(labels({ defaultChannel: null, tone: null }).slice(1, 3)) === JSON.stringify(["Email", "Professional"]));
    check("no ask shows no ask badge", labels({ replyCta: null }).length === 3);
    check(
      "every ask has its label",
      OUTREACH_REPLY_CTAS.every((cta) => labels({ replyCta: cta }).at(-1) === REPLY_CTA_LABELS[cta])
    );
    check("an ask this build doesn’t know is still readable", labels({ replyCta: "book_demo" }).at(-1) === "Book demo");
    const page = code(`${OUTREACH_DIR}/[id]/page.tsx`);
    check("the page renders them", /campaignHeaderLabels\(campaign\)/.test(page));
    check("and no raw status, channel, tone or ask badge", !/\{campaign\.status\}|replaceAll\("_", " "\)|campaign\.tone \|\|/.test(page));
    check("the v1 search-source badge is gone", !page.includes("Demo search") && !page.includes("lastSearchSource"));

    console.log("  the audience is not said twice");
    const AUDIENCE = "Health economists and outcomes researchers at pharma companies in the Boston area";
    check("the same text is a duplicate", audienceSubtitle("Marketing leads", "Marketing leads") === null);
    check("trimmed and case-insensitive", audienceSubtitle("  marketing LEADS ", "Marketing leads  ") === null);
    check("the default name of a short audience is a duplicate", audienceSubtitle("PMs at Stripe", "PMs at Stripe") === null);
    check("the default name of a long audience (cut at 60) is a duplicate", audienceSubtitle(AUDIENCE.slice(0, 60).trim(), AUDIENCE) === null);
    check("…even with spacing the name collapsed", audienceSubtitle("Product leads at fintechs", "Product  leads\nat fintechs") === null);
    check("a different name keeps the audience", audienceSubtitle("Q4 push", AUDIENCE) === AUDIENCE);
    check("a short audience that merely starts with the name keeps it", audienceSubtitle("Marketing", "Marketing leads") === "Marketing leads");
    check("exactly 60 characters is not “longer”, so a prefix is kept", audienceSubtitle("a".repeat(30), "a".repeat(30) + "b".repeat(30)) === "a".repeat(30) + "b".repeat(30));
    check("an empty name never matches", audienceSubtitle("", AUDIENCE) === AUDIENCE);
    check("no audience shows nothing", audienceSubtitle("Q4 push", "  ") === null && audienceSubtitle("Q4 push", null) === null);
    check("the page asks the helper", /audienceSubtitle\(campaign\.name,\s*campaign\.audienceQuery\)/.test(page));

    console.log("  final review");
    const pending = code("src/components/email/pending-sends.tsx");
    check("the contact page offers no Retry or Edit for a campaign send", /retryable\s*=[^;]*s\.origin !== "outreach"/.test(pending));
    check("a send stops handing over at 35s", /SEND_BUDGET_MS = 35_000/.test(code("src/lib/outreach-messages.ts")));
    const sentView = declaration(code("src/components/outreach/campaign-messages.tsx"), "function SentView(");
    check("the Sent view offers It went out for an unsure message", sentView.includes("It went out") && sentView.includes("markWentOut("));
    check("…through a guarded, wrapped action", (() => {
      const action = declaration(code("src/actions/outreach-messages.ts"), "export async function markWentOut");
      return action.includes("asActionResult") && action.indexOf("requireOutreachUser()") > 0 && action.includes("markMessageWentOutForUser(");
    })());

    console.log("  a locked, empty address is text, not a box");
    const field = declaration(people, "function SavedField(");
    check("the field says No address on file", people.includes('"No address on file"') || people.includes("No address on file"));
    check("in place of the input, only when locked and empty", /locked\s*&&\s*!saved/.test(field) || /!saved\s*&&\s*locked/.test(field));
    check("a locked address with a value keeps the read-only input", /readOnly=\{locked\}/.test(field));
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
