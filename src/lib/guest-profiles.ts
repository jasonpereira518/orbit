/**
 * Meeting guests who are not contacts yet.
 *
 * `companyFromEmail` is free and always on: a work address names its company. "Look up"
 * (`lookUpGuestFor`) is the paid part — the same person research Find people runs
 * (`researchPerson` in `web-research.ts`), on the account's own AI key, only when the user
 * asks. It is anchored on the guest's name plus the company their address names — never the
 * address or its domain (the privacy page promises exactly that), and never a name alone, which finds namesakes: a gmail.com guest
 * has no anchor and is not looked up. The brief lands in the same cache as a /find search, so
 * it shows in Find people's recent list and "Add" can save it with its work history.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { publicEmailDomain } from "@/lib/closeness-evidence";
import {
  loadResearchedPeople,
  personResearchKey,
  researchPerson,
  type PersonDossier,
  type PersonResearcher,
} from "@/lib/web-research";

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

/** What the web search is told about a guest: their name and the company their address names. */
function guestSubject(name: string, email: string): { fullName: string; company: string } | null {
  const company = companyFromEmail(email);
  if (!company || !name.trim()) return null;
  return { fullName: name.trim(), company };
}

/** A confident brief, as the prep card and the chat tool show it. `key` opens it on /find. */
export type GuestBrief = {
  key: string;
  title: string | null;
  company: string | null;
  headline: string | null;
  summary: string | null;
  /** Recent, specific things worth mentioning, each with the page it came from. */
  talkingPoints: { text: string; url: string | null }[];
};

function briefOf(key: string, d: PersonDossier): GuestBrief | null {
  if (d.match !== "confident") return null;
  return {
    key,
    title: d.current?.title ?? null,
    company: d.current?.organization ?? d.subject.company,
    headline: d.headline,
    summary: d.summary,
    talkingPoints: d.talkingPoints.slice(0, 3),
  };
}

/** Briefs already researched for these guests, by lower-cased email, in one read. */
export async function loadGuestBriefs(
  userId: string,
  guests: Array<{ name: string; email: string }>
): Promise<Map<string, GuestBrief>> {
  const byKey = new Map<string, string>();
  for (const g of guests) {
    const subject = guestSubject(g.name, g.email);
    const key = subject ? personResearchKey(subject) : null;
    if (key) byKey.set(key, g.email.toLowerCase());
  }
  const found = await loadResearchedPeople(userId, [...byKey.keys()]);
  const out = new Map<string, GuestBrief>();
  for (const [key, dossier] of found) {
    const brief = briefOf(key, dossier);
    if (brief) out.set(byKey.get(key)!, brief);
  }
  return out;
}

export type GuestLookup =
  | { status: "found"; brief: GuestBrief }
  | { status: "not_sure" }
  | { status: "no_anchor" }
  | { status: "not_a_guest" }
  | { status: "refused"; message: string };

/**
 * Look one guest up. Owner-scoped twice over: the event must be the user's, and the address a
 * guest on it who is not a contact — so this cannot be pointed at an arbitrary email. A brief
 * already in the cache is reused without a search (`researchPerson` caches per account).
 */
export async function lookUpGuestFor(
  userId: string,
  eventId: string,
  email: string,
  deps: { researcher?: PersonResearcher } = {}
): Promise<GuestLookup> {
  const db = await getDb();
  const address = email.trim().toLowerCase();
  const [event] = await db
    .select({ attendees: calendarEvents.attendees })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.id, eventId)))
    .limit(1);
  const guest = event?.attendees.find((a) => a.email.toLowerCase() === address && !a.contactId);
  if (!guest) return { status: "not_a_guest" };

  const subject = guestSubject(guest.name, address);
  if (!subject) return { status: "no_anchor" };
  const res = await researchPerson(userId, subject, { researcher: deps.researcher });
  if (!res.ok) return res.reason === "no_anchor" ? { status: "no_anchor" } : { status: "refused", message: res.message };
  const brief = briefOf(res.key, res.dossier);
  return brief ? { status: "found", brief } : { status: "not_sure" };
}
