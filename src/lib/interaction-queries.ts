/**
 * Counting and listing what happened — the timeline across the whole network, not one
 * person's: "how many coffees did I have in March", "who did I email last week", "how often
 * do I talk to Maya", "break my last quarter down by month". A relevance search over contacts
 * cannot count events; this does, exactly, user-scoped.
 *
 * Rows carry the short AI summary, never `raw_notes`: a listing fans out over many people,
 * and the raw note is the most attacker-writable text in the product.
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";

export const INTERACTION_GROUPS = ["type", "month", "contact", "source"] as const;
export type InteractionGroup = (typeof INTERACTION_GROUPS)[number];

export type InteractionQuery = {
  contactId?: string;
  /** interaction_type values: note, coffee, meeting, call, email, message… */
  types?: string[];
  source?: string;
  /** YYYY-MM-DD, inclusive. */
  after?: string;
  before?: string;
  groupBy?: InteractionGroup;
  /** 0 returns the count (and groups) only. */
  limit?: number;
};

export type InteractionQueryResult = {
  total: number;
  groups?: Array<{ key: string; count: number; contactId?: string }>;
  rows: Array<{
    id: string;
    date: string;
    type: string;
    source: string | null;
    contactId: string | null;
    contactName: string | null;
    summary: string | null;
  }>;
};

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export async function queryInteractions(userId: string, q: InteractionQuery): Promise<InteractionQueryResult> {
  const types = (q.types ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 8);
  const conditions: SQL[] = [
    sql`i.user_id = ${userId}`,
    ...(q.contactId ? [sql`i.contact_id = ${q.contactId}`] : []),
    ...(types.length ? [sql`lower(i.interaction_type) in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})`] : []),
    ...(q.source ? [sql`lower(coalesce(i.source, '')) = ${q.source.trim().toLowerCase()}`] : []),
    ...(q.after ? [sql`i.interaction_date >= ${`${q.after}T00:00:00Z`}::timestamptz`] : []),
    ...(q.before ? [sql`i.interaction_date < ${nextDay(q.before)}::timestamptz`] : []),
  ];
  const where = sql.join(conditions, sql` and `);
  const limit = Math.min(Math.max(q.limit ?? 20, 0), 50);
  const db = await getDb();
  const [list, counted, grouped] = await Promise.all([
    limit
      ? db.execute(sql`
          select i.id, i.interaction_date, i.interaction_type, i.source, i.contact_id, c.full_name,
                 left(i.ai_summary, 240) as summary
            from interactions i
            left join contacts c on c.id = i.contact_id and c.user_id = ${userId}
           where ${where}
           order by i.interaction_date desc
           limit ${limit}`)
      : Promise.resolve(null),
    db.execute(sql`select count(*) as n from interactions i where ${where}`),
    q.groupBy ? db.execute(groupSql(q.groupBy, where, userId)) : Promise.resolve(null),
  ]);
  const total = Number(rowsOf<{ n: number | string }>(counted)[0]?.n ?? 0);
  return {
    total,
    ...(grouped
      ? {
          groups: rowsOf<{ key: string | null; count: number | string; contact_id?: string | null }>(grouped).map((g) => ({
            key: g.key ?? "(not recorded)",
            count: Number(g.count),
            ...(g.contact_id ? { contactId: String(g.contact_id) } : {}),
          })),
        }
      : {}),
    rows: list
      ? rowsOf<{
          id: string;
          interaction_date: Date | string;
          interaction_type: string;
          source: string | null;
          contact_id: string | null;
          full_name: string | null;
          summary: string | null;
        }>(list).map((r) => ({
          id: String(r.id),
          date: new Date(r.interaction_date).toISOString().slice(0, 10),
          type: r.interaction_type,
          source: r.source,
          contactId: r.contact_id ? String(r.contact_id) : null,
          contactName: r.full_name,
          summary: r.summary,
        }))
      : [],
  };
}

function groupSql(group: InteractionGroup, where: SQL, userId: string): SQL {
  if (group === "contact") {
    return sql`
      select c.full_name as key, i.contact_id, count(*) as count
        from interactions i
        join contacts c on c.id = i.contact_id and c.user_id = ${userId}
       where ${where}
       group by c.full_name, i.contact_id
       order by count desc, key
       limit 25`;
  }
  const key =
    group === "month"
      ? sql`to_char(i.interaction_date at time zone 'UTC', 'YYYY-MM')`
      : group === "source"
        ? sql`nullif(i.source, '')`
        : sql`i.interaction_type`;
  return sql`
    select ${key} as key, count(*) as count
      from interactions i
     where ${where}
     group by 1
     order by ${group === "month" ? sql`key desc` : sql`count desc, key`}
     limit 25`;
}
