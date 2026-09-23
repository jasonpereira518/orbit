/**
 * Team lifecycle: who may join which team, joining, leaving, and the two sharing switches.
 *
 * A team is a verified email domain (`src/lib/team-domain.ts`). The verification itself is
 * Clerk's, read from the request in `verifiedWorkEmail`; everything below that takes the
 * proven domain as a plain argument, which is what makes it testable against PGlite and is
 * why `joinTeam` is two functions.
 *
 * Sharing is reciprocal and read live: `share_network` is a column the warm-path SQL joins
 * on every time, never a cached count, so switching it off withdraws a person's contacts
 * from every lookup immediately (the recruiters-pool rule, and for the same reason).
 */
import { cache } from "react";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { currentUser } from "@clerk/nextjs/server";
import { getDb } from "@/db";
import { contacts, teamMembers, teams, userSettings } from "@/db/schema";
import { isDemoMode } from "@/lib/demo-account";
import { UserFacingError } from "@/lib/errors";
import { teamDomainForEmail, teamNameForDomain, teammateDisplayName } from "@/lib/team-domain";

export type TeamMembership = {
  teamId: string;
  domain: string;
  name: string;
  shareNetwork: boolean;
  joinedAt: Date;
};

/** The viewer's team, or null. Request-cached: every warm-path query starts here. */
export const getViewerTeam = cache(async (userId: string): Promise<TeamMembership | null> => {
  const db = await getDb();
  const [row] = await db
    .select({
      teamId: teams.id,
      domain: teams.domain,
      name: teams.name,
      shareNetwork: teamMembers.shareNetwork,
      joinedAt: teamMembers.joinedAt,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
    .limit(1);
  return row ? { ...row, shareNetwork: row.shareNetwork === 1 } : null;
});

/**
 * The signed-in person's primary email, only when Clerk has verified it. Request context
 * only (it is Clerk's backend read), so never call it from a job. Demo mode has no Clerk
 * and answers with the demo account's address.
 */
export async function verifiedWorkEmail(): Promise<string | null> {
  if (isDemoMode()) return "demo@orbit.local";
  const user = await currentUser().catch(() => null);
  const primary = user?.primaryEmailAddress;
  if (!primary || primary.verification?.status !== "verified") return null;
  return primary.emailAddress.trim().toLowerCase();
}

export type TeamEligibility =
  | { kind: "member"; membership: TeamMembership }
  | {
      kind: "eligible";
      domain: string;
      name: string;
      existing: { id: string; name: string; memberCount: number } | null;
    }
  | { kind: "ineligible"; reason: "no_verified_email" | "public_domain" };

async function describeTeam(domain: string) {
  const db = await getDb();
  const [row] = await db
    .select({ id: teams.id, name: teams.name, memberCount: count(teamMembers.id) })
    .from(teams)
    .leftJoin(teamMembers, eq(teamMembers.teamId, teams.id))
    .where(eq(teams.domain, domain))
    .groupBy(teams.id, teams.name);
  return row ? { id: row.id, name: row.name, memberCount: Number(row.memberCount) } : null;
}

/** Members never pay the Clerk round trip; only a would-be joiner is verified. */
export async function eligibleTeamForUser(userId: string): Promise<TeamEligibility> {
  const membership = await getViewerTeam(userId);
  if (membership) return { kind: "member", membership };
  const email = await verifiedWorkEmail();
  if (!email) return { kind: "ineligible", reason: "no_verified_email" };
  const domain = teamDomainForEmail(email);
  if (!domain) return { kind: "ineligible", reason: "public_domain" };
  return { kind: "eligible", domain, name: teamNameForDomain(domain), existing: await describeTeam(domain) };
}

async function memberCountOf(teamId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: count(teamMembers.id) })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  return Number(row?.n ?? 0);
}

/**
 * The write half of joining, with the domain already proven by the caller. Race-safe the
 * way `resolveCompany` is: the team insert is `ON CONFLICT DO UPDATE` with a no-op set so
 * `RETURNING` always yields the winner, and two colleagues joining a brand-new domain at
 * once land on one row. Rejoining restates the sharing choice; joining a second domain is
 * refused because a person has one verified primary email.
 */
export async function joinTeamWithDomain(
  userId: string,
  domain: string,
  opts: { shareNetwork: boolean }
): Promise<{ teamId: string; memberCount: number }> {
  const db = await getDb();
  const [current] = await db
    .select({ domain: teams.domain })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
    .limit(1);
  if (current && current.domain !== domain) {
    throw new UserFacingError("You're already on another team. Leave it first.");
  }
  // Bare `.returning()`, not `.returning({ id: teams.id })` — an explicit field selector
  // defeats Drizzle's overload resolution against the union `Db` type after
  // `.onConflictDoUpdate()` (same trap noted in action-items.ts and contact-identity.ts).
  const [team] = await db
    .insert(teams)
    .values({ domain, name: teamNameForDomain(domain), createdBy: userId })
    .onConflictDoUpdate({ target: teams.domain, set: { domain: sql`excluded.domain` } })
    .returning();
  const shareNetwork = opts.shareNetwork ? 1 : 0;
  await db
    .insert(teamMembers)
    .values({ teamId: team.id, userId, shareNetwork, emailDomain: domain })
    .onConflictDoUpdate({
      target: teamMembers.userId,
      set: { shareNetwork, emailDomain: domain, updatedAt: new Date() },
    });
  return { teamId: team.id, memberCount: await memberCountOf(team.id) };
}

/** Join the team of the signed-in person's verified work email. */
export async function joinTeam(
  userId: string,
  opts: { shareNetwork: boolean }
): Promise<{ teamId: string; memberCount: number }> {
  const email = await verifiedWorkEmail();
  const domain = email ? teamDomainForEmail(email) : null;
  if (!domain) {
    throw new UserFacingError(
      "Teams are keyed by a verified work email. Add one in your account settings first."
    );
  }
  return joinTeamWithDomain(userId, domain, opts);
}

/** Leave; a team nobody is on any more is deleted. Per-contact `team_shared` values stay. */
export async function leaveTeam(userId: string): Promise<void> {
  const db = await getDb();
  // Bare `.returning()` — see the note in `joinTeamWithDomain` above.
  const [gone] = await db
    .delete(teamMembers)
    .where(eq(teamMembers.userId, userId))
    .returning();
  if (!gone) return;
  await db
    .delete(teams)
    .where(
      and(
        eq(teams.id, gone.teamId),
        sql`not exists (select 1 from team_members tm where tm.team_id = teams.id)`
      )
    );
}

/** The per-team switch. False when the person is not on a team. */
export async function setTeamSharing(userId: string, on: boolean): Promise<boolean> {
  const db = await getDb();
  // Bare `.returning()` — see the note in `joinTeamWithDomain` above.
  const rows = await db
    .update(teamMembers)
    .set({ shareNetwork: on ? 1 : 0, updatedAt: new Date() })
    .where(eq(teamMembers.userId, userId))
    .returning();
  return rows.length > 0;
}

/** The per-contact exception. False when the contact is not this person's. */
export async function setContactTeamShared(
  userId: string,
  contactId: string,
  shared: boolean
): Promise<boolean> {
  const db = await getDb();
  // Bare `.returning()` — see the note in `joinTeamWithDomain` above.
  const rows = await db
    .update(contacts)
    .set({ teamShared: shared ? 1 : 0, updatedAt: new Date() })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
    .returning();
  return rows.length > 0;
}

export type TeamMemberRow = {
  userId: string;
  name: string;
  /** The mirrored work address, shown only to teammates (they share the domain). */
  email: string | null;
  sharing: boolean;
  joinedAt: Date;
};

export async function listTeamMembers(teamId: string): Promise<TeamMemberRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      userId: teamMembers.userId,
      firstName: userSettings.firstName,
      lastName: userSettings.lastName,
      email: userSettings.email,
      shareNetwork: teamMembers.shareNetwork,
      joinedAt: teamMembers.joinedAt,
    })
    .from(teamMembers)
    .leftJoin(userSettings, eq(userSettings.userId, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(asc(teamMembers.joinedAt));
  return rows.map((r) => ({
    userId: r.userId,
    name: teammateDisplayName({ firstName: r.firstName, lastName: r.lastName, email: r.email }),
    email: r.email,
    sharing: r.shareNetwork === 1,
    joinedAt: r.joinedAt,
  }));
}
