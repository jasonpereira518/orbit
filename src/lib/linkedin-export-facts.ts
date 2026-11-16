/**
 * The kept LinkedIn export as a source for contacts it was not imported onto (contact-info
 * accuracy plan, PR 4): a person added later by hand, a capture, a calendar sync or an
 * address book, or a connection the user left unticked at import time, picks up their LinkedIn
 * URL, current company and role, and when you connected.
 *
 * Reads only `Connections.csv` from `import_files` (the whole export is a few hundred KB
 * gzipped; one file is a fraction of that), matches with the one matcher at the merge line,
 * and writes through `bulkMergeContactsForUser` as "linkedin_export" dated to the upload, so
 * the field rule decides: blanks fill, Orbit's guesses update, what the person typed holds.
 *
 * Only an export uploaded whole (folder or ZIP) is kept; a lone Connections.csv drop is
 * imported but not stored, so there is nothing here to read later.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, importFiles } from "@/db/schema";
import { bulkMergeContactsForUser, type ContactInput } from "@/lib/contact-writes";
import { createCompanyResolver } from "@/lib/companies";
import {
  DUPLICATE_MERGE_CONFIDENCE,
  buildDuplicateIndex,
  findDuplicateCandidatesIndexed,
  type DuplicateSubject,
} from "@/lib/duplicates";
import { parseConnectedOn, parseLinkedInConnectionsCsv, type LinkedInConnectionRow } from "@/lib/linkedin-connections";
import { gunzipExportFile } from "@/lib/linkedin-export-store";

/** Most contacts one pass looks at; the rest wait for the next import or upload. */
const MAX_CONTACTS = 5000;

async function storedConnections(userId: string) {
  const db = await getDb();
  const [file] = await db
    .select({ gz: importFiles.gz, createdAt: importFiles.createdAt })
    .from(importFiles)
    .where(
      and(
        eq(importFiles.userId, userId),
        sql`(lower(${importFiles.path}) = 'connections.csv' OR lower(${importFiles.path}) LIKE '%/connections.csv')`
      )
    )
    .orderBy(desc(importFiles.createdAt))
    .limit(1);
  if (!file) return null;
  try {
    return { rows: parseLinkedInConnectionsCsv(gunzipExportFile(file.gz)).rows, uploadedAt: file.createdAt };
  } catch {
    return null; // An unreadable file fills nothing; the import itself already reported it.
  }
}

/**
 * Fill contacts from the stored export. With `contactIds`, just those; without, every contact
 * that has no LinkedIn URL yet. Returns how many contacts a row was written onto.
 */
export async function fillFromStoredExport(userId: string, contactIds?: string[]): Promise<number> {
  if (contactIds && contactIds.length === 0) return 0;
  const stored = await storedConnections(userId);
  if (!stored?.rows.length) return 0;

  const subjects: DuplicateSubject[] = stored.rows.map((r, i) => ({
    id: String(i),
    fullName: `${r.firstName} ${r.lastName}`.trim(),
    email: r.email || null,
    linkedinUrl: r.url || null,
    xHandle: null,
    company: r.company || null,
    title: r.position || null,
  }));
  const index = buildDuplicateIndex(subjects);

  const db = await getDb();
  const people = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      email: contacts.email,
      linkedinUrl: contacts.linkedinUrl,
      company: contacts.company,
      title: contacts.title,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.userId, userId),
        contactIds
          ? inArray(contacts.id, contactIds.slice(0, MAX_CONTACTS))
          : or(isNull(contacts.linkedinUrl), eq(contacts.linkedinUrl, ""))
      )
    )
    .limit(MAX_CONTACTS);

  const merges: Array<{ contactId: string; input: Partial<ContactInput> }> = [];
  for (const person of people) {
    const [best, next] = findDuplicateCandidatesIndexed(index, person);
    if (!best || best.confidence < DUPLICATE_MERGE_CONFIDENCE) continue;
    // Two connections that fit equally well (namesakes at one company): don't pick.
    if (next && next.confidence === best.confidence) continue;
    const row: LinkedInConnectionRow = stored.rows[Number(best.contact.id)];
    const connectedOn = parseConnectedOn(row.connectedOn || "");
    merges.push({
      contactId: person.id,
      input: {
        linkedinUrl: row.url || undefined,
        email: row.email || undefined,
        company: row.company || undefined,
        title: row.position || undefined,
        // Fill-only in the merge: a where-met the person kept stays.
        howMet: "LinkedIn connection",
        dateMet: connectedOn ?? undefined,
        firstInteractionAt: connectedOn ?? undefined,
      },
    });
  }
  if (!merges.length) return 0;
  await bulkMergeContactsForUser(userId, merges, await createCompanyResolver(userId), {
    source: "linkedin_export",
    at: stored.uploadedAt,
  });
  return merges.length;
}
