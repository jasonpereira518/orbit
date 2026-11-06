/**
 * Pins the retention added for the tables that grew without a limit: old rows go, recent rows
 * stay, recipient addresses leave webhook rows sooner than the rows themselves, and a converted
 * waitlist row is anonymised without losing its place in the line or its referral link.
 *
 * Counted by tag, not absolutely: the suite shares one database.
 *
 * Run: npx tsx scripts/smoke-analytics-retention.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import {
  CONVERTED_WAITLIST_RETENTION_DAYS,
  CRON_RUN_RETENTION_DAYS,
  GATE_EVENT_RETENTION_DAYS,
  PRODUCT_EVENT_RETENTION_DAYS,
  WEBHOOK_DELIVERY_RETENTION_DAYS,
  WEBHOOK_RECIPIENT_RETENTION_DAYS,
  anonymiseConvertedWaitlist,
  pruneTable,
  runAnalyticsRetention,
  scrubWebhookRecipients,
} from "../src/lib/analytics-retention";
import { scrubText } from "../src/lib/sentry-scrub";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const DAY = 86_400_000;
const TAG = "smoke-retention";

run(async () => {
  const db = await getDb();
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  const count = async (q: ReturnType<typeof sql>) => Number(rowsOf<{ n: number }>(await db.execute(q))[0]?.n ?? 0);

  await db.execute(sql`DELETE FROM gate_events WHERE user_id = ${TAG}`);
  await db.execute(sql`DELETE FROM cron_runs WHERE job = ${TAG}`);
  await db.execute(sql`DELETE FROM webhook_deliveries WHERE source = ${TAG}`);
  await db.execute(sql`DELETE FROM product_events WHERE user_id = ${TAG}`);
  await db.execute(sql`DELETE FROM interest_list_signups WHERE email LIKE ${TAG + "%"} OR first_name = ${TAG}`);

  console.log("old rows go, recent rows stay");
  await db.execute(sql`INSERT INTO gate_events (user_id, feature, plan, created_at) VALUES (${TAG}, 'contacts', 'free', ${ago(GATE_EVENT_RETENTION_DAYS + 5)}), (${TAG}, 'contacts', 'free', ${ago(10)})`);
  await db.execute(sql`INSERT INTO cron_runs (job, status, started_at) VALUES (${TAG}, 'ok', ${ago(CRON_RUN_RETENTION_DAYS + 5)}), (${TAG}, 'ok', ${ago(1)})`);
  await db.execute(sql`INSERT INTO webhook_deliveries (source, outcome, created_at) VALUES (${TAG}, 'handled', ${ago(WEBHOOK_DELIVERY_RETENTION_DAYS + 5)}), (${TAG}, 'handled', ${ago(1)})`);
  await db.execute(sql`INSERT INTO product_events (id, name, surface, actor, user_id, created_at) VALUES (gen_random_uuid(), 'capture_saved', 'web', 'user', ${TAG}, ${ago(PRODUCT_EVENT_RETENTION_DAYS + 5)}), (gen_random_uuid(), 'capture_saved', 'web', 'user', ${TAG}, ${ago(2)})`);
  await pruneTable("gate_events", GATE_EVENT_RETENTION_DAYS);
  await pruneTable("cron_runs", CRON_RUN_RETENTION_DAYS);
  await pruneTable("webhook_deliveries", WEBHOOK_DELIVERY_RETENTION_DAYS);
  await pruneTable("product_events", PRODUCT_EVENT_RETENTION_DAYS);
  check("gate_events", (await count(sql`SELECT count(*)::int AS n FROM gate_events WHERE user_id = ${TAG}`)) === 1);
  check("cron_runs", (await count(sql`SELECT count(*)::int AS n FROM cron_runs WHERE job = ${TAG}`)) === 1);
  check("webhook_deliveries", (await count(sql`SELECT count(*)::int AS n FROM webhook_deliveries WHERE source = ${TAG}`)) === 1);
  check("product_events", (await count(sql`SELECT count(*)::int AS n FROM product_events WHERE user_id = ${TAG}`)) === 1);

  console.log("\nrecipient addresses leave webhook rows early");
  await db.execute(sql`DELETE FROM webhook_deliveries WHERE source = ${TAG}`);
  await db.execute(sql`INSERT INTO webhook_deliveries (source, outcome, detail, created_at) VALUES
    (${TAG}, 'handled', '{"recipients":["a@example.test"],"suppressed":true}', ${ago(WEBHOOK_RECIPIENT_RETENTION_DAYS + 2)}),
    (${TAG}, 'handled', '{"recipients":["b@example.test"],"suppressed":true}', ${ago(2)})`);
  const scrubbed = await scrubWebhookRecipients();
  check("the old row lost its recipients", scrubbed >= 1);
  const rows = rowsOf<{ has: boolean; sup: unknown }>(await db.execute(sql`SELECT (detail ? 'recipients') AS has, detail->'suppressed' AS sup FROM webhook_deliveries WHERE source = ${TAG} ORDER BY created_at`));
  check("the outcome of the old row stays", rows[0]?.has === false && rows[0]?.sup === true);
  check("the recent row keeps its recipients", rows[1]?.has === true);
  check("running again scrubs nothing more", (await scrubWebhookRecipients()) === 0);

  console.log("\nconverted waitlist rows are anonymised, not deleted");
  const referrer = rowsOf<{ id: string }>(await db.execute(sql`INSERT INTO interest_list_signups (email, unsubscribe_token, share_token, referral_slug) VALUES (${TAG + "-referrer@example.test"}, ${TAG + "-t0"}, ${TAG + "-s0"}, ${TAG + "-ref"}) RETURNING id`))[0]!.id;
  await db.execute(sql`INSERT INTO interest_list_signups (email, unsubscribe_token, share_token, referral_slug, first_name, last_name, referred_by_id, converted_at, user_id, utm_source) VALUES
    (${TAG + "-old@example.test"}, ${TAG + "-t1"}, ${TAG + "-s1"}, ${TAG + "-old"}, ${TAG}, 'Person', ${referrer}, ${ago(CONVERTED_WAITLIST_RETENTION_DAYS + 3)}, 'user_x', 'reddit'),
    (${TAG + "-new@example.test"}, ${TAG + "-t2"}, ${TAG + "-s2"}, ${TAG + "-new"}, ${TAG}, 'Person', ${referrer}, ${ago(3)}, 'user_y', 'reddit'),
    (${TAG + "-waiting@example.test"}, ${TAG + "-t3"}, ${TAG + "-s3"}, ${TAG + "-wait"}, ${TAG}, 'Person', NULL, NULL, NULL, NULL)`);
  const n = await anonymiseConvertedWaitlist();
  check("one row anonymised", n >= 1);
  const wl = rowsOf<{ email: string; first_name: string | null; slug: string | null; referred_by_id: string | null; utm_source: string | null; user_id: string | null }>(
    await db.execute(sql`SELECT email, first_name, referral_slug AS slug, referred_by_id, utm_source, user_id FROM interest_list_signups WHERE first_name = ${TAG} OR email LIKE 'anonymised-%' AND user_id = 'user_x'`)
  );
  const anon = wl.find((r) => r.user_id === "user_x");
  check("its email and slug no longer identify anyone", Boolean(anon) && anon!.email.startsWith("anonymised-") && anon!.slug === null && anon!.first_name === null);
  check("but its referral link and attribution stay", anon?.referred_by_id === referrer && anon?.utm_source === "reddit");
  check("a recent conversion keeps its email", wl.some((r) => r.email === TAG + "-new@example.test"));
  check("someone still waiting is untouched", wl.some((r) => r.email === TAG + "-waiting@example.test"));
  check("running again anonymises nothing more", (await anonymiseConvertedWaitlist()) === 0);

  console.log("\nthe whole sweep");
  const stats = await runAnalyticsRetention();
  check("returns a count for every table", ["cronRunsPruned", "webhookDeliveriesPruned", "webhookRecipientsScrubbed", "gateEventsPruned", "productEventsPruned", "waitlistAnonymised"].every((k) => typeof (stats as Record<string, number>)[k] === "number"));

  console.log("\nerror text is scrubbed like Sentry's");
  const text = scrubText("Failed to send to jane.doe@example.com with key sk-abcdefghijklmnopqrstuvwxyz0123456789");
  check("an address is replaced", !text.includes("jane.doe@example.com") && text.includes("[email]"), text);

  await db.execute(sql`DELETE FROM gate_events WHERE user_id = ${TAG}`);
  await db.execute(sql`DELETE FROM cron_runs WHERE job = ${TAG}`);
  await db.execute(sql`DELETE FROM webhook_deliveries WHERE source = ${TAG}`);
  await db.execute(sql`DELETE FROM product_events WHERE user_id = ${TAG}`);
  await db.execute(sql`DELETE FROM interest_list_signups WHERE email LIKE ${TAG + "%"} OR email LIKE 'anonymised-%' AND user_id IN ('user_x', 'user_y')`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll analytics-retention checks passed.");
});
