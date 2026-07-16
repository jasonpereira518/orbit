"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import Papa from "papaparse";
import { getDb } from "@/db";
import { contacts, imports } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { findDuplicateCandidates } from "@/lib/duplicates";
import { createContact, updateContact } from "@/actions/contacts";

export type LinkedInRow = {
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  position: string;
  connectedOn: string;
  url: string;
};

function mapLinkedInRow(row: Record<string, string>): LinkedInRow {
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const found = Object.entries(row).find(
        ([key]) => key.trim().toLowerCase() === k.toLowerCase()
      );
      if (found?.[1]) return found[1].trim();
    }
    return "";
  };

  return {
    firstName: get("First Name", "first name", "FirstName"),
    lastName: get("Last Name", "last name", "LastName"),
    email: get("Email Address", "Email", "email"),
    company: get("Company", "company"),
    position: get("Position", "Title", "position"),
    connectedOn: get("Connected On", "connected on"),
    url: get("URL", "LinkedIn URL", "Profile URL", "url"),
  };
}

export async function previewLinkedInCsv(csvText: string) {
  const userId = await requireUserId();
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length && !parsed.data.length) {
    throw new Error(parsed.errors[0]?.message || "Failed to parse CSV");
  }

  const rows = parsed.data.map(mapLinkedInRow).filter((r) => r.firstName || r.lastName);
  const db = await getDb();
  const existing = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });

  const preview = rows.slice(0, 50).map((row) => {
    const fullName = `${row.firstName} ${row.lastName}`.trim();
    const dups = findDuplicateCandidates(existing, {
      fullName,
      email: row.email,
      linkedinUrl: row.url,
      company: row.company,
      title: row.position,
    });
    return {
      ...row,
      fullName,
      duplicate: dups[0]
        ? {
            id: dups[0].contact.id,
            fullName: dups[0].contact.fullName,
            reason: dups[0].reason,
          }
        : null,
    };
  });

  return {
    columns: parsed.meta.fields || [],
    totalRows: rows.length,
    preview,
    duplicateCount: preview.filter((p) => p.duplicate).length,
  };
}

export async function confirmLinkedInImport(csvText: string, fileName: string) {
  const userId = await requireUserId();
  const db = await getDb();

  const [importRow] = await db
    .insert(imports)
    .values({
      userId,
      importType: "linkedin_connections",
      fileName,
      status: "processing",
    })
    .returning();

  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  const rows = parsed.data.map(mapLinkedInRow).filter((r) => r.firstName || r.lastName);
  let created = 0;
  let updated = 0;
  let duplicates = 0;

  const existing = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });

  for (const row of rows) {
    const fullName = `${row.firstName} ${row.lastName}`.trim();
    if (!fullName) continue;

    const dups = findDuplicateCandidates(existing, {
      fullName,
      email: row.email,
      linkedinUrl: row.url,
      company: row.company,
      title: row.position,
    });

    if (dups[0] && dups[0].confidence >= 0.85) {
      duplicates++;
      await updateContact(dups[0].contact.id, {
        company: row.company || undefined,
        title: row.position || undefined,
        email: row.email || undefined,
        linkedinUrl: row.url || undefined,
        firstName: row.firstName || undefined,
        lastName: row.lastName || undefined,
        source: "linkedin",
      });
      updated++;
    } else {
      const contact = await createContact({
        fullName,
        firstName: row.firstName,
        lastName: row.lastName,
        company: row.company || undefined,
        title: row.position || undefined,
        email: row.email || undefined,
        linkedinUrl: row.url || undefined,
        source: "linkedin",
        relationshipScore: 2,
        tagNames: ["linkedin"],
      });
      existing.push(contact as (typeof existing)[number]);
      created++;
    }
  }

  await db
    .update(imports)
    .set({
      status: "completed",
      rowsProcessed: rows.length,
      contactsCreated: created,
      contactsUpdated: updated,
      duplicatesFound: duplicates,
    })
    .where(eq(imports.id, importRow.id));

  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/imports");
  revalidatePath("/graph");

  return {
    importId: importRow.id,
    rowsProcessed: rows.length,
    contactsCreated: created,
    contactsUpdated: updated,
    duplicatesFound: duplicates,
  };
}

export async function listImports() {
  const userId = await requireUserId();
  const db = await getDb();
  return db.query.imports.findMany({
    where: eq(imports.userId, userId),
    orderBy: (i, { desc }) => [desc(i.createdAt)],
  });
}
