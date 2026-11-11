/**
 * Custom constellations: the plan cap, merge repointing and purge coverage.
 * Run: npx tsx scripts/smoke-custom-constellations.ts
 */
import "./smoke/_env";

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contacts, customConstellationMembers, customConstellations } from "../src/db/schema";
import { mergeContacts, unmergeContacts } from "../src/lib/contact-merge";
import { proposeMembers, type ProposeDeps } from "../src/lib/custom-constellations";
import { getConstellationLimitForPlan } from "../src/lib/plans/plan-config";
import { purgeUserData } from "../src/lib/user-data";
import { run } from "./smoke/_env";

const USER = "smoke-custom-constellations-user";

const NO_MATCH_COPY = "No one in your network matched that. Try naming a company, school, place or tag.";

function card(id: string) {
  return { id, fullName: `Person ${id}`, title: "Founder", company: "Acme", closenessTier: "inner", aiSummary: "met at a demo day" };
}

function parse(over: Record<string, unknown>) {
  return async () => ({ semanticQuery: "", filters: {}, expansionTerms: [], shape: "open", ...over });
}

function mustNotCall(what: string) {
  return async () => {
    throw new Error(`${what} must not be called`);
  };
}

/** Every dep stubbed (embed included), so the AI gate and the network are never touched. */
function stubs(over: Record<string, unknown>): ProposeDeps {
  return { embed: async () => [0.1], ...over } as unknown as ProposeDeps;
}

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();

  check(
    "cap: free=3, orbit=Infinity",
    getConstellationLimitForPlan("free") === 3 &&
      getConstellationLimitForPlan("orbit") === Infinity &&
      getConstellationLimitForPlan("max") === Infinity &&
      getConstellationLimitForPlan("lifetime") === Infinity
  );

  const [a, b] = await db
    .insert(contacts)
    .values([
      { userId: USER, fullName: "Ada Constellation" },
      { userId: USER, fullName: "Ada C. Constellation" },
    ])
    .returning();
  const [cons] = await db
    .insert(customConstellations)
    .values({ userId: USER, name: "Founders", prompt: "people who founded companies" })
    .returning();
  await db.insert(customConstellationMembers).values([
    { userId: USER, constellationId: cons.id, contactId: a.id, source: "ai", reason: "founder" },
    { userId: USER, constellationId: cons.id, contactId: b.id, source: "manual" },
  ]);

  const distinctIds = async () =>
    rowsOf<{ contact_id: string }>(
      await db.execute(
        sql`SELECT DISTINCT contact_id FROM custom_constellation_members WHERE constellation_id = ${cons.id}::uuid`
      )
    )
      .map((r) => r.contact_id)
      .sort();

  const { mergeId } = await mergeContacts(USER, a.id, b.id, { deferInvalidation: true });
  const merged = await distinctIds();
  check("merge repoints members", merged.length === 1 && merged[0] === a.id, JSON.stringify(merged));

  await unmergeContacts(USER, mergeId);
  const restored = await distinctIds();
  check(
    "undo restores both members",
    restored.length === 2 && restored.includes(a.id) && restored.includes(b.id),
    JSON.stringify(restored)
  );

  await purgeUserData(USER, { only: ["contacts"] });
  const left = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT (SELECT count(*) FROM custom_constellations WHERE user_id = ${USER})::int
           + (SELECT count(*) FROM custom_constellation_members WHERE user_id = ${USER})::int AS n
    `)
  )[0].n;
  check("purge removes both tables", left === 0, `${left} rows left`);

  // proposeMembers: stubbed deps, no DB or network.
  const listed = await proposeMembers(
    USER,
    "people at Stripe",
    stubs({
      understand: parse({ shape: "list", filters: { companies: ["Stripe"] } }),
      list: async () => ({
        total: 2,
        truncated: false,
        people: [
          { id: "p1", name: "One", title: null, company: "Stripe", lastInteraction: null },
          { id: "p2", name: "Two", title: null, company: "Stripe", lastInteraction: null },
        ],
      }),
      complete: mustNotCall("complete"),
    })
  );
  check(
    "list-shape prompt uses listing, no judge",
    listed.members.length === 2 && listed.members.every((m) => m.reason === null) && listed.name === "People at Stripe",
    JSON.stringify(listed)
  );

  const judged = await proposeMembers(
    USER,
    "my mentors",
    stubs({
      understand: parse({ semanticQuery: "mentors" }),
      search: async () => [card("c1"), card("c2")],
      complete: async () => JSON.stringify({ name: "Mentors", members: [{ id: "c1", reason: "r" }, { id: "zzz" }, { id: "c1" }] }),
    })
  );
  check(
    "open-shape prompt is judged; foreign + duplicate ids dropped",
    judged.name === "Mentors" && JSON.stringify(judged.members) === JSON.stringify([{ contactId: "c1", reason: "r" }]),
    JSON.stringify(judged)
  );

  let seenFilters: { companies?: string[] } | undefined;
  let judgeCalls = 0;
  await proposeMembers(
    USER,
    "mentors at Stripe",
    stubs({
      understand: parse({ filters: { companies: ["Stripe"] }, semanticQuery: "mentors" }),
      search: async (_u: string, o: { filters?: { companies?: string[] } }) => {
        seenFilters = o.filters;
        return [card("c1")];
      },
      complete: async () => {
        judgeCalls++;
        return JSON.stringify({ name: "Stripe mentors", members: [{ id: "c1", reason: "x" }] });
      },
    })
  );
  check(
    "mixed prompt passes filters to search and judges",
    seenFilters?.companies?.[0] === "Stripe" && judgeCalls === 1,
    `${JSON.stringify(seenFilters)} calls=${judgeCalls}`
  );

  let embedOptions: { softTimeoutMs?: number } | undefined;
  await proposeMembers(
    USER,
    "mentors who could introduce me",
    stubs({
      understand: parse({ semanticQuery: "mentors who could introduce me" }),
      embed: async (_u: string, _q: string, _e: unknown, _s: unknown, o: { softTimeoutMs?: number }) => {
        embedOptions = o;
        return [0.1];
      },
      search: async () => [card("c1")],
      complete: async () => JSON.stringify({ name: "Mentors", members: [{ id: "c1" }] }),
    })
  );
  check(
    "query embedding is bounded by a soft timeout",
    typeof embedOptions?.softTimeoutMs === "number" && embedOptions.softTimeoutMs > 0,
    JSON.stringify(embedOptions)
  );

  let nothingError: unknown;
  await proposeMembers(
    USER,
    "my mentors",
    stubs({ understand: parse({}), search: async () => [], complete: mustNotCall("complete") })
  ).catch((e) => (nothingError = e));
  check(
    "nothing matched → UserFacingError, exact copy",
    nothingError instanceof Error && nothingError.name === "UserFacingError" && nothingError.message === NO_MATCH_COPY,
    String(nothingError)
  );

  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  console.log("\nAll custom-constellation checks passed.");
});
