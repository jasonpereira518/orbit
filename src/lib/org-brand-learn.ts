/**
 * Learning the brand color of a company or school the curated table in `brand-colors.ts`
 * does not know, so a newly added organization is drawn in its own color everywhere — cards,
 * search, the constellation — instead of a tint hashed from its name.
 *
 * Where a color comes from, most trustworthy first:
 *
 *   1. The organization's official color on Wikidata (P6364 → the color item's P465 hex).
 *      Mostly schools: "Stanford" records cardinal, which no favicon states as plainly.
 *   2. The dominant color of its website icon. The website is a contact's work email domain
 *      or website field when two sources agree (or the website field alone), otherwise the
 *      official website Wikidata records (P856).
 *   3. Nothing: a row with `hex` null, so the name keeps its hashed tint and is not looked up
 *      again on every page load. Retried after `RETRY_NONE_AFTER_MS`.
 *
 * Results live in `org_brand_colors`, shared by every account (an organization's color is a
 * public fact). The app layout reads the viewer's learned colors in the same round trip that
 * finds what is still unknown, and learns a few of those after the response is sent — so a
 * company added now shows its color from the next page load on, whichever path added it
 * (a form, a capture, an import).
 *
 * Only ever sends an organization's name or domain to Wikidata and Google's favicon service —
 * never a contact's email address or any other personal detail.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { orgBrandColors } from "@/db/schema";
import {
  brandKey,
  lookupCuratedBrandByName,
  type BrandKind,
  type LearnedBrand,
} from "@/lib/brand-colors";
import { publicEmailDomain } from "@/lib/closeness-evidence";
import {
  KIND_DESCRIPTION,
  NOT_AN_ORG,
  claimValues,
  officialDomain,
  toDomain,
  wikidataClaims,
  wikidataSearch,
} from "@/lib/wikidata";

type Fetch = typeof fetch;

const USER_AGENT = "OrbitBot/1.0 (+https://orbit.app; organization brand colors)";
const FETCH_TIMEOUT_MS = 5_000;
/** How long a "found nothing" result stands before the organization is tried again. */
const RETRY_NONE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Organizations learned per page load, so the deferred work stays well inside a function's life. */
export const LEARN_PER_REQUEST = 4;
/** The most learned colors shipped with one page. Past this the rest keep their hashed tint. */
const MAX_LEARNED_PER_VIEWER = 2_000;

// -------------------------------------------------------------------------------------------
// Color extraction
// -------------------------------------------------------------------------------------------

function toHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function hsl(r: number, g: number, b: number) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  if (max === rr) h = ((gg - bb) / d) % 6;
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

const HUE_BINS = 24;

/**
 * The color an icon is "in": the most common saturated hue, averaged within its bin. Pixels
 * that are transparent, near-white or near-grey are ignored — they are the icon's canvas, not
 * its brand. A logo with no saturated color at all (a black wordmark) returns its dark ink, and
 * the surfaces grey it as they do any monochrome brand. Null when there is nothing to go on.
 */
export async function extractBrandHex(image: Buffer): Promise<string | null> {
  let data: Buffer;
  try {
    const sharp = (await import("sharp")).default;
    data = await sharp(image).resize(48, 48, { fit: "inside" }).ensureAlpha().raw().toBuffer();
  } catch {
    return null;
  }

  const bins = Array.from({ length: HUE_BINS }, () => ({ n: 0, r: 0, g: 0, b: 0 }));
  const ink = { n: 0, r: 0, g: 0, b: 0 };
  let opaque = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3]! < 200) continue;
    opaque += 1;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const { h, s, l } = hsl(r, g, b);
    if (s >= 0.3 && l >= 0.15 && l <= 0.85) {
      const bin = bins[Math.floor(h / (360 / HUE_BINS)) % HUE_BINS]!;
      bin.n += 1;
      bin.r += r;
      bin.g += g;
      bin.b += b;
    } else if (l < 0.2) {
      ink.n += 1;
      ink.r += r;
      ink.g += g;
      ink.b += b;
    }
  }
  if (!opaque) return null;

  const best = bins.reduce((a, b) => (b.n > a.n ? b : a));
  if (best.n >= Math.max(6, opaque * 0.05)) {
    return toHex(best.r / best.n, best.g / best.n, best.b / best.n);
  }
  if (ink.n >= opaque * 0.1) return toHex(ink.r / ink.n, ink.g / ink.n, ink.b / ink.n);
  return null;
}

// -------------------------------------------------------------------------------------------
// Sources
// -------------------------------------------------------------------------------------------

export { toDomain };

const WIKI = { userAgent: USER_AGENT, timeoutMs: FETCH_TIMEOUT_MS };

/**
 * A domain the logo route may hand Google's favicon service: exactly what `toDomain` makes
 * (lowercase host, a real TLD, so no IP literal, port, path or bare "localhost"), and not a
 * reserved or internal name.
 */
export function isLogoDomain(value: string): boolean {
  return (
    value.length <= 253 &&
    toDomain(value) === value &&
    !/\.(?:local|localhost|internal|intranet|lan|home|corp|arpa|test|invalid|example)$/.test(value)
  );
}

/** The dominant color of a domain's icon, via Google's favicon service. */
export async function iconColorForDomain(domain: string, fetchImpl: Fetch = fetch) {
  try {
    const res = await fetchImpl(
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`,
      { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    // An unknown domain comes back 404 with a generic globe, which must not count.
    if (!res.ok) return null;
    return extractBrandHex(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

/**
 * What Wikidata says about an organization by this exact name: its official color and its
 * official website. The search result must be named exactly this (label or alias), must not
 * be described as a person, place or work, and must be unambiguous — so "Acme" never
 * borrows a namesake's color.
 */
export async function wikidataOrg(
  name: string,
  kind: BrandKind,
  fetchImpl: Fetch = fetch
): Promise<{ hex: string | null; domain: string | null } | null> {
  const opts = { ...WIKI, fetch: fetchImpl };
  const search = await wikidataSearch(name, 7, opts);
  const want = brandKey(name);
  const named = (search ?? []).filter(
    (r) =>
      (brandKey(r.label) === want || brandKey(r.match?.text) === want) &&
      !NOT_AN_ORG.test(r.description ?? "")
  );
  // Prefer items described as the right kind of organization. Failing that, a single item by
  // this name is taken on trust — but several ("Figma" the editor, the action-figure brand, a
  // Finnish ratings board) is a guess, and a hashed tint beats someone else's color.
  const described = named.filter((r) => KIND_DESCRIPTION[kind].test(r.description ?? ""));
  const ids = (described.length ? described : named.length === 1 ? named : [])
    .map((r) => r.id)
    .slice(0, 3);
  if (!ids.length) return null;

  const entities = await wikidataClaims(ids, opts);

  for (const id of ids) {
    const claims = entities?.[id]?.claims;
    if (!claims) continue;
    const colorIds = claimValues(claims, "P6364")
      .map((v) => (v as { id?: string })?.id)
      .filter((v): v is string => Boolean(v))
      .slice(0, 4);

    let hex: string | null = null;
    if (colorIds.length) {
      const colors = await wikidataClaims(colorIds, opts);
      const hexes = colorIds
        .map((cid) => claimValues(colors?.[cid]?.claims, "P465")[0])
        .filter((v): v is string => typeof v === "string" && /^#?[0-9a-f]{6}$/i.test(v))
        .map((v) => `#${v.replace("#", "").toLowerCase()}`);
      // School colors are often "cardinal and white": take the first one with a hue.
      hex = hexes.find((h) => hsl(...rgbOf(h)).s >= 0.2 && hsl(...rgbOf(h)).l <= 0.9) ?? null;
    }
    const domain = officialDomain(claims);
    if (hex || domain) return { hex, domain };
  }
  return null;
}

function rgbOf(hex: string): [number, number, number] {
  const raw = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16)) as [number, number, number];
}

export type LearnedColor = {
  hex: string | null;
  domain: string | null;
  source: "wikidata_color" | "icon" | "none";
};

/** Learn one organization's color. Never throws; "none" when nothing trustworthy turned up. */
export async function learnOrgColor(
  name: string,
  kind: BrandKind,
  hintDomain: string | null,
  fetchImpl: Fetch = fetch
): Promise<LearnedColor> {
  if (hintDomain) {
    const hex = await iconColorForDomain(hintDomain, fetchImpl);
    if (hex) return { hex, domain: hintDomain, source: "icon" };
  }
  const wiki = await wikidataOrg(name, kind, fetchImpl);
  if (wiki?.hex) return { hex: wiki.hex, domain: wiki.domain ?? hintDomain, source: "wikidata_color" };
  if (wiki?.domain && wiki.domain !== hintDomain) {
    const hex = await iconColorForDomain(wiki.domain, fetchImpl);
    if (hex) return { hex, domain: wiki.domain, source: "icon" };
  }
  return { hex: null, domain: wiki?.domain ?? hintDomain, source: "none" };
}

// -------------------------------------------------------------------------------------------
// Per viewer
// -------------------------------------------------------------------------------------------

type OrgRow = {
  name: string;
  kind: BrandKind;
  name_key: string;
  hex: string | null;
  domain: string | null;
  resolved_at: string | Date | null;
  has_row: boolean;
};

type OrgBrandColors = {
  learned: LearnedBrand[];
  missing: Array<{ name: string; kind: BrandKind; nameKey: string }>;
};

export const EMPTY_ORG_BRAND_COLORS: OrgBrandColors = { learned: [], missing: [] };

/**
 * Per-instance copy per viewer. The (app) layout reads this on every full load and every
 * `router.refresh()`, and the read scans every contact's school (~120 ms of database time at
 * 25k contacts). Colors are cosmetic and change only when a learning pass stores one, which
 * forgets its viewer here; other instances catch up within the TTL.
 */
const BRAND_MEMO_TTL_MS = 5 * 60_000;
const BRAND_MEMO_MAX = 500;
const brandMemo = new Map<string, { at: number; value: OrgBrandColors }>();

/**
 * Sync peek of the brand memo. Caller: `(app)/layout.tsx` — memo hit stays on the critical
 * path; a miss returns null so first bytes are not blocked on the whole-network scan.
 * User: "Implement the plan as specified..."
 */
export function peekOrgBrandColors(userId: string): OrgBrandColors | null {
  const hit = brandMemo.get(userId);
  if (hit && Date.now() - hit.at < BRAND_MEMO_TTL_MS) return hit.value;
  return null;
}

/**
 * The viewer's companies and schools, each with what Orbit has learned about its color —
 * one statement. `learned` is what the page registers; `missing` is what is worth learning.
 */
export async function loadOrgBrandColors(userId: string): Promise<OrgBrandColors> {
  const hit = peekOrgBrandColors(userId);
  if (hit) return hit;
  const value = await readOrgBrandColors(userId);
  if (brandMemo.size >= BRAND_MEMO_MAX) brandMemo.delete(brandMemo.keys().next().value!);
  brandMemo.set(userId, { at: Date.now(), value });
  return value;
}

/** Drop the cached copy — one viewer's, or everyone's. For writers and tests. */
export function forgetOrgBrandColors(userId?: string): void {
  if (userId) brandMemo.delete(userId);
  else brandMemo.clear();
}

async function readOrgBrandColors(userId: string): Promise<OrgBrandColors> {
  const db = await getDb();
  const rows = rowsOf<OrgRow>(
    await db.execute(sql`
      WITH orgs AS (
        SELECT c.name AS name, 'company'::text AS kind, c.name_normalized AS name_key
          FROM companies c
         WHERE c.user_id = ${userId}
        UNION ALL
        SELECT min(regexp_replace(btrim(ct.school), '\\s+', ' ', 'g')), 'school'::text,
               lower(regexp_replace(btrim(ct.school), '\\s+', ' ', 'g'))
          FROM contacts ct
         WHERE ct.user_id = ${userId} AND btrim(coalesce(ct.school, '')) <> ''
         GROUP BY 3
      )
      SELECT o.name, o.kind, o.name_key, b.hex, b.domain, b.resolved_at, (b.name_key IS NOT NULL) AS has_row
        FROM orgs o
        LEFT JOIN org_brand_colors b ON b.name_key = o.name_key AND b.kind = o.kind
    `)
  );

  const learned: LearnedBrand[] = [];
  const missing: Array<{ name: string; kind: BrandKind; nameKey: string }> = [];
  const staleBefore = Date.now() - RETRY_NONE_AFTER_MS;
  for (const row of rows) {
    if (row.hex) {
      if (learned.length < MAX_LEARNED_PER_VIEWER) {
        const domain = toDomain(row.domain);
        learned.push({ name: row.name, kind: row.kind, hex: row.hex, ...(domain ? { domain } : {}) });
      }
      continue;
    }
    if (brandKey(row.name).length < 2) continue;
    if (lookupCuratedBrandByName(row.name, row.kind)) continue;
    const stale = row.resolved_at != null && new Date(row.resolved_at).getTime() < staleBefore;
    if (!row.has_row || stale) missing.push({ name: row.name, kind: row.kind, nameKey: row.name_key });
  }
  return { learned, missing };
}

/**
 * The website a company's contacts point at: a `website` field, or a work email domain that
 * at least two of them share (one address could be a personal domain). Only the domain ever
 * leaves this function.
 */
async function companyHintDomain(userId: string, nameKey: string): Promise<string | null> {
  const db = await getDb();
  const rows = rowsOf<{ email: string | null; website: string | null }>(
    await db.execute(sql`
      SELECT ct.email, ct.website
        FROM contacts ct
        JOIN companies c ON c.id = ct.company_id
       WHERE ct.user_id = ${userId} AND c.user_id = ${userId} AND c.name_normalized = ${nameKey}
       LIMIT 50
    `)
  );
  const websites = new Map<string, number>();
  const emails = new Map<string, number>();
  for (const row of rows) {
    const site = toDomain(row.website);
    if (site && !publicEmailDomain(site)) websites.set(site, (websites.get(site) ?? 0) + 1);
    const mail = toDomain(row.email);
    if (mail && !publicEmailDomain(mail)) emails.set(mail, (emails.get(mail) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  const site = top(websites);
  if (site) return site[0];
  const mail = top(emails);
  return mail && mail[1] >= 2 ? mail[0] : null;
}

/** Keys being learned in this process, so two overlapping page loads do not both fetch. */
const inFlight = new Set<string>();

/**
 * Learn and store colors for up to `limit` of the given organizations. Meant to run after
 * the response (`after()` in the app layout); never throws.
 */
export async function learnOrgBrandColors(
  userId: string,
  orgs: Array<{ name: string; kind: BrandKind; nameKey: string }>,
  opts: { limit?: number; fetch?: Fetch } = {}
): Promise<number> {
  const fetchImpl = opts.fetch ?? fetch;
  let stored = 0;
  const batch = orgs
    .filter((o) => !inFlight.has(`${o.kind}|${o.nameKey}`))
    .slice(0, opts.limit ?? LEARN_PER_REQUEST);
  for (const org of batch) {
    const flightKey = `${org.kind}|${org.nameKey}`;
    inFlight.add(flightKey);
    try {
      const hint = org.kind === "company" ? await companyHintDomain(userId, org.nameKey) : null;
      const color = await learnOrgColor(org.name, org.kind, hint, fetchImpl);
      const db = await getDb();
      await db
        .insert(orgBrandColors)
        .values({ nameKey: org.nameKey, kind: org.kind, name: org.name, ...color, resolvedAt: new Date() })
        .onConflictDoUpdate({
          target: [orgBrandColors.nameKey, orgBrandColors.kind],
          set: { name: org.name, ...color, resolvedAt: new Date() },
        });
      stored += 1;
    } catch (err) {
      console.warn("[org-brand-learn] could not learn a color", err instanceof Error ? err.message : err);
    } finally {
      inFlight.delete(flightKey);
    }
  }
  if (stored) forgetOrgBrandColors(userId);
  return stored;
}
