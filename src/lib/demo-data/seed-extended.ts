/**
 * The extended demo workspace's writer: everything `seedDemoWorkspace({ extended: true })`
 * adds on top of the base workspace. See `DemoSeedOptions` in `seed.ts` for why the two are
 * kept apart.
 *
 * Each surface is written independently and a failure in one is logged rather than taking
 * the rest down, the same contract as the base seeder.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  apiKeys,
  chatMessages,
  chatThreads,
  contactOpportunities,
  imports,
  interactionMentions,
  interactions,
  meetingSessions,
  meetingTranscriptSegments,
  noteBatches,
  userSettings,
  type NoteBatchResult,
} from "@/db/schema";
import { generateApiKey } from "@/lib/api/keys";
import { mintCalendarFeedToken } from "@/lib/calendar-feed";
import type { EvidenceSource } from "@/lib/chat-evidence";
import type { ChatStep } from "@/lib/chat-stream-protocol";
import { TERMS_VERSION } from "@/lib/legal";
import { buildLongTail, type LongTailSource } from "@/lib/demo-data/long-tail";
import { DEMO_PEOPLE, type DemoPerson } from "@/lib/demo-data/network";
import {
  DEMO_CAPTURES,
  DEMO_OPPORTUNITIES,
  EXTRA_TOUCHES,
  type DemoCapture,
} from "@/lib/demo-data/network-extra";
import { assignDemoPhotos } from "@/lib/demo-data/photos";

const DAY = 86_400_000;
const HOUR = 3_600_000;

export type ExtendedCast = {
  /** The hand-written cast with their fuller histories, then the long tail. */
  people: DemoPerson[];
  photos: Map<string, string | null>;
  contactSource: Map<string, LongTailSource>;
};

export function buildExtendedCast(): ExtendedCast {
  const cast = DEMO_PEOPLE.map((p) => {
    const extra = EXTRA_TOUCHES[p.fullName];
    return extra ? { ...p, touches: [...(p.touches ?? []), ...extra] } : p;
  });
  const longTail = buildLongTail(new Set(cast.map((p) => p.fullName)));

  const contactSource = new Map<string, LongTailSource>();
  for (const p of cast) {
    // Where the cast would have come from on a synced account: LinkedIn for anyone the
    // user has messaged there, the address book for anyone with an email, capture otherwise.
    const linkedin = (p.touches ?? []).some((t) => t.type === "linkedin_message") || Boolean(p.linkedinUrl);
    contactSource.set(p.fullName, linkedin ? "linkedin" : p.email ? "google_contacts" : "ai_capture");
  }
  for (const p of longTail) contactSource.set(p.fullName, p.source);

  return {
    people: [...cast, ...longTail],
    photos: assignDemoPhotos(cast, longTail),
    contactSource,
  };
}

export async function seedExtendedSurfaces(
  userId: string,
  cast: ExtendedCast,
  contactIdByName: Map<string, string>,
  now: number,
  summary: Record<string, number>
): Promise<void> {
  const ago = (days: number) => new Date(now - days * DAY);
  const surfaces: Array<[string, () => Promise<void>]> = [
    ["captures", () => seedCaptures(userId, contactIdByName, ago, summary)],
    // After captures, so the notes they logged are linked too.
    ["mentions", () => seedMentions(userId, cast, contactIdByName, summary)],
    ["opportunities", () => seedOpportunities(userId, contactIdByName, now, summary)],
    ["imports", () => seedMoreImports(userId, cast, ago, summary)],
    ["connections", () => seedConnectionArtifacts(userId, now, summary)],
    ["chat", () => seedGroundedChat(userId, contactIdByName, ago, summary)],
    ["first-run", () => settleFirstRun(userId, now)],
    ["timelines", () => settleInteractionStamps(userId)],
  ];
  for (const [name, run] of surfaces) {
    try {
      await run();
    } catch (err) {
      console.error(`[demo-data] seeding extended ${name} failed`, err);
    }
  }
}

/* ----------------------------------------------------------------------------- captures */

/**
 * Each capture is one saved note that logged several people: a `note_batches` row (the
 * /capture history and its results page), an interaction per participant pointing back at
 * it, mentions between the participants, and — for a recorded meeting — the session and its
 * transcript.
 */
async function seedCaptures(
  userId: string,
  contactIdByName: Map<string, string>,
  ago: (d: number) => Date,
  summary: Record<string, number>
) {
  const db = await getDb();
  let batches = 0;
  let meetings = 0;
  for (const [index, c] of DEMO_CAPTURES.entries()) {
    const participants = c.participants
      .map((name) => ({ name, contactId: contactIdByName.get(name) }))
      .filter((p): p is { name: string; contactId: string } => Boolean(p.contactId));
    if (participants.length === 0) continue;

    const at = atEasternHour(ago(c.daysAgo), CAPTURE_HOURS_ET[index % CAPTURE_HOURS_ET.length]);
    const batchId = randomUUID();
    const sessionId = c.meeting ? randomUUID() : null;
    const withIds = participants.map((p) => ({ ...p, interactionId: randomUUID() }));

    await db.insert(interactions).values(
      withIds.map((p, i) => ({
        id: p.interactionId,
        userId,
        contactId: p.contactId,
        interactionType: c.interactionType,
        interactionDate: at,
        sameDayOrder: i,
        source: c.kind === "calendar" ? "google_calendar" : "ai_capture",
        noteBatchId: batchId,
        rawNotes: c.text,
        topics: c.topics,
      }))
    );

    const mentions = withIds.flatMap((p) =>
      withIds
        .filter((o) => o.contactId !== p.contactId)
        .map((o) => ({
          interactionId: p.interactionId,
          contactId: o.contactId,
          text: o.name,
          confidence: 1,
          matchedBy: "exact_name" as const,
        }))
    );
    if (mentions.length) {
      await db
        .insert(interactionMentions)
        .values(mentions.map((m) => ({ userId, interactionId: m.interactionId, contactId: m.contactId, mentionText: m.text, confidence: m.confidence, matchedBy: m.matchedBy })))
        .onConflictDoNothing();
    }

    const result: NoteBatchResult = {
      participants: withIds.map((p) => ({
        contactId: p.contactId,
        interactionId: p.interactionId,
        name: p.name,
        created: false,
        duplicate: false,
      })),
      mentions,
      unresolvedMentions: [],
      actionItems: [],
      reminders: [],
      skipped: { relative: 0, unverifiable: 0, past: 0, duplicate: 0 },
      ...(c.meeting && sessionId ? { meeting: meetingResult(c, sessionId, at) } : {}),
    };

    await db.insert(noteBatches).values({
      id: batchId,
      userId,
      sourceHash: sha256(c.text),
      sourceText: c.text,
      entryPoint: "capture",
      anchorDate: at,
      anchorBasis: "note",
      status: "saved",
      result,
      inputSources: [c.kind],
      createdAt: at,
    });
    batches += 1;

    if (c.meeting && sessionId) {
      const durationMs = c.meeting.durationMin * 60_000;
      await db.insert(meetingSessions).values({
        id: sessionId,
        userId,
        title: c.title,
        attendees: c.participants.map((name) => ({ name })),
        captureSurface: "tab",
        includesMic: 1,
        status: "saved",
        startedAt: at,
        endedAt: new Date(at.getTime() + durationMs),
        durationMs,
        lastSeq: c.meeting.transcript.length - 1,
        digest: {
          title: c.title,
          summary: c.meeting.summary,
          keyPoints: c.meeting.keyPoints,
          decisions: c.meeting.decisions,
          actionItems: c.meeting.actionItems.map((a) => ({ ...a, duePhrase: null, sourceExcerpt: null })),
          blockers: [],
          openQuestions: c.meeting.openQuestions.map((q) => ({ ...q, sourceExcerpt: null })),
          participants: c.participants.map((name) => ({ name, present: true, context: null })),
          datedQuotes: [],
          notes: c.text,
        },
        noteBatchId: batchId,
        createdAt: at,
        updatedAt: at,
      });
      const step = Math.floor(durationMs / c.meeting.transcript.length);
      await db.insert(meetingTranscriptSegments).values(
        c.meeting.transcript.map((line, seq) => ({
          sessionId,
          userId,
          seq,
          startMs: seq * step,
          endMs: (seq + 1) * step - 500,
          text: line.text,
          engine: "deepgram" as const,
          speaker: line.speaker,
        }))
      );
      meetings += 1;
    }
  }
  summary.captures = batches;
  summary.meetings = meetings;
}

/**
 * Daytime clock hours (US Eastern, where the demo network lives) for the captures, so the
 * history reads like a working week whatever time of night the seed happened to run.
 */
const CAPTURE_HOURS_ET = [17, 10, 14, 9, 16];

/** `day` moved to `hour` o'clock Eastern (EDT, UTC−4 — close enough for display). */
function atEasternHour(day: Date, hour: number) {
  const d = new Date(day);
  d.setUTCHours(hour + 4, [12, 40, 5, 25, 50][hour % 5], 0, 0);
  return d;
}

function meetingResult(c: DemoCapture, sessionId: string, at: Date): NonNullable<NoteBatchResult["meeting"]> {
  const m = c.meeting!;
  return {
    sessionId,
    title: c.title,
    summary: m.summary,
    keyPoints: m.keyPoints,
    decisions: m.decisions,
    actionItems: m.actionItems,
    blockers: [],
    openQuestions: m.openQuestions,
    durationMs: m.durationMin * 60_000,
    startedAtIso: at.toISOString(),
  };
}

/* ----------------------------------------------------------------------------- mentions */

/**
 * Links every note that names another cast member to that person, both ways round on the
 * profile ("mentioned in" / "mentions"). Matching is on the full name only — first names
 * alone repeat across the network (two Marcuses) and would link the wrong person.
 */
async function seedMentions(
  userId: string,
  cast: ExtendedCast,
  contactIdByName: Map<string, string>,
  summary: Record<string, number>
) {
  const db = await getDb();
  const names = cast.people.flatMap((p) => {
    const contactId = contactIdByName.get(p.fullName)!;
    const bare = p.fullName.replace(/^Dr\.\s+/, "");
    return bare === p.fullName ? [{ text: p.fullName, contactId }] : [{ text: p.fullName, contactId }, { text: bare, contactId }];
  });

  const rows = await db
    .select({ id: interactions.id, contactId: interactions.contactId, rawNotes: interactions.rawNotes })
    .from(interactions)
    .where(and(eq(interactions.userId, userId), isNull(interactions.noteBatchId)));

  const mentions: (typeof interactionMentions.$inferInsert)[] = [];
  for (const row of rows) {
    const notes = row.rawNotes ?? "";
    const seen = new Set<string>();
    for (const n of names) {
      if (n.contactId === row.contactId || seen.has(n.contactId) || !notes.includes(n.text)) continue;
      seen.add(n.contactId);
      mentions.push({ userId, interactionId: row.id, contactId: n.contactId, mentionText: n.text, confidence: 1, matchedBy: "exact_name" });
    }
  }
  if (mentions.length) await db.insert(interactionMentions).values(mentions).onConflictDoNothing();
  summary.mentions = mentions.length;
}

/* ------------------------------------------------------------------------ opportunities */

async function seedOpportunities(
  userId: string,
  contactIdByName: Map<string, string>,
  now: number,
  summary: Record<string, number>
) {
  const db = await getDb();
  const rows = DEMO_OPPORTUNITIES.flatMap((o) => {
    const contactId = contactIdByName.get(o.person);
    if (!contactId) return [];
    return [
      {
        userId,
        contactId,
        kind: o.kind,
        label: o.label,
        status: o.status,
        direction: o.direction ?? null,
        sourceExcerpt: o.excerpt,
        dueDate: o.dueInDays == null ? null : new Date(now + o.dueInDays * DAY),
        confidenceScore: 90,
        createdBy: "ai" as const,
        itemHash: sha256(`demo-opportunity:${o.person}:${o.label}`),
        closedAt: o.status === "landed" ? new Date(now - 20 * DAY) : null,
      },
    ];
  });
  if (rows.length) await db.insert(contactOpportunities).values(rows).onConflictDoNothing();
  summary.opportunities = rows.length;
}

/* ------------------------------------------------------------------------------ imports */

/** One of every import a connected account accumulates, so /imports has a real history. */
async function seedMoreImports(
  userId: string,
  cast: ExtendedCast,
  ago: (d: number) => Date,
  summary: Record<string, number>
) {
  const db = await getDb();
  const from = (source: LongTailSource) => cast.people.filter((p) => cast.contactSource.get(p.fullName) === source).length;
  const done = (daysAgo: number) => ({ status: "completed", createdAt: ago(daysAgo), updatedAt: ago(daysAgo) });
  const rows: (typeof imports.$inferInsert)[] = [
    {
      userId,
      importType: "google_contacts",
      fileName: "Google Contacts",
      totalRows: 148,
      rowsProcessed: 148,
      contactsCreated: from("google_contacts"),
      contactsUpdated: 11,
      duplicatesFound: 9,
      stats: { skipped: 3 },
      ...done(96),
    },
    {
      userId,
      importType: "outlook_contacts",
      fileName: "Outlook Contacts",
      totalRows: 37,
      rowsProcessed: 37,
      contactsCreated: from("outlook_contacts"),
      contactsUpdated: 4,
      duplicatesFound: 6,
      stats: { skipped: 0 },
      ...done(81),
    },
    {
      userId,
      importType: "linkedin_messages",
      fileName: "messages.csv",
      totalRows: 412,
      rowsProcessed: 412,
      contactsCreated: 0,
      contactsUpdated: 31,
      duplicatesFound: 0,
      stats: { messagesImported: 412, skipped: 0 },
      ...done(64),
    },
    {
      userId,
      importType: "drive_docs",
      fileName: "6 Google Docs",
      totalRows: 6,
      rowsProcessed: 6,
      contactsCreated: 2,
      contactsUpdated: 7,
      duplicatesFound: 0,
      stats: { skipped: 0 },
      ...done(22),
    },
    {
      userId,
      importType: "gmail_recruiter_scan",
      fileName: "Gmail",
      totalRows: 214,
      rowsProcessed: 214,
      stats: { discoveryComplete: true, messagesScanned: 1_862, recruitersFound: 3 },
      ...done(2),
    },
  ];
  await db.insert(imports).values(rows);
  summary.imports = (summary.imports ?? 0) + rows.length;
}

/* -------------------------------------------------------------------------- connections */

/**
 * The integration artifacts that are real and harmless to create: an outbound calendar feed
 * (a hashed token; nothing is fetched unless someone subscribes) and two API keys whose
 * plaintext is discarded here, so no one can ever use them. OAuth connections are NOT among
 * them — those read as connected through `demo-workspace-connections.ts`, never a stored grant.
 */
async function seedConnectionArtifacts(userId: string, now: number, summary: Record<string, number>) {
  const db = await getDb();
  await mintCalendarFeedToken(userId);
  await db
    .update(userSettings)
    .set({ calendarFeedTokenCreatedAt: new Date(now - 58 * DAY), calendarFeedLastFetchedAt: new Date(now - 2 * HOUR) })
    .where(eq(userSettings.userId, userId));

  const keys = [
    { name: "Claude connector", kind: "mcp_url" as const, scopes: ["read", "write"] as Array<"read" | "write">, createdDaysAgo: 34, usedHoursAgo: 1 },
    { name: "Zapier", kind: "api" as const, scopes: ["read"] as Array<"read" | "write">, createdDaysAgo: 71, usedHoursAgo: 5 },
  ];
  await db.insert(apiKeys).values(
    keys.map((k) => {
      const key = generateApiKey(k.kind);
      return {
        userId,
        name: k.name,
        kind: k.kind,
        prefix: key.prefix,
        keyHash: key.keyHash,
        scopes: k.scopes,
        lastUsedAt: new Date(now - k.usedHoursAgo * HOUR),
        createdAt: new Date(now - k.createdDaysAgo * DAY),
      };
    })
  );
  summary.apiKeys = keys.length;
}

/* --------------------------------------------------------------------------------- chat */

/**
 * A thread answered the way chat answers today: the research steps it took, and citations
 * that open the notes they came from.
 */
async function seedGroundedChat(
  userId: string,
  contactIdByName: Map<string, string>,
  ago: (d: number) => Date,
  summary: Record<string, number>
) {
  const db = await getDb();
  const cite = async (person: string, match: string): Promise<EvidenceSource | null> => {
    const contactId = contactIdByName.get(person);
    if (!contactId) return null;
    const [row] = await db
      .select({ id: interactions.id, date: interactions.interactionDate })
      .from(interactions)
      .where(and(eq(interactions.userId, userId), eq(interactions.contactId, contactId), sql`${interactions.rawNotes} like ${`%${match}%`}`))
      .limit(1);
    return row
      ? { kind: "interaction", sourceId: row.id, contactId, date: row.date.toISOString().slice(0, 10) }
      : { kind: "contact", contactId };
  };

  const sources = [
    await cite("Nina Petrova", "first-engineer scorecard"),
    await cite("Daniel Osei", "talked me out of a bad first hire"),
    await cite("Victor Reyes", "prompting"),
    await cite("Amara Diallo", "candidate list"),
  ];
  const evidence: Record<string, EvidenceSource> = {};
  sources.forEach((s, i) => {
    if (s) evidence[`e${i + 1}`] = s;
  });

  const ref = (name: string) => ({ id: contactIdByName.get(name) ?? name, name, kind: "contact" as const });
  const activity: ChatStep[] = [
    { id: "understand", kind: "understand", label: "Understanding the question", detail: "Hiring · founding engineer", status: "done", ms: 410 },
    { id: "search", kind: "search", label: "Searching 85 contacts", detail: "Keyword, semantic and notes", status: "done", ms: 920 },
    {
      id: "rank",
      kind: "rank",
      label: "Ranking 4 people",
      status: "done",
      ms: 380,
      refs: [ref("Nina Petrova"), ref("Daniel Osei"), ref("Victor Reyes"), ref("Amara Diallo")],
    },
    { id: "answer", kind: "answer", label: "Writing the answer", status: "done", ms: 3100 },
  ];

  const at = ago(0.3);
  const [thread] = await db
    .insert(chatThreads)
    .values({ userId, title: "Who can help me hire a founding engineer?", createdAt: at, updatedAt: at })
    .returning();
  await db.insert(chatMessages).values([
    { threadId: thread.id, userId, role: "user", content: "Who can help me hire a founding engineer?", createdAt: at },
    {
      threadId: thread.id,
      userId,
      role: "assistant",
      content:
        "Start with Nina Petrova — she already sent you her first-engineer scorecard [e1] and is sending her offer template. Daniel Osei is the gut check: he talked you out of a bad first hire [e2] and offered to sit in on the final round. For candidates, Victor Reyes knows the UNC alumni pool and has seen how you work [e3], and Amara Diallo can open Bellwether's portfolio candidate list once they invest [e4].",
      activity,
      evidence,
      recommendations: [
        {
          contact_id: contactIdByName.get("Victor Reyes") ?? null,
          name: "Victor Reyes",
          reason: "Knows the UNC alumni pool and reviewed Orbit's prompting.",
          suggested_action: "Ask for two founding-engineer candidates",
          draft_message:
            "Hi Victor — we're hiring our founding engineer and I'd trust your read on anyone from the UNC alumni pool. Anyone come to mind?",
        },
        {
          contact_id: contactIdByName.get("Daniel Osei") ?? null,
          name: "Daniel Osei",
          reason: "Offered to sit in on a final round.",
          suggested_action: "Book him for the final interview",
          draft_message: null,
        },
      ],
      createdAt: new Date(at.getTime() + 9000),
    },
  ]);
  summary.chatThreads = (summary.chatThreads ?? 0) + 1;
}

/* ---------------------------------------------------------------------- first run + stamps */

/** No first-run prompt belongs on a workspace that has been in use for months. */
async function settleFirstRun(userId: string, now: number) {
  const db = await getDb();
  const long = new Date(now - 120 * DAY);
  await db
    .update(userSettings)
    .set({ wizardOfferedAt: long, wizardCompletedAt: long })
    .where(and(eq(userSettings.userId, userId), isNull(userSettings.wizardCompletedAt)));
  await db
    .update(userSettings)
    .set({ termsAcceptedAt: long, termsVersion: TERMS_VERSION })
    .where(and(eq(userSettings.userId, userId), isNull(userSettings.termsAcceptedAt)));
}

/**
 * Captures add interactions after the network was written, so each contact's first/last
 * interaction stamps are recomputed from what is actually on its timeline.
 */
async function settleInteractionStamps(userId: string) {
  const db = await getDb();
  await db.execute(sql`
    UPDATE contacts c SET
      first_interaction_at = s.first_at,
      last_interaction_at = s.last_at
    FROM (
      SELECT contact_id, min(interaction_date) AS first_at, max(interaction_date) AS last_at
      FROM interactions WHERE user_id = ${userId} GROUP BY contact_id
    ) s
    WHERE c.id = s.contact_id AND c.user_id = ${userId}
  `);
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
