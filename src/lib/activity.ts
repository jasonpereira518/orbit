import { sql, type SQL } from "drizzle-orm";
import { internalAccountSql } from "@/lib/analytics-internal";
import { TOUR_EXAMPLE_SOURCE } from "@/lib/onboarding-examples/marker";

/**
 * The two definitions every retention and activation number in the console shares.
 *
 * They exist because the same words meant different things in different places. "Active"
 * was a row written to any of five tables, which counted a nightly Radar AI call or a
 * calendar sync as a person using Orbit, and counted the operator's own accounts. "Onboarded"
 * was defined five ways, two of which disagreed about the guided tour's eight example people.
 * See ANALYTICS_AUDIT.md findings A1 and A2, and TRACKING_PLAN.md §1 for the reasoning.
 */

/** An account has this long from sign-up to be "activated". Matches `FUNNEL_MATURITY_DAYS`. */
export const ACTIVATION_WINDOW_DAYS = 7;

/**
 * Contact sources that are a person adding someone, as opposed to a bulk import or a sync.
 * `null` is a hand-typed contact. Imports (LinkedIn, Google, Outlook, calendar, a file,
 * WhatsApp) are excluded: one import is hundreds of rows in a second and says "imported",
 * not "used".
 */
const HAND_CONTACT_SOURCES = ["capture", "ai_capture", "manual", "extension", "mcp"] as const;

/**
 * Rows that mean a PERSON did something deliberate to their network, as
 * `(user_id, created_at)`. The single definition behind weekly active networkers, the
 * retention curves, "actions per active account", and the consistency chart.
 *
 * INCLUDED: a saved capture, a hand-logged note, a contact added by hand or capture, a
 * follow-up the person set, a chat question, an import the
 * person started, and the product events that have no table of their own (an MCP tool call,
 * an extension action, a completed follow-up).
 *
 * EXCLUDED, on purpose: `usage_events` (an AI call is a consequence of an action, and the
 * nightly Radar, recruiter and relationship jobs write them for people who did nothing),
 * interactions that came from a calendar sync or an import (`external_id`, `import_id`),
 * the guided tour's example people, reminders Orbit or a sync created, outreach (behind a
 * coming-soon screen, and keyed through a campaign rather than a user), and every account the
 * operator marked internal or tester.
 *
 * Takes a lower bound so each query scans only the window it draws.
 */
export function intentionalActionsSince(since: SQL): SQL {
  const handSources = sql.join(
    HAND_CONTACT_SOURCES.map((s) => sql`${s}`),
    sql`, `
  );
  return sql`
    SELECT a.user_id, a.created_at FROM (
      SELECT user_id, created_at FROM capture_jobs
        WHERE status = 'saved' AND created_at >= ${since}
      UNION ALL SELECT user_id, created_at FROM interactions
        WHERE created_at >= ${since}
          AND note_batch_id IS NULL AND external_id IS NULL AND import_id IS NULL
          AND source IS DISTINCT FROM ${TOUR_EXAMPLE_SOURCE}
      UNION ALL SELECT user_id, created_at FROM contacts
        WHERE created_at >= ${since}
          AND (source IS NULL OR source IN (${handSources}))
          AND source IS DISTINCT FROM ${TOUR_EXAMPLE_SOURCE}
      UNION ALL SELECT user_id, created_at FROM reminders
        WHERE created_at >= ${since} AND created_by IN ('user', 'extension')
      UNION ALL SELECT user_id, created_at FROM chat_messages
        WHERE created_at >= ${since} AND role = 'user'
      UNION ALL SELECT user_id, created_at FROM imports
        WHERE created_at >= ${since}
      UNION ALL SELECT user_id, occurred_at AS created_at FROM product_events
        WHERE occurred_at >= ${since} AND actor = 'user' AND user_id IS NOT NULL
          AND name IN ('mcp_tool_called', 'extension_action', 'followup_set', 'followup_completed')
    ) a
    WHERE NOT ${internalAccountSql(sql`a.user_id`)}
  `;
}

/**
 * Whether an account is ACTIVATED: it captured and acted, within seven days of signing up.
 *
 *   1. It has its own network: a contact that is not a tour example, or a completed import.
 *   2. It did one deliberate thing with it: set a follow-up, asked a chat question, or saved
 *      captures on two different UTC days.
 *
 * Both halves must happen inside the window. `userId` and `signedUpAt` are SQL expressions
 * for the account being tested (`s.user_id`, `s.created_at`); the result is a boolean
 * expression, so it works in a SELECT list, a FILTER or a WHERE.
 *
 * The JS twin is documentation: `describeActivation()` below, used by the console's "how to
 * read this" text so the page and the SQL cannot drift in wording.
 */
export function activatedSql(userId: SQL, signedUpAt: SQL): SQL {
  const window = sql.raw(`interval '${ACTIVATION_WINDOW_DAYS} days'`);
  return sql`(
    (
      EXISTS (SELECT 1 FROM contacts c
              WHERE c.user_id = ${userId} AND c.source IS DISTINCT FROM ${TOUR_EXAMPLE_SOURCE}
                AND c.created_at < ${signedUpAt} + ${window})
      OR EXISTS (SELECT 1 FROM imports i
                 WHERE i.user_id = ${userId} AND i.status = 'completed'
                   AND i.created_at < ${signedUpAt} + ${window})
    )
    AND (
      EXISTS (SELECT 1 FROM reminders r
              WHERE r.user_id = ${userId} AND r.created_by IN ('user', 'extension')
                AND r.created_at < ${signedUpAt} + ${window})
      OR EXISTS (SELECT 1 FROM chat_messages m
                 WHERE m.user_id = ${userId} AND m.role = 'user'
                   AND m.created_at < ${signedUpAt} + ${window})
      OR (SELECT count(DISTINCT date_trunc('day', j.created_at AT TIME ZONE 'UTC'))
          FROM capture_jobs j
          WHERE j.user_id = ${userId} AND j.status = 'saved'
            AND j.created_at < ${signedUpAt} + ${window}) >= 2
    )
  )`;
}

/** The sentence the console prints under every activation number. */
export function describeActivation(): string {
  return `Activated means that within ${ACTIVATION_WINDOW_DAYS} days of signing up an account had a contact of its own (not a tour example) or a completed import, and then set a follow-up, asked a chat question, or saved captures on two different days.`;
}
