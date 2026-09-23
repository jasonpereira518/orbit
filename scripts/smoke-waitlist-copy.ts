/**
 * Nothing the waitlist hands a visitor or a recipient names the product, describes what it
 * does, or points at the app's domain (src/lib/waitlist-host.ts).
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

import { readFileSync } from "node:fs";

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
  check("welcome: states the place in line", numbered.subject === "You're #1,285 on the waitlist" && numbered.text.includes("#1,285"));
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
    const src = code(file);
    // Strings and JSX text only: identifiers are minified away.
    const literals = [...src.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]!);
    const jsxText = [...src.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]!);
    const hit = [...literals, ...jsxText].find((t) => /\borbit\b/i.test(t) || /\/sign-up|\/dashboard|\/pricing/.test(t));
    check(`${file} says nothing about the product`, !hit, hit);
    check(`${file} imports no marketing chrome`, !/MarketingFooter|LandingAuthControls|OrbitLogo|BackControl/.test(src));
  }

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
