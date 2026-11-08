/**
 * Automated LinkedIn Profile Finder for Event Attendees.
 *
 * Implements a dual-tier resolution strategy:
 * 1. Graph / Network Match: Checks if the attendee matches an existing contact in the
 *    user's Orbit network who already has a verified LinkedIn profile URL.
 * 2. AI Web Grounding: If not matched in the existing network, performs an AI web search
 *    grounded query (`webSearchJson`) to locate the individual's LinkedIn profile URL
 *    (`https://www.linkedin.com/in/...`) using name, company, title, and venue context.
 *
 * All verified links are stored on `event_attendees.linkedin_url` and update the attendee's
 * identity and person keys for cross-event deduping.
 */

import { and, eq, ilike, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, eventAttendees, events } from "@/db/schema";
import { parseAiJson, userCanUseAi, webSearchJson } from "@/lib/ai";
import { updateAttendeeForUser } from "@/lib/events/store";
import type { AttendeeRole } from "@/lib/events/types";

const LINKEDIN_IN_RE =
  /^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]{2,100}\/?$/i;

export type FindLinkedInResult = {
  ok: boolean;
  linkedinUrl: string | null;
  source?: "network" | "web" | "existing";
  error?: string;
};

/** Normalize and validate a candidate LinkedIn URL. */
export function normalizeLinkedInUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  let candidate = trimmed;
  if (!candidate.startsWith("http://") && !candidate.startsWith("https://")) {
    candidate = `https://${candidate.replace(/^\/+/, "")}`;
  }
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
      const match = url.pathname.match(/\/in\/([^/]+)/);
      if (match && match[1]) {
        return `https://www.linkedin.com/in/${match[1].toLowerCase().replace(/\/+$/, "")}`;
      }
    }
  } catch {
    return null;
  }
  return LINKEDIN_IN_RE.test(trimmed) ? trimmed : null;
}

/**
 * Attempt to match attendee against existing contacts in user's network.
 */
async function findFromNetwork(
  userId: string,
  fullName: string | null,
  email: string | null,
  company: string | null
): Promise<string | null> {
  if (!fullName && !email) return null;
  const db = await getDb();

  // 1. Email exact match
  if (email) {
    const byEmail = await db
      .select({ linkedinUrl: contacts.linkedinUrl })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.email, email.toLowerCase())))
      .limit(1);
    if (byEmail[0]?.linkedinUrl) {
      const valid = normalizeLinkedInUrl(byEmail[0].linkedinUrl);
      if (valid) return valid;
    }
  }

  // 2. Name + Company match
  if (fullName && fullName.trim().length > 2) {
    const nameMatch = await db
      .select({ linkedinUrl: contacts.linkedinUrl, company: contacts.company })
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          ilike(contacts.fullName, fullName.trim())
        )
      )
      .limit(5);

    for (const match of nameMatch) {
      if (match.linkedinUrl) {
        // If company is specified on both sides, verify they align
        if (company && match.company) {
          const compA = company.toLowerCase().trim();
          const compB = match.company.toLowerCase().trim();
          if (compA.includes(compB) || compB.includes(compA)) {
            const valid = normalizeLinkedInUrl(match.linkedinUrl);
            if (valid) return valid;
          }
        } else {
          const valid = normalizeLinkedInUrl(match.linkedinUrl);
          if (valid) return valid;
        }
      }
    }
  }

  return null;
}

/**
 * Use AI Web Search Grounding to find the attendee's LinkedIn profile.
 */
async function findFromWebSearch(
  userId: string,
  person: {
    fullName: string;
    company: string | null;
    title: string | null;
    eventTitle?: string | null;
    city?: string | null;
  }
): Promise<string | null> {
  const canUseAi = await userCanUseAi(userId);
  if (!canUseAi) return null;

  const system = `You find public LinkedIn profile URLs for professional attendees.
Given a person's name and any professional context (company, job title, event location), locate their exact public LinkedIn profile URL (https://www.linkedin.com/in/...).
Only return a profile if you are confident it belongs to this specific individual.
Return strictly valid JSON:
{
  "found": boolean,
  "linkedinUrl": string | null
}`;

  const prompt = `Find LinkedIn profile:
Name: ${person.fullName}
Company: ${person.company ?? "Unknown"}
Title: ${person.title ?? "Unknown"}
Event: ${person.eventTitle ?? ""} (${person.city ?? ""})`;

  try {
    const result = await webSearchJson(userId, {
      system,
      user: prompt,
      operation: "research.person",
      maxSearches: 1,
      maxOutputTokens: 250,
    });

    const parsed = parseAiJson<{ found?: boolean; linkedinUrl?: string | null }>(result.json);
    if (parsed?.found && parsed.linkedinUrl) {
      const valid = normalizeLinkedInUrl(parsed.linkedinUrl);
      if (valid) return valid;
    }

    // Also inspect web sources cited by the search grounding response
    if (result.sources && result.sources.length > 0) {
      for (const source of result.sources) {
        const candidate = normalizeLinkedInUrl(source.url);
        if (candidate) return candidate;
      }
    }
  } catch {
    // Graceful fallback on web search error or budget limits
  }

  return null;
}

/**
 * Finds and updates the LinkedIn URL for a single attendee.
 */
export async function findAttendeeLinkedIn(
  userId: string,
  eventId: string,
  attendeeId: string
): Promise<FindLinkedInResult> {
  const db = await getDb();

  // Load attendee row
  const [row] = await db
    .select()
    .from(eventAttendees)
    .where(and(eq(eventAttendees.userId, userId), eq(eventAttendees.id, attendeeId)))
    .limit(1);

  if (!row) {
    return { ok: false, linkedinUrl: null, error: "Attendee not found" };
  }

  // If already present and valid, return immediately
  const existing = normalizeLinkedInUrl(row.linkedinUrl);
  if (existing) {
    return { ok: true, linkedinUrl: existing, source: "existing" };
  }

  const fullName = row.fullName?.trim() ?? "";
  if (!fullName && !row.email) {
    return { ok: false, linkedinUrl: null, error: "Not enough info to find LinkedIn" };
  }

  // 1. Check existing Orbit network
  const networkUrl = await findFromNetwork(userId, fullName || null, row.email, row.company);
  if (networkUrl) {
    await updateAttendeeForUser(userId, attendeeId, {
      fullName: row.fullName,
      email: row.email,
      company: row.company,
      title: row.title,
      linkedinUrl: networkUrl,
      xHandle: row.xHandle,
      attendeeRole: row.attendeeRole as AttendeeRole | null,
    });
    return { ok: true, linkedinUrl: networkUrl, source: "network" };
  }

  // Load event details for geographic/industry context
  const [event] = await db
    .select({ title: events.title, city: events.city })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.id, eventId)))
    .limit(1);

  // 2. Perform web search grounding
  const webUrl = await findFromWebSearch(userId, {
    fullName,
    company: row.company,
    title: row.title,
    eventTitle: event?.title,
    city: event?.city,
  });

  if (webUrl) {
    await updateAttendeeForUser(userId, attendeeId, {
      fullName: row.fullName,
      email: row.email,
      company: row.company,
      title: row.title,
      linkedinUrl: webUrl,
      xHandle: row.xHandle,
      attendeeRole: row.attendeeRole as AttendeeRole | null,
    });
    return { ok: true, linkedinUrl: webUrl, source: "web" };
  }

  return { ok: false, linkedinUrl: null, error: "Could not locate a verified LinkedIn profile" };
}

/**
 * Batch resolve LinkedIn profiles for attendees missing one.
 */
export async function batchFindRosterLinkedIns(
  userId: string,
  eventId: string,
  options: { limit?: number } = {}
): Promise<{ found: number; total: number }> {
  const limit = options.limit ?? 15;
  const db = await getDb();

  const missing = await db
    .select({ id: eventAttendees.id })
    .from(eventAttendees)
    .where(
      and(
        eq(eventAttendees.userId, userId),
        eq(eventAttendees.eventId, eventId),
        sql`(${eventAttendees.linkedinUrl} IS NULL OR btrim(${eventAttendees.linkedinUrl}) = '')`
      )
    )
    .limit(limit);

  if (missing.length === 0) {
    return { found: 0, total: 0 };
  }

  let foundCount = 0;
  // Concurrently run in small chunks of 3 to avoid flooding
  const chunkSize = 3;
  for (let i = 0; i < missing.length; i += chunkSize) {
    const chunk = missing.slice(i, i + chunkSize);
    const results = await Promise.all(
      chunk.map((item) =>
        findAttendeeLinkedIn(userId, eventId, item.id).catch(() => null)
      )
    );
    for (const res of results) {
      if (res?.ok && res.linkedinUrl) foundCount++;
    }
  }

  return { found: foundCount, total: missing.length };
}
