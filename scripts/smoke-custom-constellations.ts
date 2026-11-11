/**
 * Custom constellations: the plan cap, merge repointing and purge coverage.
 * Run: npx tsx scripts/smoke-custom-constellations.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-custom";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-custom";

import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contacts, customConstellationMembers, customConstellations } from "../src/db/schema";
import { mergeContacts, unmergeContacts } from "../src/lib/contact-merge";
import {
  addConstellationMember,
  createCustomConstellation,
  deleteCustomConstellation,
  getConstellationMembers,
  listCustomConstellations,
  proposeMembers,
  removeConstellationMember,
  renameCustomConstellation,
  type ProposeDeps,
} from "../src/lib/custom-constellations";
import { loadGraphData } from "../src/lib/graph-data";
import { getConstellationLimitForPlan } from "../src/lib/plans/plan-config";
import { purgeUserData } from "../src/lib/user-data";
import { run } from "./smoke/_env";

const USER = "smoke-custom-constellations-user";
const OTHER = "smoke-custom-constellations-other";

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

  async function crudChecks() {
    const mine = await db
      .insert(contacts)
      .values([1, 2, 3, 4, 5].map((n) => ({ userId: USER, fullName: `Crud Mine ${n}` })))
      .returning();
    const [theirs] = await db.insert(contacts).values({ userId: OTHER, fullName: "Crud Theirs" }).returning();
    const rowCount = async (t: string, userId: string) =>
      rowsOf<{ n: number }>(await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t} WHERE user_id = '${userId}'`)))[0].n;

    const deps = (ids: string[]): ProposeDeps =>
      stubs({
        understand: parse({ shape: "list" }),
        list: async () => ({
          total: ids.length,
          truncated: false,
          people: ids.map((id) => ({ id, name: id, title: null, company: "Stripe", lastInteraction: null })),
        }),
        complete: mustNotCall("complete"),
      });

    const first = await createCustomConstellation(USER, "people at Stripe", "free", deps([mine[0].id, mine[1].id]));
    const got = await getConstellationMembers(USER, first.id);
    check(
      "create saves row + ai members",
      got?.name === "People at Stripe" && got.members.size === 2 && got.members.has(mine[0].id),
      JSON.stringify(got && [got.name, [...got.members]])
    );
    const tabs = await listCustomConstellations(USER);
    check("list returns tab with member count", tabs.length === 1 && tabs[0].id === first.id && tabs[0].memberCount === 2, JSON.stringify(tabs));

    await createCustomConstellation(USER, "second", "free", deps([mine[2].id]));
    await createCustomConstellation(USER, "third", "free", deps([mine[3].id]));
    const ordered = await listCustomConstellations(USER);
    check("list is in creation order", ordered.length === 3 && ordered[0].id === first.id, JSON.stringify(ordered));

    let aiCalled = false;
    const refused: unknown = await createCustomConstellation(USER, "fourth", "free", {
      understand: async () => {
        aiCalled = true;
        throw new Error("understand must not be called");
      },
    } as unknown as ProposeDeps).catch((e) => e);
    check(
      "4th create on free refused before AI",
      refused instanceof Error &&
        refused.name === "UserFacingError" &&
        refused.message === "Free plan keeps up to 3 constellations. Upgrade for unlimited, or delete one to make room." &&
        !aiCalled &&
        (await listCustomConstellations(USER)).length === 3,
      String(refused)
    );

    const fourth = await createCustomConstellation(USER, "fourth", "orbit", deps([mine[4].id]));
    check("orbit plan allows a 4th", (await listCustomConstellations(USER)).length === 4 && !!fourth.id);

    // Another user can do nothing to my constellation.
    const before = JSON.stringify(await getConstellationMembers(USER, first.id).then((g) => g && [g.name, [...g.members]]));
    check("rename by another user is refused", (await renameCustomConstellation(OTHER, first.id, "Hijack")) === false);
    check("delete by another user is refused", (await deleteCustomConstellation(OTHER, first.id)) === false);
    check("add by another user is refused", (await addConstellationMember(OTHER, first.id, theirs.id)) === false);
    check("remove by another user is refused", (await removeConstellationMember(OTHER, first.id, mine[0].id)) === false);
    check("another user reads nothing", (await getConstellationMembers(OTHER, first.id)) === null);
    const after = JSON.stringify(await getConstellationMembers(USER, first.id).then((g) => g && [g.name, [...g.members]]));
    check("rows unchanged after foreign attempts", before === after && (await rowCount("custom_constellations", USER)) === 4, `${before} / ${after}`);

    check("add of another user's contact is refused", (await addConstellationMember(USER, first.id, theirs.id)) === false);
    check("no row written for a foreign contact", (await rowCount("custom_constellation_members", OTHER)) === 0);

    check("rename works", (await renameCustomConstellation(USER, first.id, "Renamed")) === true && (await getConstellationMembers(USER, first.id))?.name === "Renamed");

    check("add manual member", (await addConstellationMember(USER, first.id, mine[2].id)) === true);
    check("add twice stays one member", (await addConstellationMember(USER, first.id, mine[2].id)) === true && (await getConstellationMembers(USER, first.id))?.members.size === 3);
    const dupRows = async () =>
      rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM custom_constellation_members WHERE constellation_id = ${first.id}::uuid AND contact_id = ${mine[2].id}::uuid`))[0].n;
    check("add twice wrote one row", (await dupRows()) === 1);

    // A merge can leave two rows for one contact: reads stay distinct and prefer the reasoned one.
    await db.insert(customConstellationMembers).values([
      { userId: USER, constellationId: first.id, contactId: mine[0].id, source: "manual" },
      { userId: USER, constellationId: first.id, contactId: mine[0].id, source: "ai", reason: "kept reason" },
    ]);
    const dup = await getConstellationMembers(USER, first.id);
    check("duplicate rows read once, reason preferred", dup?.members.size === 3 && !!dup.members.get(mine[0].id), JSON.stringify(dup && [...dup.members]));

    check("remove returns true", (await removeConstellationMember(USER, first.id, mine[0].id)) === true);
    const removed = await getConstellationMembers(USER, first.id);
    check("remove deletes duplicate rows too", !removed?.members.has(mine[0].id) && removed?.members.size === 2, JSON.stringify(removed && [...removed.members]));

    check("delete works and cascades members", (await deleteCustomConstellation(USER, first.id)) === true && (await getConstellationMembers(USER, first.id)) === null);
    check(
      "delete removed its members",
      rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM custom_constellation_members WHERE constellation_id = ${first.id}::uuid`))[0].n === 0
    );
  }

  async function skyChecks() {
    const [m, x, y] = await db
      .insert(contacts)
      .values([
        { userId: USER, fullName: "Skymember Alpha", company: "SkyMemberCo", school: "SkyMemberSchool" },
        { userId: USER, fullName: "Zzoutsider Beta", company: "OutsiderCoBeta", school: "OutsiderSchoolBeta" },
        { userId: USER, fullName: "Zzoutsider Gamma", company: "OutsiderCoGamma", school: "OutsiderSchoolGamma" },
      ])
      .returning();
    const [sky] = await db.insert(customConstellations).values({ userId: USER, name: "Sky", prompt: "sky" }).returning();
    await db.insert(customConstellationMembers).values({ userId: USER, constellationId: sky.id, contactId: m.id, source: "manual" });

    const drawn = await loadGraphData(USER, { profile: Promise.resolve(null), scope: "all", onlyIds: new Set([m.id]) });
    const json = JSON.stringify(drawn);
    check(
      "onlyIds payload leaks no non-member",
      drawn.contacts.length === 1 &&
        drawn.contacts[0].id === m.id &&
        ![x.id, y.id, "Zzoutsider", "OutsiderCo", "OutsiderSchool"].some((s) => json.includes(s)),
      `${drawn.contacts.length} drawn`
    );
    check(
      "onlyIds skips the engaged filter and keeps the network's size",
      drawn.summary.constellationFilter.active === false && drawn.summary.total >= 3,
      JSON.stringify(drawn.summary.constellationFilter)
    );

    check("foreign id -> null", (await getConstellationMembers(OTHER, sky.id)) === null);

    await db.delete(contacts).where(eq(contacts.id, m.id));
    const emptied = await getConstellationMembers(USER, sky.id);
    check("member deleted -> sky still opens empty", !!emptied && emptied.members.size === 0, JSON.stringify(emptied && [...emptied.members]));
    const empty = await loadGraphData(USER, { profile: Promise.resolve(null), scope: "all", onlyIds: new Set(emptied?.members.keys()) });
    check("empty member set draws no contacts or clusters", empty.contacts.length === 0 && empty.clusters.length === 0);
  }

  try {
    await crudChecks();
    await skyChecks();
  } finally {
    await purgeUserData(USER, { keepSettings: false });
    await purgeUserData(OTHER, { keepSettings: false });
  }
  console.log("\nAll custom-constellation checks passed.");
});
