/**
 * Renders /interest's page function in its three states and checks what crosses the
 * client boundary.
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
  check("the waitlist FAQ answer is rewritten", formText.includes("no queue"));
  check("the detour section is gone", !formText.includes("There's nothing to"));

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
  const ticketInitial = findProp(ticket, "initial") as { kind: string; ticket: { number: number; planet: string; shareToken: string } };
  check("a me token renders the ticket", ticketInitial?.kind === "ticket", JSON.stringify(ticketInitial));
  check("the ticket is the row's", ticketInitial.ticket.planet === "saturn" && ticketInitial.ticket.shareToken === TOKEN);
  check("the ticket has a number", ticketInitial.ticket.number >= 1);
  const both = findProp(await Page(sp({ me: TOKEN, ref: "whatever" })), "initial") as { kind: string };
  check("me wins over ref", both.kind === "ticket");
  const bogus = findProp(await Page(sp({ me: "nope" })), "initial") as { kind: string };
  check("a bogus me token falls back to the form", bogus.kind === "form");
  const tooLong = findProp(await Page(sp({ me: "x".repeat(200) })), "initial") as { kind: string };
  check("an oversized token is ignored", tooLong.kind === "form");

  // --- metadata
  const meta = await mod.generateMetadata(sp({ me: TOKEN }));
  const og = meta.openGraph as { images?: unknown } | undefined;
  check("ticket metadata carries the image", JSON.stringify(og?.images ?? "").includes(`ticket-image?token=${TOKEN}`), JSON.stringify(og));
  check("ticket metadata titles the passenger", String(meta.title).startsWith("Passenger"));
  const refMeta = await mod.generateMetadata(sp({ ref: TOKEN }));
  check("ref metadata carries the image too", JSON.stringify(refMeta.openGraph ?? "").includes("ticket-image"));
  const plain = await mod.generateMetadata(sp({}));
  check("plain metadata is the default", String(plain.title).startsWith("Interest list"));

  await cleanup();
  console.log("\ninterest page: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
