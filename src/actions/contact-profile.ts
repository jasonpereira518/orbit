"use server";

/**
 * "Fill from Apollo" on one contact's page.
 *
 * Every export here must be async — one non-async export in a `"use server"` file kills
 * every export in it, and `tsc` will not tell you.
 */

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { enrichPeopleFromLinkedIn } from "@/lib/apollo";
import { saveContactProfile } from "@/lib/contact-profile";

export async function fillContactProfileFromApollo(
  contactId: string
): Promise<{ filled: boolean; reason: "saved" | "outranked" | "no_url" | "no_match" }> {
  const userId = await requireUserId();
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.userId, userId), eq(contacts.id, contactId)),
    columns: { id: true, fullName: true, email: true, linkedinUrl: true },
  });
  if (!contact?.linkedinUrl?.trim()) return { filled: false, reason: "no_url" };

  const [profile] = await enrichPeopleFromLinkedIn(userId, [
    {
      linkedinUrl: contact.linkedinUrl,
      fullName: contact.fullName,
      email: contact.email,
    },
  ]);
  if (!profile || !profile.experiences.length) {
    return { filled: false, reason: "no_match" };
  }

  const result = await saveContactProfile(userId, contactId, {
    source: "apollo",
    sourceUrl: profile.linkedinUrl,
    adapterVersion: null,
    capturedAt: new Date(),
    warnings: [],
    headline: null,
    about: null,
    skills: [],
    certifications: [],
    volunteering: [],
    publications: [],
    experiences: profile.experiences,
  });

  if (result.written) revalidatePath(`/contacts/${contactId}`);
  return { filled: result.written, reason: result.reason };
}
