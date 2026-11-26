/**
 * The contacts search's two-step path (a lexical first page, then `enrichContactsSearch`) must
 * end exactly where the one-shot hybrid search used to: same people, same order, same
 * "why" labels, same exact total, same cursor, same analytics. The reference is a FROZEN copy of
 * the one-shot implementation (`scripts/lib/legacy-contacts-page.ts`), run side by side over a
 * matrix of queries × sorts × filters × rankers.
 *
 * Two rankers, because PGlite has no pgvector and the semantic arm can't run here:
 *   - the real `rankContacts` (fts + trigram + work-history arms), and
 *   - an injected one that returns meaning-only and history-only matches, ranks a literal match
 *     ahead of name order, and tags rows the way the semantic arm does.
 *
 * Run: npx tsx scripts/smoke-contacts-search-enrichment.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactExperiences, contactTags, contacts, productEvents, tags } from "../src/db/schema";
import { peekRankedContacts, rankContacts, rankContactsCached, resetRankCache } from "../src/lib/contact-ranking";
import { enrichContactsSearch, enrichLatestContactsSearch, listContactsPage } from "../src/lib/contacts-page-query";
import { mergeSearchEnrichment } from "../src/lib/contacts-search-merge";
import type { ContactSort, ContactsPage, ContactsPageFilters } from "../src/lib/contacts-page";
import type { ArmName, RankedContact } from "../src/lib/hybrid-search";
import { resetSearchSampling } from "../src/lib/search-events";
import { legacyListContactsPage } from "./lib/legacy-contacts-page";
import { run } from "./smoke/_env";

const U = "smoke-contacts-search-enrich-user";
const OTHER = "smoke-contacts-search-enrich-other";

let checks = 0;
function check(label: string, ok: boolean, detail?: string) {
  checks++;
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
}
const j = (v: unknown) => JSON.stringify(v);

type Rank = typeof rankContacts;

/** A ranker that returns fixed ids with fixed arms, in the order given (best first). */
function fakeRank(byQuery: Record<string, Array<[string, ArmName[]]>>, idOf: (name: string) => string): Rank {
  return async (_userId, query) =>
    (byQuery[query.trim().toLowerCase()] ?? []).map(
      ([name, arms], i) =>
        ({ id: idOf(name), fullName: name, matchedArms: arms, rrfScore: 1 / (i + 1), relevance: 1 / (i + 1) }) as unknown as RankedContact
    );
}

async function trackedEvents(): Promise<Array<{ query_length: number; result_count: number }>> {
  const db = await getDb();
  // `track()` writes in a detached promise outside a request; give it a beat.
  await new Promise((r) => setTimeout(r, 250));
  const rows = await db.select().from(productEvents).where(eq(productEvents.userId, U));
  return rows.filter((e) => e.name === "search_performed").map((e) => e.properties as { query_length: number; result_count: number });
}
async function clearEvents() {
  const db = await getDb();
  await db.delete(productEvents).where(eq(productEvents.userId, U));
  resetSearchSampling();
}

run(async () => {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, OTHER));
  await db.delete(tags).where(eq(tags.userId, U));

  const d = (day: number) => new Date(Date.UTC(2026, 8, day, 12));
  const people: Array<Partial<typeof contacts.$inferInsert> & { fullName: string }> = [
    // Literal matches for "priya" (names, a notes mention): more than one page.
    { fullName: "Priya Raman", company: "Acme", title: "Product Manager", closeness: 95, updatedAt: d(2), lastInteractionAt: d(20), relationshipScore: 3 },
    { fullName: "Priya Nair", company: "Stripe", title: "Software Engineer", closeness: 90, updatedAt: d(1), lastInteractionAt: d(18), relationshipScore: 4 },
    { fullName: "Priyanka Das", company: "Acme", title: "Engineer", closeness: 50, updatedAt: d(3), lastInteractionAt: d(10), relationshipScore: 2 },
    { fullName: "Priya Venkat", company: "Globex", closeness: 70, updatedAt: d(5), relationshipScore: 1 },
    { fullName: "Priya Shah", company: "Initech", closeness: 20, updatedAt: d(6), relationshipScore: 1 },
    { fullName: "Priya Kapoor", company: "Acme", closeness: 60, updatedAt: d(7), lastInteractionAt: d(2), relationshipScore: 2 },
    { fullName: "Priya Menon", company: "Hooli", closeness: 40, updatedAt: d(8), relationshipScore: 3 },
    { fullName: "Hassan Ali", company: "Initech", closeness: 99, updatedAt: d(4), lastInteractionAt: d(25), relationshipScore: 5, notes: "Met through Priya at the Durham founders dinner." },
    { fullName: "Marcus Webb", company: "Globex", title: "Backend Developer", closeness: 80, updatedAt: d(9), relationshipScore: 2 },
    { fullName: "Elena Ruiz", company: "Hooli", title: "Designer", closeness: 30, updatedAt: d(10), relationshipScore: 2 },
    { fullName: "Tomás Rivera", company: "Acme", title: "Staff Engineer", closeness: 65, updatedAt: d(11), lastInteractionAt: d(1), relationshipScore: 3 },
    { fullName: "Dana Whitfield", company: "Stripe", title: "Engineering Manager", closeness: 55, updatedAt: d(12), relationshipScore: 2, notes: "Lives in Durham." },
    { fullName: "Priyam Ghosh", company: "Stripe", title: "Data Engineer", closeness: 45, updatedAt: d(13), relationshipScore: 1 },
    { fullName: "Zed Unrelated", company: "Pied Piper", closeness: 10, updatedAt: d(14), relationshipScore: 0 },
  ];
  // Filler so ordering inside a tier has real ties to break and a second page exists.
  for (let i = 0; i < 18; i++) {
    people.push({ fullName: `Filler Person ${String(i).padStart(2, "0")}`, company: i % 3 === 0 ? "Acme" : "Initech", title: i % 2 ? "Engineer" : null, closeness: (i * 7) % 100, updatedAt: d(15 + (i % 10)), relationshipScore: i % 4 });
  }
  const inserted = await db.insert(contacts).values(people.map((p) => ({ userId: U, ...p }))).returning();
  const idOf = (name: string) => inserted.find((r) => r.fullName === name)!.id;

  // Work history: Elena worked at Stripe (the experience arm finds her for "stripe" with no
  // literal "stripe" anywhere on her row), Marcus at Acme.
  await db.insert(contactExperiences).values([
    { userId: U, contactId: idOf("Elena Ruiz"), kind: "role", organization: "Stripe", organizationNormalized: "stripe", title: "Designer", source: "web", sortIndex: 0 },
    { userId: U, contactId: idOf("Marcus Webb"), kind: "role", organization: "Acme", organizationNormalized: "acme", title: "Backend Developer", source: "web", sortIndex: 0 },
  ]);
  const [mentor] = await db.insert(tags).values({ userId: U, name: "mentor" }).returning();
  await db.insert(contactTags).values(["Priya Nair", "Marcus Webb", "Tomás Rivera"].map((n) => ({ contactId: idOf(n), tagId: mentor.id })));

  const injected = fakeRank(
    {
      // Marcus: meaning only. Priyanka: literal, ranked early. Hassan: literal + meaning (no
      // label). Elena: history only. Priya Nair: literal, ranked after the non-literals.
      priya: [
        ["Marcus Webb", ["semantic"]],
        ["Priyanka Das", ["fts", "trigram"]],
        ["Hassan Ali", ["fts", "semantic"]],
        ["Elena Ruiz", ["experience"]],
        ["Priya Nair", ["fts"]],
      ],
      engineer: [
        ["Dana Whitfield", ["fts"]],
        ["Elena Ruiz", ["semantic"]],
        ["Marcus Webb", ["semantic", "experience"]],
      ],
      dur: [], // ranks nothing: the lexical page is already final
      acme: [["Elena Ruiz", ["semantic"]]],
    },
    idOf
  );

  const queries = ["priya", "pri", "engineer", "acme", "dur", "stripe", "durham", "zzzz-none"];
  const sorts: ContactSort[] = ["relevance", "name", "closeness", "recent", "last_touch"];
  const filterSets: Array<[string, ContactsPageFilters]> = [
    ["no filter", {}],
    ["company", { company: "Acme" }],
    ["tag", { tag: "mentor" }],
    ["minScore", { minScore: 2 }],
  ];
  const rankers: Array<[string, Rank]> = [["real", rankContacts], ["injected", injected]];
  const sameItems = (a: ContactsPage["items"], b: ContactsPage["items"]) => j(a) === j(b);

  let combos = 0;
  let widened = 0;
  let labelled = 0;
  for (const [rankName, rank] of rankers) {
    for (const q of queries) {
      for (const sort of sorts) {
        for (const [filterName, extra] of filterSets) {
          for (const limit of [4, 50]) {
            const tag = `${rankName} ranker, "${q}", ${sort}, ${filterName}, limit ${limit}`;
            const f: ContactsPageFilters = { ...extra, q, sort, limit };
            const legacy = await legacyListContactsPage(U, f, { rank });
            const full = await listContactsPage(U, f, { rank });
            check(`one-shot path unchanged: ${tag}`, sameItems(full.items, legacy.items) && full.total === legacy.total && full.nextCursor === legacy.nextCursor, `${j(full.items.map((r) => r.fullName))} vs ${j(legacy.items.map((r) => r.fullName))}`);

            const lexical = await listContactsPage(U, f, { search: "lexical", rank });
            const pending = q.length >= 3;
            check(`lexical page is pending only for 3+ characters: ${tag}`, Boolean(lexical.searchPending) === pending);
            if (!pending) {
              check(`short query is already final: ${tag}`, sameItems(lexical.items, legacy.items) && lexical.total === legacy.total);
              continue;
            }
            check(`lexical page carries no total and no labels: ${tag}`, lexical.total === null && lexical.items.every((r) => r.matchReason === null));

            const e = await enrichContactsSearch(U, f, { have: lexical.items.map((r) => r.id), rank });
            check(`enrichment exists: ${tag}`, e !== null);
            const enrichment = e!;
            const merged = mergeSearchEnrichment(lexical.items, enrichment, 0);
            const finalItems = enrichment.order ? merged : lexical.items;
            check(`recall + ranking + labels match the one-shot search: ${tag}`, sameItems(finalItems, legacy.items), `${j(finalItems.map((r) => [r.fullName, r.matchReason]))} vs ${j(legacy.items.map((r) => [r.fullName, r.matchReason]))}`);
            check(`exact total matches: ${tag}`, enrichment.total === legacy.total, `${enrichment.total} vs ${legacy.total}`);
            check(`cursor matches: ${tag}`, (enrichment.order ? enrichment.nextCursor : lexical.nextCursor) === legacy.nextCursor);
            check(`only rows the client lacked come back: ${tag}`, enrichment.rows.every((r) => !lexical.items.some((l) => l.id === r.id)));
            if (enrichment.order && j(enrichment.order) !== j(lexical.items.map((r) => r.id))) widened++;
            labelled += Object.keys(enrichment.matchReasons).length;

            // Holding the top k rows never duplicates, drops or invents a row.
            for (const k of [1, 3]) {
              const held = mergeSearchEnrichment(lexical.items, enrichment, k);
              const keep = Math.min(k, lexical.items.length);
              check(`a held prefix stays put: ${tag}, k=${k}`, j(held.slice(0, keep).map((r) => r.id)) === j(lexical.items.slice(0, keep).map((r) => r.id)));
              check(`a held list has no repeats: ${tag}, k=${k}`, new Set(held.map((r) => r.id)).size === held.length);
              check(`a held list still holds the whole final page: ${tag}, k=${k}`, finalItems.every((r) => held.some((h) => h.id === r.id)));
            }
            combos++;
          }
        }
      }
    }
  }
  console.log(`  ok  ${combos} search combinations match the one-shot search (${widened} widened or reordered the page, ${labelled} labels)`);
  check("the matrix exercised widening and labels", widened > 20 && labelled > 20, `${widened}/${labelled}`);

  // ---- paging through to the end: no one skipped or repeated after the enriched first page ----
  for (const sort of ["name", "closeness", "recent"] as const) {
    for (const [rankName, rank] of rankers) {
      const f: ContactsPageFilters = { q: "priya", sort, limit: 3 };
      const legacyIds: string[] = [];
      for (let cursor: string | undefined, n = 0; n < 30; n++) {
        const page = await legacyListContactsPage(U, { ...f, cursor }, { rank });
        legacyIds.push(...page.items.map((r) => r.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      const lexical = await listContactsPage(U, f, { search: "lexical", rank });
      const e = (await enrichContactsSearch(U, f, { have: lexical.items.map((r) => r.id), rank }))!;
      const newIds = (e.order ? mergeSearchEnrichment(lexical.items, e, 0) : lexical.items).map((r) => r.id);
      for (let cursor = e.order ? e.nextCursor : lexical.nextCursor, n = 0; cursor && n < 30; n++) {
        const page = await listContactsPage(U, { ...f, cursor }, { rank });
        newIds.push(...page.items.map((r) => r.id));
        cursor = page.nextCursor;
      }
      check(`paging after enrichment is complete and ordered (${sort}, ${rankName})`, j(newIds) === j(legacyIds), `${newIds.length} vs ${legacyIds.length}`);
      check(`…and repeats no one (${sort}, ${rankName})`, new Set(newIds).size === newIds.length);
    }
  }
  console.log("  ok  paging past an enriched first page skips and repeats no one");

  // ---- stale requests ----------------------------------------------------------------------------
  const sf: ContactsPageFilters = { q: "priya", sort: "relevance", limit: 50 };
  await clearEvents();
  let refused = "";
  try {
    await enrichContactsSearch(U, sf, { signal: AbortSignal.abort(), rank: injected });
  } catch (err) {
    refused = (err as Error).name;
  }
  check("an already-abandoned search stops", refused === "AbortError", refused);
  // Abandoned while the ranking was running: it must stop before the page query and record nothing.
  const ctl = new AbortController();
  let ranked = 0;
  const abortingRank: Rank = async (...args) => {
    ctl.abort();
    ranked++;
    return injected(...args);
  };
  let refused2 = "";
  try {
    await enrichContactsSearch(U, sf, { signal: ctl.signal, rank: abortingRank });
  } catch (err) {
    refused2 = (err as Error).name;
  }
  check("a search abandoned mid-flight stops at its next step", refused2 === "AbortError" && ranked === 1, refused2);
  check("…and records no analytics event", (await trackedEvents()).length === 0);
  // The page starts an enrichment per render; a newer, different search supersedes the older.
  await clearEvents();
  const slow: Rank = async (...args) => {
    await new Promise((r) => setTimeout(r, 120));
    return injected(...args);
  };
  const older = enrichLatestContactsSearch(U, { q: "priya", sort: "relevance", limit: 50 }, { rank: slow }).then(() => "done", (e: Error) => e.name);
  await new Promise((r) => setTimeout(r, 20));
  const newer = await enrichLatestContactsSearch(U, { q: "engineer", sort: "relevance", limit: 50 }, { rank: injected });
  check("a newer, different search supersedes the older one", (await older) === "AbortError" && newer !== null);
  const sameA = enrichLatestContactsSearch(U, sf, { rank: slow }).then(() => "done", (e: Error) => e.name);
  await new Promise((r) => setTimeout(r, 20));
  const sameB = enrichLatestContactsSearch(U, sf, { rank: injected });
  check("the same search started twice is not a supersession", (await sameA) === "done" && (await sameB) !== null);
  check("…and only the settled searches recorded an event", (await trackedEvents()).length === 1);
  console.log("  ok  stale searches stop early and record nothing");

  // ---- analytics: one event, with the exact total ---------------------------------------------------
  await clearEvents();
  const legacyPage = await legacyListContactsPage(U, sf, { rank: injected });
  const legacyEvents = await trackedEvents();
  await clearEvents();
  const lex = await listContactsPage(U, sf, { search: "lexical", rank: injected });
  check("the lexical page records nothing (it has no exact count yet)", (await trackedEvents()).length === 0);
  await enrichContactsSearch(U, sf, { have: lex.items.map((r) => r.id), rank: injected });
  const newEvents = await trackedEvents();
  check("one search is one event, as before", legacyEvents.length === 1 && newEvents.length === 1, `${legacyEvents.length}/${newEvents.length}`);
  check("the event carries the exact total, as before", newEvents[0].result_count === legacyPage.total && newEvents[0].result_count === legacyEvents[0].result_count && newEvents[0].query_length === 5, j(newEvents));
  await clearEvents();
  await listContactsPage(U, { q: "pr", sort: "relevance", limit: 50 }, { search: "lexical", rank: injected });
  check("a short query (final at once) records its event on the first page", (await trackedEvents()).length === 1);
  console.log("  ok  analytics: one event per search, exact result count");

  // ---- the ranking is shared, not repeated ----------------------------------------------------------
  resetRankCache();
  const a = rankContactsCached(U, "Priya", 80);
  const b = rankContactsCached(U, "  priya ", 80);
  check("the same search asks the retrieval arms once", a === b);
  await a;
  check("…and a repeat after it finished too", rankContactsCached(U, "priya", 80) === a);
  check("…but a longer embedding wait is its own ask", rankContactsCached(U, "priya", 80, { embedTimeoutMs: 1000 }) !== a);
  // The page uses a finished ranking directly (no two-step path, no reorder) and never waits for one.
  resetRankCache();
  check("nothing to peek at before a search", peekRankedContacts(U, "priya", 80) === null);
  const pending = rankContactsCached(U, "priya", 80);
  check("…nor while it is still running", peekRankedContacts(U, "priya", 80) === null);
  const settled = await pending;
  await new Promise((r) => setTimeout(r, 0));
  check("a finished ranking can be peeked at", peekRankedContacts(U, " Priya ", 80) === settled);
  check("…but only the same ask (embedding wait, limit)", peekRankedContacts(U, "priya", 80, { embedTimeoutMs: 1000 }) === null && peekRankedContacts(U, "priya", 12) === null);
  const viaPeek = await listContactsPage(U, { q: "priya", sort: "relevance", limit: 50 }, { rank: async () => settled });
  const viaLegacy = await legacyListContactsPage(U, { q: "priya", sort: "relevance", limit: 50 }, { rank: async () => settled });
  check("a page built on a peeked ranking is final and equals the one-shot page", viaPeek.searchPending === undefined && j(viaPeek) === j(viaLegacy));
  console.log("  ok  rankings are cached and shared");

  // ---- merge edge cases -----------------------------------------------------------------------------
  const rows = [{ id: "a", matchReason: null }, { id: "b", matchReason: null }, { id: "c", matchReason: null }];
  check("no order: the list is kept, labels still land", j(mergeSearchEnrichment(rows, { order: null, rows: [], matchReasons: { b: "Matched by meaning" } })) === j([{ id: "a", matchReason: null }, { id: "b", matchReason: "Matched by meaning" }, { id: "c", matchReason: null }]));
  check("an id with no row is skipped, not thrown on", mergeSearchEnrichment(rows, { order: ["c", "zz", "a"], rows: [], matchReasons: {} }).map((r) => r.id).join() === "c,a");

  check("`have` may still be loading", j(await enrichContactsSearch(U, sf, { have: Promise.resolve([]), rank: injected })) === j(await enrichContactsSearch(U, sf, { have: [], rank: injected })));
  const again = await enrichContactsSearch(U, sf, { have: [], rank: injected });
  const again2 = await enrichContactsSearch(U, sf, { have: [], rank: injected });
  check("enrichment is deterministic", j(again) === j(again2));
  check("without `have` it returns every row it ordered", again!.order!.every((id) => again!.rows.some((r) => r.id === id)));

  // Contacts of another account never appear, whatever the ranker returns.
  const [stranger] = await db.insert(contacts).values({ userId: OTHER, fullName: "Priya Stranger" }).returning();
  const leaky: Rank = async () => [{ id: stranger.id, matchedArms: ["semantic"] } as unknown as RankedContact];
  const leakedLexical = await listContactsPage(U, sf, { search: "lexical", rank: leaky });
  const leaked = (await enrichContactsSearch(U, sf, { have: leakedLexical.items.map((r) => r.id), rank: leaky }))!;
  const leakedFull = await listContactsPage(U, sf, { rank: leaky });
  check("another account's contact never enters the list or the count", !leaked.rows.some((r) => r.id === stranger.id) && !leaked.order!.includes(stranger.id) && !leakedFull.items.some((r) => r.id === stranger.id) && leaked.total === leakedFull.total);
  await db.delete(contacts).where(eq(contacts.userId, OTHER));

  console.log(`\ncontacts search enrichment: ${checks} checks passed`);
});
