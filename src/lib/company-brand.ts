import { normalizeCompanyName } from "@/lib/company-name";

/**
 * Well-known company brand colors (official-ish primaries).
 * Keys are normalized via normalizeCompanyName.
 */
const BRAND_COLORS: Record<string, string> = {
  // Tech
  apple: "#8E8E93",
  google: "#4285F4",
  "google cloud": "#4285F4",
  microsoft: "#00A4EF",
  meta: "#0866FF",
  facebook: "#0866FF",
  amazon: "#FF9900",
  "amazon web services": "#FF9900",
  "amazon web services (aws)": "#FF9900",
  aws: "#FF9900",
  ibm: "#054ADA",
  "international business machines": "#054ADA",
  oracle: "#C74634",
  salesforce: "#00A1E0",
  adobe: "#E1251B",
  nvidia: "#76B900",
  intel: "#0071C5",
  cisco: "#1BA0D7",
  dell: "#007DB8",
  hp: "#0096D6",
  "hewlett packard": "#0096D6",
  "hewlett-packard": "#0096D6",
  samsung: "#1428A0",
  sony: "#6B7280",
  // AI / startups
  openai: "#10A37F",
  anthropic: "#D4A27F",
  "hugging face": "#FFD21E",
  midjourney: "#A78BFA",
  perplexity: "#20808D",
  cursor: "#F54E00",
  stripe: "#635BFF",
  notion: "#9CA3AF",
  airbnb: "#FF5A5F",
  uber: "#9CA3AF",
  lyft: "#FF00BF",
  spotify: "#1DB954",
  netflix: "#E50914",
  discord: "#5865F2",
  slack: "#E01E5A",
  zoom: "#2D8CFF",
  dropbox: "#0061FF",
  shopify: "#96BF48",
  twilio: "#F22F46",
  cloudflare: "#F38020",
  vercel: "#9CA3AF",
  github: "#8B949E",
  gitlab: "#FC6D26",
  atlassian: "#0052CC",
  jira: "#0052CC",
  linkedin: "#0A66C2",
  twitter: "#1DA1F2",
  x: "#9CA3AF",
  // Finance / consulting
  goldman: "#7399C6",
  "goldman sachs": "#7399C6",
  jpmorgan: "#3B82F6",
  "jp morgan": "#3B82F6",
  "j.p. morgan": "#3B82F6",
  "morgan stanley": "#60A5FA",
  deloitte: "#86BC25",
  accenture: "#A100FF",
  mckinsey: "#9CA3AF",
  "bain & company": "#CC0000",
  bain: "#CC0000",
  "boston consulting group": "#0085CA",
  bcg: "#0085CA",
};

/** Short aliases that map onto a brand key above. */
const ALIASES: Record<string, string> = {
  "amazon web services (aws)": "aws",
  "amazon web services": "aws",
  amzn: "amazon",
  "meta platforms": "meta",
  "meta platforms, inc.": "meta",
  "meta platforms inc": "meta",
  "international business machines corporation": "ibm",
  "international business machines": "ibm",
  msft: "microsoft",
  "open ai": "openai",
};

function hashHue(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

/**
 * Resolve a readable brand color for a company name.
 * Known brands use official-ish hex; others get a stable pastel from the name.
 */
export function companyBrandColor(
  company: string | null | undefined
): string | null {
  if (!company?.trim()) return null;

  const normalized = normalizeCompanyName(company);
  const aliased = ALIASES[normalized] ?? normalized;

  if (BRAND_COLORS[aliased]) return BRAND_COLORS[aliased];
  if (BRAND_COLORS[normalized]) return BRAND_COLORS[normalized];

  // Longest known brand key contained in the name (e.g. "IBM Watson" → ibm)
  let bestKey: string | null = null;
  for (const key of Object.keys(BRAND_COLORS)) {
    if (key.length < 3) continue;
    if (
      (normalized.includes(key) || aliased.includes(key)) &&
      (!bestKey || key.length > bestKey.length)
    ) {
      bestKey = key;
    }
  }
  if (bestKey) return BRAND_COLORS[bestKey]!;

  // Deterministic fallback so unknown companies still get a distinct tint
  const hue = hashHue(normalized);
  return `hsl(${hue} 58% 42%)`;
}
