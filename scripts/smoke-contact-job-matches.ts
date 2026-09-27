/**
 * What a contact's profile is allowed to say about a role that opened, and what it must not.
 *
 * THE FAILURE THIS EXISTS FOR IS THE LINK. Every field in `job_postings` arrived from an
 * anonymous pull request to a public repository. `matcher.ts` keeps that text out of the
 * notification bell's `url` on purpose — a third-party link in the operating system's own
 * UI is a content-injection channel — and this section is the first place in the product
 * where such a link is rendered at all. So the guarantee it rests on is pinned here rather
 * than left to the ingest that happens to enforce it today:
 *
 *   A NON-HTTPS URL NEVER BECOMES AN HREF. Not `javascript:`, not `data:`, not a relative
 *   path, not something unparseable. `parseListing` already drops those at ingest — but that
 *   guard ran in whichever version of the ingest was deployed the day the row was written,
 *   and a row older than a guard is exactly the row that gets through it. So the read
 *   re-checks, and this asserts the read re-checks.
 *
 *   THE HOST COMES BACK WITH IT, so the component can show where a click actually goes. A
 *   link whose visible label is attacker-controlled and whose destination is invisible is
 *   the whole trick.
 *
 * The rest is the reading order and the two deliberate differences from the bell: suppressed
 * matches ARE shown here, and a posting the feed has since taken down is marked rather than
 * hidden.
 *
 * Run: npx tsx scripts/smoke-contact-job-matches.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-contact-job-matches";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-contact-job-matches";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contacts,
  jobFeedSources,
  jobPostingMatches,
  jobPostings,
} from "../src/db/schema";
import { DEFAULT_JOB_FEEDS } from "../src/lib/jobs/feed-sources";
import {
  MAX_CONTACT_JOB_MATCHES,
  listJobMatchesForContact,
} from "../src/lib/jobs/contact-matches";

const USER = "smoke-cjm-user";
const OTHER = "smoke-cjm-other";
const FEED_ID = DEFAULT_JOB_FEEDS[0].id;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const NOW = new Date("2026-09-17T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

let seq = 0;

async function main() {
  const db = await getDb();

  async function reset() {
    for (const userId of [USER, OTHER]) {
      await db.delete(jobPostingMatches).where(eq(jobPostingMatches.userId, userId));
      await db.delete(contacts).where(eq(contacts.userId, userId));
    }
    await db.delete(jobPostings).where(eq(jobPostings.sourceId, FEED_ID));
    await db.delete(jobFeedSources).where(eq(jobFeedSources.id, FEED_ID));
  }

  await reset();

  await db.insert(jobFeedSources).values({
    id: FEED_ID,
    label: DEFAULT_JOB_FEEDS[0].label,
    url: DEFAULT_JOB_FEEDS[0].url,
    season: DEFAULT_JOB_FEEDS[0].season,
    enabled: true,
  });

  async function makeContact(userId: string, fullName: string, company: string) {
    const [row] = await db.insert(contacts).values({ userId, fullName, company }).returning();
    return row!;
  }

  async function makePosting(opts: {
    title: string;
    url: string;
    postedDaysAgo?: number;
    active?: boolean;
    isVisible?: boolean;
    locations?: string[];
  }) {
    const [row] = await db
      .insert(jobPostings)
      .values({
        sourceId: FEED_ID,
        externalId: `ext-${++seq}`,
        companyName: "Stripe",
        companyKey: "stripe",
        title: opts.title,
        url: opts.url,
        terms: ["Summer 2027"],
        locations: opts.locations ?? ["Remote"],
        active: opts.active ?? true,
        isVisible: opts.isVisible ?? true,
        datePosted: daysAgo(opts.postedDaysAgo ?? 1),
        dateUpdated: daysAgo(opts.postedDaysAgo ?? 1),
      })
      .returning();
    return row!;
  }

  async function makeMatch(
    userId: string,
    contactId: string,
    postingId: string,
    status: "notified" | "suppressed" = "notified"
  ) {
    await db.insert(jobPostingMatches).values({
      userId,
      contactId,
      postingId,
      companyKey: "stripe",
      matchKind: "internship",
      status,
    });
  }

  console.log("\nthe link, which is the only dangerous field here");
  {
    const ada = await makeContact(USER, "Ada Byron", "Stripe");
    // Each of these is something `parseListing` would refuse today. The point is that a row
    // already in the table — written before that guard, or by a different ingest — must not
    // become an href either.
    const hostile: [string, string][] = [
      ["javascript:", "javascript:alert(document.cookie)"],
      ["data:", "data:text/html,<script>alert(1)</script>"],
      ["plain http", "http://simplify.jobs/p/1"],
      ["a relative path", "/contacts/00000000-0000-0000-0000-000000000000"],
      ["unparseable", "not a url at all"],
    ];
    for (const [label, url] of hostile) {
      const posting = await makePosting({ title: `Role ${label}`, url });
      await makeMatch(USER, ada.id, posting.id);
    }
    const { rows } = await listJobMatchesForContact(USER, ada.id, 20);
    check("every hostile URL is read back", rows.length === hostile.length, String(rows.length));
    check("  and not one of them became a link", rows.every((r) => r.url === null),
      JSON.stringify(rows.filter((r) => r.url).map((r) => r.url)));
    check("  nor produced a host to display", rows.every((r) => r.host === null));

    const good = await makePosting({ title: "Backend Intern", url: "https://simplify.jobs/p/abc" });
    await makeMatch(USER, ada.id, good.id);
    const after = await listJobMatchesForContact(USER, ada.id, 20);
    const linked = after.rows.find((r) => r.title === "Backend Intern")!;
    check("an https posting does become a link", linked.url === "https://simplify.jobs/p/abc", String(linked.url));
    // Without this the label can claim anything and the destination stays invisible.
    check("  and it carries the host to show beside it", linked.host === "simplify.jobs", String(linked.host));
  }

  console.log("\nwhose matches these are");
  {
    const mine = await makeContact(USER, "Grace Hopper", "Stripe");
    const theirs = await makeContact(OTHER, "Grace Hopper", "Stripe");
    const posting = await makePosting({ title: "Compiler Intern", url: "https://simplify.jobs/p/gh" });
    await makeMatch(OTHER, theirs.id, posting.id);

    const { rows } = await listJobMatchesForContact(USER, mine.id);
    check("another user's match on the same posting is not visible", rows.length === 0, String(rows.length));
    // And the read is scoped by user, not merely by an unguessable contact id.
    const wrongUser = await listJobMatchesForContact(USER, theirs.id);
    check("  nor is it reachable by asking for their contact id", wrongUser.rows.length === 0,
      String(wrongUser.rows.length));
  }

  console.log("\nwhat the profile shows that the bell does not");
  {
    const linus = await makeContact(USER, "Linus Pauling", "Stripe");
    const suppressed = await makePosting({ title: "Suppressed Role", url: "https://simplify.jobs/p/s" });
    await makeMatch(USER, linus.id, suppressed.id, "suppressed");

    const { rows } = await listJobMatchesForContact(USER, linus.id);
    // The volume guards protect a NOTIFICATION CHANNEL. Somebody who opened this page came
    // looking, and this is the only surface a suppressed match has ever had.
    check("a suppressed match is shown on the profile", rows.length === 1, String(rows.length));
    check("  flagged as one nobody was told about", rows[0]!.wasNotified === false);
  }

  console.log("\na role that has since come down");
  {
    const alan = await makeContact(USER, "Alan Turing", "Stripe");
    const closed = await makePosting({
      title: "Closed Role",
      url: "https://simplify.jobs/p/c",
      active: false,
      postedDaysAgo: 2,
    });
    const hidden = await makePosting({
      title: "Hidden Role",
      url: "https://simplify.jobs/p/h",
      isVisible: false,
      postedDaysAgo: 3,
    });
    const live = await makePosting({
      title: "Live Role",
      url: "https://simplify.jobs/p/l",
      postedDaysAgo: 10,
    });
    for (const p of [closed, hidden, live]) await makeMatch(USER, alan.id, p.id);

    const { rows } = await listJobMatchesForContact(USER, alan.id);
    // Marked, not hidden: it is why the suggestion in the bell exists, and the bell fired
    // once and can never come back to say the role came down.
    check("a closed role is still listed", rows.length === 3, String(rows.length));
    check("  active: false reads as closed", rows.find((r) => r.title === "Closed Role")!.isOpen === false);
    check("  and so does is_visible: false", rows.find((r) => r.title === "Hidden Role")!.isOpen === false);
    // Open first even though it is the oldest of the three — history does not need the top.
    check("open roles sort above closed ones, whatever their dates",
      rows[0]!.title === "Live Role", rows.map((r) => r.title).join());
  }

  console.log("\nthe cap, and saying so honestly");
  {
    const edsger = await makeContact(USER, "Edsger Dijkstra", "Stripe");
    for (let i = 0; i < MAX_CONTACT_JOB_MATCHES; i++) {
      const p = await makePosting({ title: `Role ${i}`, url: `https://simplify.jobs/p/${i}`, postedDaysAgo: i });
      await makeMatch(USER, edsger.id, p.id);
    }
    const exact = await listJobMatchesForContact(USER, edsger.id);
    check("exactly the cap is not 'more'", exact.rows.length === MAX_CONTACT_JOB_MATCHES && !exact.hasMore,
      `${exact.rows.length}/${exact.hasMore}`);

    const extra = await makePosting({ title: "One Too Many", url: "https://simplify.jobs/p/x", postedDaysAgo: 20 });
    await makeMatch(USER, edsger.id, extra.id);
    const over = await listJobMatchesForContact(USER, edsger.id);
    check("one past the cap is reported as more", over.hasMore === true);
    check("  and the list is still exactly the cap", over.rows.length === MAX_CONTACT_JOB_MATCHES,
      String(over.rows.length));
    // Newest first within the open group, so the oldest is the one that falls off.
    check("  the one dropped is the oldest", !over.rows.some((r) => r.title === "One Too Many"),
      over.rows.map((r) => r.title).join());
  }

  console.log("\nnothing to say");
  {
    const quiet = await makeContact(USER, "Quiet Person", "Nowhere");
    const { rows, hasMore } = await listJobMatchesForContact(USER, quiet.id);
    // The component returns null on this, so the card never appears as an empty heading.
    check("a contact with no matches comes back empty", rows.length === 0 && !hasMore);
  }

  await reset();
  console.log("\nsmoke-contact-job-matches: all checks passed");
  // PGlite keeps the event loop alive; without this the suite hangs here.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
