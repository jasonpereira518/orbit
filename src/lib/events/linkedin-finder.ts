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
import { getDb } from "@/db";
import { contactIdentities, contacts, eventAttendees, events } from "@/db/schema";
import { parseAiJson, userCanUseAi, webSearchJson } from "@/lib/ai";
import { updateAttendeeForUser } from "@/lib/events/store";

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
  if (!trimmed) return null;

  let candidate = trimmed;
  // If wrapped in markdown, brackets or prose, extract the LinkedIn URL first
  const match = trimmed.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+/i);
  if (match) {
    candidate = match[0];
  } else if (!candidate.startsWith("http://") && !candidate.startsWith("https://")) {
    candidate = `https://${candidate.replace(/^\/+/, "")}`;
  }

  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
      const m = url.pathname.match(/^\/in\/([^/]+)/);
      if (m && m[1]) {
        const slug = m[1].toLowerCase().replace(/\/+$/, "");
        if (
          slug.length >= 2 &&
          !/^(?:jobs|company|feed|groups|pulse|learning|school|in)$/i.test(slug)
        ) {
          return `https://www.linkedin.com/in/${slug}`;
        }
      }
    }
  } catch {}

  return null;
}

/**
 * Attempt to match attendee against existing contacts in user's network
 * or previous events attended by the user.
 */
async function findFromNetwork(
  userId: string,
  person: {
    contactId?: string | null;
    fullName: string | null;
    email: string | null;
    company: string | null;
  }
): Promise<string | null> {
  const { contactId, fullName, email, company } = person;
  if (!contactId && !fullName && !email) return null;
  const db = await getDb();

  // 1. Direct contact ID match
  if (contactId) {
    const [c] = await db
      .select({ linkedinUrl: contacts.linkedinUrl })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.id, contactId)))
      .limit(1);
    if (c?.linkedinUrl) {
      const valid = normalizeLinkedInUrl(c.linkedinUrl);
      if (valid) return valid;
    }

    const [idRow] = await db
      .select({ value: contactIdentities.value })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.userId, userId),
          eq(contactIdentities.contactId, contactId),
          eq(contactIdentities.kind, "linkedin_slug")
        )
      )
      .limit(1);
    if (idRow?.value) {
      return `https://www.linkedin.com/in/${idRow.value.toLowerCase()}`;
    }
  }

  // 2. Email exact match across contacts
  if (email) {
    const byEmail = await db
      .select({ id: contacts.id, linkedinUrl: contacts.linkedinUrl })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.email, email.toLowerCase().trim())))
      .limit(1);
    if (byEmail[0]) {
      if (byEmail[0].linkedinUrl) {
        const valid = normalizeLinkedInUrl(byEmail[0].linkedinUrl);
        if (valid) return valid;
      }
      const [idRow] = await db
        .select({ value: contactIdentities.value })
        .from(contactIdentities)
        .where(
          and(
            eq(contactIdentities.userId, userId),
            eq(contactIdentities.contactId, byEmail[0].id),
            eq(contactIdentities.kind, "linkedin_slug")
          )
        )
        .limit(1);
      if (idRow?.value) {
        return `https://www.linkedin.com/in/${idRow.value.toLowerCase()}`;
      }
    }
  }

  // 3. Check other event rosters for this user (cross-event resolution)
  if (email || (fullName && fullName.trim().length > 2)) {
    const pastAttendees = await db
      .select({ linkedinUrl: eventAttendees.linkedinUrl })
      .from(eventAttendees)
      .where(
        and(
          eq(eventAttendees.userId, userId),
          sql`(${eventAttendees.linkedinUrl} IS NOT NULL AND btrim(${eventAttendees.linkedinUrl}) != '')`,
          email
            ? eq(eventAttendees.email, email.toLowerCase().trim())
            : ilike(eventAttendees.fullName, fullName!.trim())
        )
      )
      .limit(1);
    if (pastAttendees[0]?.linkedinUrl) {
      const valid = normalizeLinkedInUrl(pastAttendees[0].linkedinUrl);
      if (valid) return valid;
    }
  }

  // 4. Name + Company match across contacts
  if (fullName && fullName.trim().length > 2) {
    const nameMatch = await db
      .select({ id: contacts.id, linkedinUrl: contacts.linkedinUrl, company: contacts.company })
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          ilike(contacts.fullName, fullName.trim())
        )
      )
      .limit(5);

    for (const match of nameMatch) {
      let isAligned = true;
      if (company && match.company) {
        const compA = company.toLowerCase().trim();
        const compB = match.company.toLowerCase().trim();
        isAligned = compA.includes(compB) || compB.includes(compA);
      }
      if (isAligned) {
        if (match.linkedinUrl) {
          const valid = normalizeLinkedInUrl(match.linkedinUrl);
          if (valid) return valid;
        }
        const [idRow] = await db
          .select({ value: contactIdentities.value })
          .from(contactIdentities)
          .where(
            and(
              eq(contactIdentities.userId, userId),
              eq(contactIdentities.contactId, match.id),
              eq(contactIdentities.kind, "linkedin_slug")
            )
          )
          .limit(1);
        if (idRow?.value) {
          return `https://www.linkedin.com/in/${idRow.value.toLowerCase()}`;
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
  try {
    const canUseAi = await userCanUseAi(userId);
    if (!canUseAi) return null;

    // Clean name from role tags (e.g. "Jane Doe (Speaker)" -> "Jane Doe")
    const cleanName = person.fullName
      .replace(/\s*\((?:speaker|host|organizer|attendee|guest|vip)\)/gi, "")
      .trim();
    if (!cleanName || cleanName.length < 2) return null;

    const system = `You find public LinkedIn profile URLs for professional attendees.
Given a person's name and professional context (company, title, location), locate their exact public LinkedIn profile URL (https://www.linkedin.com/in/...).
Only return a profile if you are confident it belongs to this specific individual.
Return strictly valid JSON:
{
  "found": boolean,
  "linkedinUrl": string | null
}`;

    const prompt = [
      `Find LinkedIn profile:`,
      `Name: ${cleanName}`,
      person.company ? `Company: ${person.company}` : null,
      person.title ? `Title: ${person.title}` : null,
      person.city ? `Location: ${person.city}` : null,
      person.eventTitle ? `Attended event: ${person.eventTitle}` : null,
      `Search query to try: "${cleanName}" ${person.company ? `"${person.company}"` : ""} site:linkedin.com/in/`,
    ]
      .filter(Boolean)
      .join("\n");

    const result = await webSearchJson(userId, {
      system,
      user: prompt,
      operation: "research.person",
      maxSearches: 1,
      maxOutputTokens: 250,
    });

    // 1. Check parsed JSON
    try {
      const parsed = parseAiJson<{ found?: boolean; linkedinUrl?: string | null }>(result.json);
      if (parsed?.found && parsed.linkedinUrl) {
        const valid = normalizeLinkedInUrl(parsed.linkedinUrl);
        if (valid) return valid;
      }
    } catch {}

    // 2. Scan raw JSON string for LinkedIn profile pattern
    const rawMatch = result.json.match(
      /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+/i
    );
    if (rawMatch) {
      const valid = normalizeLinkedInUrl(rawMatch[0]);
      if (valid) return valid;
    }

    // 3. Inspect sources cited by search grounding
    if (result.sources && result.sources.length > 0) {
      for (const source of result.sources) {
        const candidate = normalizeLinkedInUrl(source.url);
        if (candidate) return candidate;
      }
    }
  } catch {
    // Non-blocking fallback
  }

  return null;
}

async function saveLinkedIn(
  userId: string,
  row: typeof eventAttendees.$inferSelect,
  linkedinUrl: string
): Promise<void> {
  const patch = {
    fullName: row.fullName,
    email: row.email,
    company: row.company,
    title: row.title,
    linkedinUrl,
    xHandle: row.xHandle,
    attendeeRole: row.attendeeRole,
  };
  const result = await updateAttendeeForUser(userId, row.id, patch);
  if (!result.ok) {
    // If collision on identityKey, update linkedinUrl directly so the profile URL is still saved
    const db = await getDb();
    await db
      .update(eventAttendees)
      .set({ linkedinUrl, updatedAt: new Date() })
      .where(and(eq(eventAttendees.userId, userId), eq(eventAttendees.id, row.id)));
  }
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

  // Check if user accidentally stored it in xHandle or company field
  const embedded =
    normalizeLinkedInUrl(row.xHandle) ??
    normalizeLinkedInUrl(row.company);
  if (embedded) {
    await saveLinkedIn(userId, row, embedded);
    return { ok: true, linkedinUrl: embedded, source: "existing" };
  }

  const fullName = row.fullName?.trim() ?? "";
  if (!fullName && !row.email) {
    return { ok: false, linkedinUrl: null, error: "Not enough info to find LinkedIn" };
  }

  // 1. Check existing Orbit network & past event history
  const networkUrl = await findFromNetwork(userId, {
    contactId: row.contactId,
    fullName: fullName || null,
    email: row.email,
    company: row.company,
  });
  if (networkUrl) {
    await saveLinkedIn(userId, row, networkUrl);
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
    await saveLinkedIn(userId, row, webUrl);
    return { ok: true, linkedinUrl: webUrl, source: "web" };
  }

  return { ok: false, linkedinUrl: null, error: "Couldn’t find a verified LinkedIn profile" };
}

/**
 * Batch resolve LinkedIn profiles for attendees missing one.
 */
export async function batchFindRosterLinkedIns(
  userId: string,
  eventId: string,
  options: { limit?: number } = {}
): Promise<{ found: number; total: number; urls: Record<string, string> }> {
  const limit = options.limit ?? 50;
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
    return { found: 0, total: 0, urls: {} };
  }

  let foundCount = 0;
  const urls: Record<string, string> = {};

  // Concurrently run in small chunks of 3 to avoid flooding
  const chunkSize = 3;
  for (let i = 0; i < missing.length; i += chunkSize) {
    const chunk = missing.slice(i, i + chunkSize);
    const results = await Promise.all(
      chunk.map(async (item) => {
        const res = await findAttendeeLinkedIn(userId, eventId, item.id).catch(() => null);
        return { id: item.id, res };
      })
    );
    for (const { id, res } of results) {
      if (res?.ok && res.linkedinUrl) {
        foundCount++;
        urls[id] = res.linkedinUrl;
      }
    }
  }

  return { found: foundCount, total: missing.length, urls };
}
