/**
 * The three connector routes, exercised through the real handlers against PGlite.
 *
 * `scripts/smoke-api-connector-routes.ts` (pure tier) covers the request schemas; it cannot
 * prove the one property that matters most for a bearer-key API: that a caller can never
 * read or act on another user's rows. In particular `completeReminder` and `snoozeReminderTo`
 * (src/lib/reminders.ts) return `null` — not a thrown error — when a reminder does not exist
 * or belongs to someone else, and a route that forgets to check for `null` would report
 * success to a Shortcut that just "completed" a stranger's follow-up. That is a live-database
 * behaviour, not a schema one, so it earns a second, pglite-tier script.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { generateApiKey } from "../src/lib/api/keys";
import { POST as notesPost } from "../src/app/api/v1/notes/route";
import { GET as interactionsGet } from "../src/app/api/v1/interactions/route";
import { PATCH as followupsPatch } from "../src/app/api/v1/followups/[id]/route";

const USER = "connector-routes-smoke-user";
const OTHER_USER = "connector-routes-smoke-other-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Envelope = { ok: boolean; data?: unknown; error?: { code: string; message: string } };

function req(method: string, url: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function seedKey(db: Awaited<ReturnType<typeof getDb>>, userId: string, name: string) {
  const key = generateApiKey();
  await db.execute(sql`
    INSERT INTO api_keys (user_id, name, kind, prefix, key_hash, scopes)
    VALUES (${userId}, ${name}, 'api', ${key.prefix}, ${key.keyHash}, '["read","write"]'::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO user_settings (user_id, comped_plan, comped_at)
    VALUES (${userId}, 'orbit', now())
    ON CONFLICT (user_id) DO UPDATE SET comped_plan = 'orbit', comped_at = now()
  `);
  return key;
}

run(async () => {
  const db = await getDb();
  for (const u of [USER, OTHER_USER]) {
    await db.execute(sql`DELETE FROM api_keys WHERE user_id = ${u}`);
    await db.execute(sql`DELETE FROM user_settings WHERE user_id = ${u}`);
    await db.execute(sql`DELETE FROM reminders WHERE user_id = ${u}`);
    await db.execute(sql`DELETE FROM interactions WHERE user_id = ${u}`);
    await db.execute(sql`DELETE FROM contacts WHERE user_id = ${u}`);
    await db.execute(sql`DELETE FROM capture_jobs WHERE user_id = ${u}`);
  }

  const key = await seedKey(db, USER, "connector routes");
  const otherKey = await seedKey(db, OTHER_USER, "connector routes (other)");

  // --- POST /v1/notes enqueues a capture job, not a direct write --------------------------
  const notesRes = await notesPost(
    req("POST", "https://orbit.test/api/v1/notes", key.token, {
      text: "Met Ada at the museum, follow up next week",
      sourceLabel: "Apple Shortcut",
    })
  );
  check("a note is accepted", notesRes.status === 202, String(notesRes.status));
  const notesBody = (await notesRes.json()) as Envelope;
  const noteData = notesBody.data as { noteId: string; status: string };
  // The response's own `status` is always "queued": it is read straight off the row
  // `createCaptureJob` just wrote, before the fire-and-forget runner has a chance to advance
  // it. The DB row's live status is NOT asserted here, on purpose — the runner kicked off by
  // `void runCaptureJobById(...)` is a genuine background task in this same process, and by
  // the time we get back around to querying it may already have moved past "queued" (or
  // hit an error, for lack of an AI key in the smoke environment). What matters for THIS
  // route's contract is what it enqueued, not how the pipeline behind it happens to run.
  check("its own response says queued", noteData.status === "queued", noteData.status);
  const jobRow = rowsOf<{ source_kind: string; source_label: string | null; user_id: string }>(
    await db.execute(sql`SELECT source_kind, source_label, user_id FROM capture_jobs WHERE id = ${noteData.noteId}`)
  )[0];
  check("it created a capture job row", Boolean(jobRow));
  check("scoped to the calling user", jobRow?.user_id === USER, jobRow?.user_id);
  check("carrying the note's source label", jobRow?.source_label === "Apple Shortcut", jobRow?.source_label ?? "");

  // --- A read-only key cannot post a note --------------------------------------------------
  const readKey = generateApiKey();
  await db.execute(sql`
    INSERT INTO api_keys (user_id, name, kind, prefix, key_hash, scopes)
    VALUES (${USER}, 'read only', 'api', ${readKey.prefix}, ${readKey.keyHash}, '["read"]'::jsonb)
  `);
  const readOnlyNote = await notesPost(
    req("POST", "https://orbit.test/api/v1/notes", readKey.token, { text: "nope" })
  );
  check("a read-only key cannot write a note", readOnlyNote.status === 403, String(readOnlyNote.status));

  // --- GET /v1/interactions is user-scoped and updated_since-filtered ---------------------
  const [contactA] = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO contacts (user_id, full_name) VALUES (${USER}, 'Ada Lovelace') RETURNING id
    `)
  );
  const [contactB] = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO contacts (user_id, full_name) VALUES (${OTHER_USER}, 'Grace Hopper') RETURNING id
    `)
  );
  await db.execute(sql`
    INSERT INTO interactions (user_id, contact_id, interaction_date, ai_summary)
    VALUES
      (${USER}, ${contactA.id}, '2026-01-01T00:00:00Z', 'Old coffee'),
      (${USER}, ${contactA.id}, '2026-09-10T00:00:00Z', 'Recent call'),
      (${OTHER_USER}, ${contactB.id}, '2026-09-10T00:00:00Z', 'Someone else entirely')
  `);

  const listRes = await interactionsGet(
    req("GET", "https://orbit.test/api/v1/interactions?limit=50", key.token)
  );
  check("interactions list succeeds", listRes.status === 200, String(listRes.status));
  const listBody = ((await listRes.json()) as Envelope).data as {
    interactions: { id: string; summary: string | null }[];
  };
  check("it returns only this user's interactions", listBody.interactions.length === 2, String(listBody.interactions.length));
  check(
    "it never returns another user's row",
    !listBody.interactions.some((i) => i.summary === "Someone else entirely")
  );

  const sinceRes = await interactionsGet(
    req("GET", "https://orbit.test/api/v1/interactions?updated_since=2026-09-01T00:00:00.000Z", key.token)
  );
  const sinceBody = ((await sinceRes.json()) as Envelope).data as { interactions: { summary: string | null }[] };
  check(
    "updated_since excludes the older interaction",
    sinceBody.interactions.length === 1 && sinceBody.interactions[0].summary === "Recent call",
    JSON.stringify(sinceBody.interactions)
  );

  // --- PATCH /v1/followups/:id -------------------------------------------------------------
  const [reminder] = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO reminders (user_id, contact_id, title, status)
      VALUES (${USER}, ${contactA.id}, 'Follow up with Ada', 'pending')
      RETURNING id
    `)
  );
  const [otherReminder] = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO reminders (user_id, contact_id, title, status)
      VALUES (${OTHER_USER}, ${contactB.id}, 'Follow up with Grace', 'pending')
      RETURNING id
    `)
  );

  // A nonexistent id is not_found, never a crash.
  const missing = await followupsPatch(
    req("PATCH", "https://orbit.test/api/v1/followups/00000000-0000-0000-0000-000000000000", key.token, {
      status: "complete",
    })
  );
  check("a nonexistent follow-up is not_found", missing.status === 404, String(missing.status));

  // The critical case: another user's reminder id must be not_found, never a silent success.
  const crossUser = await followupsPatch(
    req("PATCH", `https://orbit.test/api/v1/followups/${otherReminder.id}`, key.token, {
      status: "complete",
    })
  );
  check(
    "completing another user's follow-up is not_found, not success",
    crossUser.status === 404,
    String(crossUser.status)
  );
  const otherStatus = rowsOf<{ status: string }>(
    await db.execute(sql`SELECT status FROM reminders WHERE id = ${otherReminder.id}`)
  )[0];
  check("the other user's reminder was left untouched", otherStatus.status === "pending", otherStatus.status);

  // Trailing slash and a query string must not break id parsing.
  const trailing = await followupsPatch(
    req("PATCH", `https://orbit.test/api/v1/followups/${reminder.id}/`, key.token, { status: "complete" })
  );
  check("a trailing slash still resolves the id", trailing.status === 200, String(trailing.status));
  const completedStatus = rowsOf<{ status: string }>(
    await db.execute(sql`SELECT status FROM reminders WHERE id = ${reminder.id}`)
  )[0];
  check("it actually completed the reminder", completedStatus.status === "done", completedStatus.status);

  // Snooze needs a real reminder to snooze — make a fresh one, then hit it with a query string.
  const [snoozeReminder] = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO reminders (user_id, contact_id, title, status)
      VALUES (${USER}, ${contactA.id}, 'Ping Ada again', 'pending')
      RETURNING id
    `)
  );
  const snoozeRes = await followupsPatch(
    req(
      "PATCH",
      `https://orbit.test/api/v1/followups/${snoozeReminder.id}?source=shortcut`,
      key.token,
      { status: "snoozed", dueAt: "2026-10-01T09:00:00.000Z" }
    )
  );
  check("snoozing with a query string still resolves the id", snoozeRes.status === 200, String(snoozeRes.status));
  const snoozeRow = rowsOf<{ due_date: string }>(
    await db.execute(sql`SELECT due_date FROM reminders WHERE id = ${snoozeReminder.id}`)
  )[0];
  check(
    "it wrote the requested due date",
    new Date(snoozeRow.due_date).toISOString() === "2026-10-01T09:00:00.000Z",
    snoozeRow.due_date
  );

  // A read-only key cannot patch a follow-up either.
  const readOnlyPatch = await followupsPatch(
    req("PATCH", `https://orbit.test/api/v1/followups/${reminder.id}`, readKey.token, { status: "complete" })
  );
  check("a read-only key cannot patch a follow-up", readOnlyPatch.status === 403, String(readOnlyPatch.status));

  for (const u of [USER, OTHER_USER]) {
    await db.execute(sql`DELETE FROM reminders WHERE user_id = ${u}`);
    await db.execute(sql`DELETE FROM interactions WHERE user_id = ${u}`);
    await db.execute(sql`DELETE FROM contacts WHERE user_id = ${u}`);
    await db.execute(sql`DELETE FROM capture_jobs WHERE user_id = ${u}`);
    await db.execute(sql`DELETE FROM api_keys WHERE user_id = ${u}`);
    await db.execute(sql`DELETE FROM user_settings WHERE user_id = ${u}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector API route (live) checks passed.");
});
