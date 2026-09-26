/**
 * Renders the waitlist page function in its three states and checks what crosses the
 * client boundary — and that the page names no product and leads nowhere.
 *
 * WHY THIS EXISTS. The page is dynamic and decides form / invited / ticket from the URL on
 * the server. The client hero only ever sees its `initial` prop, so that prop IS the
 * contract: the wrong `kind`, a missing inviter planet or a ticket for a bogus token would
 * render a page that looks fine and is wrong. Same walk as `smoke-interest-list-admin.ts`.
 *
 * Run: npx tsx scripts/smoke-interest-list-page.ts
 */
import "./smoke/_env";

import { like } from "drizzle-orm";
import { getDb } from "../src/db";
import { interestListSignups } from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";
import { invalidateInterestProof } from "../src/lib/interest-list-ticket";

const PREFIX = "smoke-page-";
const TOKEN = "smoke-page-token";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** Finds the first prop named `name` anywhere in a rendered element tree. */
function findProp(node: unknown, name: string): unknown {
  if (node == null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findProp(child, name);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  const el = node as { props?: Record<string, unknown> };
  if (!el.props) return undefined;
  if (name in el.props) return el.props[name];
  for (const value of Object.values(el.props)) {
    const hit = findProp(value, name);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Visible text of a tree, descending into children and the FAQ's q/a. */
function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  const el = node as { props?: Record<string, unknown> };
  // A React element carries its payload under `.props`; a plain data object (one entry of
  // the FAQ array, e.g. `{ q, a }`) carries it directly on itself — fall back to the node
  // when there is no `.props` wrapper, so those are reachable the same way.
  const bag = el.props ?? (el as Record<string, unknown>);
  for (const [key, value] of Object.entries(bag)) {
    if (key === "children" || key === "items" || key === "q" || key === "a") textOf(value, out);
  }
  return out;
}

/** Every `href` prop anywhere in a rendered tree, FAQ answers included. */
function hrefsOf(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) hrefsOf(child, out);
    return out;
  }
  const bag = (node as { props?: Record<string, unknown> }).props ?? (node as Record<string, unknown>);
  if (typeof bag.href === "string") out.push(bag.href);
  for (const value of Object.values(bag)) {
    if (value && typeof value === "object") hrefsOf(value, out);
  }
  return out;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
  invalidateInterestProof();
}

async function main() {
  await cleanup();
  const db = await getDb();
  await db.insert(interestListSignups).values({
    email: `${PREFIX}a@example.test`,
    unsubscribeToken: generateUnsubscribeToken(),
    shareToken: TOKEN,
    welcomePlanet: "saturn",
  });

  const mod = await import("../src/app/(site)/interest/page");
  const Page = mod.default;
  const sp = (q: Record<string, string>) => ({ searchParams: Promise.resolve(q) });

  // --- form
  const form = await Page(sp({}));
  const formInitial = findProp(form, "initial") as { kind: string; invite: unknown; proof: { count: number } };
  check("no params renders the form", formInitial?.kind === "form", JSON.stringify(formInitial));
  check("no invite without a ref", formInitial.invite === null);
  check("proof is loaded", typeof formInitial.proof?.count === "number");
  // The headline and the card live inside the client hero, which this walk cannot enter —
  // it sees the hero's props (asserted above) and the server-rendered sections below it.
  const formText = textOf(form).join(" ");
  check("the FAQ keeps the product under wraps", formText.includes("under wraps"));
  check("the front wave is explained", formText.includes("How do I get into the front wave?"));
  // Its one sanctioned mark is the "Project: Orbit" header; nothing else names it.
  const unmarked = formText.replace("Project: Orbit", "");
  check("the header carries the product mark", formText.includes("Project: Orbit"));
  check("nothing else names the product", !/orbit/i.test(unmarked), unmarked.match(/.{0,40}orbit.{0,40}/i)?.[0]);
  check(
    "nothing says it is live, free or open for sign-up",
    !/\b(live|sign up|sign-up|start free|free for)\b/i.test(formText),
    formText.match(/.{0,40}\b(live|sign up|sign-up|start free|free for)\b.{0,40}/i)?.[0]
  );
  const hrefs = hrefsOf(form);
  check(
    "it links only to itself and its privacy notice",
    hrefs.length > 0 && hrefs.every((h) => h === "#interest-join" || h === "/interest/privacy"),
    hrefs.join(", ")
  );
  check("the hero gets the waitlist page URL, not the app's", String(findProp(form, "pageUrl")).endsWith("/interest"));

  // --- invited
  const invited = await Page(sp({ ref: TOKEN }));
  const invitedInitial = findProp(invited, "initial") as { kind: string; invite: unknown; ref: unknown };
  check("a ref keeps the form", invitedInitial?.kind === "form");
  check("a ref resolves the inviter's planet", invitedInitial.invite === "saturn", String(invitedInitial.invite));
  check("the ref token is handed to the form", invitedInitial.ref === TOKEN);
  const unknownRef = findProp(await Page(sp({ ref: "nope" })), "initial") as { invite: unknown };
  check("an unknown ref shows no invite", unknownRef.invite === null);

  // --- ticket
  const ticket = await Page(sp({ me: TOKEN }));
  const ticketInitial = findProp(ticket, "initial") as {
    kind: string;
    ticket: { number: number; position: number; referrals: number; planet: string; shareToken: string };
  };
  check("a me token renders the ticket", ticketInitial?.kind === "ticket", JSON.stringify(ticketInitial));
  check("the ticket is the row's", ticketInitial.ticket.planet === "saturn" && ticketInitial.ticket.shareToken === TOKEN);
  check("the ticket has a join number and a place in line", ticketInitial.ticket.number >= 1 && ticketInitial.ticket.position >= 1);
  check("the ticket counts referrals", ticketInitial.ticket.referrals === 0);
  const leftDb = await getDb();
  await leftDb.update(interestListSignups).set({ unsubscribedAt: new Date() }).where(like(interestListSignups.email, `${PREFIX}%`));
  const left = findProp(await Page(sp({ me: TOKEN })), "initial") as { kind: string };
  check("someone who left gets the form back, not a pass", left.kind === "form");
  await leftDb.update(interestListSignups).set({ unsubscribedAt: null }).where(like(interestListSignups.email, `${PREFIX}%`));
  const both = findProp(await Page(sp({ me: TOKEN, ref: "whatever" })), "initial") as { kind: string };
  check("me wins over ref", both.kind === "ticket");
  const bogus = findProp(await Page(sp({ me: "nope" })), "initial") as { kind: string };
  check("a bogus me token falls back to the form", bogus.kind === "form");
  // `ref` loses to a ticket that resolved, not to the presence of `me`.
  const bogusMe = findProp(await Page(sp({ me: "bogus", ref: TOKEN })), "initial") as {
    kind: string;
    invite: unknown;
    ref: unknown;
  };
  check("a bogus me keeps the form", bogusMe.kind === "form", JSON.stringify(bogusMe));
  check("a bogus me does not discard a valid ref", bogusMe.invite === "saturn", String(bogusMe.invite));
  check("the surviving ref reaches the form", bogusMe.ref === TOKEN, String(bogusMe.ref));
  const tooLong = findProp(await Page(sp({ me: "x".repeat(200) })), "initial") as { kind: string };
  check("an oversized token is ignored", tooLong.kind === "form");

  // --- metadata
  const meta = await mod.generateMetadata(sp({ me: TOKEN }));
  const og = meta.openGraph as { images?: unknown } | undefined;
  check("ticket metadata carries the image", JSON.stringify(og?.images ?? "").includes(`ticket-image?token=${TOKEN}`), JSON.stringify(og));
  check("ticket metadata keeps the one title", meta.title === "Early access — the future of networking", String(meta.title));
  check("no metadata names the product", !/orbit/i.test(JSON.stringify(meta)), JSON.stringify(meta));
  check("the page swaps out the product's icon", JSON.stringify(meta.icons ?? "").includes("/waitlist/icon.png"));
  const refMeta = await mod.generateMetadata(sp({ ref: TOKEN }));
  check("ref metadata carries the image too", JSON.stringify(refMeta.openGraph ?? "").includes("ticket-image"));
  const plain = await mod.generateMetadata(sp({}));
  check("plain metadata is the default", plain.title === "Early access — the future of networking");
  check("plain metadata still previews with the generic card", JSON.stringify(plain.openGraph ?? "").includes("ticket-image"));

  // --- the admin's switch for the product demo
  const demo = await import("../src/lib/waitlist-demo");
  const { siteSettings } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  const shows = (tree: unknown) => textOf(tree).join(" ").includes("Take it for a spin");
  check("the demo shows by default (never set reads as on)", shows(form) && (await demo.getWaitlistDemoEnabled({ fresh: true })) === true);
  await demo.setWaitlistDemoEnabled("smoke-admin", false);
  check("turning it off hides the section", !shows(await Page(sp({}))));
  check("…and the rest of the page is untouched", textOf(await Page(sp({}))).join(" ").includes("How early access works"));
  await demo.setWaitlistDemoEnabled("smoke-admin", true);
  check("turning it back on shows it again", shows(await Page(sp({}))));
  const [row] = await (await getDb()).select().from(siteSettings).where(eq(siteSettings.id, 1));
  check("the switch leaves the stealth switch alone", row?.stealthEnabled === null && row?.stealthSince === null, JSON.stringify(row));
  const { adminAuditLog } = await import("../src/db/schema");
  const audited = await (await getDb()).select().from(adminAuditLog).where(like(adminAuditLog.action, "site.waitlist_demo.%"));
  check("every flip is in the audit log", audited.length === 2 && audited.every((a) => a.adminUserId === "smoke-admin"), String(audited.length));
  await (await getDb()).delete(adminAuditLog).where(like(adminAuditLog.action, "site.waitlist_demo.%"));

  // --- the privacy notice
  const privacy = await (await import("../src/app/(site)/interest/privacy/page")).default();
  const privacyText = textOf(privacy).join(" ");
  check("the notice never names the product", !/orbit/i.test(privacyText));
  check("the notice links only back to the waitlist", hrefsOf(privacy).every((h) => h === "/interest"), hrefsOf(privacy).join(", "));

  await cleanup();
  console.log("\nwaitlist page: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
