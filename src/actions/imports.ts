"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import Papa from "papaparse";
import { getDb } from "@/db";
import {
  contacts,
  gmailConnections,
  imports,
  importJobRows,
  outlookConnections,
  type CalendarEventRowPayload,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { DUPLICATE_MERGE_CONFIDENCE, findDuplicateCandidates } from "@/lib/duplicates";
import { runLinkedInImportJob } from "@/lib/import-job-processor";
import {
  GOOGLE_CONTACTS_IMPORT_TYPE,
  OUTLOOK_CONTACTS_IMPORT_TYPE,
  LINKEDIN_MESSAGES_IMPORT_TYPE,
  CALENDAR_ICS_IMPORT_TYPE,
  CALENDAR_CSV_IMPORT_TYPE,
  runImportJobById,
} from "@/lib/import-job-dispatch";
import { parseLinkedInConnectionsCsv } from "@/lib/linkedin-connections";
import {
  parseLinkedInMessagesCsv,
  participantIdentity,
  resolveConversations,
  nameFromLinkedInSlug,
  type ParsedLinkedInMessage,
} from "@/lib/linkedin-messages";
import {
  mapCalendarCsvRow,
  parseIcsEvents,
  peopleFromEvent,
  windowCalendarEvents,
  type ParsedCalendarEvent,
} from "@/lib/calendar-import";
import { fetchGooglePeopleContacts, getValidAccessToken, hasContactsScope } from "@/lib/gmail";
import {
  fetchOutlookContacts,
  getValidAccessToken as getValidOutlookAccessToken,
} from "@/lib/outlook";

function simpleHash(input: string) {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/**
 * Deterministic across re-imports of the same CSV: same conversation, same message date,
 * same content hashes to the same id every time, with no dependence on wall-clock time even
 * when `date` is null (an unparseable date in the export). That determinism is what makes
 * this id safe to carry straight through to `interactions.externalId` — see
 * `linkedinMessagesAdapter` — as the sole dedupe key for a re-imported conversation.
 */
function linkedInMessageExternalId(
  conversationId: string,
  date: Date | null,
  content: string
) {
  return `li-msg:${conversationId}:${date ? date.toISOString() : "unknown"}:${simpleHash(content.slice(0, 240))}`;
}

/** Replacement-character artifacts from decoding a non-UTF8 export as UTF-8. */
function hasEncodingArtifacts(rows: { firstName: string; lastName: string; company: string; position: string }[]) {
  return rows.some(
    (r) =>
      r.firstName.includes("�") ||
      r.lastName.includes("�") ||
      r.company.includes("�") ||
      r.position.includes("�")
  );
}

export async function previewLinkedInCsv(csvText: string) {
  const userId = await requireUserId();
  // parseLinkedInConnectionsCsv throws for expected validation failures (empty
  // file, wrong export type, no rows found). Server Actions strip thrown error
  // messages in production, replacing them with a generic digest — so those
  // failures must come back as data, not a throw, to reach the client's toast.
  let parsed: ReturnType<typeof parseLinkedInConnectionsCsv>;
  try {
    parsed = parseLinkedInConnectionsCsv(csvText);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Failed to parse CSV",
    };
  }
  const { columns, rows, warnings } = parsed;
  if (hasEncodingArtifacts(rows)) {
    warnings.push(
      "Some characters may not have decoded correctly — if names look garbled, re-export the CSV with UTF-8 encoding."
    );
  }
  const db = await getDb();
  const existing = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: {
      id: true,
      fullName: true,
      email: true,
      linkedinUrl: true,
      xHandle: true,
      company: true,
      title: true,
    },
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
    columns,
    totalRows: people.length,
    people,
    duplicateCount: people.filter((p) => p.isRepeat).length,
    warnings,
    // keep legacy key for any callers
    preview: people,
  };
}

/**
 * Starts a server-owned LinkedIn connections import: persists the selected
 * rows once, then processes them in the background via `after()`. Survives
 * tab close/navigation — the client should poll `getImportJobStatus`.
 */
export async function startLinkedInImport(
  csvText: string,
  fileName: string,
  selectedIds?: string[]
): Promise<{ importId: string; totalRows: number }> {
  const userId = await requireUserId();
  const db = await getDb();

  const { rows } = parseLinkedInConnectionsCsv(csvText);
  const selectedIndexes =
    selectedIds === undefined
      ? rows.map((_, i) => i)
      : selectedIds
          .map((id) => Number(id))
          .filter((i) => Number.isInteger(i) && i >= 0 && i < rows.length);

  if (selectedIndexes.length === 0) {
    throw new Error("No rows selected to import");
  }

  const [importRow] = await db
    .insert(imports)
    .values({
      userId,
      importType: "linkedin_connections",
      fileName,
      status: "processing",
      totalRows: selectedIndexes.length,
      stats: {},
    })
    .returning();

  await db.insert(importJobRows).values(
    selectedIndexes.map((index) => {
      const row = rows[index];
      return {
        importId: importRow.id,
        userId,
        rowIndex: index,
        payload: {
          index,
          firstName: row.firstName,
          lastName: row.lastName,
          email: row.email,
          company: row.company,
          position: row.position,
          connectedOn: row.connectedOn,
          url: row.url,
        },
      };
    })
  );

  after(() => runLinkedInImportJob(importRow.id).catch(() => {}));

  revalidatePath("/imports");

  return { importId: importRow.id, totalRows: selectedIndexes.length };
}

export type ImportJobStatus = {
  id: string;
  status: string;
  totalRows: number;
  rowsProcessed: number;
  contactsCreated: number;
  contactsUpdated: number;
  duplicatesFound: number;
  errorMessage: string | null;
  /**
   * The engine's own counters (`ImportStats.interactionsLogged`/`remindersCreated` —
   * see `src/db/schema.ts`) for how many interaction/reminder rows this job's bulk inserts
   * actually wrote. Surfaced here so the poll UI can report the number a calendar or
   * LinkedIn-messages import's user actually cares about — meetings/messages logged — rather
   * than only `contactsCreated`/`contactsUpdated`, which for a `createsContacts: false`
   * import like calendar never move the "created" half at all.
   */
  interactionsLogged: number;
  remindersCreated: number;
  /**
   * Rows the engine isolated and marked `failed` rather than failing the whole import
   * (`ImportStats.failedRows`). Surfaced so a user whose file contained unwritable rows is
   * actually told — chunk narrowing's entire purpose is to drop those rows instead of the
   * job, and a "completed" toast that never mentions them hides the loss.
   */
  failedRows: number;
};

/** Read-only status poll for a server-owned import job (see `startLinkedInImport`). */
export async function getImportJobStatus(importId: string): Promise<ImportJobStatus> {
  const userId = await requireUserId();
  const db = await getDb();
  const row = await db.query.imports.findFirst({
    where: and(eq(imports.id, importId), eq(imports.userId, userId)),
  });
  if (!row) throw new Error("Import session not found");

  return {
    id: row.id,
    status: row.status,
    totalRows: row.totalRows ?? 0,
    rowsProcessed: row.rowsProcessed ?? 0,
    contactsCreated: row.contactsCreated ?? 0,
    contactsUpdated: row.contactsUpdated ?? 0,
    duplicatesFound: row.duplicatesFound ?? 0,
    errorMessage: row.errorMessage,
    interactionsLogged: row.stats?.interactionsLogged ?? 0,
    remindersCreated: row.stats?.remindersCreated ?? 0,
    failedRows: row.stats?.failedRows ?? 0,
  };
}

/** Stop a processing import; rows already written are kept. */
export async function cancelImportSession(importId: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const existing = await db.query.imports.findFirst({
    where: and(eq(imports.id, importId), eq(imports.userId, userId)),
  });
  if (!existing) throw new Error("Import session not found");
  if (existing.status !== "processing") return existing;

  const [updated] = await db
    .update(imports)
    .set({
      status: "cancelled",
      updatedAt: new Date(),
    })
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)))
    .returning();

  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/imports");
  revalidatePath("/graph");
  revalidatePath("/chat");
  return updated;
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

/**
 * Starts a server-owned LinkedIn messages import: parses the CSV and resolves every
 * conversation's primary participant exactly **once**, writes one job row per selected
 * conversation, and hands them to the engine in the background via `after()`. Survives tab
 * close/navigation — the client should poll `getImportJobStatus`, same as `startLinkedInImport`.
 *
 * This replaces an importer that re-uploaded and re-parsed the whole CSV, and re-fetched
 * every contact, once per client-side batch of `IMPORT_BATCH_SIZE` conversations. Parsing
 * once here and letting the engine's own chunked, resumable loop (Tasks 10-13) own the
 * duplicate matching and the writes is what fixes that — the same shape as
 * `confirmGoogleContactsImport` and `confirmOutlookContactsImport`.
 *
 * `resolveConversations` is called with an empty `existing` list rather than a real contacts
 * fetch: its `match` field (used by the old per-row importer to decide create-vs-merge) is
 * unused here — the engine's own indexed duplicate matching (`identity()` below) makes that
 * decision instead, from one bulk contacts query per job rather than one per conversation.
 * Everything else `resolveConversations` computes (primary participant, display name,
 * per-conversation message grouping) is still needed and is CPU-only, not a DB round trip.
 */
export async function startLinkedInMessagesImport(
  csvText: string,
  fileName: string,
  selectedConversationIds?: string[]
): Promise<{ importId: string; totalRows: number }> {
  const userId = await requireUserId();
  const db = await getDb();

  const { messages } = parseLinkedInMessagesCsv(csvText);
  const conversations = resolveConversations(messages, []);
  const selected =
    selectedConversationIds === undefined
      ? null
      : new Set(selectedConversationIds);
  const selectedConversations = selected
    ? conversations.filter((c) => selected.has(c.conversationId))
    : conversations;

  if (selectedConversations.length === 0) {
    throw new Error("No conversations selected to import");
  }

  const byConv = new Map<string, ParsedLinkedInMessage[]>();
  for (const m of messages) {
    const list = byConv.get(m.conversationId) || [];
    list.push(m);
    byConv.set(m.conversationId, list);
  }

  const [importRow] = await db
    .insert(imports)
    .values({
      userId,
      importType: LINKEDIN_MESSAGES_IMPORT_TYPE,
      fileName,
      status: "processing",
      totalRows: selectedConversations.length,
      stats: {},
    })
    .returning();

  await db.insert(importJobRows).values(
    selectedConversations.map((conv, index) => {
      const identity = participantIdentity(conv);
      const msgs = byConv.get(conv.conversationId) || [];
      return {
        importId: importRow.id,
        userId,
        rowIndex: index,
        payload: {
          kind: "linkedin_message_thread" as const,
          conversationId: conv.conversationId,
          fullName: identity?.fullName ?? "",
          firstName: identity?.firstName ?? "",
          lastName: identity?.lastName ?? "",
          linkedinUrl: identity?.linkedinUrl ?? "",
          messages: msgs
            .filter((m) => m.content.trim())
            .map((m) => ({
              id: linkedInMessageExternalId(conv.conversationId, m.parsedDate, m.content),
              body: m.content,
              // `null`, not an epoch sentinel: an unparseable date must be excluded from
              // the conversation's date range, not silently reported as 1970 (see
              // `LinkedInMessageThreadRowPayload.messages`).
              sentAt: m.parsedDate ? m.parsedDate.toISOString() : null,
            })),
        },
      };
    })
  );

  after(() => runImportJobById(importRow.id).catch(() => {}));

  revalidatePath("/imports");

  return { importId: importRow.id, totalRows: selectedConversations.length };
}

export async function listImports() {
  const userId = await requireUserId();
  const db = await getDb();
  return db.query.imports.findMany({
    where: eq(imports.userId, userId),
    orderBy: (i, { desc }) => [desc(i.createdAt)],
  });
}

export async function previewCalendarImport(payload: {
  kind: "ics" | "csv";
  text: string;
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const existing = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: {
      id: true,
      fullName: true,
      email: true,
      linkedinUrl: true,
      xHandle: true,
      company: true,
      title: true,
    },
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

  // One-time calendar upload: reach back CALENDAR_BACKFILL_DAYS.
  const windowed = windowCalendarEvents(events);

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

/**
 * Starts a server-owned calendar import: parses and windows the file once, explodes every
 * windowed event into one job row per (event, attendee) pair — see
 * `CalendarEventRowPayload`'s doc comment for why a pair, not one row per event — and hands
 * them to the engine in the background via `after()`. Survives tab close/navigation — the
 * client should poll `getImportJobStatus`, same as `startLinkedInImport`.
 *
 * This replaces an importer the client drove chunk by chunk (`chunk: { offset, limit }`),
 * accumulating `meetingsLogged`/`contactsMatched` across calls and re-querying every one of
 * the user's contacts on every chunk to check `dups[0].confidence < 0.6` and read
 * `lastInteractionAt`/`firstInteractionAt` off whichever contact matched. The engine's own
 * duplicate index (built once per job) and `calendarAdapter.toMerge`'s
 * `bulkMergeContactsForUser`-based widening (see that adapter's comments) replace both of
 * those, the same shape as `confirmGoogleContactsImport` and `startLinkedInMessagesImport`.
 */
export async function confirmCalendarImport(payload: {
  kind: "ics" | "csv";
  text: string;
  fileName: string;
  createFollowUps?: boolean;
}): Promise<{ importId: string; totalRows: number }> {
  const userId = await requireUserId();
  const db = await getDb();
  const createFollowUps = payload.createFollowUps !== false;

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

  // Same one-time-upload backfill window as previewCalendarImport, so a confirm always
  // processes exactly what the preview showed.
  const windowed = windowCalendarEvents(events);

  // One row per (event, attendee) pair — see `CalendarEventRowPayload`'s doc comment. An
  // event with no attendees and no organizer contributes no rows at all, same as it
  // contributed nothing for the old importer's per-event `people.length === 0` skip.
  const rowPayloads: CalendarEventRowPayload[] = [];
  for (const event of windowed) {
    for (const person of peopleFromEvent(event)) {
      rowPayloads.push({
        kind: "calendar_event",
        eventUid: event.uid,
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: event.start ? event.start.toISOString() : null,
        end: event.end ? event.end.toISOString() : null,
        attendeeName: person.name,
        attendeeEmail: person.email,
        createFollowUps,
      });
    }
  }

  const [importRow] = await db
    .insert(imports)
    .values({
      userId,
      importType: payload.kind === "ics" ? CALENDAR_ICS_IMPORT_TYPE : CALENDAR_CSV_IMPORT_TYPE,
      fileName: payload.fileName,
      status: "processing",
      totalRows: rowPayloads.length,
      stats: {},
    })
    .returning();

  if (rowPayloads.length > 0) {
    await db.insert(importJobRows).values(
      rowPayloads.map((rowPayload, index) => ({
        importId: importRow.id,
        userId,
        rowIndex: index,
        payload: rowPayload,
      }))
    );
  }

  after(() => runImportJobById(importRow.id).catch(() => {}));
  revalidatePath("/imports");

  return { importId: importRow.id, totalRows: rowPayloads.length };
}

export type GoogleContactPerson = {
  id: string;
  fullName: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  photoUrl: string | null;
  isRepeat: boolean;
  duplicate: {
    id: string;
    fullName: string;
    reason: string;
    confidence: number;
  } | null;
};

export async function previewGoogleContacts(): Promise<{
  connected: boolean;
  contactsScopeGranted: boolean;
  people: GoogleContactPerson[];
}> {
  const userId = await requireUserId();
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: and(eq(gmailConnections.userId, userId), eq(gmailConnections.status, "active")),
  });
  if (!conn) {
    return { connected: false, contactsScopeGranted: false, people: [] };
  }
  if (!hasContactsScope(conn.scopes)) {
    return { connected: true, contactsScopeGranted: false, people: [] };
  }

  const accessToken = await getValidAccessToken(userId);
  const googleContacts = await fetchGooglePeopleContacts(accessToken);

  const existing = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: {
      id: true,
      fullName: true,
      email: true,
      linkedinUrl: true,
      xHandle: true,
      company: true,
      title: true,
    },
  });

  const people = googleContacts.map((p) => {
    const dups = findDuplicateCandidates(existing, {
      fullName: p.fullName,
      email: p.email,
      company: p.company,
      title: p.title,
    });
    const top = dups[0];
    return {
      id: p.resourceName,
      fullName: p.fullName,
      company: p.company,
      title: p.title,
      email: p.email,
      phone: p.phone,
      photoUrl: p.photoUrl,
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

  return { connected: true, contactsScopeGranted: true, people };
}

/**
 * Starts a server-owned Google Contacts import: snapshots the selected contacts once, then
 * hands them to the engine in the background via `after()`. Survives tab close/navigation —
 * the client should poll `getImportJobStatus`, same as `startLinkedInImport`.
 *
 * This used to be the entire import inline, one contact at a time — a headroom count, a
 * company resolve, an insert, a tag sync, an embedding API call, and a rescore, per contact.
 * A large mailbox hit the 300s function ceiling and died with nothing recoverable. Snapshotting
 * into `import_job_rows` and letting the engine's own chunked, resumable loop (Tasks 10-12)
 * own the writes is what fixes that.
 */
export async function confirmGoogleContactsImport(
  selectedIds: string[]
): Promise<{ importId: string; totalRows: number }> {
  const userId = await requireUserId();
  const db = await getDb();

  const accessToken = await getValidAccessToken(userId);
  const googleContacts = await fetchGooglePeopleContacts(accessToken);
  const selected = new Set(selectedIds);
  const rows = googleContacts.filter((p) => selected.has(p.resourceName));
  if (rows.length === 0) throw new Error("No contacts selected to import");

  const [importRow] = await db
    .insert(imports)
    .values({
      userId,
      importType: GOOGLE_CONTACTS_IMPORT_TYPE,
      fileName: "Google Contacts",
      status: "processing",
      totalRows: rows.length,
      stats: {},
    })
    .returning();

  await db.insert(importJobRows).values(
    rows.map((row, index) => ({
      importId: importRow.id,
      userId,
      rowIndex: index,
      payload: {
        kind: "google_contact" as const,
        resourceName: row.resourceName,
        fullName: row.fullName,
        firstName: row.firstName,
        lastName: row.lastName,
        company: row.company,
        title: row.title,
        email: row.email,
        phone: row.phone,
        photoUrl: row.photoUrl ?? "",
      },
    }))
  );

  after(() => runImportJobById(importRow.id).catch(() => {}));
  revalidatePath("/imports");

  return { importId: importRow.id, totalRows: rows.length };
}

export type OutlookContactPerson = {
  id: string;
  fullName: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  isRepeat: boolean;
  duplicate: {
    id: string;
    fullName: string;
    reason: string;
    confidence: number;
  } | null;
};

export async function previewOutlookContacts(): Promise<{
  connected: boolean;
  people: OutlookContactPerson[];
}> {
  const userId = await requireUserId();
  const db = await getDb();
  const conn = await db.query.outlookConnections.findFirst({
    where: and(eq(outlookConnections.userId, userId), eq(outlookConnections.status, "active")),
  });
  if (!conn) {
    return { connected: false, people: [] };
  }

  const accessToken = await getValidOutlookAccessToken(userId);
  const outlookContacts = await fetchOutlookContacts(accessToken);

  const existing = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: {
      id: true,
      fullName: true,
      email: true,
      linkedinUrl: true,
      xHandle: true,
      company: true,
      title: true,
    },
  });

  const people = outlookContacts.map((p) => {
    const dups = findDuplicateCandidates(existing, {
      fullName: p.fullName,
      email: p.email,
      company: p.company,
      title: p.title,
    });
    const top = dups[0];
    return {
      id: p.id,
      fullName: p.fullName,
      company: p.company,
      title: p.title,
      email: p.email,
      phone: p.phone,
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

  return { connected: true, people };
}

/**
 * Starts a server-owned Outlook Contacts import: snapshots the selected contacts once, then
 * hands them to the engine in the background via `after()`. Identical shape to
 * `confirmGoogleContactsImport` — see its comment for why this collapsed from a per-row loop
 * to a snapshot-and-handoff.
 */
export async function confirmOutlookContactsImport(
  selectedIds: string[]
): Promise<{ importId: string; totalRows: number }> {
  const userId = await requireUserId();
  const db = await getDb();

  const accessToken = await getValidOutlookAccessToken(userId);
  const outlookContacts = await fetchOutlookContacts(accessToken);
  const selected = new Set(selectedIds);
  const rows = outlookContacts.filter((p) => selected.has(p.id));
  if (rows.length === 0) throw new Error("No contacts selected to import");

  const [importRow] = await db
    .insert(imports)
    .values({
      userId,
      importType: OUTLOOK_CONTACTS_IMPORT_TYPE,
      fileName: "Outlook Contacts",
      status: "processing",
      totalRows: rows.length,
      stats: {},
    })
    .returning();

  await db.insert(importJobRows).values(
    rows.map((row, index) => ({
      importId: importRow.id,
      userId,
      rowIndex: index,
      payload: {
        kind: "outlook_contact" as const,
        id: row.id,
        fullName: row.fullName,
        firstName: row.firstName,
        lastName: row.lastName,
        company: row.company,
        title: row.title,
        email: row.email,
        phone: row.phone,
      },
    }))
  );

  after(() => runImportJobById(importRow.id).catch(() => {}));
  revalidatePath("/imports");

  return { importId: importRow.id, totalRows: rows.length };
}
