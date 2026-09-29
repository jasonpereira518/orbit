/**
 * Radar's company news, end to end on a throwaway PGlite with a scripted fetch.
 *
 * Parsing (Hacker News JSON, RSS, Atom, and what a hostile feed can put in them), the
 * headline company candidates, the hourly sweep (new items only, validators, a failing feed
 * recorded and survived), and the nightly per-account probe: one statement, confirmed by
 * `companiesMatch`, at most three a night, and each written once to `contact_signals`.
 *
 * The default sources are disabled for the run and replaced by test sources on example.com,
 * so nothing here reaches a real publisher. Leaves nothing behind.
 *
 * Run: npx tsx scripts/smoke-radar-feeds.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactSignals, contacts, externalItemCompanies, externalItems, externalSources } from "../src/db/schema";
import { headlineCompanies } from "../src/lib/radar/feeds/companies";
import { parseNewsDocument } from "../src/lib/radar/feeds/parse";
import { DEFAULT_NEWS_SOURCES } from "../src/lib/radar/feeds/sources";
import { deleteNewsForSources, ingestNewsItems, pruneNews, seedNewsSources } from "../src/lib/radar/feeds/store";
import { runNewsSweep } from "../src/lib/radar/feeds/sweep";
import { capturedQueries, startQueryCount, stopQueryCount } from "../src/lib/query-counter";
import { NO_SUPPRESSION, scoreContactKinds, type RadarContact } from "../src/lib/radar/score";
import { probeCompanyNews, RADAR_NEWS_PER_RUN } from "../src/lib/radar/signals/news";
import type { RadarCandidateRow } from "../src/lib/radar/signals/internal";
import { loadPostSignals, saveLinkedinActivity } from "../src/lib/radar/signals/activity";
import { handlesForTonight, pollSocialPosts } from "../src/lib/radar/signals/social";

const USER = "smoke-radar-feeds-user";
const NOW = new Date("2031-06-10T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TEST_SOURCES = ["smoke-hn", "smoke-rss", "smoke-atom", "smoke-down"];

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const hnDoc = (items: Array<{ id: string; title: string; url?: string | null; hoursAgo: number }>) =>
  JSON.stringify({
    hits: items.map((i) => ({
      objectID: i.id,
      title: i.title,
      url: i.url ?? null,
      created_at_i: Math.floor((NOW.getTime() - i.hoursAgo * HOUR) / 1000),
    })),
  });

const rssDoc = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Smoke</title>
  <item><title>Stripe acquires Bridge for $1.1B</title><link>https://example.com/stripe-bridge</link>
    <guid>rss-1</guid><pubDate>${new Date(NOW.getTime() - 3 * HOUR).toUTCString()}</pubDate>
    <description>&lt;p&gt;The payments company &lt;b&gt;bought&lt;/b&gt; a stablecoin startup.&lt;/p&gt;</description></item>
  <item><title>Hostile link</title><link>javascript:alert(1)</link><guid>rss-2</guid>
    <pubDate>${new Date(NOW.getTime() - 4 * HOUR).toUTCString()}</pubDate></item>
  <item><title>Ancient history at Acme</title><link>https://example.com/old</link><guid>rss-3</guid>
    <pubDate>${new Date(NOW.getTime() - 40 * DAY).toUTCString()}</pubDate></item>
</channel></rss>`;

const atomDoc = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Smoke</title>
  <entry><id>atom-1</id><title>Linear raises Series C led by Accel</title>
    <link rel="alternate" href="https://example.com/linear"/>
    <published>${new Date(NOW.getTime() - 2 * HOUR).toISOString()}</published>
    <summary>Project tool funding.</summary></entry>
</feed>`;

async function reset() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await deleteNewsForSources(TEST_SOURCES);
  await db
    .update(externalSources)
    .set({ enabled: true })
    .where(inArray(externalSources.id, DEFAULT_NEWS_SOURCES.map((s) => s.id)));
}

function candidate(id: string, company: string): RadarCandidateRow {
  return {
    id,
    fullName: id,
    preferredName: null,
    title: null,
    company,
    industry: null,
    tier: "mid",
    hasEvidence: true,
    priorityLevel: 0,
    relationshipScore: 2,
    statedCloseness: null,
    firstInteractionAt: null,
    lastInteractionAt: null,
    nextFollowUpAt: null,
    constellationPin: null,
    cadenceDays: null,
    cadencePhrase: null,
  };
}

run(async () => {
  const db = await getDb();
  await reset();

  console.log("parsing");
  {
    const hn = parseNewsDocument("hn", hnDoc([
      { id: "1", title: "Show HN: A tiny database in Rust", hoursAgo: 1 },
      { id: "2", title: "OpenAI and Microsoft renegotiate", url: "https://example.com/oai", hoursAgo: 2 },
    ]));
    check("Hacker News stories", hn.length === 2 && hn[0]!.externalId === "hn:1");
    check("a story with no link points at its discussion", hn[0]!.url === "https://news.ycombinator.com/item?id=1");
    const rss = parseNewsDocument("rss", rssDoc);
    check("RSS items, newest first", rss[0]?.title === "Stripe acquires Bridge for $1.1B", rss.map((r) => r.title).join(" | "));
    check("markup is stripped from summaries", rss[0]?.summary === "The payments company bought a stablecoin startup.", rss[0]?.summary ?? "");
    check("a javascript: link never survives", rss.find((r) => r.externalId === "rss-2")?.url === null);
    const atom = parseNewsDocument("atom", atomDoc);
    check("Atom entries with their alternate link", atom[0]?.url === "https://example.com/linear");
    check("garbage is nothing, not a crash", parseNewsDocument("rss", "<<<not xml").length === 0 && parseNewsDocument("hn", "{").length === 0);
  }

  console.log("\ncompany candidates");
  {
    const names = (t: string) => headlineCompanies(t).map((c) => c.name);
    check("the subject of a headline", names("Stripe acquires Bridge for $1.1B").includes("Stripe"));
    check("possessives trimmed", names("Apple’s new iPhone ships").includes("Apple"));
    check("multi-word names kept whole", names("Capital One to buy Discover Financial").includes("Capital One"));
    check("sentence furniture skipped", !names("Show HN: The new way to ship").some((n) => /^(Show|HN|The)$/.test(n)));
  }

  console.log("\nthe sweep");
  {
    // Test sources on example.com; the real ones sit out this run. Seeded first, so the
    // sweep's own seeding cannot bring them back enabled.
    await seedNewsSources();
    await db.update(externalSources).set({ enabled: false }).where(inArray(externalSources.id, DEFAULT_NEWS_SOURCES.map((s) => s.id)));
    await db.insert(externalSources).values([
      { id: "smoke-hn", label: "Smoke HN", url: "https://example.com/hn.json", kind: "hn" },
      { id: "smoke-rss", label: "Smoke RSS", url: "https://example.com/feed.xml", kind: "rss" },
      { id: "smoke-atom", label: "Smoke Atom", url: "https://example.com/atom.xml", kind: "atom" },
      { id: "smoke-down", label: "Smoke Down", url: "https://example.com/down.xml", kind: "rss" },
    ]);
    const bodies: Record<string, () => Response> = {
      "https://example.com/hn.json": () =>
        new Response(hnDoc([{ id: "9", title: "Ramp raises $500M at a new valuation", url: "https://example.com/ramp", hoursAgo: 1 }]), {
          headers: { "content-type": "application/json" },
        }),
      "https://example.com/feed.xml": () => new Response(rssDoc, { headers: { "content-type": "application/rss+xml", etag: 'W/"v1"' } }),
      "https://example.com/atom.xml": () => new Response(atomDoc, { headers: { "content-type": "application/atom+xml" } }),
      "https://example.com/down.xml": () => new Response("nope", { status: 503 }),
    };
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchDeps = {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        sent.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
        return (bodies[url] ?? (() => new Response("missing", { status: 404 })))();
      }) as typeof fetch,
    };
    const first = await runNewsSweep({ fetchDeps, now: NOW });
    check("every source read, the broken one survived", first.fetched === 3 && first.failed === 1, JSON.stringify(first));
    check("new headlines stored, stale ones skipped", first.newItems === 4, `${first.newItems}`);
    const [down] = await db.select().from(externalSources).where(eq(externalSources.id, "smoke-down"));
    check("a failing feed is counted on its row", (down?.consecutiveFailures ?? 0) >= 1 && down?.lastStatus !== "ok", JSON.stringify(down?.lastStatus));
    check("no request names a company or an account", sent.every((r) => !/stripe|acme|smoke-radar/i.test(r.url)));
    const stripeKeys = await db
      .select({ key: externalItemCompanies.companyKey })
      .from(externalItemCompanies)
      .innerJoin(externalItems, eq(externalItems.id, externalItemCompanies.itemId))
      .where(eq(externalItems.externalId, "rss-1"));
    check("each headline is filed under its company keys", stripeKeys.some((k) => k.key === "stripe"));
    sent.length = 0;
    const second = await runNewsSweep({ fetchDeps, now: new Date(NOW.getTime() + HOUR) });
    check("a second sweep adds nothing it already has", second.newItems === 0, `${second.newItems}`);
    check("and sends back the validators it was given", sent.some((r) => r.url.endsWith("feed.xml") && r.headers["if-none-match"] === 'W/"v1"'));
  }

  console.log("\nthe nightly probe");
  {
    const people = await db
      .insert(contacts)
      .values([
        { userId: USER, fullName: "At Stripe", company: "Stripe, Inc." },
        { userId: USER, fullName: "At Stripes", company: "Stripes Bakery" },
        { userId: USER, fullName: "At Linear", company: "Linear" },
        { userId: USER, fullName: "At Ramp", company: "Ramp" },
        { userId: USER, fullName: "Also Stripe", company: "Stripe" },
      ])
      .returning();
    const byName = (n: string) => people.find((p) => p.fullName === n)!.id;
    const cands = people.map((p) => candidate(p.id, p.company!));
    startQueryCount();
    const signals = await probeCompanyNews(USER, cands, new Date(NOW.getTime() + 2 * HOUR));
    const statements = stopQueryCount();
    const reads = capturedQueries().filter((q) => /external_item_companies/.test(q));
    check("one read of the news for the whole account", reads.length === 1, `${reads.length}`);
    check("plus one write of what it found", statements === 2, `${statements}`);
    const who = new Set(signals.map((s) => s.contactId));
    check("a headline reaches people at that company", who.has(byName("At Stripe")) || who.has(byName("Also Stripe")));
    check("never a company that merely shares letters", !who.has(byName("At Stripes")));
    check(`at most ${RADAR_NEWS_PER_RUN} a night`, signals.length <= RADAR_NEWS_PER_RUN, `${signals.length}`);
    check("each carries its headline, source and link",
      signals.every((s) => s.title.length > 0 && s.source.length > 0) && signals.some((s) => s.url?.startsWith("https://example.com/")));
    const stored = await db.select().from(contactSignals).where(eq(contactSignals.userId, USER));
    check("and is written to contact_signals", stored.length === signals.length && stored.every((r) => r.kind === "company_news"));
    await probeCompanyNews(USER, cands, new Date(NOW.getTime() + 3 * HOUR));
    const again = await db.select().from(contactSignals).where(eq(contactSignals.userId, USER));
    check("once", again.length === stored.length, `${again.length} vs ${stored.length}`);
    check("an account with no companies costs nothing", (await probeCompanyNews(USER, [], NOW)).length === 0);

    const ramp = signals.find((s) => s.contactId === byName("At Ramp"));
    const contact: RadarContact = {
      id: "x", company: "Ramp", tier: "mid", priorityLevel: 0, relationshipScore: 2, statedCloseness: null,
      firstInteractionAt: null, lastInteractionAt: new Date(NOW.getTime() - 10 * DAY), nextFollowUpAt: null, constellationPin: null,
      cadenceDays: null, cadencePhrase: null, targetPriority: null, goalFit: 0, hasEvidence: true,
    };
    if (ramp) {
      const heads = scoreContactKinds(contact, [{ ...ramp, contactId: "x" }], NO_SUPPRESSION, NOW).find((k) => k.kind === "heads_up");
      check("news is a heads-up that names the company", heads?.reasons[0]?.label.startsWith("Ramp in the news:") === true, heads?.reasons[0]?.label);
      check("with its source linked", heads?.evidence[0]?.url === "https://example.com/ramp");
    } else {
      check("the Ramp headline was among tonight's three", false, JSON.stringify(signals.map((s) => s.company)));
    }
  }

  console.log("\nposts");
  {
    const [bsky, masto, masto2, other] = await db
      .insert(contacts)
      .values([
        { userId: USER, fullName: "Sky Sam", blueskyHandle: "sam.bsky.social" },
        { userId: USER, fullName: "Toot Tia", mastodonAcct: "tia@example.com" },
        { userId: USER, fullName: "Toot Two", mastodonAcct: "two@example.com" },
        { userId: "someone-else-feeds", fullName: "Not Mine" },
      ])
      .returning();
    const cands = [bsky!, masto!, masto2!].map((c) => ({
      ...candidate(c.id, "Acme"),
      blueskyHandle: c.blueskyHandle,
      mastodonAcct: c.mastodonAcct,
    }));
    const at = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();
    const requests: string[] = [];
    const fetchDeps = {
      fetch: (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requests.push(url);
        const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
        if (url.includes("/xrpc/app.bsky.feed.getAuthorFeed")) {
          return json({
            feed: [
              { post: { uri: "at://did:plc:x/app.bsky.feed.post/new1", record: { text: "Shipping our v2 today", createdAt: at(5) } } },
              { post: { uri: "at://did:plc:x/app.bsky.feed.post/old1", record: { text: "Last month", createdAt: at(24 * 20) } } },
            ],
          });
        }
        if (url.includes("/api/v1/accounts/lookup")) return json({ id: "42" });
        if (url.includes("/api/v1/accounts/42/statuses")) {
          return json([{ id: "s1", url: "https://example.com/@tia/1", content: "<p>Hiring <b>two</b> engineers</p>", created_at: at(3) }]);
        }
        return new Response("no", { status: 404 });
      }) as typeof fetch,
    };
    const stored = await pollSocialPosts(USER, cands, NOW, { fetchDeps, blueskyApi: "https://example.com" });
    check("each person's newest recent post is kept", stored === 2, `${stored}`);
    check("a request carries only the handle", requests.every((u) => !/Acme|smoke-radar|someone-else/i.test(u)));
    check("no host is asked more than three times a night", requests.filter((u) => u.startsWith("https://example.com")).length <= 3, requests.join(" "));
    const again = await pollSocialPosts(USER, cands, NOW, { fetchDeps, blueskyApi: "https://example.com" });
    check("a post already kept is not kept twice", again === 0, `${again}`);
    const posts = await loadPostSignals(USER, new Set(cands.map((c) => c.id)), NOW);
    const sky = posts.find((p) => p.contactId === bsky!.id);
    // Whichever Mastodon account tonight's per-host cap let through: both live on example.com
    // here, with the Bluesky stand-in, so only one of the two was checked.
    const toot = posts.find((p) => p.network === "mastodon");
    check("the run reads them back", Boolean(sky) && Boolean(toot), JSON.stringify(posts.map((p) => p.excerpt)));
    check("markup is stripped", toot?.excerpt === "Hiring two engineers", toot?.excerpt);
    check("with a link to the post", sky?.url === "https://bsky.app/profile/sam.bsky.social/post/new1", sky?.url ?? "");
    check("only for the people being scored", (await loadPostSignals(USER, new Set([bsky!.id]), NOW)).every((p) => p.contactId === bsky!.id));

    const saved = await saveLinkedinActivity(USER, { contactId: masto2!.id, excerpt: "  A long post. ".repeat(40), url: "javascript:alert(1)" }, NOW);
    check("a saved LinkedIn post is stored", saved.saved && !saved.duplicate);
    const dup = await saveLinkedinActivity(USER, { contactId: masto2!.id, excerpt: "  A long post. ".repeat(40), url: "javascript:alert(1)" }, NOW);
    check("once", dup.saved && dup.duplicate);
    const linked = (await loadPostSignals(USER, new Set([masto2!.id]), NOW))[0];
    check("capped at 280 characters, with no unsafe link", (linked?.excerpt.length ?? 999) <= 280 && linked?.url === null && linked?.network === "linkedin");
    check("never onto someone else's contact", (await saveLinkedinActivity(USER, { contactId: other!.id, excerpt: "x" }, NOW)).reason === "not_found");
    check("never an empty post", (await saveLinkedinActivity(USER, { contactId: masto2!.id, excerpt: "   " }, NOW)).reason === "empty");

    const contact: RadarContact = {
      id: "x", company: null, tier: "mid", priorityLevel: 0, relationshipScore: 2, statedCloseness: null,
      firstInteractionAt: null, lastInteractionAt: new Date(NOW.getTime() - 10 * DAY), nextFollowUpAt: null, constellationPin: null,
      cadenceDays: null, cadencePhrase: null, targetPriority: null, goalFit: 0, hasEvidence: true,
    };
    const skyCard = scoreContactKinds(contact, [{ ...sky!, contactId: "x" }], NO_SUPPRESSION, NOW).find((k) => k.kind === "heads_up");
    const liCard = scoreContactKinds(contact, [{ ...linked!, contactId: "x", at: sky!.at }], NO_SUPPRESSION, NOW).find((k) => k.kind === "heads_up");
    check("a post is a heads-up quoting it", skyCard?.reasons[0]?.label.startsWith("Posted on Bluesky: “Shipping our v2 today”") === true, skyCard?.reasons[0]?.label);
    check("a post the person chose to save counts more", (liCard?.score ?? 0) > (skyCard?.score ?? 0));
    const many = Array.from({ length: 25 }, (_, i) => ({ ...candidate(`00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, "Acme"), blueskyHandle: `p${i}.bsky.social` }));
    const tonight = handlesForTonight(many, NOW).map((h) => h.contactId);
    const tomorrow = handlesForTonight(many, new Date(NOW.getTime() + DAY)).map((h) => h.contactId);
    check("ten handles a night, rotating", tonight.length === 10 && tonight.join() !== tomorrow.join());
    await db.delete(contacts).where(eq(contacts.userId, "someone-else-feeds"));
  }

  console.log("\npruning");
  {
    await ingestNewsItems("smoke-rss", [{ externalId: "rss-old", title: "Acme old news", summary: null, url: null, publishedAt: new Date(NOW.getTime() - 3 * DAY) }], NOW);
    await pruneNews(new Date(NOW.getTime() + 30 * DAY));
    const left = await db.select().from(externalItems).where(and(inArray(externalItems.sourceId, TEST_SOURCES)));
    check("old headlines are pruned, and their company rows with them", left.length === 0, `${left.length}`);
  }

  await reset();
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll radar feeds checks passed.");
});
