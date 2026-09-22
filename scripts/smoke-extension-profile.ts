/**
 * Work history from the extension — every branch, with a scripted model.
 *
 *   - Identity first: someone else's LinkedIn is a conflict with ZERO model
 *     calls; a spoofed host fails closed; a confirmed mismatch writes but never
 *     rewrites the contact's own LinkedIn; a contact with none gets this one.
 *   - Only what the page says: an employer that isn't on the page is dropped,
 *     and a title that isn't is cleared.
 *   - Clamped, never rejected: a month of 13 or a year as a string costs that
 *     value, not the capture (the old wire schema 400'd).
 *   - Never lose what is stored: LinkedIn's shortened list or cut-off text
 *     that shows fewer roles than Orbit holds writes nothing ("partial"); a
 *     details page replaces its own section and keeps the rest.
 *   - Degrades, never throws, for AI reasons; tenancy; the snapshot carries it.
 *
 * Run: npx tsx scripts/smoke-extension-profile.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactExperiences, contactProfiles, contacts } from "../src/db/schema";
import { getContactProfile, saveContactProfile } from "../src/lib/contact-profile";
import { ContactNotFoundError } from "../src/lib/contact-writes";
import type { PageContext, ProfileCaptureRequest } from "../src/lib/extension/contract";
import {
  MAX_PROFILE_TEXT_CHARS,
  MAX_RAW_TEXT_CHARS,
  pageContextSchema,
  profileCaptureRequestSchema,
} from "../src/lib/extension/contract.schema";
import { ExtensionRouteError } from "../src/lib/extension/http";
import { captureContactProfile, type ProfileCaptureDeps } from "../src/lib/extension/profile-capture";
import { buildSnapshot } from "../src/lib/extension/resolve";

const USER = "smoke-ext-profile-user";
const OTHER = "smoke-ext-profile-other";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
    failures++;
  }
}

async function cleanup() {
  const db = await getDb();
  for (const user of [USER, OTHER]) {
    await db.delete(contactExperiences).where(eq(contactExperiences.userId, user));
    await db.delete(contactProfiles).where(eq(contactProfiles.userId, user));
    await db.delete(contacts).where(eq(contacts.userId, user));
  }
}

async function seed(userId: string, fullName: string, linkedinUrl: string | null) {
  const db = await getDb();
  const [row] = await db.insert(contacts).values({ userId, fullName, linkedinUrl }).returning();
  return row;
}

/** A scripted model: returns `answer` as JSON, and counts its calls. */
function model(answer: unknown) {
  const calls = { n: 0 };
  const deps: ProfileCaptureDeps = {
    canUseAi: async () => true,
    complete: async () => {
      calls.n++;
      if (answer instanceof Error) throw answer;
      return typeof answer === "string" ? answer : JSON.stringify(answer);
    },
  };
  return { deps, calls };
}

const role = (organization: string, title: string | null, over: Record<string, unknown> = {}) => ({
  kind: "role",
  organization,
  title,
  startYear: 2020,
  startMonth: 1,
  endYear: null,
  endMonth: null,
  isCurrent: false,
  ...over,
});
const school = (organization: string) => ({ kind: "education", organization, fieldOfStudy: null, startYear: 2012, endYear: 2016 });

function page(url: string, blob: string, over: Partial<PageContext> = {}): PageContext {
  return {
    schemaVersion: 1,
    site: "linkedin",
    adapterVersion: "smoke-1",
    kind: "person",
    url,
    sourceUrl: url,
    capturedAt: new Date().toISOString(),
    identity: {
      name: null, headline: null, title: null, company: null, location: null,
      school: null, email: null, handle: null, profileUrl: null, photoUrl: null,
    },
    text: { blob, truncated: false, charCount: blob.length, fromSelection: false },
    warnings: [],
    ...over,
  };
}

const request = (contactId: string, p: PageContext, confirmMismatch?: boolean): ProfileCaptureRequest => ({
  contactId,
  page: p,
  ...(confirmMismatch ? { confirmMismatch } : {}),
});

async function storedRoles(contactId: string) {
  const db = await getDb();
  return db.query.contactExperiences.findMany({
    where: and(eq(contactExperiences.userId, USER), eq(contactExperiences.contactId, contactId)),
    orderBy: (t, { asc }) => [asc(t.sortIndex)],
  });
}

/** Six stored roles and a school, as a previous full capture would leave them. */
async function seedCareer(contactId: string) {
  await saveContactProfile(USER, contactId, {
    source: "extension",
    sourceUrl: null,
    adapterVersion: "smoke-0",
    capturedAt: new Date("2026-01-01"),
    warnings: [],
    headline: "Old headline",
    about: "Stored about.",
    skills: [{ name: "Go" }, { name: "Rust" }, { name: "SQL" }],
    certifications: [],
    volunteering: [],
    publications: [],
    experiences: [
      ...["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"].map((org, i) => ({
        kind: "role" as const, organization: org, title: "Engineer", fieldOfStudy: null, location: null,
        description: null, startYear: 2010 + i, startMonth: null, endYear: 2011 + i, endMonth: null, isCurrent: false,
      })),
      {
        kind: "education" as const, organization: "State University", title: null, fieldOfStudy: "CS", location: null,
        description: null, startYear: 2006, startMonth: null, endYear: 2010, endMonth: null, isCurrent: false,
      },
    ],
  });
}

run(async () => {
  await cleanup();

  const PAGE_TEXT = [
    "Grace Hopper",
    "Rear Admiral · Computing pioneer",
    "Experience",
    "Staff Engineer",
    "Stripe · Full-time",
    "Jan 2021 - Present",
    "Software Engineer",
    "Acme Robotics",
    "2017 - 2020",
    "Education",
    "Yale University",
    "People also viewed",
  ].join("\n");

  console.log("identity comes first");
  {
    const grace = await seed(USER, "Grace Hopper", "https://www.linkedin.com/in/grace-hopper");
    const m = model({ experiences: [role("Stripe", "Staff Engineer")] });
    const res = await captureContactProfile(USER, request(grace.id, page("https://www.linkedin.com/in/ada-lovelace", PAGE_TEXT)), m.deps);
    check("someone else's LinkedIn is a conflict", res.status === "conflict", res);
    check("…naming both slugs and the contact", res.conflict?.pageSlug === "ada-lovelace" && res.conflict?.contactSlug === "grace-hopper" && res.conflict?.contactName === "Grace Hopper", res.conflict);
    check("…with zero model calls", m.calls.n === 0, m.calls.n);
    check("…and nothing written", (await storedRoles(grace.id)).length === 0);

    const spoof = await captureContactProfile(
      USER,
      request(grace.id, page("https://evil.example/?ref=linkedin.com/in/grace-hopper", PAGE_TEXT)),
      m.deps
    );
    check("a non-LinkedIn host fails closed, even carrying the slug", spoof.status === "conflict" && spoof.conflict?.pageSlug === "", spoof);

    const confirmed = await captureContactProfile(
      USER,
      request(grace.id, page("https://www.linkedin.com/in/ada-lovelace", PAGE_TEXT), true),
      m.deps
    );
    check("a confirmed mismatch writes", confirmed.status === "saved", confirmed);
    const db = await getDb();
    const after = await db.query.contacts.findFirst({ where: eq(contacts.id, grace.id) });
    check("…and never rewrites the contact's own LinkedIn", after?.linkedinUrl === "https://www.linkedin.com/in/grace-hopper", after?.linkedinUrl);

    const other = await seed(OTHER, "Not Yours", null);
    let notFound = false;
    try {
      await captureContactProfile(USER, request(other.id, page("https://www.linkedin.com/in/x", PAGE_TEXT)), m.deps);
    } catch (error) {
      notFound = error instanceof ContactNotFoundError;
    }
    check("another user's contact reads as not found", notFound);

    let refused = false;
    try {
      await captureContactProfile(USER, request(grace.id, page("https://x.com/grace", PAGE_TEXT, { site: "x" })), m.deps);
    } catch (error) {
      refused = error instanceof ExtensionRouteError;
    }
    check("a page that isn't a LinkedIn profile is refused", refused);
  }

  console.log("a contact with no LinkedIn gets this page's, and only what the page says is kept");
  {
    const ada = await seed(USER, "Ada Lovelace", null);
    const m = model({
      headline: "Computing pioneer",
      experiences: [
        role("Stripe", "Staff Engineer", { isCurrent: true, startYear: 2021 }),
        role("Acme Robotics", "Chief Wizard", { startYear: "2017", endYear: 2020, startMonth: 13 }),
        role("Invented Corp", "CEO"),
        { kind: "role", organization: "   " },
        "not an entry",
        school("Yale University"),
      ],
      skills: [{ name: "COBOL" }, { bad: true }],
    });
    const res = await captureContactProfile(
      USER,
      request(ada.id, page("https://www.linkedin.com/in/ada-lovelace", PAGE_TEXT)),
      m.deps
    );
    check("saved", res.status === "saved", res);
    check("an employer the page never names is dropped", res.dropped === 1, res.dropped);
    const rows = await storedRoles(ada.id);
    check("…and never stored", !rows.some((r) => r.organization === "Invented Corp"), rows.map((r) => r.organization));
    check("real roles and the school are stored", rows.length === 3, rows.map((r) => r.organization));
    const acme = rows.find((r) => r.organization === "Acme Robotics");
    check("a title the page never states is cleared, the role kept", acme !== undefined && acme.title === null, acme?.title);
    check("a year sent as a string is read", acme?.startYear === 2017, acme?.startYear);
    check("a month of 13 costs that month, not the capture", acme?.startMonth === null, acme?.startMonth);
    const db = await getDb();
    const after = await db.query.contacts.findFirst({ where: eq(contacts.id, ada.id) });
    check("the gap is filled with the canonical profile URL", after?.linkedinUrl === "https://www.linkedin.com/in/ada-lovelace", after?.linkedinUrl);
    check("the response carries what is now stored", res.workHistory?.roleCount === 2 && res.workHistory?.schoolCount === 1, res.workHistory);

    const snap = await buildSnapshot(USER, ada.id, []);
    check("the contact snapshot carries the work history", snap?.snapshot.workHistory?.roles[0]?.organization === "Stripe", snap?.snapshot.workHistory);
  }

  console.log("never lose what is stored");
  {
    const kim = await seed(USER, "Kim Nguyen", "https://www.linkedin.com/in/kim");
    await seedCareer(kim.id);
    const shortText = ["Kim Nguyen", "Experience", "Alpha", "Engineer", "Bravo", "Engineer", "Show all 6 experiences", "Education", "State University"].join("\n");
    const shortAnswer = { experiences: [role("Alpha", "Engineer"), role("Bravo", "Engineer"), school("State University")] };

    const m = model(shortAnswer);
    const res = await captureContactProfile(USER, request(kim.id, page("https://www.linkedin.com/in/kim", shortText)), m.deps);
    check("a shortened list showing fewer roles than stored is partial", res.status === "partial" && res.openSection === "experience", res);
    check("…and writes nothing", (await storedRoles(kim.id)).length === 7);

    const cut = page("https://www.linkedin.com/in/kim", shortText.replace("Show all 6 experiences", ""));
    cut.text.truncated = true;
    const truncated = await captureContactProfile(USER, request(kim.id, cut), model(shortAnswer).deps);
    check("cut-off text showing fewer roles than stored is partial", truncated.status === "partial", truncated);

    const detailsText = ["Experience", ...["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"].flatMap((o) => [o, "Engineer"])].join("\n");
    const details = await captureContactProfile(
      USER,
      request(kim.id, page("https://www.linkedin.com/in/kim", detailsText, { section: "experience", sourceUrl: "https://www.linkedin.com/in/kim/details/experience/" })),
      model({ experiences: ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"].map((o) => role(o, "Engineer")) }).deps
    );
    check("the details page saves the full list", details.status === "saved", details);
    const rows = await storedRoles(kim.id);
    check("…all seven roles", rows.filter((r) => r.kind === "role").length === 7, rows.length);
    check("…and the school it never showed is kept", rows.some((r) => r.kind === "education" && r.organization === "State University"));
    const profile = await getContactProfile(USER, kim.id);
    check("…and so is the prose it never showed", profile?.about === "Stored about." && profile?.headline === "Old headline", profile?.about);
    check("…and the skills", profile?.skills.length === 3, profile?.skills);

    const fresh = await seed(USER, "Lee Park", "https://www.linkedin.com/in/lee");
    const firstShort = await captureContactProfile(USER, request(fresh.id, page("https://www.linkedin.com/in/lee", shortText)), model(shortAnswer).deps);
    check("a shortened list with nothing stored is kept, and says so", firstShort.status === "saved" && firstShort.shortened?.includes("experience") === true, firstShort);
    const leeProfile = await getContactProfile(USER, fresh.id);
    check("…recorded as shortened on the profile", leeProfile?.warnings.includes("experience-shortened") === true, leeProfile?.warnings);

    const skillsUnion = await captureContactProfile(
      USER,
      request(kim.id, page("https://www.linkedin.com/in/kim", detailsText.replace("Experience", "Kim\nExperience"))),
      model({ experiences: ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"].map((o) => role(o, "Engineer")), skills: [{ name: "Go" }, { name: "Kotlin" }] }).deps
    );
    const kimAfter = await getContactProfile(USER, kim.id);
    check("a profile's top skills add to the stored list, never shrink it", skillsUnion.status === "saved" && kimAfter?.skills.length === 4, kimAfter?.skills);
  }

  console.log("degrades, never throws, for AI reasons");
  {
    const sam = await seed(USER, "Sam Rivera", "https://www.linkedin.com/in/sam");
    await seedCareer(sam.id);
    const url = "https://www.linkedin.com/in/sam";

    const m = model({ experiences: [] });
    const empty = await captureContactProfile(USER, request(sam.id, page(url, "")), m.deps);
    check("no text: degraded, no model call", empty.status === "degraded" && empty.degradedReason === "no_text" && m.calls.n === 0, empty);

    const noKey = await captureContactProfile(USER, request(sam.id, page(url, PAGE_TEXT)), { ...m.deps, canUseAi: async () => false });
    check("no key: degraded, no model call", noKey.degradedReason === "no_api_key" && m.calls.n === 0, noKey);

    const threw = await captureContactProfile(USER, request(sam.id, page(url, PAGE_TEXT)), model(new Error("timeout")).deps);
    check("a model failure is ai_error", threw.degradedReason === "ai_error", threw);

    const garbage = await captureContactProfile(USER, request(sam.id, page(url, PAGE_TEXT)), model("not json {").deps);
    check("unparseable output is ai_error", garbage.degradedReason === "ai_error", garbage);

    const nothing = await captureContactProfile(USER, request(sam.id, page(url, PAGE_TEXT)), model({ experiences: [role("Nowhere Inc", "CEO")] }).deps);
    check("nothing on the page: nothing_found", nothing.status === "degraded" && nothing.degradedReason === "nothing_found", nothing);
    check("…and the stored career survives all of it", (await storedRoles(sam.id)).length === 7);
  }

  console.log("the wire");
  {
    const big = "x".repeat(MAX_PROFILE_TEXT_CHARS + 500);
    const body = {
      contactId: "7f8b9a4e-2b1c-4d2e-9f3a-1b2c3d4e5f60",
      page: page("https://www.linkedin.com/in/kim", big),
    };
    const parsed = profileCaptureRequestSchema.parse(body);
    check("/profile keeps the whole profile's text", parsed.page.text.blob.length === MAX_PROFILE_TEXT_CHARS);
    check("…and marks it truncated when it had to cut", parsed.page.text.truncated === true);
    const light = pageContextSchema.parse(body.page);
    check("every other route still gets the light copy", light.text.blob.length === MAX_RAW_TEXT_CHARS);
    const section = pageContextSchema.safeParse({ ...body.page, section: "skills" });
    check("an unknown section is refused", !section.success);
  }

  await cleanup();
  if (failures > 0) {
    console.log(`\nsmoke-extension-profile: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nsmoke-extension-profile: all checks passed");
});
