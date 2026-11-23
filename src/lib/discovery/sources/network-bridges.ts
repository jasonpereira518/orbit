/**
 * Network Bridges and 1st-Degree Contact Graph Loader
 *
 * Gathers 1st-degree contacts with their closeness tiers, relationship scores,
 * employment history (contact_experiences), and event history to identify warm intro paths.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, contactExperiences, eventAttendees } from "@/db/schema";
import { sharedAvatarUrlSql } from "@/lib/contact-avatar-sql";
import type { ContactNetworkNode } from "../scorers/mutual-graph-scorer";

export async function loadContactNetworkNodes(userId: string): Promise<ContactNetworkNode[]> {
  const db = await getDb();

  // 1. Fetch contacts
  const contactRows = await db
    .select({
      contactId: contacts.id,
      fullName: contacts.fullName,
      company: contacts.company,
      closenessTier: contacts.closenessTier,
      relationshipScore: contacts.relationshipScore,
      profileImageUrl: sql<string | null>`coalesce(${sharedAvatarUrlSql}, ${contacts.profileImageUrl})`,
      linkedinUrl: contacts.linkedinUrl,
      email: contacts.email,
    })
    .from(contacts)
    .where(eq(contacts.userId, userId));

  if (!contactRows.length) return [];

  // 2. Fetch contact experiences
  const experienceRows = await db
    .select({
      contactId: contactExperiences.contactId,
      organization: contactExperiences.organization,
      organizationNormalized: contactExperiences.organizationNormalized,
      title: contactExperiences.title,
      startYear: contactExperiences.startYear,
      endYear: contactExperiences.endYear,
      isCurrent: contactExperiences.isCurrent,
    })
    .from(contactExperiences)
    .where(eq(contactExperiences.userId, userId));

  const experiencesByContact = new Map<string, typeof experienceRows>();
  for (const exp of experienceRows) {
    const list = experiencesByContact.get(exp.contactId) || [];
    list.push(exp);
    experiencesByContact.set(exp.contactId, list);
  }

  // 3. Fetch contact attended events
  const attendeeRows = await db
    .select({
      contactId: eventAttendees.contactId,
      eventId: eventAttendees.eventId,
    })
    .from(eventAttendees)
    .where(
      and(
        eq(eventAttendees.userId, userId),
        sql`${eventAttendees.contactId} IS NOT NULL`
      )
    );

  const eventsByContact = new Map<string, string[]>();
  for (const att of attendeeRows) {
    if (!att.contactId) continue;
    const list = eventsByContact.get(att.contactId) || [];
    list.push(att.eventId);
    eventsByContact.set(att.contactId, list);
  }

  // 4. Assemble nodes
  return contactRows.map((c) => ({
    contactId: c.contactId,
    fullName: c.fullName,
    company: c.company,
    closenessTier: c.closenessTier,
    relationshipScore: c.relationshipScore,
    profileImageUrl: c.profileImageUrl,
    linkedinUrl: c.linkedinUrl,
    email: c.email,
    experiences: experiencesByContact.get(c.contactId) || [],
    attendedEventIds: eventsByContact.get(c.contactId) || [],
  }));
}
