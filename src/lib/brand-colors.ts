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
};

type BrandEntry = [kind: BrandKind, hex: string, names: readonly string[]];

const ENTRIES: readonly BrandEntry[] = [
  // Schools -------------------------------------------------------------------------------
  ["school", "#A51C30", ["Harvard University", "Harvard"]],
  ["school", "#8C1515", ["Stanford University", "Stanford"]],
  ["school", "#A31F34", ["Massachusetts Institute of Technology", "MIT"]],
  ["school", "#00356B", ["Yale University", "Yale"]],
  ["school", "#E77500", ["Princeton University", "Princeton"]],
  ["school", "#B9D9EB", ["Columbia University", "Columbia"]],
  ["school", "#011F5B", ["University of Pennsylvania", "UPenn", "Penn"]],
  ["school", "#041E42", ["Penn State", "Pennsylvania State University"]],
  ["school", "#B31B1B", ["Cornell University", "Cornell"]],
  ["school", "#4E3629", ["Brown University", "Brown"]],
  ["school", "#00693E", ["Dartmouth College", "Dartmouth"]],
  ["school", "#003262", ["UC Berkeley", "University of California Berkeley", "Berkeley"]],
  ["school", "#2774AE", ["UCLA", "University of California Los Angeles"]],
  ["school", "#FFCB05", ["University of Michigan", "Michigan"]],
  ["school", "#18453B", ["Michigan State University", "Michigan State"]],
  ["school", "#57068C", ["New York University", "NYU"]],
  ["school", "#B3A369", ["Georgia Institute of Technology", "Georgia Tech"]],
  ["school", "#C41230", ["Carnegie Mellon University", "Carnegie Mellon", "CMU"]],
  ["school", "#BF5700", ["University of Texas", "UT Austin"]],
  ["school", "#500000", ["Texas A&M University", "Texas A&M"]],
  ["school", "#4B2E83", ["University of Washington"]],
  ["school", "#003087", ["Duke University", "Duke"]],
  ["school", "#4E2A84", ["Northwestern University", "Northwestern"]],
  ["school", "#800000", ["University of Chicago", "UChicago"]],
  ["school", "#FF6C0C", ["California Institute of Technology", "Caltech"]],
  ["school", "#990000", ["University of Southern California", "USC"]],
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
  ],
  ["school", "#002147", ["University of Oxford", "Oxford"]],
  ["school", "#A3C1AD", ["University of Cambridge", "Cambridge"]],
  ["school", "#002A5C", ["University of Toronto"]],
  ["school", "#002145", ["University of British Columbia", "UBC"]],
  ["school", "#FDD54F", ["University of Waterloo", "Waterloo"]],
  ["school", "#041E42", ["Georgetown University", "Georgetown"]],
  ["school", "#CC0000", ["North Carolina State University", "NC State", "NCSU"]],
  ["school", "#9E7E38", ["Wake Forest University", "Wake Forest"]],
  ["school", "#232D4B", ["University of Virginia", "UVA"]],
  ["school", "#861F41", ["Virginia Tech"]],
  ["school", "#BA0C2F", ["University of Georgia"]],
  ["school", "#0021A5", ["University of Florida"]],
  ["school", "#BB0000", ["Ohio State University", "The Ohio State University", "Ohio State"]],
  ["school", "#C5050C", ["University of Wisconsin"]],
  ["school", "#E84A27", ["University of Illinois"]],
  ["school", "#CEB888", ["Purdue University", "Purdue"]],
  ["school", "#002D72", ["Johns Hopkins University", "Johns Hopkins"]],
  ["school", "#CFAE70", ["Vanderbilt University", "Vanderbilt"]],
  ["school", "#00205B", ["Rice University"]],
  ["school", "#012169", ["Emory University", "Emory"]],
  ["school", "#0C2340", ["University of Notre Dame", "Notre Dame"]],
  ["school", "#CC0000", ["Boston University"]],
  ["school", "#8A100B", ["Boston College"]],
  ["school", "#E21833", ["University of Maryland"]],
  ["school", "#182B49", ["UC San Diego", "UCSD"]],

  // Tech ----------------------------------------------------------------------------------
  ["company", "#4285F4", ["Google", "Alphabet"]],
  ["company", "#FF9900", ["Amazon Web Services", "AWS"]],
  ["company", "#FF9900", ["Amazon", "AMZN"]],
  ["company", "#0081FB", ["Meta", "Meta Platforms"]],
  ["company", "#0866FF", ["Facebook"]],
  ["company", "#00A4EF", ["Microsoft", "MSFT"]],
  ["company", "#A2AAAD", ["Apple"]],
  ["company", "#054ADA", ["IBM", "International Business Machines", "International Business Machines Corporation"]],
  ["company", "#C74634", ["Oracle"]],
  ["company", "#00A1E0", ["Salesforce"]],
  ["company", "#FA0F00", ["Adobe"]],
  ["company", "#76B900", ["NVIDIA"]],
  ["company", "#0071C5", ["Intel"]],
  ["company", "#049FD9", ["Cisco"]],
  ["company", "#007DB8", ["Dell", "Dell Technologies"]],
  ["company", "#0096D6", ["HP", "Hewlett Packard", "Hewlett-Packard"]],
  ["company", "#1428A0", ["Samsung"]],
  ["company", "#000000", ["Sony"]],
  ["company", "#E50914", ["Netflix"]],
  ["company", "#000000", ["Uber"]],
  ["company", "#FF00BF", ["Lyft"]],
  ["company", "#FF5A5F", ["Airbnb"]],
  ["company", "#4A154B", ["Slack"]],
  ["company", "#000000", ["Notion"]],
  ["company", "#F24E1E", ["Figma"]],
  ["company", "#0A66C2", ["LinkedIn"]],
  ["company", "#1DA1F2", ["Twitter"]],
  ["company", "#000000", ["X"]],
  ["company", "#000000", ["Vercel"]],
  ["company", "#181717", ["GitHub"]],
  ["company", "#FC6D26", ["GitLab"]],
  ["company", "#0052CC", ["Atlassian", "Jira"]],
  ["company", "#2D8CFF", ["Zoom"]],
  ["company", "#0061FF", ["Dropbox"]],
  ["company", "#F22F46", ["Twilio"]],
  ["company", "#F38020", ["Cloudflare"]],
  ["company", "#96BF48", ["Shopify"]],
  ["company", "#1DB954", ["Spotify"]],
  ["company", "#5865F2", ["Discord"]],
  ["company", "#635BFF", ["Stripe"]],
  ["company", "#000000", ["Palantir"]],
  ["company", "#FF3621", ["Databricks"]],
  ["company", "#29B5E8", ["Snowflake"]],
  ["company", "#0052FF", ["Coinbase"]],
  ["company", "#CCFF00", ["Robinhood"]],
  ["company", "#CC0000", ["Tesla"]],
  ["company", "#005288", ["SpaceX"]],
  ["company", "#5E6AD2", ["Linear"]],
  ["company", "#E60023", ["Pinterest"]],
  ["company", "#FF4500", ["Reddit"]],
  ["company", "#FFFC00", ["Snap", "Snapchat"]],
  ["company", "#FE2C55", ["TikTok"]],
  ["company", "#FF3008", ["DoorDash"]],
  ["company", "#43B02A", ["Instacart"]],
  ["company", "#FF7A59", ["HubSpot"]],
  ["company", "#F06A6A", ["Asana"]],
  ["company", "#00C4CC", ["Canva"]],
  ["company", "#58CC02", ["Duolingo"]],

  // AI ------------------------------------------------------------------------------------
  ["company", "#10A37F", ["OpenAI", "Open AI"]],
  ["company", "#D97757", ["Anthropic"]],
  ["company", "#FFD21E", ["Hugging Face"]],
  ["company", "#A78BFA", ["Midjourney"]],
  ["company", "#20808D", ["Perplexity", "Perplexity AI"]],
  ["company", "#F54E00", ["Cursor", "Anysphere"]],
  ["company", "#FA520F", ["Mistral AI", "Mistral"]],
  ["company", "#FF7759", ["Cohere"]],

  // Finance / consulting / venture ------------------------------------------------------
  ["company", "#005EB8", ["JPMorgan Chase", "JP Morgan Chase", "JPMorgan", "J.P. Morgan", "JP Morgan"]],
  ["company", "#7399C6", ["Goldman Sachs", "Goldman"]],
  ["company", "#002F6C", ["Morgan Stanley"]],
  ["company", "#012169", ["Bank of America"]],
  ["company", "#003B70", ["Citibank", "Citi"]],
  ["company", "#D71E28", ["Wells Fargo"]],
  ["company", "#004977", ["Capital One"]],
  ["company", "#003087", ["PayPal"]],
  ["company", "#1A1F71", ["Visa"]],
  ["company", "#EB001B", ["Mastercard"]],
  ["company", "#006FCF", ["American Express", "Amex"]],
  ["company", "#D04A02", ["PwC", "PricewaterhouseCoopers"]],
  ["company", "#00338D", ["KPMG"]],
  ["company", "#FFE600", ["Ernst & Young", "EY"]],
  ["company", "#86BC25", ["Deloitte"]],
  ["company", "#A100FF", ["Accenture"]],
  ["company", "#051C2C", ["McKinsey", "McKinsey & Company"]],
  ["company", "#CC0000", ["Bain & Company", "Bain"]],
  ["company", "#29BA74", ["Boston Consulting Group", "BCG"]],
  ["company", "#6C5CE7", ["MetaProp"]],
  ["company", "#F26625", ["Y Combinator", "YC"]],
  ["company", "#FF5A00", ["Andreessen Horowitz", "a16z"]],
  ["company", "#EE3224", ["Sequoia Capital", "Sequoia"]],
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
for (const [kind, hex, names] of ENTRIES) {
  const brand: Brand = { name: names[0]!, kind, hex };
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

const memo = new Map<string, Brand | null>();

/**
 * Resolve a company or school name to its brand, or null when it is not one we know.
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
