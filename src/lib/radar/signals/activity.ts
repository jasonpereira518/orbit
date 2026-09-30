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

/**
 * The run's one read of stored posts: recent `social_post` and `linkedin_activity` rows for
 * the people it is scoring, newest per person.
 */
export async function loadPostSignals(
  userId: string,
  candidateIds: ReadonlySet<string>,
  now: Date
): Promise<Extract<RadarSignal, { kind: "social_post" }>[]> {
  if (candidateIds.size === 0) return [];
  const db = await getDb();
  const since = new Date(now.getTime() - RADAR_WINDOWS.postMax * DAY_MS);
  const rows = await db
    .select({ contactId: contactSignals.contactId, occurredAt: contactSignals.occurredAt, payload: contactSignals.payload })
    .from(contactSignals)
    .where(
      and(
        eq(contactSignals.userId, userId),
        inArray(contactSignals.kind, ["social_post", "linkedin_activity"]),
        gte(contactSignals.occurredAt, since)
      )
    )
    .orderBy(sql`${contactSignals.occurredAt} desc`)
    .limit(200);
  const seen = new Set<string>();
  const out: Extract<RadarSignal, { kind: "social_post" }>[] = [];
  for (const r of rows) {
    if (seen.has(r.contactId) || !candidateIds.has(r.contactId) || !r.payload.excerpt) continue;
    seen.add(r.contactId);
    out.push({
      kind: "social_post",
      contactId: r.contactId,
      at: r.occurredAt,
      excerpt: r.payload.excerpt,
      network: r.payload.network ?? "linkedin",
      url: safeHttpUrl(r.payload.url ?? null),
    });
  }
  return out;
}

