import { hashHue } from "@/lib/hash";

/** Curated primary brand colors for common schools (normalized keys). */
const SCHOOL_COLORS: Record<string, string> = {
  "harvard university": "#A51C30",
  harvard: "#A51C30",
  "stanford university": "#8C1515",
  stanford: "#8C1515",
  mit: "#A31F34",
  "massachusetts institute of technology": "#A31F34",
  "yale university": "#00356B",
  yale: "#00356B",
  "princeton university": "#E77500",
  princeton: "#E77500",
  "columbia university": "#B9D9EB",
  columbia: "#B9D9EB",
  "university of pennsylvania": "#011F5B",
  upenn: "#011F5B",
  penn: "#011F5B",
  "cornell university": "#B31B1B",
  cornell: "#B31B1B",
  "brown university": "#4E3629",
  brown: "#4E3629",
  "dartmouth college": "#00693E",
  dartmouth: "#00693E",
  "uc berkeley": "#003262",
  berkeley: "#003262",
  "university of california berkeley": "#003262",
  ucla: "#2774AE",
  "university of california los angeles": "#2774AE",
  "university of michigan": "#FFCB05",
  michigan: "#FFCB05",
  nyu: "#57068C",
  "new york university": "#57068C",
  "georgia tech": "#B3A369",
  "georgia institute of technology": "#B3A369",
  "carnegie mellon": "#C41230",
  "carnegie mellon university": "#C41230",
  cmu: "#C41230",
  "university of texas": "#BF5700",
  "ut austin": "#BF5700",
  "university of washington": "#4B2E83",
  "duke university": "#003087",
  duke: "#003087",
  "northwestern university": "#4E2A84",
  northwestern: "#4E2A84",
  "university of chicago": "#800000",
  caltech: "#FF6C0C",
  "california institute of technology": "#FF6C0C",
  oxford: "#002147",
  "university of oxford": "#002147",
  cambridge: "#A3C1AD",
  "university of cambridge": "#A3C1AD",
  "university of toronto": "#002A5C",
  waterloo: "#FDD54F",
  "university of waterloo": "#FDD54F",
  georgetown: "#041E42",
  "georgetown university": "#041E42",
  // Carolina blue.
  unc: "#4B9CD3",
  "unc chapel hill": "#4B9CD3",
  "university of north carolina": "#4B9CD3",
  "university of north carolina at chapel hill": "#4B9CD3",
  "nc state": "#CC0000",
  ncsu: "#CC0000",
  "north carolina state university": "#CC0000",
  "wake forest": "#9E7E38",
  "wake forest university": "#9E7E38",
  "university of virginia": "#232D4B",
  uva: "#232D4B",
  "virginia tech": "#861F41",
  "university of georgia": "#BA0C2F",
  "university of florida": "#0021A5",
  "ohio state": "#BB0000",
  "ohio state university": "#BB0000",
  "the ohio state university": "#BB0000",
  "penn state": "#041E42",
  "pennsylvania state university": "#041E42",
  "university of wisconsin": "#C5050C",
  "university of illinois": "#E84A27",
  purdue: "#CEB888",
  "purdue university": "#CEB888",
  usc: "#990000",
  "university of southern california": "#990000",
  "johns hopkins": "#002D72",
  "johns hopkins university": "#002D72",
  vanderbilt: "#CFAE70",
  "vanderbilt university": "#CFAE70",
  "rice university": "#00205B",
  emory: "#012169",
  "emory university": "#012169",
  "notre dame": "#0C2340",
  "university of notre dame": "#0C2340",
  "boston university": "#CC0000",
  "boston college": "#8A100B",
  "university of maryland": "#E21833",
  "uc san diego": "#182B49",
  ucsd: "#182B49",
};

/** Curated primary brand colors for common companies. */
const COMPANY_COLORS: Record<string, string> = {
  google: "#4285F4",
  "alphabet": "#4285F4",
  "amazon web services": "#FF9900",
  aws: "#FF9900",
  amazon: "#FF9900",
  meta: "#0668E1",
  facebook: "#0668E1",
  "meta platforms": "#0668E1",
  openai: "#10A37F",
  microsoft: "#00A4EF",
  apple: "#A2AAAD",
  // Stripe's "blurple" is #635BFF — hue ~243°, on the blue/violet line. On a black sky, and
  // mixed toward white for the stars, it read plainly blue. Nudged to the violet people see.
  stripe: "#9061F9",
  vercel: "#FFFFFF",
  netflix: "#E50914",
  uber: "#000000",
  airbnb: "#FF5A5F",
  salesforce: "#00A1E0",
  oracle: "#F80000",
  ibm: "#054ADA",
  nvidia: "#76B900",
  intel: "#0071C5",
  adobe: "#FF0000",
  slack: "#4A154B",
  notion: "#FFFFFF",
  figma: "#F24E1E",
  linkedin: "#0A66C2",
  twitter: "#1DA1F2",
  x: "#FFFFFF",
  "jpmorgan chase": "#005EB8",
  "jp morgan": "#005EB8",
  "jp morgan chase": "#005EB8",
  jpmorgan: "#005EB8",
  "goldman sachs": "#7399C6",
  "morgan stanley": "#002F6C",
  "bank of america": "#012169",
  citibank: "#003B70",
  citi: "#003B70",
  metaprop: "#6C5CE7",
  "y combinator": "#F26625",
  yc: "#F26625",
  a16z: "#FF5A00",
  "andreessen horowitz": "#FF5A00",
  sequoia: "#EE3224",
  "sequoia capital": "#EE3224",
  accenture: "#A100FF",
  deloitte: "#86BC25",
  mckinsey: "#000000",
  "bain & company": "#CC0000",
  bain: "#CC0000",
  "boston consulting group": "#0095C8",
  bcg: "#0095C8",
  palantir: "#000000",
  databricks: "#FF3621",
  snowflake: "#29B5E8",
  shopify: "#96BF48",
  spotify: "#1DB954",
  discord: "#5865F2",
  github: "#FFFFFF",
  gitlab: "#FC6D26",
  atlassian: "#0052CC",
  zoom: "#2D8CFF",
  dropbox: "#0061FF",
  coinbase: "#0052FF",
  robinhood: "#CCFF00",
  tesla: "#CC0000",
  spacex: "#005288",
  // Anthropic's clay, not the older tan.
  anthropic: "#D97757",
  perplexity: "#20808D",
  cursor: "#7C6CFF",
  mistral: "#FA520F",
  "mistral ai": "#FA520F",
  linear: "#5E6AD2",
  "hugging face": "#FFD21E",
  cohere: "#FF7759",
  twilio: "#F22F46",
  cloudflare: "#F38020",
  lyft: "#FF00BF",
  pinterest: "#E60023",
  reddit: "#FF4500",
  snap: "#FFFC00",
  snapchat: "#FFFC00",
  tiktok: "#FE2C55",
  samsung: "#1428A0",
  cisco: "#049FD9",
  dell: "#007DB8",
  hp: "#0096D6",
  "hewlett packard": "#0096D6",
  paypal: "#003087",
  visa: "#1A1F71",
  mastercard: "#EB001B",
  "american express": "#006FCF",
  amex: "#006FCF",
  "wells fargo": "#D71E28",
  "capital one": "#004977",
  pwc: "#D04A02",
  kpmg: "#00338D",
  "ernst & young": "#FFE600",
  doordash: "#FF3008",
  instacart: "#43B02A",
  hubspot: "#FF7A59",
  asana: "#F06A6A",
  canva: "#00C4CC",
  duolingo: "#58CC02",
};

const NEUTRAL_STAR = "#c8d0dc";
const NEUTRAL_ORG = "#8a9bb0";

export function normalizeOrgKey(name: string | null | undefined): string {
  return (name || "")
    .trim()
    .toLowerCase()
    .replace(/[.,']/g, "")
    // "UNC-Chapel Hill" and "UNC Chapel Hill" are one school.
    .replace(/\s*[-–—]\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim();
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = light - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function hashToBrandHex(input: string): string {
  const hue = hashHue(input);
  const sat = 48 + (hashHue(input + "s") % 30);
  const light = 42 + (hashHue(input + "l") % 16);
  return hslToHex(hue, sat, light);
}

/** Whether `words` appears in `within` as a run of whole words. */
function containsWords(within: string[], words: string[]): boolean {
  if (words.length === 0 || words.length > within.length) return false;
  for (let i = 0; i + words.length <= within.length; i++) {
    if (words.every((w, j) => within[i + j] === w)) return true;
  }
  return false;
}

/** Shorter than this, a name is only ever an exact match — "ut" or "x" is not a brand inside a word. */
const MIN_PARTIAL_NAME = 4;

/**
 * The brand a name refers to, matched on whole words.
 *
 * Exact first. Then a known name inside this one ("Stripe Inc", "Google Cloud") — the longest,
 * so "Boston College" is not "Boston University" and "Penn State" is not Penn. Then this name
 * inside a known one ("Carnegie" → "Carnegie Mellon"), for names long enough to mean something.
 * Whole words throughout: raw substrings painted "Exxon" and "Box" white (they contain "x") and
 * "Utah State" Texas orange (it contains "ut").
 */
function lookupColor(
  key: string,
  map: Record<string, string>
): string | null {
  if (!key) return null;
  if (map[key]) return map[key];
  const words = key.split(" ");
  let best: string | null = null;
  for (const known of Object.keys(map)) {
    if (containsWords(words, known.split(" ")) && (!best || known.length > best.length)) {
      best = known;
    }
  }
  if (best) return map[best];
  if (key.length < MIN_PARTIAL_NAME) return null;
  for (const [known, color] of Object.entries(map)) {
    if (containsWords(known.split(" "), words)) return color;
  }
  return null;
}

function luma(hex: string): number {
  const raw = hex.replace("#", "");
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** The dimmest a brand may be drawn on the night sky. */
const MIN_SKY_LUMA = 0.4;

/**
 * Make a brand visible on the dark map without changing what colour it is.
 *
 * A dark brand is lifted toward white until it clears `MIN_SKY_LUMA`, so Duke stays Duke blue and
 * Stanford stays cardinal — they used to either stay navy (invisible on black) or, past a cutoff,
 * all become the same slate grey. Only a brand with no hue at all (a black logo) ends up grey,
 * which is what it is. Near-white is softened a touch so it does not glare.
 */
function mapFriendlyBrand(hex: string): string {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return hex;
  const l = luma(hex);
  if (l > 0.92) return "#E8EEF7";
  if (l >= MIN_SKY_LUMA) return hex;
  for (let t = 0.05; t < 1; t += 0.05) {
    const lifted = mixWithWhite(hex, t);
    if (luma(lifted) >= MIN_SKY_LUMA) return lifted;
  }
  return mixWithWhite(hex, 0.5);
}

/**
 * The brand colour for a name, from the first table that knows it.
 *
 * Both tables are asked, the likelier one first: a university is an employer as often as it is
 * a school, so a "company" cluster named UNC Chapel Hill must still find Carolina blue rather
 * than falling through to a hashed colour. The other table only by exact name, though — loose
 * word matching across kinds painted "Duke Capital Partners", a fund, Duke University blue.
 */
function resolveFromMaps(
  name: string | null | undefined,
  maps: Record<string, string>[],
  fallbackNeutral: string
): string {
  const key = normalizeOrgKey(name);
  if (!key) return fallbackNeutral;
  const [own, ...others] = maps;
  const hit = lookupColor(key, own) ?? others.map((map) => map[key]).find(Boolean);
  if (hit) return mapFriendlyBrand(hit);
  return hashToBrandHex(key);
}

/** Primary color for a contact's school star tint. */
export function schoolStarColor(school: string | null | undefined): string {
  return resolveFromMaps(school, [SCHOOL_COLORS, COMPANY_COLORS], NEUTRAL_STAR);
}

/** Primary brand color for a company. */
export function companyBrandColor(company: string | null | undefined): string {
  return resolveFromMaps(company, [COMPANY_COLORS, SCHOOL_COLORS], NEUTRAL_ORG);
}

export function clusterBrandColor(
  name: string,
  kind?: "company" | "school" | "other" | string
): string {
  if (kind === "school") return schoolStarColor(name);
  if (kind === "company") return companyBrandColor(name);
  // Infer: try school map first for known schools, else company
  const key = normalizeOrgKey(name);
  if (lookupColor(key, SCHOOL_COLORS)) return schoolStarColor(name);
  return companyBrandColor(name);
}

/** Lerp a hex color toward white (0 = unchanged, 1 = pure white). */
export function mixWithWhite(hex: string, whiteRatio: number): string {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return hex;
  const t = Math.min(1, Math.max(0, whiteRatio));
  const channel = (i: number) => {
    const v = parseInt(raw.slice(i, i + 2), 16);
    return Math.round(v + (255 - v) * t)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(2)}${channel(4)}`;
}

export function withAlpha(hex: string, alpha: number): string {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return hex;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
