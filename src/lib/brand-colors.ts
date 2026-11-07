/**
 * The one raw brand-color table: true brand hexes for companies and schools, with aliases.
 *
 * There used to be two tables — one for the constellation (`school-color.ts`) and one for
 * contact cards (`company-brand.ts`) — and they drifted: Oracle, Adobe, Slack, Perplexity and
 * Cursor each had two different colors, and a contact at "UNC Chapel Hill" got a hashed tint
 * on their card because the card table had no schools. Values here are the brand's own color,
 * never pre-adapted for a surface. Each consumer applies its own context treatment on top:
 *
 *   - `school-color.ts`  lifts dark brands within their hue so they show on the dark sky.
 *   - `company-brand.ts` greys and lifts them so they read as text in the app UI.
 *
 * Pure and dependency-free, so it is safe in client bundles and `pure`-tier smoke scripts.
 */

export type BrandKind = "company" | "school";

export type Brand = {
  /** Canonical display name — also the first alias. */
  name: string;
  kind: BrandKind;
  /** The brand's own color, `#RRGGBB`. */
  hex: string;
  /** Its website's bare host, for a logo. Curated entries only. */
  domain?: string;
};

type BrandEntry = [kind: BrandKind, hex: string, names: readonly string[], domain?: string];

const ENTRIES: readonly BrandEntry[] = [
  // Schools -------------------------------------------------------------------------------
  ["school", "#A51C30", ["Harvard University", "Harvard"], "harvard.edu"],
  ["school", "#8C1515", ["Stanford University", "Stanford"], "stanford.edu"],
  ["school", "#A31F34", ["Massachusetts Institute of Technology", "MIT"], "mit.edu"],
  ["school", "#00356B", ["Yale University", "Yale"], "yale.edu"],
  ["school", "#E77500", ["Princeton University", "Princeton"], "princeton.edu"],
  ["school", "#B9D9EB", ["Columbia University", "Columbia"], "columbia.edu"],
  ["school", "#011F5B", ["University of Pennsylvania", "UPenn", "Penn"], "upenn.edu"],
  ["school", "#041E42", ["Penn State", "Pennsylvania State University"], "psu.edu"],
  ["school", "#B31B1B", ["Cornell University", "Cornell"], "cornell.edu"],
  ["school", "#4E3629", ["Brown University", "Brown"], "brown.edu"],
  ["school", "#00693E", ["Dartmouth College", "Dartmouth"], "dartmouth.edu"],
  ["school", "#003262", ["UC Berkeley", "University of California Berkeley", "Berkeley"], "berkeley.edu"],
  ["school", "#2774AE", ["UCLA", "University of California Los Angeles"], "ucla.edu"],
  ["school", "#FFCB05", ["University of Michigan", "Michigan"], "umich.edu"],
  ["school", "#18453B", ["Michigan State University", "Michigan State"], "msu.edu"],
  ["school", "#57068C", ["New York University", "NYU"], "nyu.edu"],
  ["school", "#B3A369", ["Georgia Institute of Technology", "Georgia Tech"], "gatech.edu"],
  ["school", "#C41230", ["Carnegie Mellon University", "Carnegie Mellon", "CMU"], "cmu.edu"],
  ["school", "#BF5700", ["University of Texas", "UT Austin"], "utexas.edu"],
  ["school", "#500000", ["Texas A&M University", "Texas A&M"], "tamu.edu"],
  ["school", "#4B2E83", ["University of Washington"], "washington.edu"],
  ["school", "#003087", ["Duke University", "Duke"], "duke.edu"],
  ["school", "#4E2A84", ["Northwestern University", "Northwestern"], "northwestern.edu"],
  ["school", "#800000", ["University of Chicago", "UChicago"], "uchicago.edu"],
  ["school", "#FF6C0C", ["California Institute of Technology", "Caltech"], "caltech.edu"],
  ["school", "#990000", ["University of Southern California", "USC"], "usc.edu"],
  [
    "school",
    "#4B9CD3",
    [
      "University of North Carolina at Chapel Hill",
      "University of North Carolina",
      "UNC Chapel Hill",
      "UNC-Chapel Hill",
      "UNC",
    ],
    "unc.edu",
  ],
  ["school", "#002147", ["University of Oxford", "Oxford"], "ox.ac.uk"],
  ["school", "#A3C1AD", ["University of Cambridge", "Cambridge"], "cam.ac.uk"],
  ["school", "#002A5C", ["University of Toronto"], "utoronto.ca"],
  ["school", "#002145", ["University of British Columbia", "UBC"], "ubc.ca"],
  ["school", "#FDD54F", ["University of Waterloo", "Waterloo"], "uwaterloo.ca"],
  ["school", "#041E42", ["Georgetown University", "Georgetown"], "georgetown.edu"],
  ["school", "#CC0000", ["North Carolina State University", "NC State", "NCSU"], "ncsu.edu"],
  ["school", "#9E7E38", ["Wake Forest University", "Wake Forest"], "wfu.edu"],
  ["school", "#232D4B", ["University of Virginia", "UVA"], "virginia.edu"],
  ["school", "#861F41", ["Virginia Tech"], "vt.edu"],
  ["school", "#BA0C2F", ["University of Georgia"], "uga.edu"],
  ["school", "#0021A5", ["University of Florida"], "ufl.edu"],
  ["school", "#BB0000", ["Ohio State University", "The Ohio State University", "Ohio State"], "osu.edu"],
  ["school", "#C5050C", ["University of Wisconsin"], "wisc.edu"],
  ["school", "#E84A27", ["University of Illinois"], "illinois.edu"],
  ["school", "#CEB888", ["Purdue University", "Purdue"], "purdue.edu"],
  ["school", "#002D72", ["Johns Hopkins University", "Johns Hopkins"], "jhu.edu"],
  ["school", "#CFAE70", ["Vanderbilt University", "Vanderbilt"], "vanderbilt.edu"],
  ["school", "#00205B", ["Rice University"], "rice.edu"],
  ["school", "#012169", ["Emory University", "Emory"], "emory.edu"],
  ["school", "#0C2340", ["University of Notre Dame", "Notre Dame"], "nd.edu"],
  ["school", "#CC0000", ["Boston University"], "bu.edu"],
  ["school", "#8A100B", ["Boston College"], "bc.edu"],
  ["school", "#E21833", ["University of Maryland"], "umd.edu"],
  ["school", "#182B49", ["UC San Diego", "UCSD"], "ucsd.edu"],

  // Tech ----------------------------------------------------------------------------------
  ["company", "#4285F4", ["Google", "Alphabet"], "google.com"],
  ["company", "#FF9900", ["Amazon Web Services", "AWS"], "aws.amazon.com"],
  ["company", "#FF9900", ["Amazon", "AMZN"], "amazon.com"],
  ["company", "#0081FB", ["Meta", "Meta Platforms"], "meta.com"],
  ["company", "#0866FF", ["Facebook"], "facebook.com"],
  ["company", "#00A4EF", ["Microsoft", "MSFT"], "microsoft.com"],
  ["company", "#A2AAAD", ["Apple"], "apple.com"],
  ["company", "#054ADA", ["IBM", "International Business Machines", "International Business Machines Corporation"], "ibm.com"],
  ["company", "#C74634", ["Oracle"], "oracle.com"],
  ["company", "#00A1E0", ["Salesforce"], "salesforce.com"],
  ["company", "#FA0F00", ["Adobe"], "adobe.com"],
  ["company", "#76B900", ["NVIDIA"], "nvidia.com"],
  ["company", "#0071C5", ["Intel"], "intel.com"],
  ["company", "#049FD9", ["Cisco"], "cisco.com"],
  ["company", "#007DB8", ["Dell", "Dell Technologies"], "dell.com"],
  ["company", "#0096D6", ["HP", "Hewlett Packard", "Hewlett-Packard"], "hp.com"],
  ["company", "#1428A0", ["Samsung"], "samsung.com"],
  ["company", "#000000", ["Sony"], "sony.com"],
  ["company", "#E50914", ["Netflix"], "netflix.com"],
  ["company", "#000000", ["Uber"], "uber.com"],
  ["company", "#FF00BF", ["Lyft"], "lyft.com"],
  ["company", "#FF5A5F", ["Airbnb"], "airbnb.com"],
  ["company", "#4A154B", ["Slack"], "slack.com"],
  ["company", "#000000", ["Notion"], "notion.so"],
  ["company", "#F24E1E", ["Figma"], "figma.com"],
  ["company", "#0A66C2", ["LinkedIn"], "linkedin.com"],
  ["company", "#1DA1F2", ["Twitter"], "twitter.com"],
  ["company", "#000000", ["X"], "x.com"],
  ["company", "#000000", ["Vercel"], "vercel.com"],
  ["company", "#181717", ["GitHub"], "github.com"],
  ["company", "#FC6D26", ["GitLab"], "gitlab.com"],
  ["company", "#0052CC", ["Atlassian", "Jira"], "atlassian.com"],
  ["company", "#2D8CFF", ["Zoom"], "zoom.us"],
  ["company", "#0061FF", ["Dropbox"], "dropbox.com"],
  ["company", "#F22F46", ["Twilio"], "twilio.com"],
  ["company", "#F38020", ["Cloudflare"], "cloudflare.com"],
  ["company", "#96BF48", ["Shopify"], "shopify.com"],
  ["company", "#1DB954", ["Spotify"], "spotify.com"],
  ["company", "#5865F2", ["Discord"], "discord.com"],
  ["company", "#635BFF", ["Stripe"], "stripe.com"],
  ["company", "#000000", ["Palantir"], "palantir.com"],
  ["company", "#FF3621", ["Databricks"], "databricks.com"],
  ["company", "#29B5E8", ["Snowflake"], "snowflake.com"],
  ["company", "#0052FF", ["Coinbase"], "coinbase.com"],
  ["company", "#CCFF00", ["Robinhood"], "robinhood.com"],
  ["company", "#CC0000", ["Tesla"], "tesla.com"],
  ["company", "#005288", ["SpaceX"], "spacex.com"],
  ["company", "#5E6AD2", ["Linear"], "linear.app"],
  ["company", "#E60023", ["Pinterest"], "pinterest.com"],
  ["company", "#FF4500", ["Reddit"], "reddit.com"],
  ["company", "#FFFC00", ["Snap", "Snapchat"], "snap.com"],
  ["company", "#FE2C55", ["TikTok"], "tiktok.com"],
  ["company", "#FF3008", ["DoorDash"], "doordash.com"],
  ["company", "#43B02A", ["Instacart"], "instacart.com"],
  ["company", "#FF7A59", ["HubSpot"], "hubspot.com"],
  ["company", "#F06A6A", ["Asana"], "asana.com"],
  ["company", "#00C4CC", ["Canva"], "canva.com"],
  ["company", "#58CC02", ["Duolingo"], "duolingo.com"],

  // AI ------------------------------------------------------------------------------------
  ["company", "#10A37F", ["OpenAI", "Open AI"], "openai.com"],
  ["company", "#D97757", ["Anthropic"], "anthropic.com"],
  ["company", "#FFD21E", ["Hugging Face"], "huggingface.co"],
  ["company", "#A78BFA", ["Midjourney"], "midjourney.com"],
  ["company", "#20808D", ["Perplexity", "Perplexity AI"], "perplexity.ai"],
  ["company", "#F54E00", ["Cursor", "Anysphere"], "cursor.com"],
  ["company", "#FA520F", ["Mistral AI", "Mistral"], "mistral.ai"],
  ["company", "#FF7759", ["Cohere"], "cohere.com"],

  // Finance / consulting / venture ------------------------------------------------------
  ["company", "#005EB8", ["JPMorgan Chase", "JP Morgan Chase", "JPMorgan", "J.P. Morgan", "JP Morgan"], "jpmorganchase.com"],
  ["company", "#7399C6", ["Goldman Sachs", "Goldman"], "goldmansachs.com"],
  ["company", "#002F6C", ["Morgan Stanley"], "morganstanley.com"],
  ["company", "#012169", ["Bank of America"], "bankofamerica.com"],
  ["company", "#003B70", ["Citibank", "Citi"], "citi.com"],
  ["company", "#D71E28", ["Wells Fargo"], "wellsfargo.com"],
  ["company", "#004977", ["Capital One"], "capitalone.com"],
  ["company", "#003087", ["PayPal"], "paypal.com"],
  ["company", "#1A1F71", ["Visa"], "visa.com"],
  ["company", "#EB001B", ["Mastercard"], "mastercard.com"],
  ["company", "#006FCF", ["American Express", "Amex"], "americanexpress.com"],
  ["company", "#D04A02", ["PwC", "PricewaterhouseCoopers"], "pwc.com"],
  ["company", "#00338D", ["KPMG"], "kpmg.com"],
  ["company", "#FFE600", ["Ernst & Young", "EY"], "ey.com"],
  ["company", "#86BC25", ["Deloitte"], "deloitte.com"],
  ["company", "#A100FF", ["Accenture"], "accenture.com"],
  ["company", "#051C2C", ["McKinsey", "McKinsey & Company"], "mckinsey.com"],
  ["company", "#CC0000", ["Bain & Company", "Bain"], "bain.com"],
  ["company", "#29BA74", ["Boston Consulting Group", "BCG"], "bcg.com"],
  ["company", "#6C5CE7", ["MetaProp"], "metaprop.vc"],
  ["company", "#F26625", ["Y Combinator", "YC"], "ycombinator.com"],
  ["company", "#FF5A00", ["Andreessen Horowitz", "a16z"], "a16z.com"],
  ["company", "#EE3224", ["Sequoia Capital", "Sequoia"], "sequoiacap.com"],
];

/**
 * The key table names and lookups are compared on: lowercase, apostrophes and dots dropped
 * ("J.P." → "jp"), `&` spelled out, every other run of punctuation a single space. Unicode
 * letters survive, so "Universität" is not shredded.
 */
export function brandKey(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Every alias key → the brands it names (one per kind at most in practice). */
const INDEX = new Map<string, Brand[]>();
for (const [kind, hex, names, domain] of ENTRIES) {
  const brand: Brand = { name: names[0]!, kind, hex, ...(domain ? { domain } : {}) };
  for (const alias of names) {
    const key = brandKey(alias);
    const list = INDEX.get(key) ?? [];
    if (!list.some((b) => b === brand)) list.push(brand);
    INDEX.set(key, list);
  }
}

/** Longest alias first, so "google cloud" and "meta platforms" win over their prefixes. */
const KEYS_BY_LENGTH = [...INDEX.keys()].sort((a, b) => b.length - a.length);

/** Shorter than this, a name is never matched as part of a longer alias. */
const MIN_PARTIAL_NAME = 4;

/**
 * Pure lookups, so a dropped entry is just recomputed — to the same `Brand` object, since
 * every hit comes out of `INDEX`. Capped (oldest out first) because the keys are arbitrary
 * company names and a long-lived server instance would otherwise keep every one it saw.
 */
const memo = new Map<string, Brand | null>();
const MEMO_MAX = 5000;

/**
 * Resolve a company or school name to its brand, or null when it is not one we know.
 *
 * The curated table below wins; after it, a color Orbit learned for this exact name (see
 * `registerLearnedBrands`); after that, null, and each surface falls back to its hashed tint.
 *
 * 1. Exact alias match in either table — so a contact whose *company* is "UNC Chapel Hill"
 *    still gets Carolina blue. When both tables hold the alias, `prefer` picks.
 * 2. Otherwise the longest alias that appears in the name as whole words ("IBM Watson" →
 *    IBM, "Columbia Business School" → Columbia, and "Penn State" is not Penn). Whole words,
 *    so "x" never matches inside "Exxon" or "Box", nor "ut" inside "Utah State".
 * 3. Otherwise, for a name of at least `MIN_PARTIAL_NAME` characters, the shortest alias that
 *    contains the name as whole words ("Carnegie" → Carnegie Mellon).
 *
 * When `prefer` is given, steps 2 and 3 search only that table: a university is an employer,
 * so the exact cross-table hit is right, but loose matching across kinds painted "Duke
 * Capital Partners", a fund, Duke University blue.
 */
export function lookupBrand(
  name: string | null | undefined,
  prefer?: BrandKind
): Brand | null {
  const key = brandKey(name);
  if (!key) return null;
  return lookupCuratedBrand(key, prefer) ?? lookupLearnedBrand(key, prefer);
}

/** `lookupBrand` without learned colors: is this an organization the curated table knows? */
export function lookupCuratedBrandByName(
  name: string | null | undefined,
  prefer?: BrandKind
): Brand | null {
  const key = brandKey(name);
  return key ? lookupCuratedBrand(key, prefer) : null;
}

/**
 * Curated brands an as-you-type query names: an alias that starts with it ("goo" → Google)
 * or has a word that does ("chapel" → UNC), prefix hits first, each brand once.
 */
export function searchCuratedBrands(query: string, limit = 6): Brand[] {
  const q = brandKey(query);
  if (!q) return [];
  const prefix: Brand[] = [];
  const word: Brand[] = [];
  for (const [key, brands] of INDEX) {
    const bucket = key.startsWith(q) ? prefix : ` ${key}`.includes(` ${q}`) ? word : null;
    if (bucket) bucket.push(...brands);
  }
  return [...new Set([...prefix, ...word])].slice(0, limit);
}

function lookupCuratedBrand(key: string, prefer?: BrandKind): Brand | null {
  const memoKey = `${prefer ?? ""}|${key}`;
  const cached = memo.get(memoKey);
  if (cached !== undefined) return cached;

  let hit: Brand | null = null;
  const exact = INDEX.get(key);
  if (exact) {
    hit = exact.find((b) => b.kind === prefer) ?? exact[0]!;
  } else {
    const padded = ` ${key} `;
    for (const alias of KEYS_BY_LENGTH) {
      if (!padded.includes(` ${alias} `)) continue;
      const brands = INDEX.get(alias)!;
      const match = prefer ? brands.find((b) => b.kind === prefer) : brands[0];
      if (match) {
        hit = match;
        break;
      }
    }
    if (!hit && key.length >= MIN_PARTIAL_NAME) {
      for (const alias of [...KEYS_BY_LENGTH].reverse()) {
        if (!` ${alias} `.includes(padded)) continue;
        const brands = INDEX.get(alias)!;
        const match = prefer ? brands.find((b) => b.kind === prefer) : brands[0];
        if (match) {
          hit = match;
          break;
        }
      }
    }
  }

  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value!);
  memo.set(memoKey, hit);
  return hit;
}

/** Perceived brightness in [0, 1] from raw sRGB bytes — what the surface treatments key on. */
export function brandLuma(hex: string): number {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return 0.5;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * The hashed fallback tint for a name no table knows: this saturation and lightness, a hue
 * from the name. `company-brand.ts` and the event theme ladder share it, so an event and a
 * company tinted from the same string look related.
 */
export const FALLBACK_SATURATION = 0.58;
export const FALLBACK_LIGHTNESS = 0.42;

/** A brand color learned at runtime for an organization the curated table does not know. */
export type LearnedBrand = { name: string; kind: BrandKind; hex: string };

/** Learned brands by `brandKey`, exact names only — no partial matching on learned names. */
const LEARNED = new Map<string, Brand[]>();

/**
 * Make learned colors visible to `lookupBrand` in this JS realm. Called with the viewer's
 * learned colors by `LearnedBrandColors` (the client and SSR realms) and by the app layout
 * (the server-component realm) — each realm holds its own copy of this module.
 *
 * Process-wide rather than per request, deliberately: an organization's color is a public
 * fact, not the viewer's data, so a server that has seen Acme's color for one user may
 * serve it to the next. Idempotent, and the curated table always wins over a learned color.
 */
export function registerLearnedBrands(entries: readonly LearnedBrand[]): void {
  for (const entry of entries) {
    if (!/^#[0-9a-f]{6}$/i.test(entry.hex)) continue;
    const key = brandKey(entry.name);
    if (!key) continue;
    const list = (LEARNED.get(key) ?? []).filter((b) => b.kind !== entry.kind);
    list.push({ name: entry.name, kind: entry.kind, hex: entry.hex });
    LEARNED.set(key, list);
  }
}

function lookupLearnedBrand(key: string, prefer?: BrandKind): Brand | null {
  const list = LEARNED.get(key);
  if (!list?.length) return null;
  return list.find((b) => b.kind === prefer) ?? list[0]!;
}
