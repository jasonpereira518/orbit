/**
 * Who the user is, in the same key space as a roster row.
 *
 * Needed for two things, both of which look silly when they go wrong:
 *
 *   - "People you keep seeing" must never include the user. They are on every one of their
 *     own rosters — a calendar invite lists them, a Luma guest list lists them — so without
 *     this they would be the top result, by a distance, forever.
 *   - A page's host line-up naming the user is evidence they HOSTED the event, which is how
 *     a discovered event gets promoted from the `attended` default.
 *
 * Every source is one the user gave us themselves: the address Clerk mirrors, the social
 * links they typed into Settings, the mailbox they connected.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { personKeyOf, type PersonKey } from "@/lib/events/people";

export type SelfIdentity = {
  keys: PersonKey[];
  /** Formatted `kind:value`, which is what the aggregate compares against. */
  keyStrings: string[];
  emails: string[];
  names: string[];
};

export async function loadSelfIdentity(userId: string): Promise<SelfIdentity> {
  const db = await getDb();
  const rows = rowsOf<{
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    social_links: { linkedin?: string; twitter?: string } | null;
    mailbox: string | null;
  }>(
    await db.execute(sql`
      SELECT s.email,
             s.first_name,
             s.last_name,
             s.social_links,
             (SELECT g.email_address FROM gmail_connections g
               WHERE g.user_id = ${userId} AND g.status = 'active' LIMIT 1) AS mailbox
        FROM user_settings s
       WHERE s.user_id = ${userId}
       LIMIT 1
    `)
  );

  const row = rows[0];
  const emails = [row?.email, row?.mailbox]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
  // Mirrored from Clerk as two columns, and null on accounts predating that mirror — which
  // is fine: a missing name costs one weak key, and the email keys above do the real work.
  const names = [[row?.first_name, row?.last_name].filter(Boolean).join(" ").trim()].filter(
    (value): value is string => Boolean(value)
  );

  const keys: PersonKey[] = [];
  const push = (key: PersonKey | null) => {
    if (key && !keys.some((k) => k.kind === key.kind && k.value === key.value)) keys.push(key);
  };

  for (const email of emails) push(personKeyOf({ email }));
  push(personKeyOf({ linkedinUrl: row?.social_links?.linkedin ?? null }));
  push(personKeyOf({ xHandle: row?.social_links?.twitter ?? null }));
  // The name key last and only as a name: it is the weak tier, and it is here so the user's
  // own name-only roster rows (a pasted list that includes them) are still recognised.
  for (const name of names) push(personKeyOf({ fullName: name }));

  return {
    keys,
    keyStrings: keys.map((key) => `${key.kind}:${key.value}`),
    emails,
    names,
  };
}
