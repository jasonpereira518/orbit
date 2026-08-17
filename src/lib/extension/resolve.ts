/**
 * Resolve a page to a contact.
 *
 * This runs on every popup open and the whole first paint waits on it, so the
 * hard rule here is: never load the user's full contact list. `findDuplicateCandidates`
 * takes an array, and the obvious implementation hands it every row — which for
 * a few thousand contacts is hundreds of KB over Neon HTTP, per popup, to find
 * one person. Instead we pull a narrow candidate set with indexed predicates and
 * run the existing scoring over that.
 */

import { and, eq, ilike, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactions, reminders } from "@/db/schema";
import type { Contact } from "@/db/schema";
import { computeCloseness } from "@/lib/closeness";
import {
  heuristicStarters,
  pageValue,
  type StarterContext,
} from "@/lib/conversation-starters";
import {
  DUPLICATE_MERGE_CONFIDENCE,
  daysAgo,
  findDuplicateCandidates,
  linkedinSlug,
  normalizeXHandle,
  type DuplicateMatch,
} from "@/lib/duplicates";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import type {
  ContactFieldSuggestion,
  ContactSnapshot,
  FieldChange,
  MatchCandidate,
  MatchStatus,
  PageContext,
  ResolveResponse,
} from "./contract";

/** Above this, and alone, a match is shown directly as "you know this person". */
const CONFIDENT_CONFIDENCE = 0.9;
/** Widest net for the candidate query. Scoring happens in memory over this set. */
const CANDIDATE_LIMIT = 50;
const RECENT_INTERACTIONS = 5;
const NOTES_PREVIEW_CHARS = 300;

/* -------------------------------------------------------------------------- */
/* Page → probe                                                               */
/* -------------------------------------------------------------------------- */

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Split a display name the way the contact form does: first token, rest. */
function splitName(fullName: string | null) {
  if (!fullName) return { firstName: null, lastName: null };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return { firstName: parts[0] ?? null, lastName: null };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

export type PageProbe = {
  fullName: string | null;
  email: string | null;
  linkedinUrl: string | null;
  linkedinSlugValue: string;
  xHandle: string;
  company: string | null;
  title: string | null;
  location: string | null;
  school: string | null;
  headline: string | null;
  photoUrl: string | null;
};

export function probeFromPage(page: PageContext): PageProbe {
  const id = page.identity;
  const profileUrl = pageValue(id.profileUrl) ?? page.url;

  // The adapter canonicalizes `handle`, but fall back to parsing the URL so a
  // broken selector degrades to "we still know who this is".
  const linkedinUrlValue =
    page.site === "linkedin" ? profileUrl : null;
  const slug =
    page.site === "linkedin"
      ? linkedinSlug(pageValue(id.handle) ?? profileUrl) ||
        linkedinSlug(profileUrl)
      : "";
  const xHandle =
    page.site === "x"
      ? normalizeXHandle(pageValue(id.handle) ?? profileUrl)
      : "";

  return {
    fullName: pageValue(id.name),
    email: pageValue(id.email),
    linkedinUrl: slug ? linkedinUrlValue : null,
    linkedinSlugValue: slug,
    xHandle,
    company: pageValue(id.company),
    title: pageValue(id.title),
    location: pageValue(id.location),
    school: pageValue(id.school),
    headline: pageValue(id.headline),
    photoUrl: pageValue(id.photoUrl),
  };
}

/* -------------------------------------------------------------------------- */
/* Candidate retrieval                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Pull only rows that could plausibly match, using the indexed columns.
 *
 * The LinkedIn predicate matches on the slug rather than the whole URL because
 * stored values vary by locale subdomain, `www`, trailing slash, and
 * `?miniProfileUrn=` — all of which `linkedinSlug` already collapses on the
 * incoming side.
 */
async function loadCandidates(userId: string, probe: PageProbe) {
  const db = await getDb();
  const clauses = [];

  if (probe.linkedinSlugValue) {
    clauses.push(
      ilike(contacts.linkedinUrl, `%/in/${escapeLike(probe.linkedinSlugValue)}%`)
    );
  }
  if (probe.xHandle) {
    clauses.push(ilike(contacts.xHandle, escapeLike(probe.xHandle)));
  }
  if (probe.email) {
    clauses.push(ilike(contacts.email, escapeLike(probe.email)));
  }
  if (probe.fullName) {
    clauses.push(ilike(contacts.fullName, escapeLike(probe.fullName)));
    // Widen enough that the fuzzy-name tier has something to score against.
    const firstToken = probe.fullName.trim().split(/\s+/)[0];
    if (firstToken && firstToken.length >= 3) {
      clauses.push(ilike(contacts.fullName, `%${escapeLike(firstToken)}%`));
    }
  }

  if (clauses.length === 0) return [];

  return db.query.contacts.findMany({
    where: and(eq(contacts.userId, userId), or(...clauses)),
    limit: CANDIDATE_LIMIT,
  });
}

function classify(matches: DuplicateMatch[]): MatchStatus {
  if (matches.length === 0) return "none";
  const top = matches[0];
  const strong = matches.filter((m) => m.confidence >= DUPLICATE_MERGE_CONFIDENCE);

  // `linkedin_url` has no unique constraint and bad imports have produced
  // genuine duplicates, so several rows can tie at the top tier. Never silently
  // pick one — make the user choose.
  if (strong.length > 1) return "ambiguous";
  if (top.confidence >= CONFIDENT_CONFIDENCE && strong.length === 1) {
    return "confident";
  }
  return "ambiguous";
}

function toCandidate(match: DuplicateMatch): MatchCandidate {
  return {
    id: match.contact.id,
    fullName: match.contact.fullName,
    company: match.contact.company,
    title: match.contact.title,
    reason: match.reason,
    confidence: match.confidence,
  };
}

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                   */
/* -------------------------------------------------------------------------- */

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export type SnapshotBundle = {
  snapshot: ContactSnapshot;
  starterContext: Omit<StarterContext, "mode" | "page" | "networkOverlap" | "changes">;
};

export async function buildSnapshot(
  userId: string,
  contactId: string,
  goals: string[]
): Promise<SnapshotBundle | null> {
  const db = await getDb();

  const row = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    with: {
      contactTags: { with: { tag: true } },
      interactions: {
        orderBy: [sql`${interactions.interactionDate} DESC`],
        limit: RECENT_INTERACTIONS,
      },
      reminders: {
        where: eq(reminders.status, "pending"),
        orderBy: [sql`${reminders.dueDate} ASC NULLS LAST`],
        limit: 3,
      },
    },
  });

  if (!row) return null;

  const tags = row.contactTags.map((ct) => ct.tag.name);
  const closeness = computeCloseness({ ...row, tags }, goals);
  const now = Date.now();
  const openActionItems = row.interactions
    .flatMap((i) => i.actionItems ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5);

  const lastInteractionAt = row.lastInteractionAt;
  const gapDays = lastInteractionAt ? daysAgo(lastInteractionAt) : null;

  const snapshot: ContactSnapshot = {
    id: row.id,
    fullName: row.fullName,
    preferredName: row.preferredName,
    company: row.company,
    title: row.title,
    location: row.location,
    linkedinUrl: row.linkedinUrl,
    xHandle: row.xHandle,
    photoUrl: row.profileImageUrl,
    relationshipScore: row.relationshipScore,
    priorityLevel: row.priorityLevel,
    closeness: closeness.closeness,
    closenessTier: closeness.tier,
    lastInteractionAt: iso(lastInteractionAt),
    daysSinceLastInteraction:
      gapDays !== null && Number.isFinite(gapDays) ? gapDays : null,
    nextFollowUpAt: iso(row.nextFollowUpAt),
    followUpStatus: row.followUpStatus,
    isFollowUpOverdue: Boolean(
      row.nextFollowUpAt && row.nextFollowUpAt.getTime() <= now
    ),
    tags,
    keyFacts: row.keyFacts ?? [],
    sharedInterests: row.sharedInterests ?? [],
    opportunities: row.opportunities ?? [],
    openActionItems,
    aiSummary: row.aiSummary,
    // Never ship `notes` in full — unbounded, and the user's most sensitive
    // field. The summary plus a short preview is enough for the panel.
    notesPreview: row.notes ? row.notes.slice(0, NOTES_PREVIEW_CHARS) : null,
    recentInteractions: row.interactions.map((i) => ({
      id: i.id,
      interactionType: i.interactionType,
      interactionDate: iso(i.interactionDate),
      summary: i.aiSummary ?? i.rawNotes ?? null,
    })),
    openReminders: row.reminders.map((r) => ({
      id: r.id,
      title: r.title,
      dueDate: iso(r.dueDate),
    })),
  };

  return {
    snapshot,
    starterContext: {
      contact: row,
      tags,
      recentInteractions: row.interactions.map((i) => ({
        interactionType: i.interactionType,
        interactionDate: i.interactionDate,
        aiSummary: i.aiSummary,
        rawNotes: i.rawNotes,
        topics: i.topics ?? [],
        actionItems: i.actionItems ?? [],
      })),
      openReminders: row.reminders.map((r) => ({
        title: r.title,
        dueDate: r.dueDate,
      })),
      userGoals: goals,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Changes + suggestions                                                      */
/* -------------------------------------------------------------------------- */

function differs(pageValueRaw: string | null, stored: string | null) {
  if (!pageValueRaw) return false;
  const a = pageValueRaw.trim().toLowerCase();
  const b = (stored ?? "").trim().toLowerCase();
  return Boolean(a) && a !== b;
}

export function diffPageAgainstContact(
  probe: PageProbe,
  contact: Pick<Contact, "title" | "company" | "location">
): FieldChange[] {
  const changes: FieldChange[] = [];
  // Only report a change when there is something stored to disagree with —
  // filling an empty field is not news, it is just the create form's job.
  if (contact.title && differs(probe.title, contact.title)) {
    changes.push({ field: "title", from: contact.title, to: probe.title! });
  }
  if (contact.company && differs(probe.company, contact.company)) {
    changes.push({ field: "company", from: contact.company, to: probe.company! });
  }
  if (contact.location && differs(probe.location, contact.location)) {
    changes.push({
      field: "location",
      from: contact.location,
      to: probe.location!,
    });
  }
  return changes;
}

function suggestionFromProbe(
  probe: PageProbe,
  page: PageContext
): ContactFieldSuggestion {
  const { firstName, lastName } = splitName(probe.fullName);
  const howMet =
    page.site === "linkedin"
      ? "Found on LinkedIn"
      : page.site === "x"
        ? "Found on X"
        : page.site === "gmail"
          ? "Email thread"
          : null;

  return {
    fullName: probe.fullName,
    firstName,
    lastName,
    company: probe.company,
    title: probe.title,
    location: probe.location,
    school: probe.school,
    email: probe.email,
    linkedinUrl: probe.linkedinUrl,
    xHandle: probe.xHandle || null,
    website: null,
    photoUrl: probe.photoUrl,
    tagNames: page.site === "generic" ? [] : [page.site],
    howMet,
  };
}

/**
 * Companies and schools this person shares with the rest of the user's network.
 * Deliberately a targeted lookup rather than a scan — it only asks about the one
 * company and one school on the page.
 */
async function loadNetworkOverlap(
  userId: string,
  probe: PageProbe,
  excludeContactId?: string
): Promise<{ companies: string[]; schools: string[] }> {
  if (!probe.company && !probe.school) return { companies: [], schools: [] };

  const db = await getDb();
  const clauses = [];
  if (probe.company) {
    clauses.push(ilike(contacts.company, escapeLike(probe.company)));
  }
  if (probe.school) {
    clauses.push(ilike(contacts.school, escapeLike(probe.school)));
  }

  const rows = await db
    .select({ company: contacts.company, school: contacts.school })
    .from(contacts)
    .where(
      and(
        eq(contacts.userId, userId),
        or(...clauses),
        excludeContactId ? ne(contacts.id, excludeContactId) : undefined
      )
    )
    .limit(25);

  const companies = new Set<string>();
  const schools = new Set<string>();
  for (const row of rows) {
    if (
      probe.company &&
      row.company?.toLowerCase() === probe.company.toLowerCase()
    ) {
      companies.add(probe.company.toLowerCase());
    }
    if (probe.school && row.school?.toLowerCase() === probe.school.toLowerCase()) {
      schools.add(probe.school.toLowerCase());
    }
  }
  return { companies: [...companies], schools: [...schools] };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Score a page against the user's contacts. Exported so the save path can rerun
 * the same check server-side rather than trusting the client's `mode` — which
 * is what stops a double-clicked popup from filling a CRM with duplicates.
 */
export async function matchesForPage(userId: string, page: PageContext) {
  const probe = probeFromPage(page);
  const candidateRows = await loadCandidates(userId, probe);
  const matches = findDuplicateCandidates(candidateRows, {
    fullName: probe.fullName,
    email: probe.email,
    linkedinUrl: probe.linkedinUrl,
    xHandle: probe.xHandle || null,
    company: probe.company,
    title: probe.title,
  });
  return { probe, matches, status: classify(matches) };
}

export { toCandidate };

export async function resolveContactFromPage(
  userId: string,
  page: PageContext
): Promise<ResolveResponse> {
  const [{ probe, matches, status }, goals] = await Promise.all([
    matchesForPage(userId, page),
    listActiveGoalTextsForUser(userId),
  ]);
  const suggested = suggestionFromProbe(probe, page);

  if (status === "confident") {
    const bundle = await buildSnapshot(userId, matches[0].contact.id, goals);
    if (bundle) {
      const changes = diffPageAgainstContact(probe, matches[0].contact);
      const starterContext: StarterContext = {
        ...bundle.starterContext,
        mode: "warm",
        page,
        networkOverlap: { companies: [], schools: [] },
        changes,
      };
      return {
        status,
        contact: bundle.snapshot,
        candidates: [],
        suggested,
        changes,
        startersSeed: heuristicStarters(starterContext),
      };
    }
  }

  // Cold and ambiguous both render a page-derived panel, so both want the
  // network-overlap signal that makes a cold starter feel like Orbit.
  const overlap = await loadNetworkOverlap(userId, probe);
  const starterContext: StarterContext = {
    mode: "cold",
    page,
    contact: null,
    tags: [],
    recentInteractions: [],
    openReminders: [],
    userGoals: goals,
    networkOverlap: overlap,
    changes: [],
  };

  return {
    status,
    contact: null,
    candidates: matches.slice(0, 3).map(toCandidate),
    suggested,
    changes: [],
    startersSeed: heuristicStarters(starterContext, 2),
  };
}
