/**
 * Server half of "log a person by pasting their LinkedIn URL": turning the URLs
 * lib/linkedin-paste.ts found into people.
 *
 * Split from that module because this one reaches Apollo (and through it the database),
 * while the detection has to stay importable from the capture panel. Keep it that way.
 */
import {
  getApolloApiKey,
  enrichPeopleFromLinkedIn,
  type LinkedInProfileEnrichment,
} from "@/lib/apollo";
import { LINKEDIN_REFRESH_BATCH_SIZE } from "@/lib/outreach-types";
import {
  MAX_PASTED_LINKEDIN_PROFILES,
  personNameFromSlug,
  type LinkedInProfileRef,
  type PastedLinkedInPerson,
} from "@/lib/linkedin-paste";

/**
 * Why a paste came back with slug guesses instead of profile data. Null means the lookup
 * ran; every value here is a reason the *user* can act on, which is why it is carried out
 * to the panel rather than logged and forgotten.
 */
export type LinkedInLookupDegradation = "no_key" | "plan" | "error" | null;

export type ResolvedLinkedInPaste = {
  people: PastedLinkedInPerson[];
  degraded: LinkedInLookupDegradation;
  /** Profiles past {@link MAX_PASTED_LINKEDIN_PROFILES}, dropped before any lookup. */
  dropped: number;
};

function fromSlug(ref: LinkedInProfileRef): PastedLinkedInPerson {
  return {
    url: ref.url,
    slug: ref.slug,
    name: personNameFromSlug(ref.slug),
    title: null,
    company: null,
    location: null,
    school: null,
    email: null,
    source: "url",
  };
}

function fromEnrichment(
  ref: LinkedInProfileRef,
  profile: LinkedInProfileEnrichment
): PastedLinkedInPerson {
  const name =
    [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim() ||
    personNameFromSlug(ref.slug);
  return {
    url: ref.url,
    slug: ref.slug,
    name: name || null,
    title: profile.title,
    company: profile.company,
    location: profile.location,
    school: profile.school,
    email: profile.email,
    source: "apollo",
  };
}

/**
 * A free Apollo plan answers people-enrichment with a 403, and a missing key throws before
 * the request. Neither is a reason to refuse the paste — the slug still names the person
 * well enough to review — so both degrade instead of propagating.
 */
function degradationFor(err: unknown): LinkedInLookupDegradation {
  const message = err instanceof Error ? err.message : String(err);
  if (/not available on your current plan|403/i.test(message)) return "plan";
  if (/Add an Apollo API key/i.test(message)) return "no_key";
  return "error";
}

/**
 * Look up each pasted profile, falling back to the slug for any that cannot be resolved.
 *
 * Never throws for a lookup failure: the point of pasting a URL is to get the person into
 * Orbit, and a name read off the slug plus the URL itself is already a usable contact. The
 * caller gets `degraded` so it can say what was missing rather than silently presenting
 * guesses as profile data.
 */
export async function resolvePastedLinkedInProfiles(
  userId: string,
  refs: LinkedInProfileRef[]
): Promise<ResolvedLinkedInPaste> {
  if (!refs.length) return { people: [], degraded: null, dropped: 0 };

  const dropped = Math.max(0, refs.length - MAX_PASTED_LINKEDIN_PROFILES);
  const capped = refs.slice(0, MAX_PASTED_LINKEDIN_PROFILES);

  const apiKey = await getApolloApiKey(userId);
  if (!apiKey) {
    return { people: capped.map(fromSlug), degraded: "no_key", dropped };
  }

  const people: PastedLinkedInPerson[] = [];
  let degraded: LinkedInLookupDegradation = null;

  // Apollo's match endpoint is capped per call, and a paste can carry more than that.
  for (let i = 0; i < capped.length; i += LINKEDIN_REFRESH_BATCH_SIZE) {
    const chunk = capped.slice(i, i + LINKEDIN_REFRESH_BATCH_SIZE);
    if (degraded) {
      // The first failure was a key or plan problem, not a per-profile miss — the
      // remaining chunks would fail identically, so spend nothing on them.
      people.push(...chunk.map(fromSlug));
      continue;
    }
    try {
      const enriched = await enrichPeopleFromLinkedIn(
        userId,
        chunk.map((ref) => ({
          linkedinUrl: ref.url,
          fullName: personNameFromSlug(ref.slug),
        }))
      );
      chunk.forEach((ref, index) => {
        const profile = enriched[index];
        // A null here is Apollo saying it has no record of this person — the profile
        // exists, they just aren't in its data. The slug still names them.
        people.push(profile ? fromEnrichment(ref, profile) : fromSlug(ref));
      });
    } catch (err) {
      degraded = degradationFor(err);
      people.push(...chunk.map(fromSlug));
    }
  }

  return { people, degraded, dropped };
}
