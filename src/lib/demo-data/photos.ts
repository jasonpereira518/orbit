/**
 * Portraits for the extended demo workspace, so the contacts list, the constellation and
 * every profile read as a real network rather than a wall of initials.
 *
 * randomuser.me's portrait set: stable URLs, served over HTTPS (the app's CSP allows any
 * `https:` image, and contact photos render through a plain `<img>`), and photos of people
 * who agreed to be used as placeholders. A fixed index per person keeps every reseed looking
 * the same. A few people are left without one on purpose — a network where every face is
 * filled in looks staged.
 */

/** The hand-written cast, by the gender their portrait should match. */
const CAST_GENDER: Record<string, "f" | "m"> = {
  "Sarah Chen": "f",
  "Marcus Webb": "m",
  "Marcus Lee": "m",
  "Priya Nair": "f",
  "Dr. Elena Vasquez": "f",
  "James Okafor": "m",
  "Aisha Rahman": "f",
  "Tom Bennett": "m",
  "Nina Petrova": "f",
  "David Kim": "m",
  "Rachel Adeyemi": "f",
  "Ben Carter": "m",
  "Sofia Marchetti": "f",
  "Andre Silva": "m",
  "Maya Thompson": "f",
  "Hassan Ali": "m",
  "Grace Whitfield": "f",
  "Leo Fernandez": "m",
  "Yuki Tanaka": "f",
  "Olivia Brooks": "f",
  "Chris Nowak": "m",
  "Fatima Nasser": "f",
  "Daniel Osei": "m",
  "Amara Diallo": "f",
  "Victor Reyes": "m",
};

/** Cast members shown as initials, so not every face is filled in. */
const CAST_WITHOUT_PHOTO = new Set(["Andre Silva", "Olivia Brooks"]);
/** One in this many long-tail people is left as initials. */
const LONG_TAIL_INITIALS_EVERY = 7;

const PORTRAITS_PER_GENDER = 100;

function portraitUrl(gender: "f" | "m", index: number) {
  const folder = gender === "f" ? "women" : "men";
  return `https://randomuser.me/api/portraits/${folder}/${index % PORTRAITS_PER_GENDER}.jpg`;
}

/**
 * Assigns each person a portrait: cast first, then the long tail in order. Indices are handed
 * out per gender so no two people share a face.
 */
export function assignDemoPhotos(
  cast: readonly { fullName: string }[],
  longTail: readonly { fullName: string; gender: "f" | "m" }[]
): Map<string, string | null> {
  const next = { f: 3, m: 3 };
  const take = (g: "f" | "m") => portraitUrl(g, (next[g] += 7));
  const photos = new Map<string, string | null>();
  for (const p of cast) {
    const gender = CAST_GENDER[p.fullName];
    photos.set(p.fullName, gender && !CAST_WITHOUT_PHOTO.has(p.fullName) ? take(gender) : null);
  }
  longTail.forEach((p, i) => {
    photos.set(p.fullName, i % LONG_TAIL_INITIALS_EVERY === LONG_TAIL_INITIALS_EVERY - 1 ? null : take(p.gender));
  });
  return photos;
}
