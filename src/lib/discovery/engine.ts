/**
 * Advanced Multi-Factor People Discovery Engine
 *
 * Unifies candidate discovery across:
 * - Active projects & career goals (semantic & topic affinity)
 * - Mutual connections & 1st-degree contacts (overlapping tenure & warm intro paths)
 * - Shared event attendance & upcoming conferences (event proximity)
 * - Alma mater & target institutions (institutional affinity)
 * - Explainable scoring and dual action pathways (warm intro vs direct outreach)
 */

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, events, userSettings } from "@/db/schema";
import { linkedinSlug } from "@/lib/duplicates";
import { loadYouCurrent } from "@/lib/career-profile-server";
import { listActiveProjectsForUser } from "@/lib/projects/store";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { listTargetCompanies } from "@/lib/events/target-companies";
import { mineEventRosterCandidates } from "./sources/event-rosters";
import { loadContactNetworkNodes } from "./sources/network-bridges";
import { scoreProjectAffinity } from "./scorers/project-scorer";
import { scoreMutualIntroPath } from "./scorers/mutual-graph-scorer";
import { scoreEventProximity } from "./scorers/event-scorer";
import { scoreInstitutionalAffinity } from "./scorers/institution-scorer";
import { synthesizeExplanation } from "./explainer";
import type {
  DiscoveryOptions,
  RawCandidate,
  SurfacedCandidate,
  SurfacedTier,
  UserDiscoveryContext,
} from "./types";

const norm = (s: string | null | undefined) =>
  (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export async function loadUserDiscoveryContext(
  userId: string,
  now: Date = new Date()
): Promise<UserDiscoveryContext> {
  const db = await getDb();

  const [projects, goals, youCurrent, targetCompanies, userEventsRows] = await Promise.all([
    listActiveProjectsForUser(userId).catch(() => []),
    listActiveGoalTextsForUser(userId).catch(() => []),
    loadYouCurrent(userId).catch(() => ({ career: null, senderBio: null, schools: [] })),
    listTargetCompanies(userId).catch(() => []),
    db
      .select({
        id: events.id,
        title: events.title,
        startsAt: events.startsAt,
      })
      .from(events)
      .where(eq(events.userId, userId))
      .orderBy(desc(events.startsAt))
      .limit(50)
      .catch(() => []),
  ]);

  const userPastCompanies: string[] = [];
  if (youCurrent.career?.role?.company) {
    userPastCompanies.push(youCurrent.career.role.company);
  }
  for (const pos of youCurrent.career?.positions || []) {
    if (pos.company && !userPastCompanies.includes(pos.company)) {
      userPastCompanies.push(pos.company);
    }
  }

  const userEvents = userEventsRows.map((e) => ({
    id: e.id,
    title: e.title,
    startsAt: e.startsAt ? new Date(e.startsAt) : null,
    isUpcoming: Boolean(e.startsAt && new Date(e.startsAt).getTime() > now.getTime()),
  }));

  return {
    userId,
    projects,
    goals,
    careerProfile: youCurrent.career,
    schools: youCurrent.schools || [],
    targetCompanies: targetCompanies.map((c) => ({ name: c.name, priority: c.priority })),
    userPastCompanies,
    userEvents,
  };
}

/**
 * Filters out candidates who are already contacts or the user themself.
 */
async function filterKnownPeople<T extends { fullName: string; company?: string | null; linkedinUrl?: string | null }>(
  userId: string,
  candidates: T[]
): Promise<T[]> {
  if (!candidates.length) return [];
  const db = await getDb();

  const names = [...new Set(candidates.map((c) => norm(c.fullName)))];
  const slugs = [...new Set(candidates.map((c) => linkedinSlug(c.linkedinUrl)).filter(Boolean))];

  const [known, settings] = await Promise.all([
    db
      .select({
        fullName: contacts.fullName,
        company: contacts.company,
        linkedinUrl: contacts.linkedinUrl,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          or(
            inArray(sql`lower(trim(${contacts.fullName}))`, names),
            ...slugs.map((s) => sql`lower(${contacts.linkedinUrl}) like ${`%/in/${s}%`}`)
          )
        )
      )
      .catch(() => []),
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { socialLinks: true },
    }).catch(() => null),
  ]);

  const knownPeople = new Set(known.map((c) => `${norm(c.fullName)}|${norm(c.company)}`));
  const knownSlugs = new Set(known.map((c) => linkedinSlug(c.linkedinUrl)).filter(Boolean));

  const ownSlug = linkedinSlug(settings?.socialLinks?.linkedin);
  if (ownSlug) knownSlugs.add(ownSlug);

  return candidates.filter((c) => {
    const slug = linkedinSlug(c.linkedinUrl);
    const key = `${norm(c.fullName)}|${norm(c.company)}`;
    return !knownPeople.has(key) && !(slug && knownSlugs.has(slug));
  });
}

/**
 * Main discovery orchestrator.
 */
export async function discoverPeopleAdvanced(
  userId: string,
  options: DiscoveryOptions = {},
  now: Date = new Date(),
  extraCandidates: RawCandidate[] = []
): Promise<SurfacedCandidate[]> {
  const limit = options.limit ?? 10;

  // 1. Load context and 1st-degree contact nodes
  const [context, contactNodes] = await Promise.all([
    loadUserDiscoveryContext(userId, now),
    loadContactNetworkNodes(userId).catch(() => []),
  ]);

  // 2. Gather candidates (event rosters + extra candidates provided)
  const localCandidates = await mineEventRosterCandidates(userId, now, 60).catch(() => []);
  const candidatePool: RawCandidate[] = [...extraCandidates, ...localCandidates];

  // 3. Drop candidates who are already known contacts
  const eligibleCandidates = await filterKnownPeople(userId, candidatePool);

  const surfaced: SurfacedCandidate[] = [];

  // 4. Run multi-factor scoring
  for (const candidate of eligibleCandidates) {
    const projectRes = scoreProjectAffinity(candidate, context, options.filterProjectId);
    const mutualRes = scoreMutualIntroPath(candidate, contactNodes);
    const eventRes = scoreEventProximity(candidate, context);
    const instRes = scoreInstitutionalAffinity(candidate, context);

    // Filter constraints if requested
    if (options.requireMutual && mutualRes.score === 0) continue;
    if (options.onlyEvents && eventRes.score === 0) continue;

    // Catalyst score (0-10)
    let catalystScore = 0;
    const catReasons: string[] = [];
    if (candidate.newsContext) {
      if (/funding|raised|seed|series [a-d]|ipo/i.test(candidate.newsContext)) {
        catalystScore = 10;
        catReasons.push("Recent funding milestone announced");
      } else if (/launched|released|hiring|expanded/i.test(candidate.newsContext)) {
        catalystScore = 8;
        catReasons.push("Recent product launch or team expansion");
      } else {
        catalystScore = 5;
        catReasons.push("Recent industry news mention");
      }
    }

    const totalScore = Math.min(
      100,
      projectRes.score +
        mutualRes.score +
        eventRes.score +
        instRes.score +
        catalystScore
    );

    // Skip if zero connection points
    if (totalScore <= 0) continue;

    const allReasons = [
      ...projectRes.reasons,
      ...mutualRes.reasons,
      ...eventRes.reasons,
      ...instRes.reasons,
      ...catReasons,
    ];

    const explanation = synthesizeExplanation({
      candidate,
      score: totalScore,
      matchedProjects: projectRes.matchedProjects,
      introPath: mutualRes.bestIntroPath,
      eventOverlap: eventRes.eventOverlap,
      institutionalTies: instRes.institutionalTies,
      reasons: allReasons,
    });

    const tier: SurfacedTier =
      totalScore >= 70
        ? "must_meet"
        : totalScore >= 45
        ? "strong_fit"
        : "worth_exploring";

    surfaced.push({
      id: candidate.id,
      fullName: candidate.fullName,
      headline: candidate.headline || [candidate.title, candidate.company].filter(Boolean).join(" at ") || null,
      company: candidate.company,
      title: candidate.title,
      location: candidate.location,
      avatarUrl: candidate.avatarUrl,
      linkedinUrl: candidate.linkedinUrl,
      email: candidate.email,
      source: candidate.source,
      score: totalScore,
      tier,
      scoreBreakdown: {
        projectRelevance: projectRes.score,
        mutualIntroStrength: mutualRes.score,
        eventProximity: eventRes.score,
        institutionalAffinity: instRes.score,
        catalystBoost: catalystScore,
      },
      introPath: mutualRes.bestIntroPath,
      eventOverlap: eventRes.eventOverlap,
      institutionalTies: instRes.institutionalTies,
      matchedProjects: projectRes.matchedProjects,
      primaryWhy: explanation.primaryWhy,
      bulletReasons: explanation.bulletReasons,
      suggestedOpener: explanation.suggestedOpener,
    });
  }

  // 5. Sort best-first (score desc)
  surfaced.sort((a, b) => b.score - a.score);

  return surfaced.slice(0, limit);
}
