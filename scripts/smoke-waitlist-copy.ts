/**
 * Nothing the waitlist hands a recipient names the product, describes what it does, or
 * points at the app's domain (src/lib/waitlist-host.ts). The page itself carries exactly
 * one mark — "Project: Orbit", top left — and nothing else that names it.
 *
 * WHY THIS EXISTS. The waitlist goes to a large audience before the product is public, and
 * emails are the easiest thing in the world to forward. A leak here is one careless string
 * — a logo URL built on `getAppBaseUrl()`, a "try it now" link, "Orbit" in a footer — and
 * nothing else would catch it before it reached thousands of inboxes. So every email the
 * waitlist sends is built with the app's and the waitlist's domains set to different
 * values, and every URL in it must be on the waitlist's. The UI strings are checked at the
 * source, comments stripped.
 *
 * Database tier only because the email module's error logging imports `@/db`; nothing is
 * written. Run: npx tsx scripts/smoke-waitlist-copy.ts
 */
import "./smoke/_env";

import { readFileSync, readdirSync } from "node:fs";

const APP_BASE = "https://app.orbit-example.test";
const WAITLIST = "join.example";

process.env.APP_BASE_URL = APP_BASE;
process.env.WAITLIST_HOST = WAITLIST;
delete process.env.WAITLIST_BASE_URL;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** Words that would describe what the product does. The pitch stays one line above them. */
const FEATURE_WORDS = /\b(orbit|crm|contacts?|linkedin|gmail|calendar|follow-ups?|intros?|drifting|capture|reminders?|outreach|recruiters?|constellation|sign[- ]?up|start free|free for|pricing|already live)\b/i;

function urlsIn(html: string) {
  return [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

function assertClean(name: string, message: { subject: string; html: string; text: string }) {
  const all = `${message.subject}\n${message.html}\n${message.text}`;
  const hit = all.match(new RegExp(`.{0,40}${FEATURE_WORDS.source}.{0,40}`, "i"));
  check(`${name}: names nothing and describes nothing`, !hit, hit?.[0]);
  check(`${name}: never mentions the app's domain`, !all.includes("orbit-example"));
  const urls = urlsIn(message.html);
  check(
    `${name}: every link and image is on the waitlist's domain`,
    urls.length > 0 && urls.every((u) => u.startsWith(`https://${WAITLIST}/`)),
    urls.filter((u) => !u.startsWith(`https://${WAITLIST}/`)).join(", ")
  );
  check(`${name}: has a way to leave`, /Leave the waitlist/.test(message.html) && /Leave the waitlist/.test(message.text));
}

/** Source with comments stripped, so a comment describing the rule never trips it. */
function code(file: string) {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
}

async function main() {
  const email = await import("../src/lib/interest-list-email");
  const { buildBroadcastEmail } = await import("../src/lib/broadcasts");
  const { buildShareUrl, buildTicketUrl } = await import("../src/lib/interest-list");
  const { getWaitlistPageUrl } = await import("../src/lib/app-url");

  console.log("Links point at the waitlist's own domain:");
  const page = getWaitlistPageUrl();
  check("the waitlist page is the waitlist domain's root", page === `https://${WAITLIST}/`, page);
  const links = { ticketUrl: buildTicketUrl(page, "tok"), shareUrl: buildShareUrl(page, "tok") };
  check("pass and invite links are on it", links.ticketUrl === `https://${WAITLIST}/?me=tok` && links.shareUrl === `https://${WAITLIST}/?ref=tok`);
  const leave = email.buildUnsubscribeUrl("tok");
  check("the leave link is on it", leave.startsWith(`https://${WAITLIST}/api/interest-list/unsubscribe`), leave);

  console.log("\nEvery email the waitlist sends:");
  assertClean("welcome", email.buildInterestListWelcomeEmail({ unsubscribeUrl: leave, planet: "saturn", links, position: 1285 }));
  const numbered = email.buildInterestListWelcomeEmail({ unsubscribeUrl: leave, planet: "saturn", links, position: 1285 });
  check("welcome: states the place in line", numbered.text.includes("#1,285") && numbered.html.includes("No. 1,285"));
  check("welcome: the subject is the paper letter's", numbered.subject === "You're on the list");
  check("welcome: the referral URL stays on the pass page", !numbered.html.includes("?ref=") && !numbered.text.includes("?ref="));
  const anchors = [...numbered.html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]!);
  check("welcome: one link besides the leave link", anchors.length === 2 && anchors[0]!.includes("?me=tok"), anchors.join(", "));
  check("welcome: asks clients not to invert the paper", numbered.html.includes('content="light only"'));
  const unnumbered = email.buildInterestListWelcomeEmail({ unsubscribeUrl: leave, planet: "saturn", links, position: null });
  check("welcome: without a count, says no number rather than a wrong one", !/#\d/.test(unnumbered.subject + unnumbered.text));
  check("welcome: explains the front wave", numbered.text.includes("front wave"));
  assertClean("front wave", email.buildFrontWaveEmail({ unsubscribeUrl: leave, planet: "mars", links }));
  assertClean("broadcast", buildBroadcastEmail({ subject: "An update", body: "Opening line.\n\nMore.", unsubscribeUrl: leave }));

  console.log("\nWho it comes from:");
  process.env.RESEND_FROM_EMAIL = "orbit@app.orbit-example.test";
  process.env.CONTACT_INBOX_EMAIL = "jason@app.orbit-example.test";
  delete process.env.WAITLIST_FROM_EMAIL;
  delete process.env.WAITLIST_REPLY_TO;
  check("with a waitlist domain, never the app's sender", email.waitlistSender() === null, String(email.waitlistSender()));
  check("…and never the app's contact inbox as reply-to", email.waitlistReplyTo() === undefined);
  process.env.WAITLIST_FROM_EMAIL = "hello@join.example";
  check("a bare waitlist sender is signed by Jason", email.waitlistSender() === "Jason <hello@join.example>");
  process.env.WAITLIST_FROM_EMAIL = "Early Access <hi@join.example>";
  check("a named waitlist sender is left alone", email.waitlistSender() === "Early Access <hi@join.example>");
  delete process.env.WAITLIST_FROM_EMAIL;
  delete process.env.WAITLIST_HOST;
  check("before any waitlist domain, the app's sender still works", email.waitlistSender() === "Jason <orbit@app.orbit-example.test>");
  process.env.WAITLIST_HOST = WAITLIST;

  console.log("\nThe leave link asks first:");
  const { GET } = await import("../src/app/api/interest-list/unsubscribe/route");
  const { NextRequest } = await import("next/server");
  const res = await GET(new NextRequest(`https://${WAITLIST}/api/interest-list/unsubscribe?token=abc`));
  const body = await res.text();
  check("a GET shows a confirmation, never leaves by itself", res.status === 200 && body.includes('method="post"') && body.includes("Leave the waitlist"));
  check("the confirmation names nothing", !/orbit/i.test(body));
  check("…and posts back to itself", body.includes('action="/api/interest-list/unsubscribe?token=abc"'));

  console.log("\nWhat the waitlist's own pages and components say:");
  const surface = [
    "src/app/(site)/interest/page.tsx",
    "src/app/(site)/interest/privacy/page.tsx",
    "src/app/(site)/interest/loading.tsx",
    "src/components/interest/interest-hero.tsx",
    "src/components/interest/boarding-pass.tsx",
    "src/components/interest/share-row.tsx",
    "src/components/interest/proof-line.tsx",
    "src/components/interest/moons.tsx",
    "src/components/interest/waitlist-skeleton.tsx",
    "src/app/api/interest-list/ticket-image/route.tsx",
    "src/app/api/interest-list/unsubscribe/route.ts",
    "src/lib/interest-list.ts",
  ];
  for (const file of surface) {
    // The page's one sanctioned mark is its "Project: Orbit" header; nothing else may name it.
    const raw = code(file);
    const src = file === "src/app/(site)/interest/page.tsx" ? raw.replace(/>\s*Project: Orbit\s*</, "><") : raw;
    // Strings and JSX text only: identifiers are minified away.
    const literals = [...src.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]!);
    const jsxText = [...src.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]!);
    const hit = [...literals, ...jsxText].find((t) => /\borbit\b/i.test(t) || /\/sign-up|\/dashboard|\/pricing/.test(t));
    check(`${file} says nothing about the product`, !hit, hit);
    check(`${file} imports no marketing chrome`, !/MarketingFooter|LandingAuthControls|OrbitLogo|BackControl/.test(src));
  }

  console.log("\nThe app demo is self-contained:");
  const demoDir = "src/components/interest/app-demo";
  const demoFiles = readdirSync(demoDir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => `${demoDir}/${f}`);
  check("the demo has files to check", demoFiles.length >= 10, String(demoFiles.length));
  for (const file of demoFiles) {
    const src = code(file);
    const banned = src.match(/from\s+["'](@\/db[^"']*|@clerk\/[^"']*|@\/actions[^"']*|next\/link|next\/image|next\/navigation|@\/components\/orbit-logo)["']/);
    check(`${file} imports nothing from the app, auth or database`, !banned, banned?.[1]);
    check(`${file} links nowhere and fetches nothing`, !/\bhref=|\bfetch\(|\bwindow\.open\(|\blocation\.(href|assign)/.test(src));
    const assets = [...src.matchAll(/["'](\/[a-z0-9_\-/.]+\.(?:png|jpe?g|svg|webp|gif))["']/gi)].map((m) => m[1]!);
    check(`${file} loads assets only from /waitlist/`, assets.every((a) => a.startsWith("/waitlist/")), assets.join(", "));
  }

  console.log("\nThe demo's chat answers from its cast:");
  const { answerQuestion } = await import("../src/components/interest/app-demo/demo-chat");
  const promise = answerQuestion("What did I promise Maya?");
  check("a promise question answers with the promise", promise.kind === "promise" && promise.text.includes("design offsite") && promise.draft?.personId === "maya");
  check("…citing Gmail or Calendar", promise.sources.some((s) => s.source === "Gmail" || s.source === "Google Calendar"));
  check("a company question lists the people there", answerQuestion("Who do I know at Stripe?").kind === "company");
  check("an intro question picks a match", answerQuestion("Who should meet Grace Liu?").text.includes("Elena"));
  check("a follow-up question ranks suggestions", answerQuestion("Who should I follow up with this week?").kind === "follow-up");
  check("an unknown company says so", answerQuestion("Who do I know at Acme Rockets?").kind === "company-none");
  check("anything else still gets an answer", answerQuestion("best pizza near me").text.length > 20);
  const kinds = promise.steps.map((x) => x.kind).join(",");
  check("the answer narrates the real chat's stages in order", kinds === "understand,search,rank,read,answer", kinds);
  const read = promise.steps.find((x) => x.kind === "read");
  check("…and reads exactly the people it cites", JSON.stringify(read?.refs) === JSON.stringify([...new Set(promise.sources.map((x) => x.personId))]));

  console.log("\nThe demo's actions ripple through it:");
  const st = await import("../src/components/interest/app-demo/demo-state");
  let s = st.initialDemoState("explore");
  const due0 = st.stats(s).due;
  s = st.demoReducer(s, { type: "setFollowUp", id: "maya", days: 0 });
  check("setting a follow-up due today raises the Due count", st.stats(s).due === due0 + 1);
  check("…and answers the engine's nudge", !st.activeSuggestions(s).some((x) => x.personId === "maya"));
  s = st.demoReducer(s, { type: "ask", q: "What did I promise Maya?" });
  const turn = s.chat.find((t) => t.role === "assistant")!;
  s = st.demoReducer(s, { type: "draft", turnId: turn.id });
  s = st.demoReducer(s, { type: "sendDraft", turnId: turn.id });
  const maya = (await import("../src/components/interest/app-demo/demo-cast")).personById("maya")!;
  check("sending a draft logs it to the timeline via Gmail", st.timelineOf(s, maya)[0]?.source === "Gmail" && st.lastTouchOf(s, maya) === 0);
  check("reset keeps the mode", st.demoReducer({ ...s, mode: "tour" }, { type: "reset" }).mode === "tour");

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nThe waitlist names nothing and leads nowhere.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
