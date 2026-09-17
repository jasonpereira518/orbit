/**
 * The whole job-feed runtime against PGlite, with a scripted fetch and no network.
 *
 * THE FAILURE THIS EXISTS FOR. A feed matcher is one bug away from being a spam cannon. The
 * properties pinned here are the four the design says must never be cut:
 *
 *   ONE NOTIFICATION PER (user, posting, contact), FOREVER. A second sweep over the same
 *   postings must create nothing at all — not a duplicate suggestion, not a duplicate match
 *   row. The unique index is what enforces it, and `onConflictDoNothing().returning()` is
 *   what makes the sweep able to tell a new pair from one it has already decided about.
 *
 *   THE VOLUME GUARDS SUPPRESS, THEY DO NOT DROP. A match past the per-run cap is still
 *   written, as `suppressed` with no suggestion — so the index keeps blocking it and the row
 *   is the only record of why nobody was told.
 *
 *   A MATCH IS AN ai_suggestion, NEVER A REMINDER. `loadNotificationPanel` maps suggestions
 *   at a hardcoded `urgency: "info"`, so nothing here can fire an OS notification off text
 *   that came from an anonymous pull request.
 *
 *   THE CURSOR NEVER OUTRUNS WHAT WAS WRITTEN. A run cut short by the wall-clock budget must
 *   leave the cursor at the last row it actually stored, or the listings it skipped are lost
 *   permanently.
 *
 * Run: npx tsx scripts/smoke-job-feed-sweep.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-job-feed-sweep";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-job-feed-sweep";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  aiSuggestions,
  contactOpportunities,
  contacts,
  jobFeedSources,
  jobPostingMatches,
  jobPostings,
} from "../src/db/schema";
import { DEFAULT_JOB_FEEDS, MAX_POSTING_AGE_DAYS } from "../src/lib/jobs/feed-sources";
import { runJobFeedSweep } from "../src/lib/jobs/feed-sweep";
import {
  JOB_SIGNAL_SUGGESTION_TYPE,
  MAX_MATCHES_PER_USER_PER_RUN,
  MAX_OPEN_JOB_SUGGESTIONS,
} from "../src/lib/jobs/matcher";

const USER = "smoke-job-feed-user";
const OTHER = "smoke-job-feed-other";
const FEED_ID = DEFAULT_JOB_FEEDS[0].id;
const SEASON = DEFAULT_JOB_FEEDS[0].season;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const NOW = new Date("2026-09-17T12:00:00Z");
const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

let nextId = 0;
function listing(over: Partial<Record<string, unknown>> = {}) {
  nextId += 1;
  return {
    id: `listing-${nextId}`,
    company_name: "Stripe",
    title: `Software Engineer Intern ${nextId}`,
    url: "https://example.com/apply",
    company_url: "https://stripe.com",
    terms: [SEASON],
    locations: ["New York, NY"],
    active: true,
    is_visible: true,
    date_posted: unix(daysAgo(1)),
    date_updated: unix(daysAgo(1)),
    ...over,
  };
}

/** A fetch that answers one scripted response per call and records the request headers. */
function scriptedFetch(responses: Response[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const res = responses[i++];
    if (!res) throw new Error("no scripted response left");
    return res;
  }) as unknown as typeof fetch;
  return { deps: { fetch: fn }, calls };
}

function feedResponse(items: unknown[], headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function reset() {
  const db = await getDb();
  for (const user of [USER, OTHER]) {
    await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, user));
    await db.delete(jobPostingMatches).where(eq(jobPostingMatches.userId, user));
    // Cascades interactions, opportunities and mentions.
    await db.delete(contacts).where(eq(contacts.userId, user));
  }
  await db.delete(jobPostings).where(eq(jobPostings.sourceId, FEED_ID));
  await db.delete(jobFeedSources).where(eq(jobFeedSources.id, FEED_ID));
}

/** A contact at `company`, with one open opportunity of `kind`. */
async function seedWatcher(
  userId: string,
  fullName: string,
  company: string,
  kind: "internship" | "referral" = "internship"
) {
  const db = await getDb();
  const [contact] = await db
    .insert(contacts)
    .values({ userId, fullName, company })
    .returning();
  await db.insert(contactOpportunities).values({
    userId,
    contactId: contact!.id,
    kind,
    label: "summer internship",
    status: "open",
    createdBy: "ai",
  });
  return contact!;
}

async function main() {
  await reset();
  const db = await getDb();

  console.log("\nthe first sweep: seed, fetch, ingest, match");
  const sarah = await seedWatcher(USER, "Sarah Chen", "Stripe");
  {
    const { deps, calls } = scriptedFetch([feedResponse([listing(), listing()], { etag: 'W/"v1"' })]);
    const stats = await runJobFeedSweep({ fetchDeps: deps, now: NOW });

    check("the configured feed is seeded on first run", stats.feeds === 1, String(stats.feeds));
    check("  and no validators are sent the first time", !("if-none-match" in calls[0]!.headers));
    check("two listings ingested", stats.upserted === 2, String(stats.upserted));

    const stored = await db.query.jobPostings.findMany({ where: eq(jobPostings.sourceId, FEED_ID) });
    check("  rows are in job_postings", stored.length === 2, String(stored.length));
    // The bucket, not the raw name: this is what the matcher probes.
    check("  filed under the company bucket", stored.every((p) => p.companyKey === "stripe"), JSON.stringify(stored.map((p) => p.companyKey)));

    check("one contact matched", stats.match.matchesCreated === 2, String(stats.match.matchesCreated));
    // Two postings, one contact, ONE suggestion. `filteredSuggestions` dedupes on
    // `suggestionType:contactId`, so per-posting rows would render in the bell and then
    // silently collapse on the dashboard.
    check("  aggregated into a single suggestion", stats.match.suggestionsCreated === 1, String(stats.match.suggestionsCreated));

    const [suggestion] = await db.query.aiSuggestions.findMany({ where: eq(aiSuggestions.userId, USER) });
    check("  of the job-signal type", suggestion?.suggestionType === JOB_SIGNAL_SUGGESTION_TYPE, suggestion?.suggestionType);
    check("  pointing at the contact, never at the posting", JSON.stringify(suggestion?.relatedContactIds) === JSON.stringify([sarah.id]));
    check("  naming the company", Boolean(suggestion?.title.includes("Stripe")), suggestion?.title);
    check("  and the person", Boolean(suggestion?.description?.includes("Sarah Chen")), suggestion?.description ?? "");
    // The panel renders `description` as plain text and links to /contacts/{id}. A URL from
    // an anonymous pull request must never become a clickable link in the notification bell.
    check("  carrying no third-party URL", !`${suggestion?.title} ${suggestion?.description}`.includes("http"), suggestion?.description ?? "");
  }

  console.log("\nthe second sweep tells nobody anything twice");
  {
    const { deps, calls } = scriptedFetch([new Response(null, { status: 304 })]);
    const stats = await runJobFeedSweep({ fetchDeps: deps, now: NOW });
    check("the stored etag is sent back", calls[0]!.headers["if-none-match"] === 'W/"v1"', JSON.stringify(calls[0]!.headers));
    check("  and a 304 costs nothing", stats.notModified === 1 && stats.upserted === 0);
    // The postings are still there and still match. Nothing new may be created.
    check("no new match rows", stats.match.matchesCreated === 0, String(stats.match.matchesCreated));
    check("  and no second suggestion", stats.match.suggestionsCreated === 0, String(stats.match.suggestionsCreated));
    const all = await db.query.aiSuggestions.findMany({ where: eq(aiSuggestions.userId, USER) });
    check("  still exactly one in the table", all.length === 1, String(all.length));
  }

  console.log("\nwhat is deliberately not matched");
  await reset();
  await seedWatcher(USER, "Sarah Chen", "Stripe");
  {
    const { deps } = scriptedFetch([
      feedResponse([
        // A posting the feed backfilled. "An internship dropping" is the promise, and an old
        // row matching trains people to ignore the notification.
        listing({ date_posted: unix(daysAgo(MAX_POSTING_AGE_DAYS + 5)), date_updated: unix(daysAgo(1)) }),
        listing({ active: false }),
        listing({ is_visible: false }),
        // A different employer. `companyFamilyKey`'s first-token fallback would match this.
        listing({ company_name: "Stripe Bank" }),
        // Next year's roles in the same file.
        listing({ terms: ["Summer 2028"] }),
      ]),
    ]);
    const stats = await runJobFeedSweep({ fetchDeps: deps, now: NOW });
    check("a wrong-season listing is never stored", stats.perFeed[0]!.skippedSeason === 1, String(stats.perFeed[0]!.skippedSeason));
    check("  the rest are", stats.upserted === 4, String(stats.upserted));
    check("nothing matches", stats.match.matchesCreated === 0, String(stats.match.matchesCreated));
  }

  console.log("\nthe company spellings that must match, and the one that must not");
  await reset();
  await seedWatcher(USER, "Dana Cole", "Capital One");
  {
    const { deps } = scriptedFetch([
      // The direction a lookup-key set gets wrong: the feed carries the suffix and the
      // contact does not, and `job_postings.company_key` is a single indexed column.
      feedResponse([listing({ company_name: "Capital One, N.A." })]),
    ]);
    const stats = await runJobFeedSweep({ fetchDeps: deps, now: NOW });
    check('"Capital One" matches "Capital One, N.A."', stats.match.matchesCreated === 1, String(stats.match.matchesCreated));
  }

  console.log("\nthe per-run cap suppresses rather than drops");
  await reset();
  {
    // One contact, many postings: past the cap the extra matches must still be WRITTEN.
    await seedWatcher(USER, "Sarah Chen", "Stripe");
    const many = Array.from({ length: MAX_MATCHES_PER_USER_PER_RUN + 4 }, () => listing());
    const { deps } = scriptedFetch([feedResponse(many)]);
    const stats = await runJobFeedSweep({ fetchDeps: deps, now: NOW });

    check("every posting is ingested", stats.upserted === many.length, String(stats.upserted));
    check("every match row is written", stats.match.matchesCreated === many.length, String(stats.match.matchesCreated));
    check(`  but only ${MAX_MATCHES_PER_USER_PER_RUN} are notified`, stats.match.suppressed === 4, String(stats.match.suppressed));

    const rows = await db.query.jobPostingMatches.findMany({ where: eq(jobPostingMatches.userId, USER) });
    const suppressed = rows.filter((r) => r.status === "suppressed");
    const notified = rows.filter((r) => r.status === "notified");
    check("  the suppressed rows exist, with no suggestion", suppressed.length === 4 && suppressed.every((r) => r.suggestionId === null), String(suppressed.length));
    check("  and the notified ones carry theirs", notified.length === MAX_MATCHES_PER_USER_PER_RUN && notified.every((r) => r.suggestionId !== null));
    // The point of writing them: the unique index now blocks these forever, so "we decided
    // this was noise" is a decision that survives.
    const again = await runJobFeedSweep({ fetchDeps: scriptedFetch([new Response(null, { status: 304 })]).deps, now: NOW });
    check("  and a later run never revisits them", again.match.matchesCreated === 0, String(again.match.matchesCreated));
  }

  console.log("\nthe open-suggestion cap");
  await reset();
  {
    // One contact per company, so each is its own suggestion — the per-contact aggregation
    // cannot hide the cap.
    for (let i = 0; i < MAX_OPEN_JOB_SUGGESTIONS + 3; i++) {
      await seedWatcher(USER, `Person ${i}`, `Company${i}Labs`);
    }
    const items = Array.from({ length: MAX_OPEN_JOB_SUGGESTIONS + 3 }, (_, i) =>
      listing({ company_name: `Company${i}Labs` })
    );
    const { deps } = scriptedFetch([feedResponse(items)]);
    const stats = await runJobFeedSweep({ fetchDeps: deps, now: NOW });
    check(`at most ${MAX_OPEN_JOB_SUGGESTIONS} suggestions are opened`, stats.match.suggestionsCreated === MAX_OPEN_JOB_SUGGESTIONS, String(stats.match.suggestionsCreated));
    check("  the rest are suppressed, not lost", stats.match.suppressed === 3, String(stats.match.suppressed));
    const open = await db.query.aiSuggestions.findMany({ where: eq(aiSuggestions.userId, USER) });
    check("  and the table agrees", open.length === MAX_OPEN_JOB_SUGGESTIONS, String(open.length));
  }

  console.log("\none user's opportunities never reach another user");
  await reset();
  {
    await seedWatcher(USER, "Sarah Chen", "Stripe");
    await seedWatcher(OTHER, "Someone Else", "Datadog");
    const { deps } = scriptedFetch([feedResponse([listing()])]);
    await runJobFeedSweep({ fetchDeps: deps, now: NOW });
    const mine = await db.query.jobPostingMatches.findMany({ where: eq(jobPostingMatches.userId, USER) });
    const theirs = await db.query.jobPostingMatches.findMany({ where: eq(jobPostingMatches.userId, OTHER) });
    check("the watching user is matched", mine.length === 1);
    check("  and the other user is not", theirs.length === 0, String(theirs.length));
    const theirSuggestions = await db.query.aiSuggestions.findMany({ where: eq(aiSuggestions.userId, OTHER) });
    check("  and gets no suggestion", theirSuggestions.length === 0);
  }

  console.log("\na closed opportunity stops watching");
  await reset();
  {
    const contact = await seedWatcher(USER, "Sarah Chen", "Stripe");
    await db
      .update(contactOpportunities)
      .set({ status: "landed" })
      .where(and(eq(contactOpportunities.userId, USER), eq(contactOpportunities.contactId, contact.id)));
    const { deps } = scriptedFetch([feedResponse([listing()])]);
    const stats = await runJobFeedSweep({ fetchDeps: deps, now: NOW });
    check("the posting is still ingested", stats.upserted === 1);
    check("  but nobody is watching the company", stats.match.matchesCreated === 0, String(stats.match.matchesCreated));
  }

  console.log("\nthe incremental cursor");
  await reset();
  await seedWatcher(USER, "Sarah Chen", "Stripe");
  {
    const old = listing({ date_updated: unix(daysAgo(30)), date_posted: unix(daysAgo(30)) });
    const recent = listing({ date_updated: unix(daysAgo(1)) });
    const first = scriptedFetch([feedResponse([old, recent], { etag: 'W/"a"' })]);
    await runJobFeedSweep({ fetchDeps: first.deps, now: NOW });

    const source = await db.query.jobFeedSources.findFirst({ where: eq(jobFeedSources.id, FEED_ID) });
    check("the cursor advances to the newest row written", source?.lastMaxDateUpdated === unix(daysAgo(1)), String(source?.lastMaxDateUpdated));
    check("  and the etag is stored for next time", source?.etag === 'W/"a"', String(source?.etag));

    // A second 200 with the same document: everything is at or behind the cursor, so the
    // skew allowance is the only reason anything is re-read.
    const second = scriptedFetch([feedResponse([old, recent], { etag: 'W/"b"' })]);
    const stats = await runJobFeedSweep({ fetchDeps: second.deps, now: NOW });
    check("a listing far behind the cursor is skipped", stats.perFeed[0]!.skippedStale === 1, String(stats.perFeed[0]!.skippedStale));
    // Within the 3-day skew window: contributors backdate, and the repo's own scripts
    // rewrite these fields, so an exact-cursor comparison silently misses real edits.
    check("  one inside the skew window is re-read", stats.perFeed[0]!.upserted === 1, String(stats.perFeed[0]!.upserted));
    const rows = await db.query.jobPostings.findMany({ where: eq(jobPostings.sourceId, FEED_ID) });
    check("  and re-reading updates rather than duplicates", rows.length === 2, String(rows.length));
  }

  console.log("\na run cut short leaves the cursor where it actually got to");
  await reset();
  {
    // The deadline is already past, so the first chunk is never started.
    const { deps } = scriptedFetch([feedResponse([listing(), listing()])]);
    const stats = await runJobFeedSweep({ fetchDeps: deps, now: NOW, deadline: Date.now() - 1 });
    check("nothing is written", stats.upserted === 0, String(stats.upserted));
    check("  and the run reports itself truncated", stats.truncated);
    const source = await db.query.jobFeedSources.findFirst({ where: eq(jobFeedSources.id, FEED_ID) });
    check("  the cursor does not move past unwritten rows", source?.lastMaxDateUpdated === 0, String(source?.lastMaxDateUpdated));
    // The validators are the point: storing them here would make the next run a 304 and the
    // rest of the file would never be seen.
    check("  and no etag is stored, so the next run re-downloads", !source?.etag, String(source?.etag));
  }

  console.log("\nfeed failures are recorded, never thrown");
  await reset();
  {
    const { deps } = scriptedFetch([new Response(null, { status: 500 }), new Response(null, { status: 500 }), new Response(null, { status: 500 })]);
    const stats = await runJobFeedSweep({ fetchDeps: deps, now: NOW });
    check("the sweep completes", stats.failed === 1, String(stats.failed));
    const source = await db.query.jobFeedSources.findFirst({ where: eq(jobFeedSources.id, FEED_ID) });
    check("  the status is stored", source?.lastStatus === "http_error", String(source?.lastStatus));
    check("  and the failure is counted", source?.consecutiveFailures === 1, String(source?.consecutiveFailures));
  }
  {
    // A body that arrived whole and is not the file we expect. No validators stored, so the
    // next run re-reads rather than 304ing forever against something it cannot parse.
    const { deps } = scriptedFetch([feedResponse({ listings: [] } as unknown as unknown[], { etag: 'W/"drift"' })]);
    const stats = await runJobFeedSweep({ fetchDeps: deps, now: NOW });
    check("a document of the wrong shape is drift", stats.perFeed[0]!.status === "schema_drift", stats.perFeed[0]!.status);
    const source = await db.query.jobFeedSources.findFirst({ where: eq(jobFeedSources.id, FEED_ID) });
    check("  and its etag is not stored", !source?.etag, String(source?.etag));
  }

  console.log("\na disabled feed is never re-enabled by a deploy");
  await reset();
  {
    await runJobFeedSweep({ fetchDeps: scriptedFetch([feedResponse([])]).deps, now: NOW });
    await db.update(jobFeedSources).set({ enabled: false }).where(eq(jobFeedSources.id, FEED_ID));
    // No scripted response at all: if the sweep tried to fetch, this would throw.
    const stats = await runJobFeedSweep({ fetchDeps: scriptedFetch([]).deps, now: NOW });
    check("the disabled feed is not fetched", stats.feeds === 0, String(stats.feeds));
    const source = await db.query.jobFeedSources.findFirst({ where: eq(jobFeedSources.id, FEED_ID) });
    check("  and the seed does not turn it back on", source?.enabled === false);
  }

  await reset();
  console.log("\nsmoke-job-feed-sweep: all checks passed");
  // PGlite keeps the event loop alive; without this the suite hangs here.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
