/**
 * Job moves: noticing that a contact changed jobs, and remembering it.
 *
 * `contact_experiences` is replaced wholesale on every capture, and `contacts.title` /
 * `company` are overwritten in place, so without this Orbit only ever knows where someone
 * works *now*. Each time a fresh work history arrives, `detectJobChanges` compares it with
 * what was stored and `recordJobChanges` writes the difference to `contact_job_changes` —
 * a log no later capture rewrites — and acts on it: the contact's title/company follow the
 * new role, the timeline gets an entry, and the dashboard offers a congratulations.
 *
 * ## What counts as a move
 *
 * Employers are compared by family (`companyFamilyRoot`, so Google → Google DeepMind is not
 * a move) and otherwise by `normalizeCompanyKey`. Deliberately NOT `companyFamilyKey`: its
 * first-word fallback would make Bank of America → Bank of Montreal the same employer.
 *
 * Web search is the usual source, and search results lag and disagree. So a move is only
 * recorded against a real baseline (a first capture is not a move), never onto a role that
 * started before the one it would replace (a stale snippet), and never back onto an
 * employer the log says they left within {@link FLAP_WINDOW_DAYS} (two sources
 * disagreeing, not two moves). "Left" needs positive evidence — the old role now shows an
 * end — because a search that simply didn't surface a role proves nothing.
 *
 * Auth-free and free of `next/server`, like `note-batch-save.ts`, so the smoke suite can
 * drive it against PGlite.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  aiSuggestions,
  contactExperiences,
  contactJobChanges,
  contacts,
  interactions,
  type ContactJobChangeKind,
  type ContactProfileSource,
} from "@/db/schema";
import { companyFamilyRoot } from "@/lib/company-family";
import { normalizeCompanyKey } from "@/lib/company-name";
import type { IncomingExperience } from "@/lib/contact-profile";
import { jobChangeSentence, sanitizeProfileLine } from "@/lib/contact-profile-format";
import type { FieldChange } from "@/lib/extension/contract";
import { updateContactForUser } from "@/lib/contact-writes";
import { AI_DERIVED_SOURCE } from "@/lib/interaction-provenance";

/** A move back onto an employer they left this recently is sources disagreeing. */
export const FLAP_WINDOW_DAYS = 180;
/**
 * A role that started longer ago than this is history, not news: no congratulations. The
 * first search after a long gap can find a move a year late, and "congrats!" then is odd.
 */
export const CONGRATS_MAX_AGE_MONTHS = 6;
/** How far back the brief and chat's "Recent moves" line looks. */
export const RECENT_MOVES_DAYS = 365;

export const JOB_CHANGE_SUGGESTION_TYPE = "job_change_congrats";
export const JOB_CHANGE_INTERACTION_TYPE = "job_change";
export { jobChangeSentence };

/** One role in a snapshot, the only fields comparison needs. */
export type SnapshotRole = {
  organization: string;
  title: string | null;
  startYear: number | null;
  startMonth: number | null;
  isCurrent: boolean;
};

export type JobBaseline = {
  /** False when nothing is known about where they work — then nothing can be a move. */
  hasBaseline: boolean;
  roles: SnapshotRole[];
  /** Employer keys the log says they left inside the flap window. */
  recentlyLeft: Set<string>;
};

export type DetectedJobChange = {
  kind: ContactJobChangeKind;
  fromOrg: string | null;
  fromTitle: string | null;
  toOrg: string | null;
  toTitle: string | null;
  startedYear: number | null;
  startedMonth: number | null;
  dedupeKey: string;
};

export type StoredJobChange = DetectedJobChange & {
  id: string;
  source: ContactProfileSource;
  detectedAt: Date;
};

/** The key two employer names are compared by. Empty for a blank name. */
export function employerKey(org: string | null | undefined): string {
  if (!org?.trim()) return "";
  return companyFamilyRoot(org) ?? normalizeCompanyKey(org);
}

function titleKey(title: string | null | undefined): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Year-month as one comparable number; null when the year is unknown. */
function startOrdinal(role: { startYear: number | null; startMonth: number | null }): number | null {
  if (role.startYear === null) return null;
  return role.startYear * 12 + (role.startMonth ?? 1);
}

function hashKey(parts: Array<string | number | null>): string {
  return createHash("sha256")
    .update(parts.map((p) => (p === null ? "" : String(p))).join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

/**
 * The moves between a stored snapshot and a fresh work history. Pure.
 *
 * Returns nothing without a baseline, so a contact's first-ever history never reads as a
 * string of career changes.
 */
export function detectJobChanges(before: JobBaseline, after: IncomingExperience[]): DetectedJobChange[] {
  if (!before.hasBaseline) return [];

  const prevCurrent = before.roles.filter((r) => r.isCurrent && employerKey(r.organization));
  const nextRoles = after.filter((e) => e.kind === "role" && employerKey(e.organization));
  const nextCurrent = nextRoles.filter((e) => e.isCurrent);
  const prevKeys = new Set(prevCurrent.map((r) => employerKey(r.organization)));
  const nextKeys = new Set(nextCurrent.map((e) => employerKey(e.organization)));

  const changes: DetectedJobChange[] = [];

  // The role a new job most plausibly replaced: a previous current employer that is no
  // longer current. Null when they added a role alongside the old one.
  const replaced = prevCurrent.find((r) => !nextKeys.has(employerKey(r.organization))) ?? null;
  const latestPrevStart = Math.max(
    -Infinity,
    ...prevCurrent.map((r) => startOrdinal(r) ?? -Infinity)
  );

  for (const role of nextCurrent) {
    const key = employerKey(role.organization);
    if (prevKeys.has(key)) {
      // Same employer family: a new title there is a promotion or a change of role.
      const prev = prevCurrent.find((r) => employerKey(r.organization) === key)!;
      if (prev.title && role.title && titleKey(prev.title) !== titleKey(role.title)) {
        changes.push({
          kind: "title_change",
          fromOrg: prev.organization,
          fromTitle: prev.title,
          toOrg: role.organization,
          toTitle: role.title,
          startedYear: role.startYear,
          startedMonth: role.startMonth,
          dedupeKey: hashKey(["title_change", key, titleKey(prev.title), titleKey(role.title)]),
        });
      }
      continue;
    }
    // A stale snippet: a "current" role that began before the one it would replace.
    const start = startOrdinal(role);
    if (start !== null && Number.isFinite(latestPrevStart) && start < latestPrevStart) continue;
    // Sources disagreeing: back onto an employer they were logged as leaving recently.
    if (before.recentlyLeft.has(key)) continue;
    changes.push({
      kind: "joined",
      fromOrg: replaced?.organization ?? null,
      fromTitle: replaced?.title ?? null,
      toOrg: role.organization,
      toTitle: role.title,
      startedYear: role.startYear,
      startedMonth: role.startMonth,
      dedupeKey: hashKey(["joined", employerKey(replaced?.organization), key, titleKey(role.title)]),
    });
  }

  // "Left" only on positive evidence — the old role now carries an end — and only when no
  // new job already records the departure as its "from".
  if (!changes.some((c) => c.kind === "joined")) {
    for (const prev of prevCurrent) {
      const key = employerKey(prev.organization);
      if (nextKeys.has(key)) continue;
      const ended = nextRoles.find((e) => employerKey(e.organization) === key && !e.isCurrent);
      if (!ended) continue;
      changes.push({
        kind: "left",
        fromOrg: prev.organization,
        fromTitle: prev.title,
        toOrg: null,
        toTitle: null,
        startedYear: ended.endYear,
        startedMonth: ended.endMonth,
        dedupeKey: hashKey(["left", key, ended.endYear]),
      });
    }
  }

  return changes;
}

/**
 * What is stored about where this contact works, for `detectJobChanges` to compare with.
 * Reads the snapshot BEFORE the new capture replaces it.
 */
export async function loadJobBaseline(
  userId: string,
  contactId: string,
  now: Date = new Date()
): Promise<JobBaseline> {
  const db = await getDb();
  const since = new Date(now.getTime() - FLAP_WINDOW_DAYS * 86_400_000);
  const [stored, contact, recent] = await Promise.all([
    db
      .select({
        organization: contactExperiences.organization,
        title: contactExperiences.title,
        startYear: contactExperiences.startYear,
        startMonth: contactExperiences.startMonth,
        isCurrent: contactExperiences.isCurrent,
      })
      .from(contactExperiences)
      .where(
        and(
          eq(contactExperiences.userId, userId),
          eq(contactExperiences.contactId, contactId),
          eq(contactExperiences.kind, "role")
        )
      ),
    db.query.contacts.findFirst({
      where: and(eq(contacts.userId, userId), eq(contacts.id, contactId)),
      columns: { title: true, company: true },
    }),
    db
      .select({ fromOrg: contactJobChanges.fromOrg })
      .from(contactJobChanges)
      .where(
        and(
          eq(contactJobChanges.userId, userId),
          eq(contactJobChanges.contactId, contactId),
          gte(contactJobChanges.detectedAt, since)
        )
      ),
  ]);

  const recentlyLeft = new Set(recent.map((r) => employerKey(r.fromOrg)).filter(Boolean));
  if (stored.length) return { hasBaseline: true, roles: stored, recentlyLeft };
  // No stored history: the contact's own title/company is the baseline — typed by the
  // user, or from their LinkedIn export — as long as it names an employer.
  if (contact?.company?.trim()) {
    return {
      hasBaseline: true,
      roles: [
        {
          organization: contact.company,
          title: contact.title,
          startYear: null,
          startMonth: null,
          isCurrent: true,
        },
      ],
      recentlyLeft,
    };
  }
  return { hasBaseline: false, roles: [], recentlyLeft };
}

/**
 * Log detected moves and act on them. Returns the moves that were new — a re-detection of
 * a logged move writes nothing and triggers nothing.
 *
 * Order matters: the log insert is the arbiter, so everything after it runs only for rows
 * it actually inserted. Each follow-on is best-effort; the log is the record.
 */
export async function recordJobChanges(
  userId: string,
  contactId: string,
  changes: DetectedJobChange[],
  options: { source: ContactProfileSource; now?: Date }
): Promise<DetectedJobChange[]> {
  if (!changes.length) return [];
  const now = options.now ?? new Date();
  const db = await getDb();

  const inserted = await db
    .insert(contactJobChanges)
    .values(
      changes.map((c) => ({
        userId,
        contactId,
        kind: c.kind,
        fromOrg: c.fromOrg,
        fromTitle: c.fromTitle,
        toOrg: c.toOrg,
        toTitle: c.toTitle,
        startedYear: c.startedYear,
        startedMonth: c.startedMonth,
        source: options.source,
        dedupeKey: c.dedupeKey,
        detectedAt: now,
      }))
    )
    .onConflictDoNothing({
      target: [contactJobChanges.userId, contactJobChanges.contactId, contactJobChanges.dedupeKey],
    })
    // Bare: a field selector defeats Drizzle's overload resolution against the union `Db`
    // type (the trap noted in action-items.ts).
    .returning();
  const fresh = new Set(inserted.map((r) => r.dedupeKey));
  const newChanges = changes.filter((c) => fresh.has(c.dedupeKey));
  if (!newChanges.length) return [];

  // 1. The contact follows the new role, so lists, search and the graph show where they
  //    are now. The old values live on in the log.
  const current = newChanges.find((c) => c.kind === "joined") ?? newChanges.find((c) => c.kind === "title_change");
  if (current?.toOrg) {
    await updateContactForUser(
      userId,
      contactId,
      { company: current.toOrg, ...(current.toTitle ? { title: current.toTitle } : {}) },
      { skipRevalidate: true, skipEmbedding: true, skipSummary: true }
    ).catch(() => null);
  }

  // 2. The timeline. AI_DERIVED_SOURCE keeps it out of last-touch and closeness — they
  //    changed jobs; nobody talked to anybody.
  await db
    .insert(interactions)
    .values(
      newChanges.map((c) => ({
        userId,
        contactId,
        interactionType: JOB_CHANGE_INTERACTION_TYPE,
        interactionDate: now,
        source: AI_DERIVED_SOURCE,
        externalId: `job-change:${contactId}:${c.dedupeKey}`,
        rawNotes: jobChangeSentence(c),
        aiSummary: jobChangeSentence(c),
        topics: [],
        sameDayOrder: 0,
      }))
    )
    .onConflictDoNothing({
      target: [interactions.userId, interactions.externalId],
      where: sql`${interactions.externalId} is not null`,
    })
    .catch(() => null);

  // 3. A congratulations nudge — for news only: a move they made recently, not a move the
  //    first search after a long gap happened to find years late, and never for leaving.
  const nowOrdinal = now.getFullYear() * 12 + now.getMonth() + 1;
  const nudge = newChanges.find((c) => {
    if (c.kind === "left") return false;
    // An unknown month counts as December: the generous reading of "started in 2026".
    const started = c.startedYear === null ? null : c.startedYear * 12 + (c.startedMonth ?? 12);
    return started === null || nowOrdinal - started <= CONGRATS_MAX_AGE_MONTHS;
  });
  if (nudge) {
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.userId, userId), eq(contacts.id, contactId)),
      columns: { fullName: true },
    });
    const name = contact?.fullName?.split(/\s+/)[0] || "They";
    await db
      .insert(aiSuggestions)
      .values({
        userId,
        suggestionType: JOB_CHANGE_SUGGESTION_TYPE,
        title:
          nudge.kind === "title_change"
            ? `${name} has a new role at ${nudge.toOrg}`
            : `${name} joined ${nudge.toOrg}`,
        description: `${jobChangeSentence(nudge)} — a good moment to congratulate them.`,
        relatedContactIds: [contactId],
        // Detected from web search, not a model's opinion of the relationship: steady and
        // equal for every row, so ordering falls back to recency.
        confidenceScore: 70,
        status: "pending",
      })
      .catch(() => null);
  }

  return newChanges;
}

/** A contact's logged moves, newest first. */
export async function getJobChanges(userId: string, contactId: string): Promise<StoredJobChange[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(contactJobChanges)
    .where(and(eq(contactJobChanges.userId, userId), eq(contactJobChanges.contactId, contactId)))
    .orderBy(desc(contactJobChanges.detectedAt));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    fromOrg: r.fromOrg,
    fromTitle: r.fromTitle,
    toOrg: r.toOrg,
    toTitle: r.toTitle,
    startedYear: r.startedYear,
    startedMonth: r.startedMonth,
    dedupeKey: r.dedupeKey,
    source: r.source,
    detectedAt: r.detectedAt,
  }));
}

/**
 * One "Recent moves" line per contact for the brief and chat: the last year's moves,
 * newest first, in one query for the whole set.
 */
export async function getRecentMoveLines(
  userId: string,
  contactIds: string[],
  now: Date = new Date()
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!contactIds.length) return out;
  const db = await getDb();
  const since = new Date(now.getTime() - RECENT_MOVES_DAYS * 86_400_000);
  const rows = await db
    .select()
    .from(contactJobChanges)
    .where(
      and(
        eq(contactJobChanges.userId, userId),
        inArray(contactJobChanges.contactId, contactIds),
        gte(contactJobChanges.detectedAt, since)
      )
    )
    .orderBy(desc(contactJobChanges.detectedAt));
  const byContact = new Map<string, string[]>();
  for (const r of rows) {
    const list = byContact.get(r.contactId) ?? [];
    // Org names and titles came from web search: one line each, as the career line does.
    if (list.length < 3) list.push(sanitizeProfileLine(jobChangeSentence(r)));
    byContact.set(r.contactId, list);
  }
  for (const [id, list] of byContact) out.set(id, list.join("; "));
  return out;
}

/**
 * The newest logged move, shaped as the extension's page diff, for its congratulations
 * opener when the page itself shows nothing new — the move was already noticed by a web
 * search, so the page and Orbit agree. Only a recent move: congratulating someone on a job
 * they started a year ago reads as not paying attention.
 */
export async function recentMoveAsFieldChanges(
  userId: string,
  contactId: string,
  now: Date = new Date()
): Promise<FieldChange[]> {
  const db = await getDb();
  const since = new Date(now.getTime() - CONGRATS_MAX_AGE_MONTHS * 30 * 86_400_000);
  const [move] = await db
    .select()
    .from(contactJobChanges)
    .where(
      and(
        eq(contactJobChanges.userId, userId),
        eq(contactJobChanges.contactId, contactId),
        inArray(contactJobChanges.kind, ["joined", "title_change"]),
        gte(contactJobChanges.detectedAt, since)
      )
    )
    .orderBy(desc(contactJobChanges.detectedAt))
    .limit(1);
  if (!move?.toOrg) return [];
  const changes: FieldChange[] = [];
  if (move.kind === "joined") changes.push({ field: "company", from: move.fromOrg, to: move.toOrg });
  if (move.toTitle) changes.push({ field: "title", from: move.fromTitle, to: move.toTitle });
  return changes;
}

/** What the Experience section shows about tracking: the moves, and when it looks next. */
export async function getWorkHistoryTracking(
  userId: string,
  contactId: string,
  now: Date = new Date()
): Promise<{ moves: StoredJobChange[]; nextCheckAt: Date | null }> {
  const db = await getDb();
  const [moves, contact] = await Promise.all([
    getJobChanges(userId, contactId),
    db.query.contacts.findFirst({
      where: and(eq(contacts.userId, userId), eq(contacts.id, contactId)),
      columns: { workHistoryDueAt: true },
    }),
  ]);
  // Only a real date ahead. A past one is overdue and a near one is usually a sweep's
  // ten-minute lease; "next check Sep 29" read on Sep 30 would look broken.
  const due = contact?.workHistoryDueAt ?? null;
  return { moves, nextCheckAt: due && due.getTime() > now.getTime() + 86_400_000 ? due : null };
}
