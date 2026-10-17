// Must stay first: strips DATABASE_URL / provider keys before any DB-importing module loads.
import "../../scripts/smoke/_env";
/**
 * Characterization of every copy of the identity helpers (plan P0.4, audit A6/B7).
 *
 * One input table per helper family is run against EVERY copy and each copy's CURRENT
 * answer is recorded. The `DISAGREEMENTS` blocks pin where copies differ so plan step P4.3
 * can flip them deliberately. Where a copy is private (not exported) its body is copied
 * VERBATIM below and labelled; those copies MUST be updated by hand if the source changes
 * (or deleted when P4.3 removes the copy).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLinkedInProfileUrl as isLinkedInProfileUrlContactInput } from "@/lib/contact-input";
import { linkedinSlug } from "@/lib/duplicates";
import { normalizeEmail as normalizeEmailRecruiters, normalizeLinkedinUrl } from "@/lib/recruiters";
import { normalizeEmail as normalizeEmailActivity } from "@/lib/email-activity";
import { canonicalLinkedInUrl } from "@/lib/linkedin-paste";
import { buildLinkedInUrl, isDemoProspect as isDemoProspectChannels } from "@/lib/outreach-channels";
import { isDemoProspect as isDemoProspectQuality } from "@/lib/outreach-quality";
import { isUuid as isUuidIds } from "@/lib/ids";
import { isUuid as isUuidChatSend } from "@/lib/chat-send";
import { isUuid as isUuidMeeting } from "@/lib/meeting-sessions";
import { escapeLike as escapeLikeRank } from "@/lib/contact-search-rank";

/* ----------------------------- verbatim private copies (UPDATE IF SOURCE CHANGES) ----- */

/** private copy at actions/contacts.ts:1236 — body copied verbatim. */
function isLinkedInProfileUrlActionsContacts(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    return host === "linkedin.com" && /\/in\//i.test(url.pathname);
  } catch {
    return /linkedin\.com\/in\//i.test(trimmed);
  }
}

/** private copy at lib/contact-avatar-connectors.ts:29 — body copied verbatim. */
function normalizeEmailAvatarConnectors(email: string): string {
  return email.trim().toLowerCase();
}

/** private copy at lib/hybrid-search.ts:104 (escapeLikeValue) — body copied verbatim. */
function escapeLikeHybridSearch(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** private copy at lib/extension/resolve.ts:54 — body copied verbatim. */
function escapeLikeExtensionResolve(value: string) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** private copy at lib/reminders-page-query.ts:82 — body copied verbatim. */
function escapeLikeRemindersPage(q: string) {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** private copy at app/api/track/route.ts:216 — body copied verbatim. */
const isUuidTrackRoute = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/* ------------------------------------------------------------------ LinkedIn URLs ----- */

type UrlRow = {
  input: string;
  /** contact-input.ts:66 (exported): any *.linkedin.com host, any path. */
  contactInput: boolean;
  /** actions/contacts.ts:1236 (private): linkedin.com or www. only, path must contain /in/. */
  actionsContacts: boolean;
  /** duplicates.ts linkedinSlug */
  slug: string;
  /** recruiters.ts normalizeLinkedinUrl */
  recruiters: string | null;
  /** outreach-channels.ts buildLinkedInUrl (only run on non-blank input) */
  build: string | null;
};

const L = "https://www.linkedin.com";
const URL_TABLE: UrlRow[] = [
  { input: "https://www.linkedin.com/in/jane-doe", contactInput: true, actionsContacts: true, slug: "jane-doe", recruiters: `${L}/in/jane-doe`, build: `${L}/in/jane-doe` },
  { input: "https://www.linkedin.com/in/Jane-Doe/", contactInput: true, actionsContacts: true, slug: "jane-doe", recruiters: `${L}/in/jane-doe`, build: `${L}/in/Jane-Doe/` },
  { input: "  linkedin.com/in/jane-doe  ", contactInput: true, actionsContacts: true, slug: "jane-doe  ", recruiters: `${L}/in/jane-doe`, build: `${L}/in/linkedin.com/in/jane-doe` },
  { input: "LINKEDIN.COM/IN/Jane", contactInput: true, actionsContacts: true, slug: "jane", recruiters: `${L}/in/jane`, build: `${L}/in/LINKEDIN.COM/IN/Jane` },
  { input: "https://uk.linkedin.com/in/jane-doe", contactInput: true, actionsContacts: false, slug: "jane-doe", recruiters: `${L}/in/jane-doe`, build: "https://uk.linkedin.com/in/jane-doe" },
  { input: "www.linkedin.com/in/jane", contactInput: true, actionsContacts: true, slug: "jane", recruiters: `${L}/in/jane`, build: `${L}/in/www.linkedin.com/in/jane` },
  { input: "https://www.linkedin.com/in/jane/?trk=x#frag", contactInput: true, actionsContacts: true, slug: "jane", recruiters: `${L}/in/jane`, build: `${L}/in/jane/?trk=x#frag` },
  { input: "https://www.linkedin.com/in/jane?utm=1", contactInput: true, actionsContacts: true, slug: "jane", recruiters: `${L}/in/jane`, build: `${L}/in/jane?utm=1` },
  { input: "https://www.linkedin.com/company/acme", contactInput: true, actionsContacts: false, slug: `${L}/company/acme`, recruiters: `${L}/company/acme`, build: `${L}/company/acme` },
  { input: "https://www.linkedin.com/", contactInput: true, actionsContacts: false, slug: `${L}/`, recruiters: L, build: `${L}/` },
  { input: "https://www.linkedin.com/in/", contactInput: true, actionsContacts: true, slug: `${L}/in/`, recruiters: `${L}/in`, build: `${L}/in/` },
  { input: "https://www.linkedin.com/pub/jane/1/2/3", contactInput: true, actionsContacts: false, slug: `${L}/pub/jane/1/2/3`, recruiters: `${L}/pub/jane/1/2/3`, build: `${L}/pub/jane/1/2/3` },
  { input: "http://linkedin.com/in/jane", contactInput: true, actionsContacts: true, slug: "jane", recruiters: `${L}/in/jane`, build: "http://linkedin.com/in/jane" },
  { input: "https://example.com/in/jane", contactInput: false, actionsContacts: false, slug: "https://example.com/in/jane", recruiters: `${L}/in/jane`, build: "https://example.com/in/jane" },
  { input: "https://evil.com/linkedin.com/in/jane", contactInput: false, actionsContacts: false, slug: "jane", recruiters: `${L}/linkedin.com/in/jane`, build: "https://evil.com/linkedin.com/in/jane" },
  { input: "notlinkedin.com/in/jane", contactInput: false, actionsContacts: false, slug: "jane", recruiters: `${L}/in/jane`, build: `${L}/in/notlinkedin.com/in/jane` },
  { input: "https://linkedin.com.evil.com/in/jane", contactInput: false, actionsContacts: false, slug: "https://linkedin.com.evil.com/in/jane", recruiters: `${L}/in/jane`, build: "https://linkedin.com.evil.com/in/jane" },
  { input: "ftp://linkedin.com/in/x", contactInput: false, actionsContacts: false, slug: "x", recruiters: `${L}//linkedin.com/in/x`, build: `${L}/in/ftp://linkedin.com/in/x` },
  { input: "jane-doe", contactInput: false, actionsContacts: false, slug: "jane-doe", recruiters: L, build: `${L}/in/jane-doe` },
  { input: "/in/jane", contactInput: false, actionsContacts: false, slug: "/in/jane", recruiters: `${L}/jane`, build: `${L}/in/in/jane` },
  { input: "", contactInput: false, actionsContacts: false, slug: "", recruiters: null, build: null },
  { input: "   ", contactInput: false, actionsContacts: false, slug: "", recruiters: null, build: null },
];

describe("isLinkedInProfileUrl: every copy against one input table", () => {
  for (const row of URL_TABLE) {
    it(`contact-input.ts / actions/contacts.ts copy: ${JSON.stringify(row.input)}`, () => {
      assert.equal(isLinkedInProfileUrlContactInput(row.input), row.contactInput, "lib/contact-input.ts:66");
      assert.equal(isLinkedInProfileUrlActionsContacts(row.input), row.actionsContacts, "private copy at actions/contacts.ts:1236");
    });
  }
});

describe("LinkedIn slug / normalizer / builder copies: one input table", () => {
  for (const row of URL_TABLE) {
    it(`slug + normalize + build: ${JSON.stringify(row.input)}`, () => {
      assert.equal(linkedinSlug(row.input), row.slug, "duplicates.ts linkedinSlug");
      assert.equal(normalizeLinkedinUrl(row.input), row.recruiters, "recruiters.ts normalizeLinkedinUrl");
      if (row.build !== null) assert.equal(buildLinkedInUrl(row.input), row.build, "outreach-channels.ts buildLinkedInUrl");
    });
  }

  it("null / undefined", () => {
    assert.equal(linkedinSlug(null), "");
    assert.equal(linkedinSlug(undefined), "");
    assert.equal(normalizeLinkedinUrl(null), null);
    assert.equal(normalizeLinkedinUrl(undefined), null);
  });

  it("canonicalLinkedInUrl (linkedin-paste.ts) just prefixes the slug: no trim, no lowercase, no encoding", () => {
    assert.equal(canonicalLinkedInUrl("jane"), `${L}/in/jane`);
    assert.equal(canonicalLinkedInUrl("Jane-Doe"), `${L}/in/Jane-Doe`);
    assert.equal(canonicalLinkedInUrl("a b"), `${L}/in/a b`);
    assert.equal(canonicalLinkedInUrl("José"), `${L}/in/José`);
  });
});

describe("DISAGREEMENTS (LinkedIn): P4.3 flips these", () => {
  it("[P4.3] regional host: contact-input accepts uk.linkedin.com, actions/contacts copy rejects it", () => {
    const u = "https://uk.linkedin.com/in/jane-doe";
    assert.equal(isLinkedInProfileUrlContactInput(u), true);
    assert.equal(isLinkedInProfileUrlActionsContacts(u), false);
  });

  it("[P4.3] non-profile paths: contact-input accepts /company/ and the bare host, the other copy requires /in/", () => {
    for (const u of ["https://www.linkedin.com/company/acme", "https://www.linkedin.com/"]) {
      assert.equal(isLinkedInProfileUrlContactInput(u), true, u);
      assert.equal(isLinkedInProfileUrlActionsContacts(u), false, u);
    }
  });

  it("[P4.3] the same profile URL yields four different 'canonical' spellings", () => {
    const u = "https://uk.linkedin.com/in/Jane-Doe/?trk=1";
    assert.equal(linkedinSlug(u), "jane-doe"); // slug, lowercased
    assert.equal(normalizeLinkedinUrl(u), `${L}/in/jane-doe`); // www host, lowercased path, no query
    assert.equal(buildLinkedInUrl(u), u); // passes through untouched when it starts with http
    assert.equal(canonicalLinkedInUrl("Jane-Doe"), `${L}/in/Jane-Doe`); // keeps case
  });

  it("[P4.3] normalizeLinkedinUrl rewrites ANY host to www.linkedin.com; linkedinSlug keeps a non-LinkedIn URL whole", () => {
    assert.equal(normalizeLinkedinUrl("https://example.com/in/jane"), `${L}/in/jane`);
    assert.equal(linkedinSlug("https://example.com/in/jane"), "https://example.com/in/jane");
  });

  it("[P4.3] a bare slug: buildLinkedInUrl makes a profile URL, normalizeLinkedinUrl drops it to the bare host", () => {
    assert.equal(buildLinkedInUrl("jane-doe"), `${L}/in/jane-doe`);
    assert.equal(normalizeLinkedinUrl("jane-doe"), L);
  });

  it("[P4.3] linkedinSlug does not trim a slug that has trailing whitespace; the others do", () => {
    assert.equal(linkedinSlug("  linkedin.com/in/jane-doe  "), "jane-doe  ");
    assert.equal(normalizeLinkedinUrl("  linkedin.com/in/jane-doe  "), `${L}/in/jane-doe`);
  });

  it("[P4.3] a slug-less /in/ URL is a valid profile URL to one copy and has no slug in the other", () => {
    assert.equal(isLinkedInProfileUrlActionsContacts("https://www.linkedin.com/in/"), true);
    assert.equal(linkedinSlug("https://www.linkedin.com/in/"), `${L}/in/`);
  });
});

/* ------------------------------------------------------------------------- emails ----- */

type EmailRow = { input: string | null | undefined; activity: string | null; recruiters: string | null; avatar: string | null };
const EMAIL_TABLE: EmailRow[] = [
  { input: "jane@example.com", activity: "jane@example.com", recruiters: "jane@example.com", avatar: "jane@example.com" },
  { input: "Jane@Example.com", activity: "jane@example.com", recruiters: "jane@example.com", avatar: "jane@example.com" },
  { input: "JANE@EXAMPLE.COM", activity: "jane@example.com", recruiters: "jane@example.com", avatar: "jane@example.com" },
  { input: "  jane@example.com  ", activity: "jane@example.com", recruiters: "jane@example.com", avatar: "jane@example.com" },
  { input: "jane", activity: null, recruiters: "jane", avatar: "jane" },
  { input: "a@b", activity: "a@b", recruiters: "a@b", avatar: "a@b" },
  { input: "Jane Doe <jane@x.com>", activity: "jane doe <jane@x.com>", recruiters: "jane doe <jane@x.com>", avatar: "jane doe <jane@x.com>" },
  { input: "", activity: null, recruiters: null, avatar: "" },
  { input: "   ", activity: null, recruiters: null, avatar: "" },
  { input: null, activity: null, recruiters: null, avatar: null },
  { input: undefined, activity: null, recruiters: null, avatar: null },
];

describe("normalizeEmail: every copy against one input table", () => {
  for (const row of EMAIL_TABLE) {
    it(`${JSON.stringify(row.input)}`, () => {
      assert.equal(normalizeEmailActivity(row.input), row.activity, "lib/email-activity.ts:80");
      assert.equal(normalizeEmailRecruiters(row.input), row.recruiters, "lib/recruiters.ts:34");
      // The avatar copy takes a string only (null / undefined would throw); null rows are not run.
      if (typeof row.input === "string") {
        assert.equal(normalizeEmailAvatarConnectors(row.input), row.avatar, "private copy at lib/contact-avatar-connectors.ts:29");
      }
    });
  }

  it("avatar-connectors copy throws on null/undefined (the other two return null)", () => {
    assert.throws(() => normalizeEmailAvatarConnectors(null as unknown as string));
    assert.throws(() => normalizeEmailAvatarConnectors(undefined as unknown as string));
  });
});

describe("DISAGREEMENTS (email): P4.3 flips these", () => {
  it("[P4.3] no-@ string: email-activity says null, recruiters and avatar copies keep it", () => {
    assert.equal(normalizeEmailActivity("jane"), null);
    assert.equal(normalizeEmailRecruiters("jane"), "jane");
    assert.equal(normalizeEmailAvatarConnectors("jane"), "jane");
  });

  it("[P4.3] empty / blank: avatar copy returns '' where the other two return null", () => {
    assert.equal(normalizeEmailAvatarConnectors("   "), "");
    assert.equal(normalizeEmailActivity("   "), null);
    assert.equal(normalizeEmailRecruiters("   "), null);
  });
});

/* ------------------------------------------------------------------ isDemoProspect ----- */

describe("isDemoProspect: channels (prospect) vs quality (enrichment)", () => {
  // quality takes only the enrichment value; channels takes { externalId, enrichment }.
  const rows: Array<{ label: string; prospect: { externalId?: string | null; enrichment?: unknown }; channels: boolean; quality: boolean }> = [
    { label: "enrichment.demo === true", prospect: { enrichment: { demo: true } }, channels: true, quality: true },
    { label: "enrichment.demo === 'true' (string)", prospect: { enrichment: { demo: "true" } }, channels: false, quality: false },
    { label: "enrichment.demo === false", prospect: { enrichment: { demo: false } }, channels: false, quality: false },
    { label: "enrichment null", prospect: { enrichment: null }, channels: false, quality: false },
    { label: "enrichment undefined", prospect: {}, channels: false, quality: false },
    { label: "externalId demo-1", prospect: { externalId: "demo-1" }, channels: true, quality: false },
    { label: "externalId DEMO-1 (case-sensitive)", prospect: { externalId: "DEMO-1" }, channels: false, quality: false },
    { label: "externalId ' demo-1' (not trimmed)", prospect: { externalId: " demo-1" }, channels: false, quality: false },
    { label: "externalId real-1", prospect: { externalId: "real-1" }, channels: false, quality: false },
    { label: "externalId null", prospect: { externalId: null }, channels: false, quality: false },
    { label: "externalId demo-1 AND demo:false", prospect: { externalId: "demo-1", enrichment: { demo: false } }, channels: true, quality: false },
  ];
  for (const r of rows) {
    it(r.label, () => {
      assert.equal(isDemoProspectChannels(r.prospect), r.channels, "outreach-channels.ts:56");
      assert.equal(isDemoProspectQuality(r.prospect.enrichment), r.quality, "outreach-quality.ts:4");
    });
  }

  it("[P4.3] DISAGREEMENT: a demo- externalId is a demo prospect to channels but not to quality", () => {
    assert.equal(isDemoProspectChannels({ externalId: "demo-1" }), true);
    assert.equal(isDemoProspectQuality(undefined), false);
  });

  it("quality accepts a bare enrichment object only; non-objects are false", () => {
    for (const v of [true, "x", 0, [], null, undefined]) assert.equal(isDemoProspectQuality(v), false);
    assert.equal(isDemoProspectQuality({ demo: true }), true);
  });
});

/* ------------------------------------------------------------------------ escapeLike ---- */

describe("escapeLike: all copies agree", () => {
  const inputs = ["plain", "", "%", "_", "a_b%c", "50%_off\\x", "\\", "ünï%code"];
  const expected = ["plain", "", "\\%", "\\_", "a\\_b\\%c", "50\\%\\_off\\\\x", "\\\\", "ünï\\%code"];
  inputs.forEach((input, i) => {
    it(JSON.stringify(input), () => {
      assert.equal(escapeLikeRank(input), expected[i], "lib/contact-search-rank.ts:12");
      assert.equal(escapeLikeHybridSearch(input), expected[i], "private copy at lib/hybrid-search.ts:104");
      assert.equal(escapeLikeExtensionResolve(input), expected[i], "private copy at lib/extension/resolve.ts:54");
      assert.equal(escapeLikeRemindersPage(input), expected[i], "private copy at lib/reminders-page-query.ts:82");
    });
  });
});

/* -------------------------------------------------------------------------- isUuid ----- */

describe("isUuid: all copies agree on strings (and on non-strings)", () => {
  const GOOD = ["123e4567-e89b-12d3-a456-426614174000", "123E4567-E89B-12D3-A456-426614174000", "0192f3a0-7c1b-7000-8000-000000000000"];
  const BAD: unknown[] = [
    " 123e4567-e89b-12d3-a456-426614174000",
    "123e4567-e89b-12d3-a456-426614174000\n",
    "123e4567-e89b-12d3-a456-42661417400",
    "123e4567e89b12d3a456426614174000",
    "not-a-uuid",
    "",
    null,
    undefined,
    42,
  ];
  const copies: Array<[string, (v: unknown) => boolean]> = [
    ["lib/ids.ts:22", (v) => isUuidIds(v as string)],
    ["lib/chat-send.ts:17", (v) => isUuidChatSend(v)],
    ["lib/meeting-sessions.ts:869", (v) => isUuidMeeting(v as string)],
    ["private copy at app/api/track/route.ts:216", (v) => isUuidTrackRoute(v)],
  ];
  for (const [name, fn] of copies) {
    it(`${name}`, () => {
      for (const g of GOOD) assert.equal(fn(g), true, g);
      for (const b of BAD) assert.equal(fn(b), false, String(b));
    });
  }
});

/*
 * Not covered: daysBetween / addDays / startOfDay copies (keep-in-touch.ts, radar/score.ts,
 * chat-attention.ts, cadence-phrase.ts, relative-date.ts, ics.ts, opportunity-extract.ts,
 * chat-history-groups.ts, date-commitment-extract.ts) are all module-private with differing
 * signatures (Date/ms/string) — they must be exported (or consolidated) before they can be
 * characterized without copying bodies.
 */
