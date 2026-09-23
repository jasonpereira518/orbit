/**
 * The who-knows-whom lookup against a real database: what a sharing viewer learns, and —
 * every other line here — what they do not. A non-sharing viewer sees nothing; a
 * non-sharing teammate contributes nothing; a contact marked private is invisible; another
 * team is another world; the viewer's own contacts never come back as a path.
 *
 * Rows live under `smoke-warm-*` ids and are removed in `finally`. Do NOT run while
 * `next dev` holds `.data/pglite` — PGlite is single-writer.
 *
 * Run: npx tsx scripts/smoke-warm-paths.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { companies, contacts, teamMembers, teams, userSettings } from "../src/db/schema";
import type { ClosenessTier } from "../src/db/schema";
import { claimIdentities } from "../src/lib/contact-identity";
import { resolveCompany } from "../src/lib/companies";
import { identityKeysFor } from "../src/lib/duplicates";
import { findWarmPaths, warmPathsForTargets } from "../src/lib/leads/warm-path-query";
import { joinTeamWithDomain, setTeamSharing } from "../src/lib/teams";
import { ensureUserSettings } from "../src/lib/user-settings";

const V = "smoke-warm-viewer";
const A = "smoke-warm-alex";
const B = "smoke-warm-bee";
const C = "smoke-warm-chris";
const O = "smoke-warm-outsider";
const N = "smoke-warm-nobody";
const USERS = [V, A, B, C, O, N];
const DOMAIN = "smoke-warm.test";
const OTHER = "other-smoke-warm.test";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, USERS));
  await db.delete(companies).where(inArray(companies.userId, USERS));
  await db.delete(teamMembers).where(inArray(teamMembers.userId, USERS));
  await db.delete(teams).where(inArray(teams.domain, [DOMAIN, OTHER]));
  await db.delete(userSettings).where(inArray(userSettings.userId, USERS));
}

async function person(
  userId: string,
  fullName: string,
  opts: { email?: string; company?: string; tier?: ClosenessTier; closeness?: number; shared?: boolean }
) {
  const db = await getDb();
  const company = opts.company ? await resolveCompany(userId, opts.company) : null;
  // Bare `.returning()`, not `.returning({ id: contacts.id })` — an explicit field
  // selector defeats Drizzle's overload resolution against the union `Db` type (same
  // trap noted in src/lib/teams.ts and src/lib/action-items.ts:57).
  const [row] = await db
    .insert(contacts)
    .values({
      userId,
      fullName,
      email: opts.email ?? null,
      company: company?.name ?? null,
      companyId: company?.id ?? null,
      closenessTier: opts.tier ?? null,
      closeness: opts.closeness ?? null,
      teamShared: opts.shared === false ? 0 : 1,
    })
    .returning();
  await claimIdentities(userId, row.id, identityKeysFor({ email: opts.email }), "smoke");
  return row.id;
}

async function main() {
  const db = await getDb();
  await cleanup();
  try {
    for (const u of USERS) await ensureUserSettings(u);
    await db.update(userSettings).set({ firstName: "Alex", lastName: "Ng", email: "alex@smoke-warm.test" }).where(eq(userSettings.userId, A));
    await db.update(userSettings).set({ firstName: null, lastName: null, email: "chris@smoke-warm.test" }).where(eq(userSettings.userId, C));

    await joinTeamWithDomain(V, DOMAIN, { shareNetwork: true });
    await joinTeamWithDomain(A, DOMAIN, { shareNetwork: true });
    await joinTeamWithDomain(B, DOMAIN, { shareNetwork: false });
    await joinTeamWithDomain(C, DOMAIN, { shareNetwork: true });
    await joinTeamWithDomain(O, OTHER, { shareNetwork: true });

    // Alex: knows Jane closely, two more at Acme, and one person marked private.
    await person(A, "Jane Doe", { email: "jane@target.test", company: "Acme", tier: "inner", closeness: 80 });
    await person(A, "Bob Ray", { email: "bob@target.test", company: "Acme", tier: "outer", closeness: 20 });
    await person(A, "Carol Wu", { email: "carol@target.test", company: "Acme", tier: "mid", closeness: 50 });
    await person(A, "Zed Private", { email: "zed@private.test", tier: "inner", closeness: 90, shared: false });
    // Chris: nameless in the mirror, knows Jane a little and Dan loosely; a never-scored contact.
    await person(C, "Jane Doe", { email: "jane@target.test", tier: "mid", closeness: 45 });
    await person(C, "Dan Lee", { email: "dan@target.test", tier: "outer", closeness: 10 });
    await person(C, "Eve Unscored", { email: "eve@target.test" });
    // Bee is not sharing; the outsider is on another team; the viewer's own contact is not a path.
    await person(B, "Jane Doe", { email: "jane@target.test", tier: "inner", closeness: 99 });
    await person(O, "Jane Doe", { email: "jane@target.test", tier: "inner", closeness: 99 });
    await person(V, "Jane Doe", { email: "jane@target.test", tier: "inner", closeness: 99 });

    console.log("\nreciprocity is decided before any query");
    check("no team → no_team", (await findWarmPaths(N, { email: "jane@target.test" })).status === "no_team");
    await setTeamSharing(V, false);
    check("not sharing → not_sharing", (await findWarmPaths(V, { email: "jane@target.test" })).status === "not_sharing");
    await setTeamSharing(V, true);

    console.log("\nwhat a sharing viewer learns");
    const jane = await findWarmPaths(V, { email: "jane@target.test", companyNormalized: "acme" });
    check("lookup ok", jane.status === "ok");
    if (jane.status === "ok") {
      const ids = jane.path.direct.map((d) => d.teammate.userId);
      check("Jane is hot", jane.path.warmth === "hot", jane.path.warmth);
      check("Alex (inner) then Chris (mid)", ids.join(",") === `${A},${C}`, ids.join(","));
      check("named from the mirror, with the mailbox fallback", jane.path.direct[0].teammate.name === "Alex Ng" && jane.path.direct[1].teammate.name === "chris");
      check("tier and score are carried", jane.path.direct[0].tier === "inner" && jane.path.direct[0].closeness === 80);
      check("matched on the email", jane.path.direct[0].matchedOn === "email");
      check("the non-sharing teammate is absent", !ids.includes(B));
      check("the other team is absent", !ids.includes(O));
      check("the viewer's own contact is not a path", !ids.includes(V));
      const acme = jane.path.account.find((a) => a.teammate.userId === A);
      check("Alex knows 3 people at Acme, best inner", acme?.count === 3 && acme.bestTier === "inner", JSON.stringify(acme));
      check("nobody else has an Acme path", jane.path.account.length === 1);
    }

    const zed = await findWarmPaths(V, { email: "zed@private.test" });
    check("a private contact is invisible: cold", zed.status === "ok" && zed.path.warmth === "cold" && zed.path.direct.length === 0);

    const dan = await findWarmPaths(V, { email: "dan@target.test" });
    check("one loose path is cool", dan.status === "ok" && dan.path.warmth === "cool");

    const eve = await findWarmPaths(V, { email: "eve@target.test" });
    check("a never-scored contact counts as outer", eve.status === "ok" && eve.path.direct[0]?.tier === "outer");

    const onlyCompany = await findWarmPaths(V, { companyNormalized: "acme" });
    check("a company alone is cool, with the account path", onlyCompany.status === "ok" && onlyCompany.path.warmth === "cool" && onlyCompany.path.account.length === 1);

    const nothing = await findWarmPaths(V, { email: "nobody@nowhere.test" });
    check("an unknown person is cold", nothing.status === "ok" && nothing.path.warmth === "cold");

    console.log("\nthe batched form agrees with the single one");
    const batch = await warmPathsForTargets(V, [
      { key: "jane", email: "jane@target.test", companyNormalized: "acme" },
      { key: "dan", email: "dan@target.test" },
      { key: "zed", email: "zed@private.test" },
    ]);
    check("batch ok", batch.status === "ok");
    if (batch.status === "ok" && jane.status === "ok" && dan.status === "ok" && zed.status === "ok") {
      const same = (k: string, single: typeof jane.path) => {
        const b = batch.paths.get(k);
        return !!b && b.warmth === single.warmth && b.direct.map((d) => d.teammate.userId).join() === single.direct.map((d) => d.teammate.userId).join() && b.account.length === single.account.length;
      };
      check("jane", same("jane", jane.path));
      check("dan", same("dan", dan.path));
      check("zed", same("zed", zed.path));
    }
  } finally {
    await cleanup();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll warm-path query checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
