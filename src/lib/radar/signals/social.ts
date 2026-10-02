/**
 * The nightly check of public Bluesky and Mastodon posts, for contacts whose handle the
 * person added on the contact page.
 *
 * Unlike the news sweep, this is a request per handle to a third party, so it is stated
 * plainly: each request carries only a public handle the person chose to add, never the
 * list, never anything about the account. At most `RADAR_POST_HANDLES_PER_RUN` handles a
 * night, rotating through everyone with a handle across nights, at most
 * `RADAR_POST_PER_HOST` requests to one host per run, all through `guardedFetchText` (https
 * only, public addresses only, size-capped) and inside a hard deadline. Nightly runs only:
 * nobody waits on a page while this talks to other servers.
 *
 * What it keeps is each person's newest post from the last week, as a sanitized excerpt,
 * written once to `contact_signals`; the run reads it back with the LinkedIn activity the
 * extension saved (`loadPostSignals`).
 */
import { guardedFetchText, type FetchPageDeps } from "@/lib/events/guarded-fetch";
import { safeHttpUrl } from "@/lib/safe-links";
import { RADAR_WINDOWS } from "@/lib/radar/score";
import { cleanExcerpt, storePosts, type PostToStore } from "@/lib/radar/signals/activity";
import type { RadarCandidateRow } from "@/lib/radar/signals/internal";

export const RADAR_POST_HANDLES_PER_RUN = 10;
export const RADAR_POST_PER_HOST = 3;
/** The whole check's budget within a run. */
export const RADAR_POST_BUDGET_MS = 12_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_BYTES = 512 * 1024;
const DAY_MS = 86_400_000;
const JSON_TYPES = ["application/json", "text/json", "text/plain"] as const;
/** Bluesky's public AppView. Overridable only so a smoke can point it at a scripted host. */
export const BLUESKY_API = "https://public.api.bsky.app";

type Handle = { contactId: string; network: "bluesky" | "mastodon"; handle: string };

/** Everyone with a handle, in a stable order, and tonight's slice of them. */
export function handlesForTonight(candidates: readonly RadarCandidateRow[], now: Date): Handle[] {
  const all: Handle[] = [];
  for (const c of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) {
    if (c.blueskyHandle) all.push({ contactId: c.id, network: "bluesky", handle: c.blueskyHandle });
    if (c.mastodonAcct) all.push({ contactId: c.id, network: "mastodon", handle: c.mastodonAcct });
  }
  if (all.length <= RADAR_POST_HANDLES_PER_RUN) return all;
  const day = Math.floor(now.getTime() / DAY_MS);
  const start = (day * RADAR_POST_HANDLES_PER_RUN) % all.length;
  return Array.from({ length: RADAR_POST_HANDLES_PER_RUN }, (_, i) => all[(start + i) % all.length]!);
}

async function getJson(url: string, deps: FetchPageDeps | undefined): Promise<unknown> {
  const res = await guardedFetchText(url, {
    accept: "application/json",
    contentTypes: JSON_TYPES,
    wrongTypeMessage: "Not JSON.",
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxBytes: MAX_BYTES,
    onOverflow: "error",
    deps,
  });
  return JSON.parse(res.text) as unknown;
}

type Post = { id: string; text: string; url: string | null; at: Date };

async function blueskyPosts(handle: string, deps: FetchPageDeps | undefined, api: string): Promise<Post[]> {
  const url = `${api}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=5&filter=posts_no_replies`;
  const data = (await getJson(url, deps)) as { feed?: Array<{ post?: { uri?: string; record?: { text?: string; createdAt?: string } } }> };
  return (data.feed ?? []).flatMap((f) => {
    const uri = f.post?.uri;
    const text = f.post?.record?.text;
    const at = f.post?.record?.createdAt ? new Date(f.post.record.createdAt) : null;
    if (!uri || !text || !at || !Number.isFinite(at.getTime())) return [];
    const rkey = uri.split("/").pop();
    return [{ id: uri, text, url: rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null, at }];
  });
}

async function mastodonPosts(acct: string, deps?: FetchPageDeps): Promise<Post[]> {
  const [user, host] = acct.split("@");
  if (!user || !host) return [];
  const account = (await getJson(`https://${host}/api/v1/accounts/lookup?acct=${encodeURIComponent(user)}`, deps)) as { id?: string };
  if (!account.id) return [];
  const statuses = (await getJson(
    `https://${host}/api/v1/accounts/${encodeURIComponent(account.id)}/statuses?limit=5&exclude_replies=true&exclude_reblogs=true`,
    deps
  )) as Array<{ id?: string; url?: string; content?: string; created_at?: string }>;
  return (Array.isArray(statuses) ? statuses : []).flatMap((s) => {
    const at = s.created_at ? new Date(s.created_at) : null;
    if (!s.id || !s.content || !at || !Number.isFinite(at.getTime())) return [];
    return [{ id: s.url ?? s.id, text: s.content, url: s.url ?? null, at }];
  });
}

function hostOf(h: Handle, api: string): string {
  return h.network === "bluesky" ? new URL(api).host : h.handle.split("@")[1] ?? "";
}

/**
 * Check tonight's handles and store each person's newest recent post. Returns how many new
 * posts were stored. Never throws: a server being down costs that person's post, nothing more.
 */
export async function pollSocialPosts(
  userId: string,
  candidates: readonly RadarCandidateRow[],
  now: Date,
  opts: { deadline?: number; fetchDeps?: FetchPageDeps; blueskyApi?: string } = {}
): Promise<number> {
  const deadline = opts.deadline ?? Date.now() + RADAR_POST_BUDGET_MS;
  const api = opts.blueskyApi ?? BLUESKY_API;
  const perHost = new Map<string, number>();
  const found: PostToStore[] = [];
  for (const h of handlesForTonight(candidates, now)) {
    if (Date.now() >= deadline) break;
    const host = hostOf(h, api);
    const used = perHost.get(host) ?? 0;
    // A Mastodon check is two requests; count both against the host.
    const cost = h.network === "mastodon" ? 2 : 1;
    if (!host || used + cost > RADAR_POST_PER_HOST) continue;
    perHost.set(host, used + cost);
    try {
      const posts =
        h.network === "bluesky" ? await blueskyPosts(h.handle, opts.fetchDeps, api) : await mastodonPosts(h.handle, opts.fetchDeps);
      const recent = posts
        .filter((p) => p.at <= now && now.getTime() - p.at.getTime() <= RADAR_WINDOWS.postMax * DAY_MS)
        .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
      const excerpt = cleanExcerpt(recent?.text);
      if (!recent || !excerpt) continue;
      found.push({ contactId: h.contactId, network: h.network, postId: recent.id, excerpt, url: safeHttpUrl(recent.url), at: recent.at });
    } catch {
      // Unreachable, private, renamed, or not JSON: tonight, this person has no post.
    }
  }
  return storePosts(userId, found);
}
