/** Personal / consumer mail hosts — not useful as company logos. */
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "mail.com",
  "yandex.com",
  "gmx.com",
  "gmx.net",
  "zoho.com",
]);

/** Well-known company name → logo domain. */
const COMPANY_DOMAINS: Record<string, string> = {
  amazon: "amazon.com",
  "amazon.com": "amazon.com",
  "amazon web services": "aws.amazon.com",
  "amazon web services (aws)": "aws.amazon.com",
  aws: "aws.amazon.com",
  google: "google.com",
  alphabet: "abc.xyz",
  meta: "meta.com",
  "meta platforms": "meta.com",
  facebook: "facebook.com",
  microsoft: "microsoft.com",
  apple: "apple.com",
  openai: "openai.com",
  anthropic: "anthropic.com",
  nvidia: "nvidia.com",
  netflix: "netflix.com",
  uber: "uber.com",
  airbnb: "airbnb.com",
  stripe: "stripe.com",
  shopify: "shopify.com",
  salesforce: "salesforce.com",
  oracle: "oracle.com",
  ibm: "ibm.com",
  intel: "intel.com",
  adobe: "adobe.com",
  slack: "slack.com",
  notion: "notion.so",
  figma: "figma.com",
  linkedin: "linkedin.com",
  twitter: "x.com",
  x: "x.com",
  spotify: "spotify.com",
  tesla: "tesla.com",
  goldman: "goldmansachs.com",
  "goldman sachs": "goldmansachs.com",
  "jp morgan": "jpmorgan.com",
  "jpmorgan": "jpmorgan.com",
  "j.p. morgan": "jpmorgan.com",
  mckinsey: "mckinsey.com",
  "mckinsey & company": "mckinsey.com",
  bcg: "bcg.com",
  "boston consulting group": "bcg.com",
  deloitte: "deloitte.com",
  accenture: "accenture.com",
  "y combinator": "ycombinator.com",
  yc: "ycombinator.com",
};

/** Well-known school name → logo domain. */
const SCHOOL_DOMAINS: Record<string, string> = {
  mit: "mit.edu",
  "massachusetts institute of technology": "mit.edu",
  stanford: "stanford.edu",
  "stanford university": "stanford.edu",
  harvard: "harvard.edu",
  "harvard university": "harvard.edu",
  "harvard college": "harvard.edu",
  yale: "yale.edu",
  "yale university": "yale.edu",
  princeton: "princeton.edu",
  "princeton university": "princeton.edu",
  columbia: "columbia.edu",
  "columbia university": "columbia.edu",
  "university of pennsylvania": "upenn.edu",
  upenn: "upenn.edu",
  penn: "upenn.edu",
  cornell: "cornell.edu",
  "cornell university": "cornell.edu",
  brown: "brown.edu",
  "brown university": "brown.edu",
  dartmouth: "dartmouth.edu",
  "dartmouth college": "dartmouth.edu",
  berkeley: "berkeley.edu",
  "uc berkeley": "berkeley.edu",
  "university of california, berkeley": "berkeley.edu",
  "university of california berkeley": "berkeley.edu",
  ucla: "ucla.edu",
  "university of california, los angeles": "ucla.edu",
  cmu: "cmu.edu",
  "carnegie mellon": "cmu.edu",
  "carnegie mellon university": "cmu.edu",
  caltech: "caltech.edu",
  "california institute of technology": "caltech.edu",
  nyu: "nyu.edu",
  "new york university": "nyu.edu",
  "university of michigan": "umich.edu",
  "university of texas": "utexas.edu",
  "ut austin": "utexas.edu",
  "georgia tech": "gatech.edu",
  "georgia institute of technology": "gatech.edu",
  "university of washington": "uw.edu",
  "university of toronto": "utoronto.ca",
  waterloo: "uwaterloo.ca",
  "university of waterloo": "uwaterloo.ca",
  oxford: "ox.ac.uk",
  "university of oxford": "ox.ac.uk",
  cambridge: "cam.ac.uk",
  "university of cambridge": "cam.ac.uk",
};

function normalizeOrgKey(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function domainFromEmail(email: string | null | undefined): string | null {
  if (!email?.includes("@")) return null;
  const domain = email.split("@")[1]?.toLowerCase().trim();
  if (!domain || PERSONAL_EMAIL_DOMAINS.has(domain)) return null;
  return domain;
}

export function domainFromWebsite(
  website: string | null | undefined
): string | null {
  if (!website?.trim()) return null;
  try {
    const raw = website.trim();
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./i, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

export function domainFromCompanyName(
  company: string | null | undefined
): string | null {
  if (!company?.trim()) return null;
  const key = normalizeOrgKey(company);
  return COMPANY_DOMAINS[key] ?? null;
}

export function domainFromSchoolName(
  school: string | null | undefined
): string | null {
  if (!school?.trim()) return null;
  const key = normalizeOrgKey(school);
  if (SCHOOL_DOMAINS[key]) return SCHOOL_DOMAINS[key];

  // "Something University" → try something.edu when it looks like a US school name
  if (/\buniversity\b|\bcollege\b|\binstitute\b/i.test(key)) {
    const slug = key
      .replace(/\b(the|university|of|college|institute|at)\b/g, " ")
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9]/g, "");
    if (slug.length >= 3 && slug.length <= 24) {
      return `${slug}.edu`;
    }
  }
  return null;
}

/** Public favicon URL for a domain (no API key). */
export function orgLogoUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

export function resolveCompanyDomain(input: {
  company?: string | null;
  email?: string | null;
  website?: string | null;
}): string | null {
  return (
    domainFromCompanyName(input.company) ||
    domainFromEmail(input.email) ||
    domainFromWebsite(input.website)
  );
}

export function resolveSchoolDomain(school: string | null | undefined): string | null {
  return domainFromSchoolName(school);
}
