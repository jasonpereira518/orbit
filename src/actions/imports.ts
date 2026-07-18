"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import Papa from "papaparse";
import { getDb } from "@/db";
import { contacts, imports, interactions, reminders } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { daysAgo, findDuplicateCandidates } from "@/lib/duplicates";
import { createContact, updateContact } from "@/actions/contacts";
import {
  parseLinkedInMessagesCsv,
  participantIdentity,
  resolveConversations,
  type ParsedLinkedInMessage,
} from "@/lib/linkedin-messages";
import { enrichContactsFromMessages } from "@/lib/message-enrichment";
import { refreshOutreachSuggestions } from "@/lib/reminders";
import {
  mapCalendarCsvRow,
  parseIcsEvents,
  type ParsedCalendarEvent,
} from "@/lib/calendar-import";
import { upsertContactEmbedding } from "@/lib/search";

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

export async function previewLinkedInMessagesCsv(csvText: string) {
  const userId = await requireUserId();
  const { columns, messages } = parseLinkedInMessagesCsv(csvText);
  if (!messages.length) {
    throw new Error("No messages found in CSV. Export Messages from LinkedIn data download.");
  }

  const db = await getDb();
  const existing = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });

  const conversations = resolveConversations(messages, existing);
  const matched = conversations.filter((c) => c.match);
  const unmatched = conversations.filter((c) => !c.match);

  return {
    columns,
    totalMessages: messages.length,
    totalConversations: conversations.length,
    matchedCount: matched.length,
    unmatchedCount: unmatched.length,
    preview: conversations.slice(0, 40).map((c) => ({
      conversationId: c.conversationId,
      title: c.conversationTitle,
      messageCount: c.messageCount,
      latestDate: c.latestDate?.toISOString() ?? null,
      sampleContent: c.sampleContent,
      match: c.match,
      willCreate: !c.match && !!(c.participantNames[0] || c.participantUrls[0]),
    })),
  };
}

export async function confirmLinkedInMessagesImport(
  csvText: string,
  fileName: string
) {
  const userId = await requireUserId();
  const db = await getDb();

  const [importRow] = await db
    .insert(imports)
    .values({
      userId,
      importType: "linkedin_messages",
      fileName,
      status: "processing",
    })
    .returning();

  const { messages } = parseLinkedInMessagesCsv(csvText);
  let existing = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });

  const conversations = resolveConversations(messages, existing);
  const byConv = new Map<string, ParsedLinkedInMessage[]>();
  for (const m of messages) {
    const list = byConv.get(m.conversationId) || [];
    list.push(m);
    byConv.set(m.conversationId, list);
  }

  let created = 0;
  let updated = 0;
  let messagesImported = 0;
  let skipped = 0;
  const touchedContactIds = new Set<string>();

  for (const conv of conversations) {
    const msgs = byConv.get(conv.conversationId) || [];
    let contactId = conv.match?.contactId;

    if (!contactId) {
      const identity = participantIdentity(conv);
      if (!identity.fullName || identity.fullName === "LinkedIn contact") {
        if (!identity.linkedinUrl) {
          skipped += msgs.length;
          continue;
        }
      }

      const contact = await createContact({
        fullName: identity.fullName,
        firstName: identity.firstName,
        lastName: identity.lastName,
        linkedinUrl: identity.linkedinUrl,
        source: "linkedin_messages",
        relationshipScore: 2,
        tagNames: ["linkedin", "messages"],
      });
      contactId = contact.id;
      existing = [
        ...existing,
        contact as (typeof existing)[number],
      ];
      created++;
    } else {
      const identity = participantIdentity(conv);
      await updateContact(contactId, {
        linkedinUrl: identity.linkedinUrl || undefined,
        source: "linkedin_messages",
      });
      updated++;
    }

    touchedContactIds.add(contactId);

    // Avoid re-importing identical message content+date for this contact
    const existingInteractions = await db.query.interactions.findMany({
      where: and(
        eq(interactions.userId, userId),
        eq(interactions.contactId, contactId),
        eq(interactions.source, "linkedin_messages_import")
      ),
    });
    const existingKeys = new Set(
      existingInteractions.map(
        (i) =>
          `${i.interactionDate?.toISOString() || ""}|${(i.rawNotes || "").slice(0, 200)}`
      )
    );

    let earliest: Date | null = null;
    let latest: Date | null = null;

    for (const msg of msgs) {
      if (!msg.content.trim()) {
        skipped++;
        continue;
      }
      const date = msg.parsedDate || new Date();
      const key = `${date.toISOString()}|${msg.content.slice(0, 200)}`;
      if (existingKeys.has(key)) {
        skipped++;
        continue;
      }

      const fromLabel = msg.from || "LinkedIn";
      await db.insert(interactions).values({
        userId,
        contactId,
        interactionType: "linkedin_message",
        interactionDate: date,
        source: "linkedin_messages_import",
        rawNotes: msg.content,
        aiSummary: `${fromLabel}: ${msg.content.slice(0, 240)}`,
        topics: msg.subject ? [msg.subject] : [],
      });
      messagesImported++;
      existingKeys.add(key);

      if (!earliest || date < earliest) earliest = date;
      if (!latest || date > latest) latest = date;
    }

    if (earliest || latest) {
      const contact = existing.find((c) => c.id === contactId);
      await db
        .update(contacts)
        .set({
          firstInteractionAt:
            contact?.firstInteractionAt && earliest
              ? contact.firstInteractionAt < earliest
                ? contact.firstInteractionAt
                : earliest
              : earliest || contact?.firstInteractionAt || null,
          lastInteractionAt:
            contact?.lastInteractionAt && latest
              ? contact.lastInteractionAt > latest
                ? contact.lastInteractionAt
                : latest
              : latest || contact?.lastInteractionAt || null,
          updatedAt: new Date(),
        })
        .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
    }
  }

  await db
    .update(imports)
    .set({
      status: "completed",
      rowsProcessed: messages.length,
      contactsCreated: created,
      contactsUpdated: updated,
      duplicatesFound: skipped,
    })
    .where(eq(imports.id, importRow.id));

  // Enrichment may fail without API key — still complete the import
  let enrichment: Awaited<ReturnType<typeof enrichContactsFromMessages>> | null =
    null;
  try {
    enrichment = await enrichContactsFromMessages(
      userId,
      [...touchedContactIds]
    );
  } catch {
    enrichment = null;
  }

  try {
    await refreshOutreachSuggestions(userId);
  } catch {
    // non-fatal
  }

  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/imports");
  revalidatePath("/graph");
  revalidatePath("/chat");

  return {
    importId: importRow.id,
    rowsProcessed: messages.length,
    messagesImported,
    contactsCreated: created,
    contactsUpdated: updated,
    skipped,
    enrichment,
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

function peopleFromEvent(event: ParsedCalendarEvent) {
  const people: Array<{ name: string; email: string }> = [...event.attendees];
  if (event.organizer) people.push(event.organizer);
  return people.filter((p) => p.email || p.name);
}

export async function previewCalendarImport(payload: {
  kind: "ics" | "csv";
  text: string;
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const existing = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });

  let events: ParsedCalendarEvent[] = [];

  if (payload.kind === "ics") {
    events = parseIcsEvents(payload.text);
  } else {
    const parsed = Papa.parse<Record<string, string>>(payload.text, {
      header: true,
      skipEmptyLines: true,
    });
    events = parsed.data.map((row, i) => {
      const mapped = mapCalendarCsvRow(row);
      const attendees = mapped.attendees
        .split(/[,;]/)
        .map((part) => {
          const emailMatch = part.match(/([\w.+-]+@[\w.-]+)/);
          return {
            name: part.replace(/<[^>]+>/, "").trim(),
            email: (emailMatch?.[1] || "").toLowerCase(),
          };
        })
        .filter((p) => p.email || p.name);
      return {
        uid: `csv-${i}-${mapped.summary}`,
        summary: mapped.summary,
        description: mapped.description,
        location: mapped.location,
        start: mapped.start,
        end: mapped.end,
        attendees,
        organizer: null,
      } satisfies ParsedCalendarEvent;
    });
  }

  // Focus on past 180 days through next 14 days
  const now = Date.now();
  const windowed = events.filter((e) => {
    if (!e.start) return true;
    const t = e.start.getTime();
    return t >= now - 180 * 86400000 && t <= now + 14 * 86400000;
  });

  const preview = windowed.slice(0, 40).map((event) => {
    const people = peopleFromEvent(event);
    const matches = people
      .map((person) => {
        const dups = findDuplicateCandidates(existing, {
          fullName: person.name || undefined,
          email: person.email || undefined,
        });
        return dups[0]
          ? {
              person,
              contactId: dups[0].contact.id,
              fullName: dups[0].contact.fullName,
              reason: dups[0].reason,
            }
          : { person, contactId: null, fullName: null, reason: null };
      })
      .filter((m) => m.contactId || m.person.email || m.person.name);

    return {
      uid: event.uid,
      summary: event.summary || "(untitled event)",
      start: event.start?.toISOString() ?? null,
      attendeeCount: people.length,
      matchedContacts: matches.filter((m) => m.contactId).length,
      matches: matches.slice(0, 6),
    };
  });

  return {
    totalEvents: events.length,
    windowedEvents: windowed.length,
    matchedEventCount: preview.filter((p) => p.matchedContacts > 0).length,
    preview,
  };
}

export async function confirmCalendarImport(payload: {
  kind: "ics" | "csv";
  text: string;
  fileName: string;
  createFollowUps?: boolean;
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const createFollowUps = payload.createFollowUps !== false;

  const [importRow] = await db
    .insert(imports)
    .values({
      userId,
      importType: payload.kind === "ics" ? "calendar_ics" : "calendar_csv",
      fileName: payload.fileName,
      status: "processing",
    })
    .returning();

  let events: ParsedCalendarEvent[] = [];
  if (payload.kind === "ics") {
    events = parseIcsEvents(payload.text);
  } else {
    const parsed = Papa.parse<Record<string, string>>(payload.text, {
      header: true,
      skipEmptyLines: true,
    });
    events = parsed.data.map((row, i) => {
      const mapped = mapCalendarCsvRow(row);
      const attendees = mapped.attendees
        .split(/[,;]/)
        .map((part) => {
          const emailMatch = part.match(/([\w.+-]+@[\w.-]+)/);
          return {
            name: part.replace(/<[^>]+>/, "").trim(),
            email: (emailMatch?.[1] || "").toLowerCase(),
          };
        })
        .filter((p) => p.email || p.name);
      return {
        uid: `csv-${i}-${mapped.summary}`,
        summary: mapped.summary,
        description: mapped.description,
        location: mapped.location,
        start: mapped.start,
        end: mapped.end,
        attendees,
        organizer: null,
      } satisfies ParsedCalendarEvent;
    });
  }

  const now = Date.now();
  const windowed = events.filter((e) => {
    if (!e.start) return true;
    const t = e.start.getTime();
    return t >= now - 180 * 86400000 && t <= now + 14 * 86400000;
  });

  const existing = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });

  let meetingsLogged = 0;
  let remindersCreated = 0;
  let skipped = 0;
  const touched = new Set<string>();

  const priorMeetings = await db.query.interactions.findMany({
    where: and(
      eq(interactions.userId, userId),
      eq(interactions.source, "calendar_import")
    ),
  });
  const meetingKeys = new Set(
    priorMeetings.map(
      (i) =>
        `${i.contactId}|${i.interactionDate?.toISOString().slice(0, 10) || ""}|${(i.aiSummary || "").slice(0, 120)}`
    )
  );

  for (const event of windowed) {
    const people = peopleFromEvent(event);
    if (!people.length) {
      skipped++;
      continue;
    }

    const eventDate = event.start || new Date();
    const isPast = eventDate.getTime() <= now;

    for (const person of people) {
      const dups = findDuplicateCandidates(existing, {
        fullName: person.name || undefined,
        email: person.email || undefined,
      });

      // Only log meetings for people already in the network
      if (!dups[0] || dups[0].confidence < 0.6) {
        continue;
      }

      const contact = dups[0].contact;
      touched.add(contact.id);

      const note = [
        event.summary ? `Meeting: ${event.summary}` : "Calendar meeting",
        event.location ? `Location: ${event.location}` : "",
        event.description ? event.description.slice(0, 500) : "",
      ]
        .filter(Boolean)
        .join("\n");

      const key = `${contact.id}|${eventDate.toISOString().slice(0, 10)}|${(event.summary || "Calendar meeting").slice(0, 120)}`;
      if (meetingKeys.has(key)) {
        skipped++;
        continue;
      }

      await db.insert(interactions).values({
        userId,
        contactId: contact.id,
        interactionType: "meeting",
        interactionDate: eventDate,
        source: "calendar_import",
        rawNotes: note,
        aiSummary: event.summary || "Calendar meeting",
        topics: event.summary ? [event.summary] : [],
      });
      meetingKeys.add(key);
      meetingsLogged++;

      await db
        .update(contacts)
        .set({
          lastInteractionAt:
            !contact.lastInteractionAt ||
            eventDate > contact.lastInteractionAt
              ? eventDate
              : contact.lastInteractionAt,
          firstInteractionAt:
            !contact.firstInteractionAt ||
            eventDate < contact.firstInteractionAt
              ? eventDate
              : contact.firstInteractionAt,
          email: contact.email || person.email || undefined,
          updatedAt: new Date(),
        })
        .where(and(eq(contacts.id, contact.id), eq(contacts.userId, userId)));

      await upsertContactEmbedding(
        userId,
        contact.id,
        "meeting",
        `${contact.fullName}\n${note}`,
        `cal:${event.uid}:${contact.id}`
      );

      if (createFollowUps && isPast && daysAgo(eventDate) <= 21) {
        const due = new Date(eventDate);
        due.setDate(due.getDate() + 2);
        if (due.getTime() < now) {
          due.setTime(now + 2 * 86400000);
        }
        await db.insert(reminders).values({
          userId,
          contactId: contact.id,
          title: `Follow up after ${event.summary || "meeting"}`,
          description: `You met with ${contact.fullName}. Send a quick thank-you or next step.`,
          dueDate: due,
          status: "pending",
          reminderType: "post_meeting",
          createdBy: "import",
        });
        remindersCreated++;
      }
    }
  }

  await db
    .update(imports)
    .set({
      status: "completed",
      rowsProcessed: windowed.length,
      contactsCreated: 0,
      contactsUpdated: touched.size,
      duplicatesFound: skipped,
    })
    .where(eq(imports.id, importRow.id));

  try {
    await refreshOutreachSuggestions(userId);
  } catch {
    // non-fatal
  }

  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/imports");
  revalidatePath("/graph");

  return {
    importId: importRow.id,
    eventsProcessed: windowed.length,
    meetingsLogged,
    contactsMatched: touched.size,
    remindersCreated,
    skipped,
  };
}
