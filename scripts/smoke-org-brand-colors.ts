/**
 * Learned organization colors, end to end against PGlite with the network stubbed out.
 *
 * What this pins:
 *   - an icon's color is its dominant saturated hue; a black wordmark reads as its ink; a
 *     blank or undecodable image is no color at all
 *   - `lookupBrand` answers a learned name once registered, and the curated table still wins
 *   - Wikidata is only believed for an exact, unambiguous organization by that name
 *   - the layout's one query finds the viewer's unknown companies and schools, skips curated
 *     ones and other people's, and a learned color comes back on the next load
 *   - a "found nothing" result is stored and not retried on every page load
 *   - only a domain is ever sent out, never a contact's email address
 *
 * Run: npx tsx scripts/smoke-org-brand-colors.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import sharp from "sharp";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { companies, contacts, orgBrandColors } from "../src/db/schema";
import { lookupBrand, registerLearnedBrands } from "../src/lib/brand-colors";
import { companyBrandColor } from "../src/lib/company-brand";
import {
  extractBrandHex,
  learnOrgBrandColors,
  loadOrgBrandColors,
  toDomain,
  wikidataOrg,
} from "../src/lib/org-brand-learn";

const USER = "smoke-org-brand-user";
const OTHER = "smoke-org-brand-other";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** A 64px icon: a colored disc (or square) on a white or transparent canvas. */
async function icon(fill: string, background = "#ffffff") {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${background}"/><circle cx="32" cy="32" r="22" fill="${fill}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function hue(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return { r: r!, g: g!, b: b! };
}

async function main() {
  console.log("\nExtraction");
  const red = await extractBrandHex(await icon("#d62828"));
  check("a red logo on white reads as red", !!red && hue(red).r > 180 && hue(red).g < 80, String(red));
  const ink = await extractBrandHex(await icon("#111111"));
  check("a black wordmark reads as its ink", !!ink && hue(ink).r < 40, String(ink));
  check("a blank white icon is no color", (await extractBrandHex(await icon("#ffffff"))) === null);
  check("junk bytes are no color", (await extractBrandHex(Buffer.from("not an image"))) === null);

  console.log("\nDomains");
  check("a URL", toDomain("https://www.Acme.io/about?x=1") === "acme.io");
  check("an email keeps only its domain", toDomain("jane.doe@acme.io") === "acme.io");
  check("junk is refused", toDomain("not a url") === null && toDomain("") === null);

  console.log("\nRegistry");
  check("an unknown company has no brand", lookupBrand("Zyqorp Rockets", "company") === null);
  registerLearnedBrands([
    { name: "Zyqorp Rockets", kind: "company", hex: "#2a9d8f" },
    { name: "Stripe", kind: "company", hex: "#000000" },
    { name: "Bad Hex Co", kind: "company", hex: "red" },
  ]);
  check("a learned one does, by any casing", lookupBrand("zyqorp  ROCKETS", "company")?.hex === "#2a9d8f");
  check("  and the cards use it", companyBrandColor("Zyqorp Rockets") === "#2a9d8f", String(companyBrandColor("Zyqorp Rockets")));
  check("the curated table still wins", lookupBrand("Stripe", "company")?.hex !== "#000000");
  check("a malformed hex is ignored", lookupBrand("Bad Hex Co", "company") === null);

  console.log("\nWikidata");
  const sent: string[] = [];
  const fixtures: Record<string, unknown> = {
    "search:Zyqorp": { search: [{ id: "Q1", label: "Zyqorp", description: "American software company" }] },
    "search:Twofold": {
      search: [
        { id: "Q2", label: "Twofold", description: "online editor" },
        { id: "Q3", label: "Twofold", description: "brand of toys" },
      ],
    },
    "search:Smith": { search: [{ id: "Q4", label: "Smith", description: "family name" }] },
    "search:Gleeson University": {
      search: [{ id: "Q5", label: "Gleeson University", description: "private university in Ohio" }],
    },
    "ids:Q1": { entities: { Q1: { claims: { P856: [{ mainsnak: { datavalue: { value: "https://www.zyqorp.dev" } } }] } } } },
    "ids:Q5": {
      entities: {
        Q5: {
          claims: {
            P856: [{ mainsnak: { datavalue: { value: "https://gleeson.edu" } } }],
            P6364: [{ mainsnak: { datavalue: { value: { id: "Q90" } } } }, { mainsnak: { datavalue: { value: { id: "Q91" } } } }],
          },
        },
      },
    },
    "ids:Q90|Q91": {
      entities: {
        Q90: { claims: { P465: [{ mainsnak: { datavalue: { value: "FFFFFF" } } }] } },
        Q91: { claims: { P465: [{ mainsnak: { datavalue: { value: "7A0019" } } }] } },
      },
    },
  };
  const icons: Record<string, Buffer> = {
    "acme-hint.io": await icon("#1d4ed8"),
    "zyqorp.dev": await icon("#16a34a"),
  };
  const stubFetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    sent.push(url.toString());
    if (url.hostname === "www.google.com") {
      const buf = icons[url.searchParams.get("domain") ?? ""];
      return buf ? new Response(new Uint8Array(buf), { status: 200 }) : new Response("", { status: 404 });
    }
    const action = url.searchParams.get("action");
    const key = action === "wbsearchentities" ? `search:${url.searchParams.get("search")}` : `ids:${url.searchParams.get("ids")}`;
    const body = fixtures[key] ?? (action === "wbsearchentities" ? { search: [] } : { entities: {} });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  check("a single exact company gives its website", (await wikidataOrg("Zyqorp", "company", stubFetch))?.domain === "zyqorp.dev");
  check("two namesakes are a guess, and refused", (await wikidataOrg("Twofold", "company", stubFetch)) === null);
  check("a family name is not an organization", (await wikidataOrg("Smith", "company", stubFetch)) === null);
  const school = await wikidataOrg("Gleeson University", "school", stubFetch);
  check("a school's official color skips white for its hue", school?.hex === "#7a0019", JSON.stringify(school));

  console.log("\nPer viewer");
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(contacts).where(eq(contacts.userId, u));
    await db.delete(companies).where(eq(companies.userId, u));
  }
  await db.delete(orgBrandColors).where(inArray(orgBrandColors.nameKey, ["acme hint", "zyqorp", "google", "nowhere labs", "gleeson university", "secret co"]));

  const made = await db
    .insert(companies)
    .values([
      { userId: USER, name: "Acme Hint", nameNormalized: "acme hint" },
      { userId: USER, name: "Zyqorp", nameNormalized: "zyqorp" },
      { userId: USER, name: "Google", nameNormalized: "google" },
      { userId: USER, name: "Nowhere Labs", nameNormalized: "nowhere labs" },
      { userId: OTHER, name: "Secret Co", nameNormalized: "secret co" },
    ])
    .returning();
  const acme = made.find((c) => c.name === "Acme Hint")!;
  await db.insert(contacts).values([
    { userId: USER, fullName: "Ann One", company: "Acme Hint", companyId: acme.id, email: "ann@acme-hint.io" },
    { userId: USER, fullName: "Ben Two", company: "Acme Hint", companyId: acme.id, email: "ben@acme-hint.io" },
    { userId: USER, fullName: "Cat Three", school: "Gleeson  University" },
  ]);

  const first = await loadOrgBrandColors(USER);
  const missing = first.missing.map((m) => `${m.kind}:${m.nameKey}`).sort();
  check(
    "unknown companies and schools are found; curated and other people's are not",
    missing.join() === ["company:acme hint", "company:nowhere labs", "company:zyqorp", "school:gleeson university"].sort().join(),
    missing.join()
  );

  sent.length = 0;
  const stored = await learnOrgBrandColors(USER, first.missing, { limit: 10, fetch: stubFetch });
  check("each one is learned and stored", stored === 4, String(stored));
  check("nothing sent out carries an email address", sent.every((u) => !decodeURIComponent(u).includes("@")), sent.join("\n"));

  const rows = await db.select().from(orgBrandColors).where(inArray(orgBrandColors.nameKey, ["acme hint", "zyqorp", "nowhere labs", "gleeson university"]));
  const byKey = new Map(rows.map((r) => [r.nameKey, r]));
  check("a shared work email domain is the company's website", byKey.get("acme hint")?.domain === "acme-hint.io" && byKey.get("acme hint")?.source === "icon");
  check("  and its icon is its color", !!byKey.get("acme hint")?.hex && hue(byKey.get("acme hint")!.hex!).b > 150);
  check("Wikidata's website is used when the contacts have none", byKey.get("zyqorp")?.domain === "zyqorp.dev" && !!byKey.get("zyqorp")?.hex);
  check("a school takes its official color", byKey.get("gleeson university")?.hex === "#7a0019" && byKey.get("gleeson university")?.source === "wikidata_color");
  check("nothing found is still recorded", byKey.has("nowhere labs") && byKey.get("nowhere labs")?.hex === null);

  const second = await loadOrgBrandColors(USER);
  check("the next load carries the learned colors", second.learned.length === 3, JSON.stringify(second.learned));
  check("  and has nothing left to learn — a miss is not retried every load", second.missing.length === 0, JSON.stringify(second.missing));

  await db.update(orgBrandColors).set({ resolvedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) }).where(eq(orgBrandColors.nameKey, "nowhere labs"));
  check("a month-old miss is tried again", (await loadOrgBrandColors(USER)).missing.some((m) => m.nameKey === "nowhere labs"));
  check("another user sees only their own organizations", (await loadOrgBrandColors(OTHER)).missing.map((m) => m.nameKey).join() === "secret co");

  for (const u of [USER, OTHER]) {
    await db.delete(contacts).where(eq(contacts.userId, u));
    await db.delete(companies).where(eq(companies.userId, u));
  }
  console.log("\nsmoke-org-brand-colors: all checks passed");
}

run(main);
