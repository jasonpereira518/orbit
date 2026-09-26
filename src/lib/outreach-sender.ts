/**
 * The From address for outreach mail.
 *
 * On Orbit's hosted Resend key, mail goes from Orbit's own verified domain. On a user's OWN
 * key that address is wrong: Resend only sends from domains verified in the account the key
 * belongs to, so every send was rejected. Here the domain comes from the user's Resend
 * account itself — no settings column — and a key with no verified domain refuses the send
 * rather than falling back to Orbit's domain, which could never work on that key.
 *
 * No `@/db`: the lookup is injectable, so `scripts/smoke-outreach-sender.ts` runs pure.
 */
import { createHash } from "node:crypto";
import { UserFacingError } from "@/lib/errors";

export const NO_VERIFIED_DOMAIN_MESSAGE =
  "Your Resend account has no verified domain yet — verify one at resend.com/domains, then send again";

/** The mailbox name on the user's domain. Replies go to Phase 0's `replyTo`, not here. */
export const OUTREACH_LOCAL_PART = "outreach";

export const SENDER_CACHE_TTL_MS = 10 * 60 * 1000;

export type ResendDomain = { name: string; status: string };
export type ListResendDomains = (apiKey: string) => Promise<ResendDomain[]>;

/** Resend SDK 6.x: `domains.list()` → `{ data: { data: Domain[] } | null, error }`. */
export const listResendDomainsWithSdk: ListResendDomains = async (apiKey) => {
  const { Resend } = await import("resend");
  const { data, error } = await new Resend(apiKey).domains.list();
  if (error || !data) throw new Error(`Resend domains lookup: ${error?.message ?? "no data"}`);
  return data.data.map((d) => ({ name: d.name, status: d.status }));
};

/**
 * Per user AND key, so replacing a key is a fresh lookup. Successes only: a user who has
 * just verified their domain must not wait ten minutes to be believed. Per instance, like
 * every other in-memory cache here — a cold instance simply looks up once.
 */
const senderDomains = new Map<string, { domain: string; expiresAt: number }>();
const SENDER_CACHE_SWEEP_ABOVE = 1000;

function cacheKey(userId: string, apiKey: string) {
  return `${userId}:${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
}

/** A display name that cannot break out of the header. */
function displayName(firstName: string | null): string | null {
  const clean = firstName?.replace(/[\r\n"<>,]/g, "").trim();
  return clean ? clean : null;
}

export async function outreachFromAddress(input: {
  userId: string;
  apiKey: string;
  resendKeyIsPersonal: boolean;
  firstName: string | null;
  hostedFrom: string;
  listDomains?: ListResendDomains;
  now?: () => number;
}): Promise<string> {
  if (!input.resendKeyIsPersonal) return input.hostedFrom;

  const now = (input.now ?? Date.now)();
  const key = cacheKey(input.userId, input.apiKey);
  let cached = senderDomains.get(key);
  if (!cached || cached.expiresAt <= now) {
    let domains: ResendDomain[];
    try {
      domains = await (input.listDomains ?? listResendDomainsWithSdk)(input.apiKey);
    } catch {
      // Same answer as "none verified": whatever went wrong, Orbit's domain is not an
      // option on this key, and the fix the person can make is in their Resend account.
      throw new UserFacingError(NO_VERIFIED_DOMAIN_MESSAGE);
    }
    const verified = domains.find((d) => d.status === "verified");
    if (!verified) throw new UserFacingError(NO_VERIFIED_DOMAIN_MESSAGE);
    cached = { domain: verified.name, expiresAt: now + SENDER_CACHE_TTL_MS };
    // Expired entries read as absent above, so dropping them changes no answer; without
    // this, a long-lived instance keeps one per user and key it ever served.
    if (senderDomains.size >= SENDER_CACHE_SWEEP_ABOVE) {
      for (const [k, entry] of senderDomains) if (entry.expiresAt <= now) senderDomains.delete(k);
    }
    senderDomains.set(key, cached);
  }

  const address = `${OUTREACH_LOCAL_PART}@${cached.domain}`;
  const name = displayName(input.firstName);
  return name ? `${name} <${address}>` : address;
}

export function __clearSenderCacheForTests() {
  senderDomains.clear();
}
