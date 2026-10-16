/**
 * Meeting guests who are not contacts yet.
 *
 * `companyFromEmail` is free and always on: a work address names its company. "Look up"
 * (`lookUpGuestFor`) is the paid part — one web search on the account's own AI key, only when
 * the user asks, anchored on that company. Never on the email itself (the web search never sees
 * an address — the rule `work-history-research.ts` keeps) and never on a name alone, which
 * finds namesakes: a gmail.com guest has no anchor and is not looked up.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, guestProfiles } from "@/db/schema";
import { publicEmailDomain } from "@/lib/closeness-evidence";
import { consumeBucket, RATE_LIMITS } from "@/lib/rate-limit";
import { researchWithWebSearch, type WorkHistoryResearcher } from "@/lib/work-history-research";

/** Second-level labels under a country code: acme.co.uk is "acme", not "co". */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc"]);

/** "priya@harbor-health.com" → "Harbor Health"; null for gmail.com and friends, or no domain. */
export function companyFromEmail(email: string | null | undefined): string | null {
  const domain = email?.split("@")[1]?.trim().toLowerCase();
  if (!domain || !domain.includes(".") || publicEmailDomain(domain)) return null;
  const parts = domain.split(".");
  const tld = parts[parts.length - 1]!;
  const sld = parts[parts.length - 2]!;
  const label = tld.length === 2 && SECOND_LEVEL.has(sld) && parts.length >= 3 ? parts[parts.length - 3]! : sld;
  if (!label || label.length < 2 || publicEmailDomain(`${label}.${tld}`)) return null;
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

export type GuestProfile = typeof guestProfiles.$inferSelect;

/** Stored lookups for these addresses, by lower-cased email. */
export async function loadGuestProfiles(userId: string, emails: string[]): Promise<Map<string, GuestProfile>> {
  const keys = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!keys.length) return new Map();
  const db = await getDb();
  const rows = await db
    .select()
    .from(guestProfiles)
    .where(and(eq(guestProfiles.userId, userId), inArray(guestProfiles.email, keys)));
  return new Map(rows.map((r) => [r.email, r]));
}

/** As fresh as a contact's own web profile (`work-history-research.ts`). */
const FRESH_MS = 30 * 86_400_000;

export type GuestLookup =
  | { status: "found"; profile: GuestProfile }
  | { status: "not_sure"; profile: GuestProfile }
  | { status: "no_anchor" }
  | { status: "not_a_guest" };

/**
 * Look one guest up. Owner-scoped twice over: the event must be the user's, and the address a
 * guest on it — so this cannot be pointed at an arbitrary email. Throws only what the AI gate
 * and the rate limiter throw (both user-facing); the caller turns those into copy.
 */
export async function lookUpGuestFor(
  userId: string,
  eventId: string,
  email: string,
  deps: { researcher?: WorkHistoryResearcher; now?: Date } = {}
): Promise<GuestLookup> {
  const now = deps.now ?? new Date();
  const db = await getDb();
  const key = email.trim().toLowerCase();
  const [event] = await db
    .select({ attendees: calendarEvents.attendees })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.id, eventId)))
    .limit(1);
  const guest = event?.attendees.find((a) => a.email.toLowerCase() === key && !a.contactId);
  if (!guest) return { status: "not_a_guest" };

  const cached = (await loadGuestProfiles(userId, [key])).get(key);
  if (cached && now.getTime() - cached.checkedAt.getTime() < FRESH_MS) {
    return cached.confident ? { status: "found", profile: cached } : { status: "not_sure", profile: cached };
  }

  const company = companyFromEmail(key);
  if (!company || !guest.name.trim()) return { status: "no_anchor" };

  await consumeBucket("work-history", userId, RATE_LIMITS.workHistoryResearch);
  const answer = await (deps.researcher ?? researchWithWebSearch)(userId, {
    fullName: guest.name.trim(),
    title: null,
    company,
    location: null,
    school: null,
    linkedinUrl: null,
  });
  const work = answer.experiences.filter((e) => e.kind === "role");
  const current = work.find((e) => e.endYear === null) ?? work[0];
  const linkedin = answer.sources.find((s) => /linkedin\.com\/in\//i.test(s.url))?.url ?? null;
  const values = {
    userId,
    email: key,
    name: guest.name.trim(),
    // Only what a confident match says is kept as fact; an unsure one keeps the date it was tried.
    title: answer.confident ? (current?.title ?? null) : null,
    company: answer.confident ? (current?.organization ?? company) : null,
    headline: answer.confident ? answer.headline : null,
    linkedinUrl: answer.confident ? linkedin : null,
    sources: answer.confident ? answer.sources.slice(0, 5).map((s) => ({ url: s.url, title: s.title ?? null })) : [],
    confident: answer.confident,
    checkedAt: now,
  };
  const [profile] = await db
    .insert(guestProfiles)
    .values(values)
    .onConflictDoUpdate({ target: [guestProfiles.userId, guestProfiles.email], set: values })
    .returning();
  return answer.confident ? { status: "found", profile } : { status: "not_sure", profile };
}
