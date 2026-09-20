/**
 * Contacts from a delta-token source, in bulk.
 *
 * `ingestEvents` is the same shape for interactions; this is its counterpart for address
 * books — Google People, Outlook People, iCloud CardDAV, a CRM's contact list. Uploaded
 * files keep going through the staged import engine, which owns resumability and per-row
 * poison isolation that a streamed sync does not need.
 *
 * It takes the same `IngestContext` rather than one of its own so a connector that syncs
 * both people and meetings builds the duplicate index once.
 *
 * Enrichment is fill-blanks-only, deliberately: a provider's stale title must never
 * overwrite what the user typed. `bulkMergeContactsForUser` already implements that rule.
 */
import {
  addToDuplicateIndex,
  findDuplicateCandidatesIndexed,
} from "@/lib/duplicates";
import {
  bulkMergeContactsForUser,
  createContactsBulkForUser,
  type ContactInput,
} from "@/lib/contact-writes";
import type { IngestContext } from "@/lib/ingest/events";

/** One person as a provider describes them. Every field but the name is optional. */
export type PersonRecord = {
  fullName: string;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  xHandle?: string | null;
  company?: string | null;
  title?: string | null;
  location?: string | null;
};

export type PeopleIngestStats = {
  seen: number;
  created: number;
  matched: number;
  /** Would have been created but for the plan's contact cap. */
  blockedByPlan: number;
};

function emptyStats(): PeopleIngestStats {
  return { seen: 0, created: 0, matched: 0, blockedByPlan: 0 };
}

/**
 * Identity key used to collapse duplicate person entries *within a single batch*.
 *
 * Same precedence as `participantIdentityKey` in `ingest/events.ts`. This is only about
 * "are these two rows the same person" within the rows just handed to `ingestPeople` —
 * cross-batch matching is the duplicate index's job.
 */
function personIdentityKey(p: PersonRecord): string | null {
  const linkedin = p.linkedinUrl?.trim().toLowerCase();
  if (linkedin) return `li:${linkedin}`;
  const email = p.email?.trim().toLowerCase();
  if (email) return `em:${email}`;
  const handle = p.xHandle?.trim().toLowerCase();
  if (handle) return `hd:${handle}`;
  const name = p.fullName?.trim().toLowerCase().replace(/\s+/g, " ");
  if (name) return `nm:${name}`;
  return null;
}

/** First-non-empty wins — enrichment fills blanks, matching `bulkMergeContactsForUser`'s COALESCE. */
function foldPersonInput(
  into: Partial<ContactInput>,
  extra: Partial<ContactInput>
): Partial<ContactInput> {
  return {
    ...into,
    email: into.email ?? extra.email,
    phone: into.phone ?? extra.phone,
    linkedinUrl: into.linkedinUrl ?? extra.linkedinUrl,
    xHandle: into.xHandle ?? extra.xHandle,
    company: into.company ?? extra.company,
    title: into.title ?? extra.title,
    location: into.location ?? extra.location,
  };
}

function toContactInput(person: PersonRecord, source: string): ContactInput {
  return {
    fullName: person.fullName.trim(),
    email: person.email?.trim() || undefined,
    phone: person.phone?.trim() || undefined,
    linkedinUrl: person.linkedinUrl?.trim() || undefined,
    xHandle: person.xHandle?.trim() || undefined,
    company: person.company?.trim() || undefined,
    title: person.title?.trim() || undefined,
    location: person.location?.trim() || undefined,
    source,
  };
}

/**
 * Match every record against the workspace, then write in two bulk statements.
 *
 * Costs two statements in the steady state regardless of batch size — the same budget
 * discipline `ingestEvents` keeps, and the reason a 5,000-contact address book does not melt
 * `neon-http`, where every round trip is a separate HTTP request.
 */
export async function ingestPeople(
  ctx: IngestContext,
  people: PersonRecord[]
): Promise<PeopleIngestStats> {
  const stats = emptyStats();
  if (people.length === 0) return stats;

  /**
   * Both accumulators are keyed, not appended to blindly — the same reason `ingestEvents`
   * keys its own. A batch routinely repeats one person (a CRM export listing someone twice,
   * or a person brand new to the network who appears under two rows). Without folding here:
   *
   *   - `bulkMergeContactsForUser` would receive two VALUES rows for the same contact id.
   *     Unlike the interactions upsert this module's sibling uses, that UPDATE...FROM has no
   *     ON CONFLICT to raise on it — Postgres just applies one of the two rows, arbitrarily.
   *   - A brand-new person appearing twice would be queued for creation twice, because the
   *     duplicate index cannot see this batch's own pending creates until after they are
   *     written — the in-batch case `findDuplicateCandidatesIndexed` alone cannot catch.
   */
  const toCreate: ContactInput[] = [];
  const createIndexByKey = new Map<string, number>();
  const mergeByContactId = new Map<string, Partial<ContactInput>>();

  for (const person of people) {
    const name = person.fullName?.trim();
    if (!name) continue;
    stats.seen++;

    const [best] = findDuplicateCandidatesIndexed(ctx.index, {
      fullName: name,
      email: person.email ?? null,
      linkedinUrl: person.linkedinUrl ?? null,
      xHandle: person.xHandle ?? null,
      company: person.company ?? null,
      title: person.title ?? null,
    });

    if (best && best.confidence >= ctx.options.matchConfidence) {
      ctx.touchedContactIds.add(best.contact.id);
      const input = toContactInput(person, ctx.options.source);
      const existing = mergeByContactId.get(best.contact.id);
      if (existing) {
        mergeByContactId.set(best.contact.id, foldPersonInput(existing, input));
      } else {
        stats.matched++;
        mergeByContactId.set(best.contact.id, input);
      }
      continue;
    }

    if (!ctx.options.createsContacts) continue;

    // Already queued to be created earlier in this same batch — fold in, do not re-create.
    const key = personIdentityKey(person);
    const pending = key === null ? undefined : createIndexByKey.get(key);
    if (pending !== undefined) {
      toCreate[pending] = foldPersonInput(
        toCreate[pending],
        toContactInput(person, ctx.options.source)
      ) as ContactInput;
      continue;
    }

    if (ctx.headroom !== null && ctx.headroom - toCreate.length <= 0) {
      stats.blockedByPlan++;
      continue;
    }
    const input = toContactInput(person, ctx.options.source);
    if (key !== null) createIndexByKey.set(key, toCreate.length);
    toCreate.push(input);
  }

  // 1 statement (plus the resolver's primed lookups, which are per-batch, not per-row).
  if (toCreate.length > 0) {
    const created = await createContactsBulkForUser(ctx.userId, toCreate, ctx.companyResolve, {
      skipRevalidate: true,
      skipEmbedding: true,
      skipSummary: true,
      skipCloseness: true,
      headroom: ctx.headroom,
    });
    stats.created = created.length;
    // Fewer created than asked for means the cap bit part-way through the batch.
    stats.blockedByPlan += toCreate.length - created.length;
    if (ctx.headroom !== null) ctx.headroom -= created.length;
    for (const contact of created) {
      ctx.touchedContactIds.add(contact.id);
      // Fold new contacts into the index so a LATER batch matches them rather than creating
      // the person again. Within this batch, `createIndexByKey` already did that job.
      addToDuplicateIndex(ctx.index, {
        id: contact.id,
        fullName: contact.fullName,
        email: contact.email,
        linkedinUrl: contact.linkedinUrl,
        xHandle: contact.xHandle,
        company: contact.company,
        title: contact.title,
      });
    }
  }

  // 1 statement.
  if (mergeByContactId.size > 0) {
    await bulkMergeContactsForUser(
      ctx.userId,
      [...mergeByContactId.entries()].map(([contactId, input]) => ({ contactId, input })),
      ctx.companyResolve
    );
  }

  return stats;
}
