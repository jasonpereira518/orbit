import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, outreachCampaigns, outreachMessages, outreachProspects } from "@/db/schema";
import { findConfidentDuplicate, resolveOrCreateContact } from "@/lib/contact-resolve";
import { updateContactForUser, type ContactWriteOptions } from "@/lib/contact-writes";
import { linkedinSlug } from "@/lib/duplicates";
import { UserFacingError } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { isPlaceholderAddress } from "@/lib/outreach-quality";
import { MAX_CAMPAIGN_PEOPLE, type NewProspect, type ProspectEnrichment } from "@/lib/outreach-types";
import { loadResearchedPerson, MAX_EXCLUDED_NAMES, saveResearchedPersonForUser } from "@/lib/web-research";

/**
 * People on an outreach campaign: found on the web, typed in, or picked from a brief.
 *
 * `outreach_prospects` has no `user_id`; every read and write here proves ownership through
 * `outreach_campaigns.user_id`. The functions that act on one prospect return its
 * `campaignId`, so the Server Action can revalidate `/outreach/<campaign>` without a second read.
 */

const MAX_PER_CALL = 10;
const LINKEDIN_RE = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]{2,100}\/?$/;
const EMAIL_RE = /^[^\s@"<>():]+@[^\s@"<>():]+$/;
const BRIEF_KEY_RE = /^[0-9a-f]{64}$/;
/**
 * Messages that mean Orbit (or the person) already reached out. `opened` is a delivered
 * status on legacy rows; `unsure` means "may have sent".
 */
const CONTACTED = ["queued", "sent", "copied", "opened", "unsure"];
/** Messages that tie an email thread to the address it went to, or may have. */
const EMAILED = ["queued", "sent", "unsure"];

const CAMPAIGN_GONE = "That campaign isn’t yours or no longer exists";
const PERSON_GONE = "That person isn’t on your list or was removed";
const ALREADY_CONTACTED = "They’ve already been contacted, so they stay on the list";

/* ------------------------------------------------------------------ keys + shape ----- */

/**
 * `normalizeCompanyKey` for people: the same folding, but Unicode-aware. That one is ASCII-only
 * (warm paths rely on it), so "李明" and "王芳" both become "" and "José" becomes "jos". Here
 * accents are stripped and any letter or digit in any script is kept. ASCII input comes out
 * exactly as `normalizeCompanyKey` has it.
 */
function normalizePersonKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The name-and-company key two spellings of one person share, whatever else is known about them. */
export function prospectNameKey(p: { fullName: string; company: string | null }): string {
  return `name:${normalizePersonKey(p.fullName)}|${normalizePersonKey(p.company ?? "")}`;
}

/** `li:<slug>` when there is a LinkedIn `/in/` URL, else the name key. Unique per campaign. */
export function prospectExternalId(p: { fullName: string; company: string | null; linkedinUrl: string | null }): string {
  const slug = linkedinSlug(p.linkedinUrl);
  return slug ? `li:${slug}` : prospectNameKey(p);
}

function squash(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function cleanEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.length <= 254 && EMAIL_RE.test(email) && !isPlaceholderAddress(email) ? email : null;
}

function cleanLinkedin(value: unknown): string | null {
  const url = typeof value === "string" ? value.trim() : "";
  return LINKEDIN_RE.test(url) ? url : null;
}

function cleanPageUrl(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 2000) return null;
  try {
    const { protocol } = new URL(text);
    return protocol === "http:" || protocol === "https:" ? text : null;
  } catch {
    return null;
  }
}

/**
 * One person from a client or a model, made safe to store. Null when there is no usable name,
 * or nothing to tell them apart from the next person of that name (a company or a LinkedIn
 * URL) — the same rule as `/find`.
 */
export function normalizeNewProspect(input: unknown): NewProspect | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const fullName = squash(raw.fullName);
  if (fullName.length < 2 || fullName.length > 100) return null;

  const company = squash(raw.company).slice(0, 100).trim() || null;
  const linkedinUrl = cleanLinkedin(raw.linkedinUrl);
  if (!company && !linkedinUrl) return null;

  const key = typeof raw.researchKey === "string" ? raw.researchKey : "";
  return {
    fullName,
    title: squash(raw.title).slice(0, 120).trim() || null,
    company,
    email: cleanEmail(raw.email),
    linkedinUrl,
    location: squash(raw.location).slice(0, 100).trim() || null,
    origin: raw.origin === "find" || raw.origin === "brief" ? raw.origin : "manual",
    url: cleanPageUrl(raw.url),
    whyMatches: squash(raw.whyMatches).slice(0, 240).trim() || null,
    researchKey: BRIEF_KEY_RE.test(key) ? key : null,
  };
}

/* ------------------------------------------------------------------ ownership ----- */

async function requireOwnCampaign(userId: string, campaignId: string) {
  if (isUuid(campaignId)) {
    const db = await getDb();
    const row = await db.query.outreachCampaigns.findFirst({
      where: and(eq(outreachCampaigns.id, campaignId), eq(outreachCampaigns.userId, userId)),
      columns: { id: true },
    });
    if (row) return;
  }
  throw new UserFacingError(CAMPAIGN_GONE);
}

async function requireOwnProspect(userId: string, prospectId: string) {
  if (isUuid(prospectId)) {
    const db = await getDb();
    const [row] = await db
      .select({ prospect: outreachProspects })
      .from(outreachProspects)
      .innerJoin(outreachCampaigns, eq(outreachCampaigns.id, outreachProspects.campaignId))
      .where(and(eq(outreachProspects.id, prospectId), eq(outreachCampaigns.userId, userId)))
      .limit(1);
    if (row) return row.prospect;
  }
  throw new UserFacingError(PERSON_GONE);
}

async function hasMessage(prospectId: string, statuses: string[], channel?: string) {
  const db = await getDb();
  const [row] = await db
    .select({ id: outreachMessages.id })
    .from(outreachMessages)
    .where(
      and(
        eq(outreachMessages.prospectId, prospectId),
        inArray(outreachMessages.status, statuses),
        channel ? eq(outreachMessages.channel, channel) : undefined
      )
    )
    .limit(1);
  return Boolean(row);
}

type CampaignRow = { id: string; externalId: string; fullName: string; company: string | null; status: string };

/** Everyone already on the campaign, findable by external id or by name+company. */
async function campaignIndex(campaignId: string) {
  const db = await getDb();
  const rows: CampaignRow[] = await db
    .select({
      id: outreachProspects.id,
      externalId: outreachProspects.externalId,
      fullName: outreachProspects.fullName,
      company: outreachProspects.company,
      status: outreachProspects.status,
    })
    .from(outreachProspects)
    .where(eq(outreachProspects.campaignId, campaignId));
  const byKey = new Map<string, CampaignRow>();
  for (const row of rows) {
    byKey.set(row.externalId, row);
    byKey.set(prospectNameKey(row), row);
  }
  return { rows, find: (p: NewProspect) => byKey.get(prospectExternalId(p)) ?? byKey.get(prospectNameKey(p)) };
}

function enrichmentOf(p: NewProspect, emailSource: ProspectEnrichment["emailSource"]): ProspectEnrichment {
  return { origin: p.origin, url: p.url, whyMatches: p.whyMatches, researchKey: p.researchKey, emailSource };
}

/* ------------------------------------------------------------------ add / skip / remove ----- */

/**
 * Add up to ten people to a campaign as `selected`. Someone already there (same LinkedIn
 * profile, or the same name at the same company) is counted, not doubled; an excluded one is
 * put back. A person Orbit already knows is linked to that contact and borrows its email.
 */
export async function addProspectsForUser(
  userId: string,
  campaignId: string,
  people: unknown[]
): Promise<{ added: number; alreadyThere: number; invalid: number }> {
  if (!Array.isArray(people) || people.length > MAX_PER_CALL) {
    throw new UserFacingError(`Add up to ${MAX_PER_CALL} people at a time`);
  }
  await requireOwnCampaign(userId, campaignId);

  let invalid = 0;
  const incoming: NewProspect[] = [];
  for (const raw of people) {
    const p = normalizeNewProspect(raw);
    if (p) incoming.push(p);
    else invalid += 1;
  }

  const { rows, find } = await campaignIndex(campaignId);
  const fresh: NewProspect[] = [];
  const revive = new Set<string>();
  const seen = new Set<string>();
  let alreadyThere = 0;
  for (const p of incoming) {
    const keys = [prospectExternalId(p), prospectNameKey(p)];
    const row = find(p);
    if (row || keys.some((k) => seen.has(k))) {
      alreadyThere += 1;
      if (row?.status === "excluded") revive.add(row.id);
    } else {
      keys.forEach((k) => seen.add(k));
      fresh.push(p);
    }
  }

  const selected = rows.filter((r) => r.status === "selected").length;
  if (fresh.length + revive.size && selected + fresh.length + revive.size > MAX_CAMPAIGN_PEOPLE) {
    throw new UserFacingError(`A campaign holds up to ${MAX_CAMPAIGN_PEOPLE} people`);
  }

  const db = await getDb();
  if (revive.size) {
    await db
      .update(outreachProspects)
      .set({ status: "selected", updatedAt: new Date() })
      .where(
        and(
          eq(outreachProspects.campaignId, campaignId),
          eq(outreachProspects.status, "excluded"),
          inArray(outreachProspects.id, [...revive])
        )
      );
  }
  if (!fresh.length) return { added: 0, alreadyThere, invalid };

  const duplicates = await Promise.all(
    fresh.map((p) =>
      findConfidentDuplicate(userId, {
        fullName: p.fullName,
        company: p.company ?? undefined,
        email: p.email ?? undefined,
        linkedinUrl: p.linkedinUrl ?? undefined,
      })
    )
  );

  // One multi-row insert, as `searchProspectsCore` does. A microsecond per slot keeps the
  // order they were given in; DO NOTHING covers a concurrent add of the same person.
  const inserted = await db
    .insert(outreachProspects)
    .values(
      fresh.map((p, i) => {
        const contact = duplicates[i]?.contact;
        const contactEmail = p.email ? null : cleanEmail(contact?.email);
        return {
          campaignId,
          externalId: prospectExternalId(p),
          contactId: contact?.id ?? null,
          fullName: p.fullName,
          title: p.title,
          company: p.company,
          email: p.email ?? contactEmail,
          linkedinUrl: p.linkedinUrl,
          location: p.location,
          enrichment: enrichmentOf(p, p.email ? "user" : contactEmail ? "contact" : null),
          status: "selected",
          createdAt: sql`now() + ${i}::integer * interval '1 microsecond'`,
        };
      })
    )
    .onConflictDoNothing({ target: [outreachProspects.campaignId, outreachProspects.externalId] })
    // Bare `.returning()`: an explicit field selector defeats the overload on the driver union.
    .returning();

  return { added: inserted.length, alreadyThere: alreadyThere + fresh.length - inserted.length, invalid };
}

/** Remember a candidate the user passed on as `excluded`, so "Find more" won't offer them again. */
export async function skipCandidateForUser(userId: string, campaignId: string, person: unknown): Promise<void> {
  await requireOwnCampaign(userId, campaignId);
  const p = normalizeNewProspect(person);
  if (!p) throw new UserFacingError("That person doesn’t look right");

  const db = await getDb();
  const row = (await campaignIndex(campaignId)).find(p);
  if (row) {
    if (await hasMessage(row.id, CONTACTED)) throw new UserFacingError(ALREADY_CONTACTED);
    await db.update(outreachProspects).set({ status: "excluded", updatedAt: new Date() }).where(eq(outreachProspects.id, row.id));
    return;
  }
  await db
    .insert(outreachProspects)
    .values({
      campaignId,
      externalId: prospectExternalId(p),
      fullName: p.fullName,
      title: p.title,
      company: p.company,
      email: p.email,
      linkedinUrl: p.linkedinUrl,
      location: p.location,
      enrichment: enrichmentOf(p, p.email ? "user" : null),
      status: "excluded",
    })
    .onConflictDoNothing({ target: [outreachProspects.campaignId, outreachProspects.externalId] });
}

/** Take someone off the list (`excluded`, so Find more won't bring them back). Returns their campaign. */
export async function removeProspectForUser(userId: string, prospectId: string): Promise<string> {
  const prospect = await requireOwnProspect(userId, prospectId);
  if (await hasMessage(prospect.id, CONTACTED)) throw new UserFacingError(ALREADY_CONTACTED);
  const db = await getDb();
  await db.update(outreachProspects).set({ status: "excluded", updatedAt: new Date() }).where(eq(outreachProspects.id, prospect.id));
  return prospect.campaignId;
}

/** Everyone the campaign has ever listed, newest first, for "Find more" to skip. */
export async function campaignKnownNamesForUser(userId: string, campaignId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ fullName: outreachProspects.fullName })
    .from(outreachProspects)
    .innerJoin(outreachCampaigns, eq(outreachCampaigns.id, outreachProspects.campaignId))
    .where(and(eq(outreachProspects.campaignId, campaignId), eq(outreachCampaigns.userId, userId)))
    .orderBy(desc(outreachProspects.updatedAt), desc(outreachProspects.createdAt))
    .limit(MAX_EXCLUDED_NAMES);
  return rows.map((r) => r.fullName);
}

/* ------------------------------------------------------------------ email + brief ----- */

/** Set, or with null clear, the address a person will be emailed at. Returns their campaign. */
export async function setProspectEmailForUser(userId: string, prospectId: string, email: string | null): Promise<string> {
  const prospect = await requireOwnProspect(userId, prospectId);
  const wanted = typeof email === "string" && email.trim() ? cleanEmail(email) : null;
  if (typeof email === "string" && email.trim() && !wanted) throw new UserFacingError("That address doesn’t look right");
  if (await hasMessage(prospect.id, EMAILED, "email")) {
    throw new UserFacingError("They’ve already been emailed, so the address stays");
  }
  const db = await getDb();
  await db
    .update(outreachProspects)
    .set({
      email: wanted,
      enrichment: { ...prospect.enrichment, emailSource: wanted ? "user" : null },
      updatedAt: new Date(),
    })
    .where(eq(outreachProspects.id, prospect.id));
  return prospect.campaignId;
}

/**
 * Tie a cached person brief to a prospect. A confident brief also fills in whatever the
 * prospect is missing (title, company, LinkedIn); it never overwrites. Returns their campaign.
 */
export async function attachBriefForUser(userId: string, prospectId: string, researchKey: string): Promise<string> {
  const prospect = await requireOwnProspect(userId, prospectId);
  const dossier = await loadResearchedPerson(userId, researchKey);
  if (!dossier) throw new UserFacingError("That brief has expired — research them again");

  const fill: { title?: string; company?: string; linkedinUrl?: string } = {};
  if (dossier.match === "confident") {
    const title = squash(dossier.current?.title).slice(0, 120).trim();
    const company = squash(dossier.current?.organization ?? dossier.subject.company).slice(0, 100).trim();
    const linkedinUrl = cleanLinkedin(dossier.subject.linkedinUrl);
    if (!prospect.title && title) fill.title = title;
    if (!prospect.company && company) fill.company = company;
    if (!prospect.linkedinUrl && linkedinUrl) fill.linkedinUrl = linkedinUrl;
  }
  const db = await getDb();
  await db
    .update(outreachProspects)
    .set({ ...fill, enrichment: { ...prospect.enrichment, researchKey }, updatedAt: new Date() })
    .where(eq(outreachProspects.id, prospect.id));
  return prospect.campaignId;
}

/* ------------------------------------------------------------------ contact at send time ----- */

/**
 * The contact behind a prospect, created if it doesn't exist yet. Called when a message is
 * about to go out, so a campaign never fills the address book with people nobody contacted.
 *
 * Someone Orbit already knows is used as is: only their blank email and LinkedIn URL are
 * filled in, never overwritten, and their source and history are left alone. Only a genuinely
 * new person is created, through a confident brief when there is one (the way "Save to Orbit"
 * does) and otherwise from the prospect's own details.
 */
export async function ensureProspectContactForUser(
  userId: string,
  prospectId: string,
  opts?: ContactWriteOptions
): Promise<string> {
  const prospect = await requireOwnProspect(userId, prospectId);
  const email = cleanEmail(prospect.email);
  const linkedinUrl = linkedinSlug(prospect.linkedinUrl) ? prospect.linkedinUrl : null;

  let contactId = prospect.contactId;
  if (!contactId) {
    contactId =
      (
        await findConfidentDuplicate(userId, {
          fullName: prospect.fullName,
          company: prospect.company ?? undefined,
          email: email ?? undefined,
          linkedinUrl: linkedinUrl ?? undefined,
        })
      )?.contact.id ?? null;
  }
  if (!contactId) {
    const key = (prospect.enrichment as ProspectEnrichment | null)?.researchKey;
    if (key && (await loadResearchedPerson(userId, key))?.match === "confident") {
      contactId = (await saveResearchedPersonForUser(userId, key, opts))?.contactId ?? null;
    }
  }
  if (!contactId) {
    ({ contactId } = await resolveOrCreateContact(
      userId,
      {
        fullName: prospect.fullName,
        company: prospect.company ?? undefined,
        title: prospect.title ?? undefined,
        location: prospect.location ?? undefined,
        email: email ?? undefined,
        linkedinUrl: linkedinUrl ?? undefined,
        source: "outreach",
      },
      { source: "outreach", ...opts }
    ));
  }

  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { email: true, linkedinUrl: true },
  });
  const blanks = {
    ...(email && !contact?.email ? { email } : {}),
    ...(linkedinUrl && !contact?.linkedinUrl ? { linkedinUrl } : {}),
  };
  if (contact && Object.keys(blanks).length) await updateContactForUser(userId, contactId, blanks, opts);
  if (contactId !== prospect.contactId) {
    await db.update(outreachProspects).set({ contactId, updatedAt: new Date() }).where(eq(outreachProspects.id, prospect.id));
  }
  return contactId;
}
