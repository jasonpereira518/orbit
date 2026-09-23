/**
 * The leads pipeline's storage: save a target (deduplicated), list, change status, and turn
 * a lead into a contact. Every statement carries the owner's `user_id` in its WHERE.
 */
import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { leads, type Lead, type LeadSource, type LeadStatus } from "@/db/schema";
import { resolveOrCreateContact, type ResolveOptions } from "@/lib/contact-resolve";
import { UserFacingError } from "@/lib/errors";
import { normalizeLeadInput, type LeadInput, type NormalizedLead } from "./lead-identity";

/** A pipeline is a working list, not an archive: past this many, the oldest drop off the page. */
export const PIPELINE_LIMIT = 500;

export type SaveLeadInput = LeadInput & {
  source: Exclude<LeadSource, "crm">;
  apolloId?: string | null;
};

/** The columns a second save may fill when the first left them blank. */
const FILLABLE = [
  "email",
  "emailNormalized",
  "linkedinUrl",
  "linkedinSlug",
  "phone",
  "phoneE164",
  "companyName",
  "companyNormalized",
  "title",
] as const satisfies readonly (keyof NormalizedLead & keyof Lead)[];

async function findByApolloId(userId: string, apolloId: string): Promise<Lead | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.userId, userId), eq(leads.apolloId, apolloId)))
    .limit(1);
  return row ?? null;
}

async function findByIdentity(userId: string, lead: NormalizedLead): Promise<Lead | null> {
  const matches: SQL[] = [];
  if (lead.emailNormalized) matches.push(eq(leads.emailNormalized, lead.emailNormalized));
  if (lead.linkedinSlug) matches.push(eq(leads.linkedinSlug, lead.linkedinSlug));
  if (!matches.length) return null;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.userId, userId), or(...matches)))
    .orderBy(desc(leads.updatedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Save a target. The same person saved twice — by email, LinkedIn or Apollo id — is one lead:
 * the existing row keeps its values and only fills its blanks, and a dismissed lead saved
 * again is reopened.
 */
export async function saveLead(
  userId: string,
  input: SaveLeadInput
): Promise<{ lead: Lead; created: boolean }> {
  const normalized = normalizeLeadInput(input);
  if (!normalized.displayName) throw new UserFacingError("Add a name for this lead");
  const apolloId = input.apolloId?.trim() || null;
  const db = await getDb();

  const existing =
    (apolloId ? await findByApolloId(userId, apolloId) : null) ??
    (await findByIdentity(userId, normalized));
  if (existing) {
    const fill: Partial<NormalizedLead> = {};
    for (const key of FILLABLE) {
      if (existing[key] == null && normalized[key] != null) fill[key] = normalized[key];
    }
    const [updated] = await db
      .update(leads)
      .set({
        ...fill,
        ...(existing.apolloId == null && apolloId ? { apolloId } : {}),
        status: existing.status === "dismissed" ? "open" : existing.status,
        updatedAt: new Date(),
      })
      .where(and(eq(leads.id, existing.id), eq(leads.userId, userId)))
      .returning();
    return { lead: updated ?? existing, created: false };
  }

  try {
    const [created] = await db
      .insert(leads)
      .values({ userId, source: input.source, apolloId, ...normalized })
      .returning();
    return { lead: created, created: true };
  } catch (err) {
    // Two saves of the same Apollo person racing on `leads_user_apollo_uidx`: the winner's row is
    // the answer, the resolveCompany pattern.
    if (apolloId) {
      const raced = await findByApolloId(userId, apolloId);
      if (raced) return { lead: raced, created: false };
    }
    throw err;
  }
}

export async function listLeads(
  userId: string,
  opts: { statuses?: readonly LeadStatus[] } = {}
): Promise<Lead[]> {
  const db = await getDb();
  const where = opts.statuses?.length
    ? and(eq(leads.userId, userId), inArray(leads.status, [...opts.statuses]))
    : eq(leads.userId, userId);
  return db.select().from(leads).where(where).orderBy(desc(leads.updatedAt)).limit(PIPELINE_LIMIT);
}

export async function getLead(userId: string, leadId: string): Promise<Lead | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** False when the lead is not this user's. */
export async function setLeadStatus(userId: string, leadId: string, status: LeadStatus): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(leads)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(leads.id, leadId), eq(leads.userId, userId)))
    .returning();
  return rows.length > 0;
}

/**
 * "Add to contacts", through the resolver every other path uses: a lead who is already in the
 * network is matched rather than duplicated. The plan's contact cap applies and its
 * PaywallError propagates for the caller to turn into copy. Idempotent: a lead already linked
 * returns its contact.
 */
export async function convertLeadToContact(
  userId: string,
  leadId: string,
  options: ResolveOptions = {}
): Promise<{ contactId: string; outcome: "created" | "matched" | "merged" | "linked" }> {
  const lead = await getLead(userId, leadId);
  if (!lead) throw new UserFacingError("That lead isn’t yours to change");
  if (lead.contactId) return { contactId: lead.contactId, outcome: "linked" };

  const { contactId, outcome } = await resolveOrCreateContact(
    userId,
    {
      fullName: lead.displayName,
      email: lead.email ?? undefined,
      phone: lead.phone ?? undefined,
      linkedinUrl: lead.linkedinUrl ?? undefined,
      company: lead.companyName ?? undefined,
      title: lead.title ?? undefined,
      source: "leads",
    },
    options
  );
  const db = await getDb();
  await db
    .update(leads)
    .set({ contactId, status: "converted", updatedAt: new Date() })
    .where(and(eq(leads.id, lead.id), eq(leads.userId, userId)));
  return { contactId, outcome };
}
