/**
 * Parsing and normalising acquisition signals. No database, no framework.
 *
 * FIRST TOUCH, NOT LAST. Someone who follows a Reddit link, reads for a week, then types
 * the URL directly and signs up was acquired by Reddit — last-touch would credit "direct"
 * and quietly erase the only channel that actually worked. So the values are captured on
 * the first marketing page a browser ever sees, parked in a cookie, and written exactly
 * once on the first authenticated request.
 *
 * SEPARATE FROM `attribution.ts` BECAUSE MIDDLEWARE READS IT. `src/proxy.ts` is where the
 * first touch is captured, and `attribution.ts` imports `@/db` — which would pull PGlite,
 * and therefore `node:fs`, into the middleware bundle. This file imports nothing at all.
 *
 * Do not re-export these from `attribution.ts`; a re-export makes the broken import path
 * compile again and the failure returns the next time middleware needs a helper.
 */

/** How long a first touch stays claimable. Longer than most funnels, shorter than forever. */
export const ATTRIBUTION_COOKIE = "orbit_attr";
export const ATTRIBUTION_MAX_AGE_S = 90 * 24 * 60 * 60;

export type Attribution = {
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  landingPath: string | null;
};

const EMPTY: Attribution = {
  referrer: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  landingPath: null,
};

/** Trim, lowercase and null out blanks. `utm_source=` in a URL is absence, not a value. */
function clean(value: string | null | undefined, lower = true): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  // Cap length: these end up in GROUP BY, and a pathological referrer should not become a
  // 4KB row or a bucket of one.
  const capped = trimmed.slice(0, 512);
  return lower ? capped.toLowerCase() : capped;
}

/**
 * Reduce a referrer URL to its host.
 *
 * The full URL is worse than useless for grouping — every Reddit thread is its own bucket,
 * so the one channel that mattered renders as forty rows of one. The host is the channel.
 */
export function referrerHost(referrer: string | null | undefined): string | null {
  const raw = clean(referrer, false);
  if (!raw) return null;
  try {
    return new URL(raw).host.replace(/^www\./, "").toLowerCase();
  } catch {
    // Not a URL. Keep it — Android intents and some clients send bare tokens, and a
    // mystery value in the rollup is more informative than a silently dropped one.
    return raw.slice(0, 128).toLowerCase();
  }
}

/** Parse a landing URL into the attribution we would store for it. */
export function attributionFromUrl(
  url: string,
  referrer: string | null | undefined
): Attribution {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return EMPTY;
  }

  const q = parsed.searchParams;
  return {
    referrer: referrerHost(referrer),
    utmSource: clean(q.get("utm_source")),
    utmMedium: clean(q.get("utm_medium")),
    utmCampaign: clean(q.get("utm_campaign")),
    landingPath: clean(parsed.pathname, false),
  };
}

/**
 * Is there a CHANNEL here, or was this a bare direct visit?
 *
 * `landingPath` deliberately does not count. It is set on literally every request, so
 * including it would make this function always true — and since middleware calls it to
 * decide whether to set a cookie, that would drop a tracking cookie on every visitor in
 * order to remember nothing. A cookie should exist only when there is an actual channel
 * worth carrying to signup; the landing path is context that rides along with one.
 */
export function hasSignal(a: Attribution): boolean {
  return Boolean(a.referrer || a.utmSource || a.utmMedium || a.utmCampaign);
}

export function serializeAttribution(a: Attribution): string {
  return JSON.stringify(a);
}

export function parseAttribution(raw: string | null | undefined): Attribution | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Attribution>;
    const a: Attribution = {
      referrer: clean(parsed.referrer, false),
      utmSource: clean(parsed.utmSource),
      utmMedium: clean(parsed.utmMedium),
      utmCampaign: clean(parsed.utmCampaign),
      landingPath: clean(parsed.landingPath, false),
    };
    return hasSignal(a) ? a : null;
  } catch {
    // A cookie is user-controlled input. Malformed means discard, never throw — an
    // attribution failure must not be able to break a page load.
    return null;
  }
}

