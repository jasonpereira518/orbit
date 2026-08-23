import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";

/**
 * One account's history, merged across everything that writes.
 *
 * The inspector's timeline was built from imports alone, which made it a list of file
 * uploads rather than a history: the question it needs to answer is "what was this person
 * actually doing in March", and imports are the least of it.
 *
 * THE UNION ARM LIST IS THE ALLOWLIST. An arm that does not select a column cannot leak
 * it, which is why labels are assembled in SQL rather than in JS — the shape of the query
 * is the guarantee.
 *
 * Three arms name a person: contacts, interactions and chat thread titles. Reminder labels
 * deliberately do not, because a reminder's title and description are the *user's prose
 * about a third party* rather than a record of that person — the action kind and status say
 * everything the timeline needs.
 *
 * The chat arm reads `chat_threads`, never `chat_messages`. That is not a redaction
 * preference but a hard line: message content is in `NEVER_REVEALABLE`, and reading one row
 * per thread instead of one per message keeps the transcript table out of this query
 * entirely.
 */

export type AdminTimelineKind =
  | "contact"
  | "interaction"
  | "chat"
  | "reminder"
  | "import"
  | "connection"
  | "calendar"
  | "campaign"
  | "admin";

export type AdminTimelineEntry = {
  kind: AdminTimelineKind;
  /** Assembled in SQL from the arm's own columns; see the module header. */
  label: string;
  /** System output only (import errors, sync errors) — never user prose. */
  detail: string | null;
  resourceType: string | null;
  resourceId: string | null;
  at: Date;
};

export const TIMELINE_PAGE_SIZE = 40;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

type TimelineRecord = {
  kind: string;
  label: string;
  detail: string | null;
  resource_type: string | null;
  resource_id: string | null;
  at: string | Date;
};

export async function loadAdminTimeline(
  userId: string,
  opts: {
    limit?: number;
    /** Keyset cursor, not OFFSET: the feed grows at the head while you page. */
    before?: Date | null;
  } = {}
): Promise<{ entries: AdminTimelineEntry[]; hasMore: boolean }> {
  const db = await getDb();
  const limit = Math.min(Math.max(opts.limit ?? TIMELINE_PAGE_SIZE, 1), 200);

  // The `before` bound is applied per arm rather than once at the end, so each arm can use
  // its (user_id, created_at) index instead of scanning and discarding.
  const before = opts.before ?? null;
  const cutoff = sql`${before}::timestamptz`;
  const bound = before
    ? sql`AND created_at < ${cutoff}`
    : sql``;

  const contactLabel = sql`'Contact added: ' || full_name`;
  const interactionLabel = sql`'Logged ' || interaction_type || coalesce(' with ' || (
        SELECT c.full_name FROM contacts c WHERE c.id = i.contact_id
      ), '')`;
  const chatLabel = sql`'Chat thread: ' || coalesce(title, 'untitled')`;

  const result = await db.execute(sql`
    WITH merged AS (
      SELECT 'contact' AS kind, ${contactLabel} AS label, NULL::text AS detail,
             'contact' AS resource_type, id::text AS resource_id, created_at AS at
      FROM contacts WHERE user_id = ${userId} ${bound}

      UNION ALL
      SELECT 'interaction', ${interactionLabel}, NULL,
             'interaction', i.id::text, i.created_at
      FROM interactions i WHERE i.user_id = ${userId}
        ${before ? sql`AND i.created_at < ${cutoff}` : sql``}

      UNION ALL
      SELECT 'chat', ${chatLabel}, NULL, 'chat_thread', id::text, created_at
      FROM chat_threads WHERE user_id = ${userId} ${bound}

      UNION ALL
      -- Title and description are the user's prose about a third party rather than a
      -- record of them, so the label stays structural. See the module header.
      SELECT 'reminder', 'Reminder created (' || action_kind || ')', NULL,
             'reminder', id::text, created_at
      FROM reminders WHERE user_id = ${userId} ${bound}

      UNION ALL
      SELECT 'import',
             'Import ' || status || ': ' || import_type ||
               coalesce(' (' || total_rows::text || ' rows)', ''),
             error_message, 'import', id::text, created_at
      FROM imports WHERE user_id = ${userId} ${bound}

      UNION ALL
      SELECT 'connection', 'Gmail connected (' || status || ')', NULL,
             'gmail', id::text, created_at
      FROM gmail_connections WHERE user_id = ${userId} ${bound}

      UNION ALL
      SELECT 'connection', 'Outlook connected (' || status || ')', NULL,
             'outlook', id::text, created_at
      FROM outlook_connections WHERE user_id = ${userId} ${bound}

      UNION ALL
      SELECT 'calendar',
             'Calendar feed added' ||
               coalesce(' (' || last_sync_status || ')', ''),
             last_sync_error, 'calendar_subscription', id::text, created_at
      FROM calendar_subscriptions WHERE user_id = ${userId} ${bound}

      UNION ALL
      SELECT 'campaign', 'Campaign ' || status, NULL,
             'outreach_campaign', id::text, created_at
      FROM outreach_campaigns WHERE user_id = ${userId} ${bound}

      UNION ALL
      -- The operator's own footprint, inline in the account's history, which is where you
      -- want it when reconstructing what happened.
      SELECT 'admin', 'Admin: ' || action, reason,
             coalesce(resource_type, 'admin'), resource_id, created_at
      FROM admin_audit_log WHERE target_user_id = ${userId} ${bound}
    )
    SELECT * FROM merged
    ORDER BY at DESC
    LIMIT ${limit + 1}
  `);

  const records = rowsOf<TimelineRecord>(result);
  const hasMore = records.length > limit;

  return {
    entries: records.slice(0, limit).map((r) => ({
      kind: r.kind as AdminTimelineKind,
      label: r.label,
      detail: r.detail,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      at: toDate(r.at),
    })),
    hasMore,
  };
}
