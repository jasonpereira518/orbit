/**
 * Joining, leaving and sharing on a team, against a real database.
 *
 * Every assertion is either a race (two colleagues joining a brand-new domain at once must
 * land on ONE team) or a boundary (a member cannot touch another member's contacts; a
 * non-member cannot flip sharing). Rows live under `smoke-team-*` ids and go in `finally`.
 * Do NOT run while `next dev` holds `.data/pglite` — PGlite is single-writer.
 *
 * Run: npx tsx scripts/smoke-team-lifecycle.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, teamMembers, teams, userSettings } from "../src/db/schema";
import { isUserFacingError } from "../src/lib/errors";
import {
  getViewerTeam,
  joinTeamWithDomain,
  leaveTeam,
  listTeamMembers,
  setContactTeamShared,
  setTeamSharing,
} from "../src/lib/teams";
import { ensureUserSettings } from "../src/lib/user-settings";

const A = "smoke-team-a";
const B = "smoke-team-b";
const C = "smoke-team-c";
const USERS = [A, B, C];
const DOMAIN = "smoke-team.test";
const OTHER = "other-smoke-team.test";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(teamMembers).where(inArray(teamMembers.userId, USERS));
  await db.delete(teams).where(inArray(teams.domain, [DOMAIN, OTHER]));
  await db.delete(contacts).where(inArray(contacts.userId, USERS));
  await db.delete(userSettings).where(inArray(userSettings.userId, USERS));
}

async function teamsWithDomain(domain: string) {
  const db = await getDb();
  return db.select({ id: teams.id, createdBy: teams.createdBy }).from(teams).where(eq(teams.domain, domain));
}

async function main() {
  const db = await getDb();
  await cleanup();
  try {
    for (const u of USERS) await ensureUserSettings(u);
    await db.update(userSettings).set({ firstName: "Alex", lastName: "Ng" }).where(eq(userSettings.userId, A));

    console.log("\ntwo colleagues join a new domain at once");
    const [ra, rb] = await Promise.all([
      joinTeamWithDomain(A, DOMAIN, { shareNetwork: true }),
      joinTeamWithDomain(B, DOMAIN, { shareNetwork: false }),
    ]);
    check("both land on the same team", ra.teamId === rb.teamId, `${ra.teamId} vs ${rb.teamId}`);
    check("exactly one team row exists", (await teamsWithDomain(DOMAIN)).length === 1);
    const a = await getViewerTeam(A);
    const b = await getViewerTeam(B);
    check("A is a sharing member", a?.shareNetwork === true && a.domain === DOMAIN);
    check("B joined without sharing", b?.shareNetwork === false);
    check("the team is named from its domain", a?.name === "Smoke-team");

    console.log("\nrejoining is idempotent and re-states the sharing choice");
    const again = await joinTeamWithDomain(A, DOMAIN, { shareNetwork: false });
    check("same team id", again.teamId === ra.teamId);
    check("membership count unchanged", again.memberCount === 2, String(again.memberCount));
    check("sharing now off", (await getViewerTeam(A))?.shareNetwork === false);
    check("and can be switched back", (await setTeamSharing(A, true)) === true && (await getViewerTeam(A))?.shareNetwork === true);
    check("a non-member cannot flip sharing", (await setTeamSharing(C, true)) === false);

    console.log("\none team per person");
    let refused: unknown = null;
    try {
      await joinTeamWithDomain(A, OTHER, { shareNetwork: true });
    } catch (err) {
      refused = err;
    }
    check("joining a second domain is refused with a readable message", isUserFacingError(refused));
    check("and no second team was created", (await teamsWithDomain(OTHER)).length === 0);

    console.log("\nthe per-contact opt-out is the owner's alone");
    // Bare `.returning()`, not `.returning({ id, teamShared })` — an explicit field
    // selector defeats Drizzle's overload resolution against the union `Db` type (same
    // trap noted in src/lib/teams.ts and src/lib/action-items.ts).
    const [contact] = await db
      .insert(contacts)
      .values({ userId: A, fullName: "Ada Lovelace" })
      .returning();
    check("a new contact is shared by default", contact.teamShared === 1);
    check("another member cannot hide it", (await setContactTeamShared(B, contact.id, false)) === false);
    const [still] = await db.select({ teamShared: contacts.teamShared }).from(contacts).where(eq(contacts.id, contact.id));
    check("so it stays shared", still.teamShared === 1);
    check("its owner can", (await setContactTeamShared(A, contact.id, false)) === true);
    const [hidden] = await db.select({ teamShared: contacts.teamShared }).from(contacts).where(eq(contacts.id, contact.id));
    check("and then it is hidden", hidden.teamShared === 0);

    console.log("\nmembers are listed by name, with the sharing flag");
    const members = await listTeamMembers(ra.teamId);
    const alex = members.find((m) => m.userId === A);
    const bee = members.find((m) => m.userId === B);
    check("two members", members.length === 2, String(members.length));
    check("names come from the settings mirror", alex?.name === "Alex Ng", alex?.name);
    check("a nameless account falls back", bee?.name === "A teammate", bee?.name);
    check("the sharing flag is carried", alex?.sharing === true && bee?.sharing === false);

    console.log("\nleaving");
    await leaveTeam(B);
    check("the team survives while a member remains", (await teamsWithDomain(DOMAIN)).length === 1);
    check("B is no longer a member", (await getViewerTeam(B)) === null);
    await leaveTeam(A);
    check("the last member takes the team with them", (await teamsWithDomain(DOMAIN)).length === 0);
    check("leaving twice is harmless", (await leaveTeam(A), true));
    const [orphan] = await db.select({ teamShared: contacts.teamShared }).from(contacts).where(eq(contacts.id, contact.id));
    check("the per-contact choice survives leaving", orphan.teamShared === 0);
  } finally {
    await cleanup();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll team lifecycle checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
