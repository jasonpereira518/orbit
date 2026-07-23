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
  ut: "#BF5700",
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
  stripe: "#635BFF",
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
  anthropic: "#D4A27F",
  perplexity: "#22B8CF",
  cursor: "#7C6CFF",
};

const NEUTRAL_STAR = "#c8d0dc";
const NEUTRAL_ORG = "#8a9bb0";

export function normalizeOrgKey(name: string | null | undefined): string {
  return (name || "")
    .trim()
    .toLowerCase()
    .replace(/[.,']/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim();
}

function hashHue(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h % 360;
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

function lookupColor(
  key: string,
  map: Record<string, string>
): string | null {
  if (!key) return null;
  if (map[key]) return map[key];
  for (const [known, color] of Object.entries(map)) {
    if (key.includes(known) || known.includes(key)) return color;
  }
  return null;
}

/** Lift near-black / near-white brands so they glow on the dark map. */
function mapFriendlyBrand(hex: string): string {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return hex;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (luma < 0.12) return "#6B7C93";
  if (luma > 0.92) return "#E8EEF7";
  return hex;
}

function resolveFromMap(
  name: string | null | undefined,
  map: Record<string, string>,
  fallbackNeutral: string
): string {
  const key = normalizeOrgKey(name);
  if (!key) return fallbackNeutral;
  const hit = lookupColor(key, map);
  if (hit) return mapFriendlyBrand(hit);
  return hashToBrandHex(key);
}

/** Primary color for a contact's school star tint. */
export function schoolStarColor(school: string | null | undefined): string {
  return resolveFromMap(school, SCHOOL_COLORS, NEUTRAL_STAR);
}

/** Primary brand color for a company. */
export function companyBrandColor(company: string | null | undefined): string {
  return resolveFromMap(company, COMPANY_COLORS, NEUTRAL_ORG);
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

export function withAlpha(hex: string, alpha: number): string {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return hex;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const NEUTRAL_STAR_COLOR = NEUTRAL_STAR;
