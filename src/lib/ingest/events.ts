/**
 * The one write path every connector goes through.
 *
 * A connector's job is to produce `NetworkEvent`s. Resolving people to contacts, respecting
 * the plan's contact cap, minting idempotent external ids, widening interaction windows and
 * flagging embeddings are this module's job, done once, in bulk, the same way for every
 * source. That split is what makes "add another connector" mean "write a fetcher and a
 * mapper" rather than "reimplement the write path and hope it matches".
 *
 * ## Why this is not the import engine
 *
 * `import-engine.ts` already owns a semantic write path, and it is deliberately not reused
 * here. Its contract is that adapters are pure functions and the engine owns every SQL
 * statement, "which is the only way the per-chunk round-trip budget can be a property of the
 * system rather than a habit each importer has to remember". Routing engine writes through
 * this module would either push SQL behind an adapter — breaking that contract and the perf
 * guard that enforces it — or grow this module into a second engine.
 *
 * So there is one *semantic* write path with two drivers:
 *
 *   - staged `import_job_rows`   — resumable, progress-reporting, poison-row isolating.
 *     For a file a user uploaded, where the work is known up front.
 *   - streamed provider batches  — cursored, time-budgeted, no staging.
 *     For a sync that pulls until the provider says it is done.
 *
 * They share the four primitives where the duplication actually was: the duplicate index,
 * `createContactsBulkForUser`, `bulkMergeContactsForUser`, and `interactionExternalId`.
 *
 * ## Import restrictions
 *
 * No `next/server`, no `next/cache`, no Clerk. `internal-auth.ts` and `cron-runs.ts` both
 * record that importing `next/server` alone retains the Node event loop and hangs any `tsx`
 * script. This module is loaded by the sync scheduler, by smoke scripts, and (later) by an
 * HTTP route and MCP tools; `revalidatePath` belongs to whichever caller has a request.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interactions, reminders } from "@/db/schema";
import {
  DUPLICATE_MERGE_CONFIDENCE,
  addToDuplicateIndex,
  buildDuplicateIndex,
  findDuplicateCandidatesIndexed,
  type DuplicateIndex,
  type DuplicateSubject,
} from "@/lib/duplicates";
import {
  bulkMergeContactsForUser,
  contactHeadroomForUser,
  createContactsBulkForUser,
  type ContactInput,
} from "@/lib/contact-writes";
import { createCompanyResolver, type CompanyResolver } from "@/lib/companies";
import { interactionExternalId } from "@/lib/ingest/external-id";
import type { InteractionInsert, ReminderInsert } from "@/lib/import-engine";

/** One identifiable person on an event. Every field optional — sources differ in what they know. */
export type NetworkParticipant = {
  email?: string | null;
  name?: string | null;
  linkedinUrl?: string | null;
  handle?: string | null;
  phone?: string | null;
  company?: string | null;
  title?: string | null;
};

export type NetworkEventType = "meeting" | "email" | "message" | "call";

export type NetworkEvent = {
  /**
   * Namespace for this event's id, ALREADY prefixed by the producer — `cal:<iCalUID>` for
   * calendar. Ingest appends `:${contactId}`; producers must never do that themselves, or
   * two attendees of one meeting collide on `interactions_user_external_uidx`.
   */
  externalIdBase: string;
  type: NetworkEventType;
  timestamp: Date;
  participants: NetworkParticipant[];
  summary?: string | null;
  notes?: string | null;
  topics?: string[] | null;
};

export type IngestOptions = {
  /** Written to `interactions.source`, and the provenance badge in the timeline. */
  source: string;
  /**
   * Whether an unmatched participant becomes a new contact.
   *
   * Per-source on purpose, and the two calendar paths genuinely differ: the ongoing
   * subscription creates people it sees in your meetings, while the one-shot file import is
   * annotate-only (`calendarAdapter.createsContacts === false`) so that uploading a calendar
   * cannot push a free user over their contact limit.
   */
  createsContacts: boolean;
  /**
   * Confidence at or above which a match merges instead of creating.
   *
   * Calendar sources pass 0.6 — an attendee list is already strong evidence that a
   * name-only match is the same person, which is why `calendarAdapter` uses that figure.
   */
  matchConfidence?: number;
  interactionType?: string;
  /**
   * Reminders this source wants alongside each logged interaction — today, the ICS
   * subscription's post-meeting follow-ups.
   *
   * Pure, like the import engine's equivalent: it returns rows and ingest owns the SQL, so a
   * source cannot accidentally make the write path per-row. Deduped in bulk on
   * `(contactId, description)`, which is why the description must be deterministic for a
   * given (event, contact) — a re-sync then reproduces byte-identical candidates and they
   * are filtered out instead of piling up.
   */
  reminders?: (event: NetworkEvent, contactId: string, userId: string) => ReminderInsert[];
  /**
   * Report which contact each participant resolved to, in `IngestStats.resolutions`.
   *
   * Opt-in so no existing caller pays for the extra array. Added for the events feature,
   * which has to write `event_attendees.contact_id` back after a connect and otherwise has
   * no way to learn the mapping: `IngestStats` is counts only.
   *
   * The alternatives were both worse. Re-probing with `findDuplicateCandidatesIndexed` after
   * the fact runs the matcher a SECOND time against an index this function has since mutated,
   * so it could legitimately disagree with the answer actually used — and this module's own
   * comments warn that a write path must never be where that divergence is discovered.
   * Parsing the contact id back out of `external_id` reverses a format `external-id.ts`
   * explicitly calls a data contract. Ingest is the only code that legitimately knows this
   * mapping, so it is the code that should say.
   */
  reportResolutions?: boolean;
  /**
   * Written to `contacts.met_context` / `how_met` on contacts this run CREATES.
   *
   * Only on create: `bulkMergeContactsForUser` COALESCEs, so an existing contact keeps
   * whatever story it already had rather than having it rewritten by a later source.
   */
  metContext?: string;
  howMet?: (event: NetworkEvent) => string | null;
};

export type IngestStats = {
  eventsSeen: number;
  contactsCreated: number;
  contactsMatched: number;
  interactionsLogged: number;
  /** Participants nothing matched, on a source that does not create contacts. */
  unmatched: number;
  /** Participants that would have been created but for the plan's contact cap. */
  blockedByPlan: number;
  remindersCreated: number;
  /** Populated only when `IngestOptions.reportResolutions` is set. */
  resolutions?: Array<{ participant: NetworkParticipant; contactId: string }>;
};

export type IngestContext = {
  userId: string;
  options: Required<Pick<IngestOptions, "source" | "createsContacts" | "matchConfidence">> &
    IngestOptions;
  index: DuplicateIndex;
  companyResolve: CompanyResolver;
  /** Remaining contact allowance, or null for unlimited. Decremented locally as we create. */
  headroom: number | null;
  touchedContactIds: Set<string>;
};

function emptyStats(): IngestStats {
  return {
    eventsSeen: 0,
    contactsCreated: 0,
    contactsMatched: 0,
    interactionsLogged: 0,
    unmatched: 0,
    blockedByPlan: 0,
    remindersCreated: 0,
  };
}

/**
 * Identity key used to collapse duplicate participant entries *within a single event*.
 *
 * Strongest available signal wins. This is only about "are these two attendee lines the same
 * person" — cross-contact matching is the duplicate index's job, and this must not try to be
 * a second, weaker version of it.
 */
function participantIdentityKey(p: NetworkParticipant): string | null {
  const linkedin = p.linkedinUrl?.trim().toLowerCase();
  if (linkedin) return `li:${linkedin}`;
  const email = p.email?.trim().toLowerCase();
  if (email) return `em:${email}`;
  const handle = p.handle?.trim().toLowerCase();
  if (handle) return `hd:${handle}`;
  const name = p.name?.trim().toLowerCase().replace(/\s+/g, " ");
  if (name) return `nm:${name}`;
  return null;
}

/**
 * Combine one more event into the patch already accumulated for a contact in this batch.
 *
 * Windows take the extremes — `bulkMergeContactsForUser` widens with LEAST/GREATEST against
 * what is already stored, but it can only see the single row we hand it, so the batch has to
 * arrive pre-widened. Scalars keep the first non-empty value: enrichment fills blanks, and
 * the merge itself COALESCEs, so nothing a user typed is ever overwritten.
 */
function foldMerge(into: Partial<ContactInput>, pair: { event: NetworkEvent; participant: NetworkParticipant }): Partial<ContactInput> {
  const at = pair.event.timestamp;
  const firstAt = into.firstInteractionAt ? new Date(into.firstInteractionAt) : null;
  const lastAt = into.lastInteractionAt ? new Date(into.lastInteractionAt) : null;
  return {
    email: into.email ?? (pair.participant.email?.trim() || undefined),
    company: into.company ?? (pair.participant.company?.trim() || undefined),
    title: into.title ?? (pair.participant.title?.trim() || undefined),
    firstInteractionAt: firstAt && firstAt <= at ? firstAt : at,
    lastInteractionAt: lastAt && lastAt >= at ? lastAt : at,
  };
}

function toContactInput(
  p: NetworkParticipant,
  source: string,
  extra?: { metContext?: string; howMet?: string | null }
): ContactInput {
  return {
    metContext: extra?.metContext,
    howMet: extra?.howMet ?? undefined,
    fullName: (p.name || p.email || "").trim(),
    email: p.email?.trim() || undefined,
    linkedinUrl: p.linkedinUrl?.trim() || undefined,
    xHandle: p.handle?.trim() || undefined,
    phone: p.phone?.trim() || undefined,
    company: p.company?.trim() || undefined,
    title: p.title?.trim() || undefined,
    source,
  };
}

/**
 * Everything expensive, done once per run rather than once per batch.
 *
 * The duplicate index is a full read of the user's contacts, and the company resolver and
 * headroom check are each a query. A sync that pulls twenty pages must not pay for those
 * twenty times — hoisting them here is what keeps the per-batch cost flat.
 */
export async function openIngestContext(
  userId: string,
  options: IngestOptions
): Promise<IngestContext> {
  const db = await getDb();

  // The same seven narrow columns the import engine reads. Deliberately not `select *`:
  // `DuplicateSubject` is kept small so a batch never drags notes and summaries across the
  // wire for people it is not going to touch.
  const existing = (await db.query.contacts.findMany({
    where: (c, { eq }) => eq(c.userId, userId),
    columns: {
      id: true,
      fullName: true,
      email: true,
      linkedinUrl: true,
      xHandle: true,
      company: true,
      title: true,
    },
  })) as DuplicateSubject[];

  return {
    userId,
    options: {
      ...options,
      matchConfidence: options.matchConfidence ?? DUPLICATE_MERGE_CONFIDENCE,
      source: options.source,
      createsContacts: options.createsContacts,
    },
    index: buildDuplicateIndex(existing),
    companyResolve: await createCompanyResolver(userId),
    headroom: options.createsContacts ? await contactHeadroomForUser(userId) : null,
    touchedContactIds: new Set(),
  };
}

/**
 * Write one batch of events.
 *
 * Costs 3 statements in the steady state — create, merge, insert interactions — regardless of
 * batch size, against the engine's guarded budgets of 14 (create) and 9 (merge). Anything
 * that would make this per-row is a bug, not a tuning question.
 */
export async function ingestEvents(
  ctx: IngestContext,
  events: NetworkEvent[]
): Promise<IngestStats> {
  const stats = emptyStats();
  if (events.length === 0) return stats;
  stats.eventsSeen = events.length;

  type Pair = { event: NetworkEvent; participant: NetworkParticipant };
  const pairs: Pair[] = [];
  for (const event of events) {
    // Collapse repeated entries for one person within this event — the organizer who is also
    // listed as an attendee is the common case.
    const seen = new Set<string>();
    for (const participant of event.participants) {
      const key = participantIdentityKey(participant);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      pairs.push({ event, participant });
    }
  }
  if (pairs.length === 0) return stats;

  /**
   * Both accumulators are keyed, not appended to blindly, and that is load-bearing.
   *
   * A single batch routinely contains the same person more than once — a colleague in three
   * of this week's meetings. Emitting one merge row per (event, participant) would hand
   * `bulkMergeContactsForUser` several VALUES rows for one contact id, and its single
   * `UPDATE ... FROM (VALUES ...)` applies exactly one of them: the other events' window
   * contributions are silently dropped, so a batch containing both an old and a new meeting
   * would widen the interaction window in only one direction. Likewise, a person who is new
   * to the network and appears in two events would be pushed to `toCreate` twice and created
   * twice, because the duplicate index cannot know about them until after the insert returns.
   *
   * So merges fold per contact (windows by min/max, scalars first-non-empty) and creates fold
   * per participant identity, with every contributing pair remembered so each event still
   * logs its own interaction.
   */
  const toCreate: Array<{ input: ContactInput; pairs: Pair[] }> = [];
  const createIndexByKey = new Map<string, number>();
  const mergeByContactId = new Map<string, { input: Partial<ContactInput>; pairs: Pair[] }>();
  const resolved: Array<{ pair: Pair; contactId: string }> = [];

  for (const pair of pairs) {
    const probe = {
      fullName: pair.participant.name ?? null,
      email: pair.participant.email ?? null,
      linkedinUrl: pair.participant.linkedinUrl ?? null,
      xHandle: pair.participant.handle ?? null,
      company: pair.participant.company ?? null,
      title: pair.participant.title ?? null,
    };
    // The INDEXED matcher only. The linear `findDuplicateCandidates` scores a bare full-name
    // match at 0.6 and differs in its fuzzy branch; the two are not interchangeable, and a
    // write path must never be the place that discovers it.
    const [best] = findDuplicateCandidatesIndexed(ctx.index, probe);

    if (best && best.confidence >= ctx.options.matchConfidence) {
      const contactId = best.contact.id;
      const existing = mergeByContactId.get(contactId);
      if (existing) {
        existing.pairs.push(pair);
        existing.input = foldMerge(existing.input, pair);
      } else {
        stats.contactsMatched++;
        mergeByContactId.set(contactId, {
          input: foldMerge({}, pair),
          pairs: [pair],
        });
      }
      resolved.push({ pair, contactId });
      continue;
    }

    if (!ctx.options.createsContacts) {
      stats.unmatched++;
      continue;
    }

    const key = participantIdentityKey(pair.participant);
    const pending = key === null ? undefined : createIndexByKey.get(key);
    if (pending !== undefined) {
      // Already being created by an earlier event in this batch — attach, do not re-create.
      toCreate[pending].pairs.push(pair);
      continue;
    }

    if (ctx.headroom !== null && ctx.headroom - toCreate.length <= 0) {
      stats.blockedByPlan++;
      continue;
    }
    const input = toContactInput(pair.participant, ctx.options.source, {
      metContext: ctx.options.metContext,
      howMet: ctx.options.howMet?.(pair.event) ?? null,
    });
    if (!input.fullName) {
      stats.unmatched++;
      continue;
    }
    if (key !== null) createIndexByKey.set(key, toCreate.length);
    toCreate.push({ input, pairs: [pair] });
  }

  // 1 statement (plus the resolver's primed lookups, which are per-batch, not per-row).
  if (toCreate.length > 0) {
    const created = await createContactsBulkForUser(
      ctx.userId,
      // Date the new contact from the events that produced it, never from `now`.
      // `contactInsertValues` defaults both interaction columns to the current time when no
      // `dateMet` is supplied, and `contacts.last_interaction_at` is read directly by the
      // closeness cohort — so a person first seen in a meeting three months ago would
      // otherwise be scored as maximally recent the moment a sync discovered them, which is
      // precisely the false signal continuous sync exists to avoid.
      //
      // `dateMet` drives `last_interaction_at` on insert, so it takes the LATEST event;
      // `firstInteractionAt` is honoured verbatim and takes the earliest.
      toCreate.map((c) => {
        const times = c.pairs.map((pair) => pair.event.timestamp.getTime());
        return {
          ...c.input,
          dateMet: new Date(Math.max(...times)).toISOString(),
          firstInteractionAt: new Date(Math.min(...times)),
        };
      }),
      ctx.companyResolve,
      {
        skipRevalidate: true,
        skipEmbedding: true,
        skipSummary: true,
        skipCloseness: true,
        headroom: ctx.headroom ?? undefined,
      }
    );
    stats.contactsCreated = created.length;
    created.forEach((contact, i) => {
      // Fold new contacts into the index so a LATER batch matches them rather than creating
      // the person again. Within this batch, `createIndexByKey` already did that job.
      addToDuplicateIndex(ctx.index, contact as DuplicateSubject);
      for (const pair of toCreate[i]?.pairs ?? []) {
        resolved.push({ pair, contactId: contact.id });
      }
    });
    if (ctx.headroom !== null) ctx.headroom -= created.length;
    // Fewer created than asked for means the cap bit part-way through the batch.
    stats.blockedByPlan += toCreate.length - created.length;
  }

  // 1 statement.
  if (mergeByContactId.size > 0) {
    await bulkMergeContactsForUser(
      ctx.userId,
      [...mergeByContactId.entries()].map(([contactId, m]) => ({ contactId, input: m.input })),
      ctx.companyResolve
    );
  }

  // 1 statement.
  if (resolved.length > 0) {
    const rows: InteractionInsert[] = resolved.map(({ pair, contactId }) => ({
      userId: ctx.userId,
      contactId,
      interactionType: ctx.options.interactionType ?? pair.event.type,
      interactionDate: pair.event.timestamp,
      source: ctx.options.source,
      externalId: interactionExternalId(pair.event.externalIdBase, contactId),
      rawNotes: pair.event.notes ?? null,
      aiSummary: pair.event.summary ?? null,
      topics: pair.event.topics ?? null,
    }));

    // Intra-batch dedupe, copied from the import engine and equally load-bearing here.
    // `ON CONFLICT DO UPDATE` raises "cannot affect row a second time" when one INSERT's own
    // VALUES hits the same conflict target twice — and two attendee entries that survive
    // `participantIdentityKey` (one email-only, one name-only) can still resolve to the SAME
    // existing contact through the duplicate index, producing the same external id. Last one
    // in row order wins.
    const byExternalId = new Map<string, InteractionInsert>();
    for (const row of rows) byExternalId.set(row.externalId as string, row);
    const deduped = [...byExternalId.values()];

    const db = await getDb();
    const logged = await db
      .insert(interactions)
      .values(deduped)
      .onConflictDoUpdate({
        target: [interactions.userId, interactions.externalId],
        targetWhere: sql`${interactions.externalId} is not null`,
        set: {
          interactionDate: sql`excluded.interaction_date`,
          rawNotes: sql`excluded.raw_notes`,
          aiSummary: sql`excluded.ai_summary`,
          topics: sql`excluded.topics`,
          source: sql`excluded.source`,
        },
      })
      .returning();
    stats.interactionsLogged = logged.length;
    for (const { contactId } of resolved) ctx.touchedContactIds.add(contactId);

    // 0-2 statements. A separate insert rather than folded into the one above: `reminders`
    // is a different table, and unlike `interactions.externalId` it has no soft-unique column
    // to lean an upsert on. So it dedupes the way the import engine does — one SELECT scoped
    // to the contacts this batch actually touched, then an exact (contactId, description)
    // match — rather than a per-row existence check.
    if (ctx.options.reminders) {
      const candidates: ReminderInsert[] = [];
      for (const { pair, contactId } of resolved) {
        candidates.push(...ctx.options.reminders(pair.event, contactId, ctx.userId));
      }
      if (candidates.length > 0) {
        const contactIds = [
          ...new Set(
            candidates
              .map((r) => r.contactId)
              .filter((cid): cid is string => typeof cid === "string")
          ),
        ];
        const db2 = await getDb();
        const existing = contactIds.length
          ? await db2.query.reminders.findMany({
              where: and(eq(reminders.userId, ctx.userId), inArray(reminders.contactId, contactIds)),
              columns: { contactId: true, description: true },
            })
          : [];
        const seen = new Set(existing.map((r) => `${r.contactId}::${r.description ?? ""}`));
        // Also dedupe within the batch, so two events for one contact cannot insert the same
        // reminder twice in a single run.
        const fresh = candidates.filter((r) => {
          const key = `${r.contactId}::${r.description ?? ""}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (fresh.length > 0) {
          const created = await db2.insert(reminders).values(fresh).returning();
          stats.remindersCreated = created.length;
        }
      }
    }
  }

  if (ctx.options.reportResolutions) {
    stats.resolutions = resolved.map(({ pair, contactId }) => ({
      participant: pair.participant,
      contactId,
    }));
  }

  return stats;
}

/**
 * Once per run, never per batch.
 *
 * Each of these is either a full-network read or an AI round trip; the import engine already
 * learned that calling them per chunk is how a large job becomes slow. Closeness is marked
 * dirty rather than recalculated — `process-stalled` drains stale cohorts in batches, which
 * is the existing debounce and stops a sync storm from triggering a recalibration storm.
 */
export async function finalizeIngest(ctx: IngestContext): Promise<void> {
  if (ctx.touchedContactIds.size === 0) return;
  const { markCohortDirty } = await import("@/lib/closeness-materialize");
  const { kickEmbeddingBackfill } = await import("@/lib/embedding-backfill");
  await markCohortDirty(ctx.userId).catch(() => null);
  await kickEmbeddingBackfill(ctx.userId).catch(() => null);
}
