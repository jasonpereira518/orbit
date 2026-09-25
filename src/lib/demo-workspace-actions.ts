/**
 * What the demo workspace's provider-calling actions do instead of calling the provider.
 *
 * Every one of these would otherwise reach for an OAuth token the demo workspace does not
 * have (`demo-workspace-connections.ts`). Rather than failing on camera, each records the
 * outcome the real run would have ended in — a finished, "nothing new" run — as an ordinary
 * `imports` row, so the same panels that poll a real run render this one.
 */
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, imports } from "@/db/schema";

/** A recruiter-mailbox scan that finished having found the recruiters already on file. */
export async function recordDemoRecruiterScan(
  userId: string,
  importType: string,
  mailbox: string
): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .insert(imports)
    .values({
      userId,
      importType,
      fileName: mailbox,
      status: "completed",
      totalRows: 214,
      rowsProcessed: 214,
      stats: { discoveryComplete: true, messagesScanned: 1_862, recruitersFound: 3 },
    })
    .returning(); // bare: a field selector breaks over the Db union
  return row.id;
}

/** A Drive import of the picked files that read them all and found nothing to change. */
export async function recordDemoDriveImport(
  userId: string,
  files: readonly { name?: string | null }[]
): Promise<{ importId: string; totalRows: number }> {
  const db = await getDb();
  const [row] = await db
    .insert(imports)
    .values({
      userId,
      importType: "drive_docs",
      fileName: files.length === 1 ? files[0].name ?? "Google Doc" : `${files.length} Google Docs`,
      status: "completed",
      totalRows: files.length,
      rowsProcessed: files.length,
      contactsUpdated: files.length,
      stats: { skipped: 0 },
    })
    .returning(); // bare: a field selector breaks over the Db union
  return { importId: row.id, totalRows: files.length };
}

/**
 * An address-book preview in which everyone is already in Orbit — which is exactly what a
 * re-sync of a book imported months ago looks like. Drawn from the account's own contacts,
 * so the names on screen are the names in the network.
 */
export async function demoAddressBookPreview(userId: string, limit = 40) {
  const db = await getDb();
  const rows = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: { id: true, fullName: true, company: true, title: true, email: true, profileImageUrl: true },
    orderBy: [asc(contacts.fullName)],
    limit,
  });
  return rows.map((c) => ({
    id: `people/demo-${c.id}`,
    fullName: c.fullName,
    company: c.company ?? "",
    title: c.title ?? "",
    email: c.email ?? "",
    phone: "",
    photoUrl: c.profileImageUrl?.startsWith("https://") ? c.profileImageUrl : null,
    isRepeat: true,
    duplicate: { id: c.id, fullName: c.fullName, reason: "Same name and email", confidence: 1 },
  }));
}

/** A contacts import whose picks were all people already in the network, refreshed in place. */
export async function recordDemoContactsImport(
  userId: string,
  importType: "google_contacts" | "outlook_contacts",
  count: number
): Promise<{ importId: string; totalRows: number }> {
  const db = await getDb();
  const [row] = await db
    .insert(imports)
    .values({
      userId,
      importType,
      fileName: importType === "google_contacts" ? "Google Contacts" : "Outlook Contacts",
      status: "completed",
      totalRows: count,
      rowsProcessed: count,
      contactsUpdated: count,
      duplicatesFound: count,
      stats: { skipped: 0 },
    })
    .returning(); // bare: a field selector breaks over the Db union
  return { importId: row.id, totalRows: count };
}
