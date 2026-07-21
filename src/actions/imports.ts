"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import Papa from "papaparse";
import { getDb } from "@/db";
import {
  contacts,
  imports,
  interactions,
  reminders,
  type ImportStats,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { daysAgo, findDuplicateCandidates } from "@/lib/duplicates";
import { createContact, updateContact } from "@/actions/contacts";
import {
  parseLinkedInMessagesCsv,
  participantIdentity,
  resolveConversations,
  nameFromLinkedInSlug,
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

/** Align preview badges with confirm merge behavior. */
const DUPLICATE_MERGE_CONFIDENCE = 0.85;

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

/** Parse LinkedIn "Connected On" values like "15 Jan 2024" or "01/15/2024". */
function parseConnectedOn(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return null;
}

function mergeStats(
  prev: ImportStats | null | undefined,
  next: ImportStats
): ImportStats {
  const base = prev ?? {};
  return {
    skipped: (base.skipped ?? 0) + (next.skipped ?? 0),
    messagesImported:
      (base.messagesImported ?? 0) + (next.messagesImported ?? 0),
    meetingsLogged: (base.meetingsLogged ?? 0) + (next.meetingsLogged ?? 0),
    remindersCreated:
      (base.remindersCreated ?? 0) + (next.remindersCreated ?? 0),
    contactsEnriched:
      (base.contactsEnriched ?? 0) + (next.contactsEnriched ?? 0),
    eventsProcessed: (base.eventsProcessed ?? 0) + (next.eventsProcessed ?? 0),
  };
}

function simpleHash(input: string) {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function linkedInMessageExternalId(
  conversationId: string,
  date: Date,
  content: string
) {
  return `li-msg:${conversationId}:${date.toISOString()}:${simpleHash(content.slice(0, 240))}`;
}

function calendarMeetingExternalId(eventUid: string, contactId: string) {
  return `cal:${eventUid}:${contactId}`;
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

  const people = rows.map((row, index) => {
    const fullName = `${row.firstName} ${row.lastName}`.trim();
    const dups = findDuplicateCandidates(existing, {
      fullName,
      email: row.email,
      linkedinUrl: row.url,
      company: row.company,
      title: row.position,
    });
    const top = dups[0];
    return {
      id: String(index),
      index,
      ...row,
      fullName,
      isRepeat: Boolean(top && top.confidence >= DUPLICATE_MERGE_CONFIDENCE),
      duplicate: top
        ? {
            id: top.contact.id,
            fullName: top.contact.fullName,
            reason: top.reason,
            confidence: top.confidence,
          }
        : null,
    };
  });

  return {
    columns: parsed.meta.fields || [],
    totalRows: people.length,
    people,
    duplicateCount: people.filter((p) => p.isRepeat).length,
    // keep legacy key for any callers
    preview: people,
  };
}

export type ImportChunkOptions = {
  /** Continue an existing import session across client-side batches. */
  importId?: string;
  /** When false, leave status as processing so more chunks can run. Default true. */
  finalize?: boolean;
};

async function resolveImportRow(
  userId: string,
  values: {
    importType: string;
    fileName: string;
  },
  importId?: string
) {
  const db = await getDb();
  if (importId) {
    const existing = await db.query.imports.findFirst({
      where: and(eq(imports.id, importId), eq(imports.userId, userId)),
    });
    if (!existing) throw new Error("Import session not found");
    if (existing.status === "failed" || existing.status === "completed") {
      throw new Error(`Import session already ${existing.status}`);
    }
    return existing;
  }
  const [created] = await db
    .insert(imports)
    .values({
      userId,
      importType: values.importType,
      fileName: values.fileName,
      status: "processing",
      stats: {},
    })
    .returning();
  return created;
}

export async function failImportSession(
  importId: string,
  errorMessage: string
) {
  const userId = await requireUserId();
  const db = await getDb();
  await db
    .update(imports)
    .set({
      status: "failed",
      errorMessage: errorMessage.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)));
  revalidatePath("/imports");
}

export async function confirmLinkedInImport(
  csvText: string,
  fileName: string,
  selectedIds?: string[],
  options?: ImportChunkOptions
) {
  const userId = await requireUserId();
  const db = await getDb();
  const finalize = options?.finalize !== false;
  const writeOpts = { skipRevalidate: true };

  const importRow = await resolveImportRow(
    userId,
    { importType: "linkedin_connections", fileName },
    options?.importId
  );

  try {
    const parsed = Papa.parse<Record<string, string>>(csvText, {
      header: true,
      skipEmptyLines: true,
    });

    const rows = parsed.data
      .map(mapLinkedInRow)
      .filter((r) => r.firstName || r.lastName);
    const selected =
      selectedIds === undefined
        ? new Set(rows.map((_, i) => String(i)))
        : new Set(selectedIds);

    let created = 0;
    let updated = 0;
    let duplicates = 0;
    let skipped = 0;
    let processed = 0;

    const existing = await db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
    });

    for (let index = 0; index < rows.length; index++) {
      if (!selected.has(String(index))) continue;

      const row = rows[index];
      const fullName = `${row.firstName} ${row.lastName}`.trim();
      if (!fullName) {
        skipped++;
        continue;
      }

      processed++;
      const connectedOn = parseConnectedOn(row.connectedOn);
      const dups = findDuplicateCandidates(existing, {
        fullName,
        email: row.email,
        linkedinUrl: row.url,
        company: row.company,
        title: row.position,
      });

      if (dups[0] && dups[0].confidence >= DUPLICATE_MERGE_CONFIDENCE) {
        duplicates++;
        await updateContact(
          dups[0].contact.id,
          {
            company: row.company || undefined,
            title: row.position || undefined,
            email: row.email || undefined,
            linkedinUrl: row.url || undefined,
            firstName: row.firstName || undefined,
            lastName: row.lastName || undefined,
            source: "linkedin",
            dateMet: connectedOn || undefined,
            howMet: "LinkedIn connection",
            metContext: "online",
          },
          writeOpts
        );
        updated++;
      } else {
        const contact = await createContact(
          {
            fullName,
            firstName: row.firstName,
            lastName: row.lastName,
            company: row.company || undefined,
            title: row.position || undefined,
            email: row.email || undefined,
            linkedinUrl: row.url || undefined,
            source: "linkedin",
            relationshipScore: 2,
            dateMet: connectedOn,
            howMet: "LinkedIn connection",
            metContext: "online",
            tagNames: ["linkedin"],
          },
          writeOpts
        );
        existing.push(contact as (typeof existing)[number]);
        created++;
      }
    }

    const contactsCreated = (importRow.contactsCreated ?? 0) + created;
    const contactsUpdated = (importRow.contactsUpdated ?? 0) + updated;
    const duplicatesFound = (importRow.duplicatesFound ?? 0) + duplicates;
    const rowsProcessed = (importRow.rowsProcessed ?? 0) + processed;
    const stats = mergeStats(importRow.stats, { skipped });

    await db
      .update(imports)
      .set({
        status: finalize ? "completed" : "processing",
        rowsProcessed,
        contactsCreated,
        contactsUpdated,
        duplicatesFound,
        stats,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(imports.id, importRow.id));

    if (finalize) {
      revalidatePath("/");
      revalidatePath("/contacts");
      revalidatePath("/imports");
      revalidatePath("/graph");
      revalidatePath("/knowledge");
      revalidatePath("/chat");
    }

    return {
      importId: importRow.id,
      rowsProcessed,
      contactsCreated,
      contactsUpdated,
      duplicatesFound,
      skipped,
      chunkCreated: created,
      chunkUpdated: updated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed";
    await db
      .update(imports)
      .set({
        status: "failed",
        errorMessage: message.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(imports.id, importRow.id));
    throw err;
  }
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
  const people = conversations.map((c) => ({
    id: c.conversationId,
    conversationId: c.conversationId,
    title: c.conversationTitle,
    messageCount: c.messageCount,
    latestDate: c.latestDate?.toISOString() ?? null,
    sampleContent: c.sampleContent,
    match: c.match,
    willCreate: !c.match && !!c.primaryUrl,
    isRepeat: Boolean(c.match),
    displayName:
      c.match?.fullName ||
      c.primaryName ||
      (c.primaryUrl ? nameFromLinkedInSlug(c.primaryUrl) : "Unknown"),
    linkedinUrl: c.primaryUrl,
  }));

  const matched = people.filter((c) => c.isRepeat);
  const unmatched = people.filter((c) => !c.isRepeat);

  return {
    columns,
    totalMessages: messages.length,
    totalConversations: people.length,
    matchedCount: matched.length,
    unmatchedCount: unmatched.length,
    people,
    // keep legacy key
    preview: people,
  };
}

export async function confirmLinkedInMessagesImport(
  csvText: string,
  fileName: string,
  selectedConversationIds?: string[],
  options?: ImportChunkOptions
) {
  const userId = await requireUserId();
  const db = await getDb();
  const finalize = options?.finalize !== false;
  const writeOpts = { skipRevalidate: true };

  const importRow = await resolveImportRow(
    userId,
    { importType: "linkedin_messages", fileName },
    options?.importId
  );

  try {
    const { messages } = parseLinkedInMessagesCsv(csvText);
    let existing = await db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
    });

    const conversations = resolveConversations(messages, existing);
    const selected =
      selectedConversationIds === undefined
        ? null
        : new Set(selectedConversationIds);

    const byConv = new Map<string, ParsedLinkedInMessage[]>();
    for (const m of messages) {
      const list = byConv.get(m.conversationId) || [];
      list.push(m);
      byConv.set(m.conversationId, list);
    }

    let created = 0;
    let updated = 0;
    let duplicates = 0;
    let messagesImported = 0;
    let skipped = 0;
    const touchedContactIds = new Set<string>();

    for (const conv of conversations) {
      if (selected && !selected.has(conv.conversationId)) continue;

      const msgs = byConv.get(conv.conversationId) || [];
      let contactId = conv.match?.contactId;

      if (!contactId) {
        const identity = participantIdentity(conv);
        if (!identity?.linkedinUrl) {
          skipped += msgs.length;
          continue;
        }

        const contact = await createContact(
          {
            fullName: identity.fullName,
            firstName: identity.firstName,
            lastName: identity.lastName,
            linkedinUrl: identity.linkedinUrl,
            source: "linkedin_messages",
            relationshipScore: 2,
            howMet: "LinkedIn messages",
            metContext: "online",
            tagNames: ["linkedin", "messages"],
          },
          writeOpts
        );
        contactId = contact.id;
        existing = [...existing, contact as (typeof existing)[number]];
        created++;
      } else {
        duplicates++;
        const identity = participantIdentity(conv);
        await updateContact(
          contactId,
          {
            linkedinUrl: identity?.linkedinUrl || undefined,
            source: "linkedin_messages",
          },
          writeOpts
        );
        updated++;
      }

      touchedContactIds.add(contactId);

      const existingInteractions = await db.query.interactions.findMany({
        where: and(
          eq(interactions.userId, userId),
          eq(interactions.contactId, contactId),
          eq(interactions.source, "linkedin_messages_import")
        ),
      });
      const existingExternalIds = new Set(
        existingInteractions
          .map((i) => i.externalId)
          .filter((id): id is string => Boolean(id))
      );
      // Legacy dedupe for rows imported before externalId
      const existingLegacyKeys = new Set(
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
        const externalId = linkedInMessageExternalId(
          conv.conversationId,
          date,
          msg.content
        );
        const legacyKey = `${date.toISOString()}|${msg.content.slice(0, 200)}`;
        if (
          existingExternalIds.has(externalId) ||
          existingLegacyKeys.has(legacyKey)
        ) {
          skipped++;
          continue;
        }

        const fromLabel = msg.from || "LinkedIn";
        try {
          await db.insert(interactions).values({
            userId,
            contactId,
            interactionType: "linkedin_message",
            interactionDate: date,
            source: "linkedin_messages_import",
            externalId,
            rawNotes: msg.content,
            aiSummary: `${fromLabel}: ${msg.content.slice(0, 240)}`,
            topics: msg.subject ? [msg.subject] : [],
          });
        } catch {
          // Unique (user_id, external_id) race / re-import
          skipped++;
          continue;
        }
        messagesImported++;
        existingExternalIds.add(externalId);
        existingLegacyKeys.add(legacyKey);

        if (!earliest || date < earliest) earliest = date;
        if (!latest || date > latest) latest = date;
      }

      // Derive scannable timeline events (reach-out, meetings, in-person)
      try {
        const { extractLinkedInTimelineEvents } = await import(
          "@/lib/linkedin-timeline-events"
        );
        const timelineEvents = await extractLinkedInTimelineEvents(
          userId,
          conv.conversationId,
          msgs.map((m) => ({
            from: m.from,
            content: m.content,
            parsedDate: m.parsedDate,
          }))
        );
        for (const ev of timelineEvents) {
          if (existingExternalIds.has(ev.externalId)) continue;
          try {
            await db.insert(interactions).values({
              userId,
              contactId,
              interactionType: ev.interactionType,
              interactionDate: ev.interactionDate,
              source: "linkedin_messages_import",
              externalId: ev.externalId,
              rawNotes: ev.rawNotes,
              aiSummary: ev.summary,
              topics: [],
              sameDayOrder: 0,
            });
            existingExternalIds.add(ev.externalId);
            if (!earliest || ev.interactionDate < earliest) {
              earliest = ev.interactionDate;
            }
            if (!latest || ev.interactionDate > latest) {
              latest = ev.interactionDate;
            }
          } catch {
            // dedupe race
          }
        }
      } catch {
        // Enrichment is best-effort; raw messages already imported
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

    const contactsCreated = (importRow.contactsCreated ?? 0) + created;
    const contactsUpdated = (importRow.contactsUpdated ?? 0) + updated;
    const duplicatesFound = (importRow.duplicatesFound ?? 0) + duplicates;
    const rowsProcessed = (importRow.rowsProcessed ?? 0) + messagesImported;
    const touchedAll = new Set([
      ...(importRow.stats?.touchedContactIds ?? []),
      ...touchedContactIds,
    ]);
    let stats = mergeStats(importRow.stats, {
      skipped,
      messagesImported,
    });
    stats = {
      ...stats,
      touchedContactIds: [...touchedAll],
    };

    let enrichment: Awaited<
      ReturnType<typeof enrichContactsFromMessages>
    > | null = null;

    if (finalize) {
      try {
        enrichment = await enrichContactsFromMessages(userId, [...touchedAll]);
        if (enrichment?.contactsEnriched) {
          stats = {
            ...stats,
            contactsEnriched:
              (stats.contactsEnriched ?? 0) + enrichment.contactsEnriched,
          };
        }
      } catch {
        enrichment = null;
      }

      try {
        await refreshOutreachSuggestions(userId);
      } catch {
        // non-fatal
      }
    }

    await db
      .update(imports)
      .set({
        status: finalize ? "completed" : "processing",
        rowsProcessed,
        contactsCreated,
        contactsUpdated,
        duplicatesFound,
        stats,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(imports.id, importRow.id));

    if (finalize) {
      revalidatePath("/");
      revalidatePath("/contacts");
      revalidatePath("/imports");
      revalidatePath("/graph");
      revalidatePath("/chat");
      revalidatePath("/knowledge");
    }

    return {
      importId: importRow.id,
      rowsProcessed,
      messagesImported,
      contactsCreated,
      contactsUpdated,
      duplicatesFound,
      skipped,
      enrichment,
      chunkMessagesImported: messagesImported,
      chunkCreated: created,
      chunkUpdated: updated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed";
    await db
      .update(imports)
      .set({
        status: "failed",
        errorMessage: message.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(imports.id, importRow.id));
    throw err;
  }
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
  importId?: string;
  finalize?: boolean;
  /** Process only a slice of windowed events (for progress UI). */
  chunk?: { offset: number; limit: number };
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const createFollowUps = payload.createFollowUps !== false;
  const finalize = payload.finalize !== false;

  const importRow = await resolveImportRow(
    userId,
    {
      importType: payload.kind === "ics" ? "calendar_ics" : "calendar_csv",
      fileName: payload.fileName,
    },
    payload.importId
  );

  try {
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

    const chunkEvents = payload.chunk
      ? windowed.slice(
          payload.chunk.offset,
          payload.chunk.offset + payload.chunk.limit
        )
      : windowed;

    const existing = await db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
    });

    let meetingsLogged = 0;
    let remindersCreated = 0;
    let skipped = 0;
    const touched = new Set<string>(
      importRow.stats?.touchedContactIds ?? []
    );

    for (const event of chunkEvents) {
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

        const externalId = calendarMeetingExternalId(event.uid, contact.id);
        const prior = await db.query.interactions.findFirst({
          where: and(
            eq(interactions.userId, userId),
            eq(interactions.externalId, externalId)
          ),
        });

        if (prior) {
          await db
            .update(interactions)
            .set({
              interactionDate: eventDate,
              rawNotes: note,
              aiSummary: event.summary || "Calendar meeting",
              topics: event.summary ? [event.summary] : [],
              source: "calendar_import",
            })
            .where(eq(interactions.id, prior.id));
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
            .where(
              and(eq(contacts.id, contact.id), eq(contacts.userId, userId))
            );
          skipped++;
          continue;
        }

        await db.insert(interactions).values({
          userId,
          contactId: contact.id,
          interactionType: "meeting",
          interactionDate: eventDate,
          source: "calendar_import",
          externalId,
          rawNotes: note,
          aiSummary: event.summary || "Calendar meeting",
          topics: event.summary ? [event.summary] : [],
        });
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
          externalId
        );

        if (createFollowUps && isPast && daysAgo(eventDate) <= 21) {
          const existingReminder = await db.query.reminders.findFirst({
            where: and(
              eq(reminders.userId, userId),
              eq(reminders.contactId, contact.id),
              eq(reminders.reminderType, "post_meeting")
            ),
          });
          const alreadyForEvent =
            existingReminder &&
            (existingReminder.description || "").includes(event.uid);

          if (!alreadyForEvent) {
            const due = new Date(eventDate);
            due.setDate(due.getDate() + 2);
            if (due.getTime() < now) {
              due.setTime(now + 2 * 86400000);
            }
            await db.insert(reminders).values({
              userId,
              contactId: contact.id,
              title: `Follow up after ${event.summary || "meeting"}`,
              description: `You met with ${contact.fullName}. Event ${event.uid}`,
              dueDate: due,
              status: "pending",
              reminderType: "post_meeting",
              createdBy: "import",
            });
            remindersCreated++;
          }
        }
      }
    }

    const rowsProcessed =
      (importRow.rowsProcessed ?? 0) + chunkEvents.length;
    const stats = {
      ...mergeStats(importRow.stats, {
        skipped,
        meetingsLogged,
        remindersCreated,
        eventsProcessed: chunkEvents.length,
      }),
      touchedContactIds: [...touched],
    };

    await db
      .update(imports)
      .set({
        status: finalize ? "completed" : "processing",
        rowsProcessed,
        contactsCreated: 0,
        contactsUpdated: touched.size,
        duplicatesFound: stats.skipped ?? 0,
        stats,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(imports.id, importRow.id));

    if (finalize) {
      try {
        await refreshOutreachSuggestions(userId);
      } catch {
        // non-fatal
      }

      revalidatePath("/");
      revalidatePath("/contacts");
      revalidatePath("/imports");
      revalidatePath("/graph");
    }

    return {
      importId: importRow.id,
      eventsProcessed: chunkEvents.length,
      totalWindowed: windowed.length,
      meetingsLogged,
      contactsMatched: touched.size,
      remindersCreated,
      skipped,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed";
    await db
      .update(imports)
      .set({
        status: "failed",
        errorMessage: message.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(imports.id, importRow.id));
    throw err;
  }
}
