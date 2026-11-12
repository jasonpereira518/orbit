/**
 * Posts by the people in someone's network: saved from LinkedIn by the extension (only when
 * the person opted in), and read from public Bluesky and Mastodon profiles by the nightly
 * run. Both land in `contact_signals` and both are read back by the run in one statement.
 *
 * Every string here is third-party text: cleaned to one line, capped at 280 characters, and
 * the link through `safeHttpUrl`, before it is stored. It reaches a prompt only inside a
 * fence, and the card only as text.
 */
import { createHash } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contactSignals, contacts } from "@/db/schema";
import { cleanSingleLine } from "@/lib/ai-security";
import { safeHttpUrl } from "@/lib/safe-links";
import { findIdentityOwners } from "@/lib/contact-identity";
import { linkedinSlug } from "@/lib/duplicates";
import { RADAR_WINDOWS } from "@/lib/radar/score";
import type { ContactSignalPayload, RadarSignal } from "@/lib/radar/types";

export const EXCERPT_MAX = 280;
const DAY_MS = 86_400_000;

export type SocialNetwork = "bluesky" | "mastodon" | "linkedin";

export function cleanExcerpt(text: string | null | undefined): string | null {
  if (!text) return null;
  return cleanSingleLine(text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "), EXCERPT_MAX);
}

export function postDedupeHash(contactId: string, network: SocialNetwork, idOrUrl: string): string {
  return createHash("sha256").update(`post:${network}:${contactId}:${idOrUrl}`).digest("hex");
}

export type PostToStore = {
  contactId: string;
  network: SocialNetwork;
  /** A stable id for the post: its URI, or the excerpt when there is nothing better. */
  postId: string;
  excerpt: string;
  url: string | null;
  at: Date;
};

/** Store posts, once each. Returns how many were new. */
export async function storePosts(userId: string, posts: readonly PostToStore[]): Promise<number> {
  if (posts.length === 0) return 0;
  const db = await getDb();
  const inserted = await db
    .insert(contactSignals)
    .values(
      posts.map((p) => ({
        userId,
        contactId: p.contactId,
        kind: p.network === "linkedin" ? ("linkedin_activity" as const) : ("social_post" as const),
        occurredAt: p.at,
        source: p.network,
        payload: { excerpt: p.excerpt, url: p.url, network: p.network } satisfies ContactSignalPayload,
        dedupeHash: postDedupeHash(p.contactId, p.network, p.postId),
      }))
    )
    .onConflictDoNothing({ target: [contactSignals.userId, contactSignals.dedupeHash] })
    .returning();
  return inserted.length;
}

/**
 * "Save as Radar activity", from the extension. Refused unless the person opted in, and only
 * for their own contact. Returns whether it was new.
 */
export async function saveLinkedinActivity(
  userId: string,
  input: { contactId: string; excerpt: string; url?: string | null; seenAt?: string | null },
  now: Date = new Date()
): Promise<{ saved: boolean; duplicate: boolean; reason?: "not_found" | "empty" }> {
  const db = await getDb();
  const [owned] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, input.contactId), eq(contacts.userId, userId)))
    .limit(1);
  if (!owned) return { saved: false, duplicate: false, reason: "not_found" };
  const excerpt = cleanExcerpt(input.excerpt);
  if (!excerpt) return { saved: false, duplicate: false, reason: "empty" };
  const url = safeHttpUrl(input.url);
  const seen = input.seenAt ? new Date(input.seenAt) : now;
  const at = Number.isFinite(seen.getTime()) && seen <= now ? seen : now;
  const inserted = await storePosts(userId, [
    { contactId: input.contactId, network: "linkedin", postId: url ?? excerpt, excerpt, url, at },
  ]);
  return { saved: true, duplicate: inserted === 0 };
}

/** A scan reads at most this many posts from one page (the extension's own cap is the same). */
export const SCAN_MAX_POSTS = 25;

function profileOf(slug: string) {
  return `https://www.linkedin.com/in/${slug}`;
}

/**
 * "Scan this page", step one: which of these LinkedIn profiles are the person's contacts.
 * Matched by profile slug through `contact_identities` only, never by name, so a namesake is
 * never taken for someone they know. Nothing about the profiles sent is kept.
 */
export async function matchScannedAuthors(
  userId: string,
  profileUrls: readonly string[]
): Promise<{ profileUrl: string; contactId: string; name: string }[]> {
  const slugs = [...new Set(profileUrls.slice(0, SCAN_MAX_POSTS).map((u) => linkedinSlug(u)).filter(Boolean))];
  if (slugs.length === 0) return [];
  const owners = await findIdentityOwners(
    userId,
    slugs.map((value) => ({ kind: "linkedin_slug" as const, value }))
  );
  if (owners.length === 0) return [];
  const db = await getDb();
  const people = await db
    .select({ id: contacts.id, name: contacts.fullName, preferred: contacts.preferredName })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), inArray(contacts.id, [...new Set(owners.map((o) => o.contactId))])));
  const nameOf = new Map(people.map((p) => [p.id, p.preferred?.trim() || p.name]));
  return owners.flatMap((o) => {
    const name = nameOf.get(o.contactId);
    return name ? [{ profileUrl: profileOf(o.key.value), contactId: o.contactId, name }] : [];
  });
}

/** A post's own link, kept only when it is LinkedIn's: a scan has no business storing any other. */
function linkedinPostUrl(raw: string | null | undefined): string | null {
  const url = safeHttpUrl(raw);
  if (!url) return null;
  try {
    return /(^|\.)linkedin\.com$/i.test(new URL(url).hostname) ? url : null;
  } catch {
    return null;
  }
}

/**
 * "Scan this page", step two: store the posts whose author is one of the person's contacts.
 * The authors are matched again here, so a post the extension sends for anyone else is
 * dropped, whatever step one said. Returns how many were new, how many were already kept, and
 * who they were by.
 */
export async function saveScannedPosts(
  userId: string,
  posts: readonly { authorProfileUrl: string; excerpt: string; url?: string | null }[],
  now: Date = new Date()
): Promise<{ saved: number; duplicate: number; people: string[] }> {
  const batch = posts.slice(0, SCAN_MAX_POSTS);
  const matched = await matchScannedAuthors(userId, batch.map((p) => p.authorProfileUrl));
  const bySlug = new Map(matched.map((m) => [linkedinSlug(m.profileUrl), m]));
  const toStore: PostToStore[] = [];
  const people = new Set<string>();
  for (const p of batch) {
    const who = bySlug.get(linkedinSlug(p.authorProfileUrl));
    const excerpt = cleanExcerpt(p.excerpt);
    if (!who || !excerpt) continue;
    const url = linkedinPostUrl(p.url);
    toStore.push({ contactId: who.contactId, network: "linkedin", postId: url ?? excerpt, excerpt, url, at: now });
    people.add(who.name);
  }
  const saved = await storePosts(userId, toStore);
  return { saved, duplicate: toStore.length - saved, people: [...people] };
}

/**
 * The run's one read of stored posts and mentions: recent `linkedin_activity` rows (posts saved
 * with the extension) and `web_mention` rows (what the people check found, on a cited link) for
 * the people it is scoring, newest of each per person.
 */
export async function loadPostSignals(
  userId: string,
  candidateIds: ReadonlySet<string>,
  now: Date
): Promise<Extract<RadarSignal, { kind: "social_post" | "public_mention" }>[]> {
  if (candidateIds.size === 0) return [];
  const db = await getDb();
  const since = new Date(now.getTime() - Math.max(RADAR_WINDOWS.postMax, RADAR_WINDOWS.mentionMax) * DAY_MS);
  const rows = await db
    .select({ id: contactSignals.id, kind: contactSignals.kind, contactId: contactSignals.contactId, occurredAt: contactSignals.occurredAt, payload: contactSignals.payload })
    .from(contactSignals)
    .where(
      and(
        eq(contactSignals.userId, userId),
        inArray(contactSignals.kind, ["linkedin_activity", "web_mention"]),
        gte(contactSignals.occurredAt, since)
      )
    )
    .orderBy(sql`${contactSignals.occurredAt} desc`)
    .limit(200);
  const seen = new Set<string>();
  const out: Extract<RadarSignal, { kind: "social_post" | "public_mention" }>[] = [];
  for (const r of rows) {
    const key = `${r.kind}:${r.contactId}`;
    if (seen.has(key) || !candidateIds.has(r.contactId) || !r.payload.excerpt) continue;
    const url = safeHttpUrl(r.payload.url ?? null);
    const source = { table: "contact_signals" as const, id: r.id, text: r.payload.excerpt, quote: r.payload.excerpt, urls: url ? [url] : [] };
    if (r.kind === "web_mention") {
      // A mention is only ever stored with its cited link; one without is not shown.
      if (!url) continue;
      out.push({ kind: "public_mention", contactId: r.contactId, at: r.occurredAt, text: r.payload.excerpt, url, mentionKind: r.payload.mentionKind ?? "post", source });
    } else {
      out.push({ kind: "social_post", contactId: r.contactId, at: r.occurredAt, excerpt: r.payload.excerpt, network: "linkedin", url, source });
    }
    seen.add(key);
  }
  return out;
}

