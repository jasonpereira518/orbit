/**
 * The three connector routes, exercised through the real handlers against PGlite.
 *
 * `scripts/smoke-api-connector-routes.ts` (pure tier) covers the request schemas; it cannot
 * prove the properties that matter most for a bearer-key, AI-spending, shared-pipeline API:
 *
 *   - That a caller can never read or act on another user's rows. In particular
 *     `completeReminder` and `snoozeReminderTo` (src/lib/reminders.ts) return `null` — not a
 *     thrown error — when a reminder does not exist or belongs to someone else, and a route
 *     that forgets to check for `null` would report success to a Shortcut that just
 *     "completed" a stranger's follow-up.
 *   - That a malformed or missing id resolves to `not_found`, not a Postgres cast error
 *     turned into a 500 by the generic error funnel.
 *   - That the documented 50,000-character note limit is reachable in bytes, not just in
 *     `noteBody`'s own character count — that gap only shows up once a real body is read.
 *   - That `/v1/notes` actually spends against the SAME AI-cost bucket the app's own Extract
 *     does, and that a note it enqueues survives the app's own "only one review at a time"
 *     discard — both are effects on shared state a schema check cannot see at all.
 *
 * All of that is live-database (or live-rate-limit-bucket, or live-server-action) behaviour,
 * not a schema one, so it earns this second, pglite-tier script.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { generateApiKey } from "../src/lib/api/keys";
import { POST as notesPost } from "../src/app/api/v1/notes/route";
import { GET as interactionsGet } from "../src/app/api/v1/interactions/route";
import { PATCH as followupsPatch } from "../src/app/api/v1/followups/[id]/route";
import { queueCaptureJob } from "../src/actions/capture-jobs";

const USER = "connector-routes-smoke-user";
const OTHER_USER = "connector-routes-smoke-other-user";
const DEMO_USER = "demo-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Envelope = { ok: boolean; data?: unknown; error?: { code: string; message: string } };

function req(method: string, url: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
    // A real HTTP client (Shortcuts, Zapier, curl) always sends an accurate Content-Length.
    // `new Request()` does NOT set one for a string body — it stays absent — which would let
    // a byte-size bug hide behind this test harness the way it cannot behind a real request:
    // `readJson` (src/lib/api/http.ts) checks the declared Content-Length FIRST, and only
    // falls back to the decoded string's own `.length` (UTF-16 code units, not bytes) when
    // no header is present. Setting it here is what makes the non-ASCII byte-cap check below
    // actually exercise the byte-accurate path instead of an accidentally lenient one.
    headers["content-length"] = String(Buffer.byteLength(payload, "utf8"));
  }
  return new Request(url, { method, headers, body: payload });
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
  // OTHER_USER never calls a route directly — every cross-user check drives it through
  // USER's key against OTHER_USER's rows — but it still needs the comped `user_settings`
  // row `seedKey` writes, or a route reachable to it would 402 rather than exercise the
  // cross-user path.
  await seedKey(db, OTHER_USER, "connector routes (other)");

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

  // The route must give the job `sourceKind: "api"` — the ONLY thing that exempts it from
  // `queueCaptureJob`'s "only one review at a time" discard (see src/actions/capture-jobs.ts
  // and the type's own comment in src/lib/capture/types.ts for why that value is safe to key
  // an exemption on: nothing else in this codebase ever sets it). Asserting the flag is not
  // enough on its own — see the demo-mode section near the end of this script, which drives
  // the actual discard code path rather than just checking this column.
  check("the job carries sourceKind \"api\"", jobRow?.source_kind === "api", jobRow?.source_kind);

  // The AI-spend guard, not just the request-volume one: `/v1/notes` must consume the same
  // `capture` bucket the app's own Extract does (RATE_LIMITS.capture), in ADDITION to
  // apiHandler's own `apiWrite` bucket — otherwise a key could run the parser at double the
  // in-app rate, on a BYOK user's own provider bill.
  const captureBucketRow = rowsOf<{ count: number }>(
    await db.execute(sql`SELECT count FROM rate_limit_buckets WHERE bucket = ${`capture:${USER}`}`)
  )[0];
  check(
    "posting a note consumes the capture rate-limit bucket, not just apiWrite",
    Boolean(captureBucketRow) && captureBucketRow.count >= 1,
    JSON.stringify(captureBucketRow)
  );

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
    req("GET", "https://orbit.test/api/v1/interactions?occurred_since=2026-09-01T00:00:00.000Z", key.token)
  );
  const sinceBody = ((await sinceRes.json()) as Envelope).data as { interactions: { summary: string | null }[] };
  check(
    "occurred_since excludes the older interaction",
    sinceBody.interactions.length === 1 && sinceBody.interactions[0].summary === "Recent call",
    JSON.stringify(sinceBody.interactions)
  );

  // Apple Shortcuts' ISO8601 formatter emits a UTC offset, not `Z`, by default — this must
  // not 400 a real client.
  const sinceOffsetRes = await interactionsGet(
    req(
      "GET",
      `https://orbit.test/api/v1/interactions?occurred_since=${encodeURIComponent("2026-08-31T20:00:00-04:00")}`,
      key.token
    )
  );
  check(
    "occurred_since accepts a UTC-offset timestamp",
    sinceOffsetRes.status === 200,
    String(sinceOffsetRes.status)
  );
  const sinceOffsetBody = ((await sinceOffsetRes.json()) as Envelope).data as {
    interactions: { summary: string | null }[];
  };
  check(
    "…and it filters correctly once converted (same instant as the Z case above)",
    sinceOffsetBody.interactions.length === 1 && sinceOffsetBody.interactions[0].summary === "Recent call",
    JSON.stringify(sinceOffsetBody.interactions)
  );

  // --- POST /v1/notes: the documented character limit is reachable in bytes, not just chars ---
  //
  // `noteBody.text` is bounded at 50,000 CHARACTERS. `readJson`'s default byte cap
  // (64,000 bytes) is well under what 50,000 non-Latin characters need in UTF-8 — a
  // Japanese note at the documented limit is ~150,000 bytes, more than double the old cap.
  // This must be ACCEPTED now that the route passes an explicit byte budget sized for UTF-8.
  const nonAsciiText = "あ".repeat(50_000); // exactly the documented character limit
  const nonAsciiNote = await notesPost(
    req("POST", "https://orbit.test/api/v1/notes", key.token, { text: nonAsciiText })
  );
  check(
    "a non-ASCII note at the documented character limit is accepted, not 413",
    nonAsciiNote.status === 202,
    String(nonAsciiNote.status)
  );

  // --- POST /v1/notes: a contactId must belong to the caller ---------------------------------
  //
  // `contactId` lands in `capture_jobs.seed_contact_id`, which has no foreign key — nothing
  // downstream would notice another user's id sitting there, which is exactly why this has
  // to be checked here rather than left to the database.
  const foreignContact = await notesPost(
    req("POST", "https://orbit.test/api/v1/notes", key.token, {
      text: "Note attached to someone else's contact",
      contactId: contactB.id, // belongs to OTHER_USER
    })
  );
  check(
    "a note cannot seed another user's contact",
    foreignContact.status === 400,
    String(foreignContact.status)
  );
  const foreignContactBody = (await foreignContact.json()) as Envelope;
  check(
    "…and names the offending field",
    foreignContactBody.error?.code === "invalid_request",
    JSON.stringify(foreignContactBody.error)
  );

  const ownContact = await notesPost(
    req("POST", "https://orbit.test/api/v1/notes", key.token, {
      text: "Note attached to my own contact",
      contactId: contactA.id, // belongs to USER
    })
  );
  check("…while the caller's own contact is accepted", ownContact.status === 202, String(ownContact.status));

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

  // A malformed id must never reach the database: passed to `completeReminder` unchecked, a
  // non-uuid string makes Postgres throw on the `uuid` column comparison, which the generic
  // error funnel turns into a 500 — a client-caused error masquerading as a server fault.
  const malformed = await followupsPatch(
    req("PATCH", "https://orbit.test/api/v1/followups/not-a-uuid", key.token, { status: "complete" })
  );
  check(
    "a malformed id is not_found, not a 500",
    malformed.status === 404,
    String(malformed.status)
  );
  const malformedBody = (await malformed.json()) as Envelope;
  check(
    "…with the same code as a wrong-owner id (no enumeration signal)",
    malformedBody.error?.code === "not_found",
    JSON.stringify(malformedBody.error)
  );

  // `/v1/followups/` with nothing after the slash: `pathname.split("/").filter(Boolean).pop()`
  // returns the literal segment `"followups"` here, not `""` — so a bare `if (!id)` guard
  // never fires, and without the uuid shape check this also fell through to the 500 above.
  const emptySegment = await followupsPatch(
    req("PATCH", "https://orbit.test/api/v1/followups/", key.token, { status: "complete" })
  );
  check(
    "a bare /followups/ with nothing after it is not_found, not a 500",
    emptySegment.status === 404,
    String(emptySegment.status)
  );

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

  // Same Shortcuts-formatter concern as occurred_since above, but for the request BODY.
  const [offsetSnoozeReminder] = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO reminders (user_id, contact_id, title, status)
      VALUES (${USER}, ${contactA.id}, 'Ping Ada a third time', 'pending')
      RETURNING id
    `)
  );
  const offsetSnoozeRes = await followupsPatch(
    req("PATCH", `https://orbit.test/api/v1/followups/${offsetSnoozeReminder.id}`, key.token, {
      status: "snoozed",
      dueAt: "2026-10-01T11:00:00+02:00",
    })
  );
  check(
    "snoozing with a UTC-offset dueAt is accepted",
    offsetSnoozeRes.status === 200,
    String(offsetSnoozeRes.status)
  );
  const offsetSnoozeRow = rowsOf<{ due_date: string }>(
    await db.execute(sql`SELECT due_date FROM reminders WHERE id = ${offsetSnoozeReminder.id}`)
  )[0];
  check(
    "…and converts it to the correct instant",
    new Date(offsetSnoozeRow.due_date).toISOString() === "2026-10-01T09:00:00.000Z",
    offsetSnoozeRow.due_date
  );

  // A read-only key cannot patch a follow-up either.
  const readOnlyPatch = await followupsPatch(
    req("PATCH", `https://orbit.test/api/v1/followups/${reminder.id}`, readKey.token, { status: "complete" })
  );
  check("a read-only key cannot patch a follow-up", readOnlyPatch.status === 403, String(readOnlyPatch.status));

  // --- The sourceKind:"api" exemption, driven through the REAL discard code path -------------
  //
  // `queueCaptureJob` (src/actions/capture-jobs.ts) is what the app's own Extract button
  // calls, and — before this round's fix — its "only one review at a time" rule discarded
  // EVERY job sitting in ready/reviewing/failed/transcribed for the account, no matter what.
  // A note the public API enqueued overnight, still awaiting review, would be silently wiped
  // out by the very next single-note Extract the person did in the app. Checking the job's
  // OWN `source_kind` column is not proof this is fixed — the discard query itself has to
  // filter on it. So this drives the actual server action rather than asserting on the flag.
  //
  // An EARLIER version of this fix exempted anything carrying a `batchGroupId`, reasoning
  // that a grouped job always has a way back through `CaptureQueuePanel`. That was wrong on
  // two counts the reviewer caught: the panel only renders for a GROUP of more than one job
  // (`capture-queue-panel.tsx`'s `if (jobs.length <= 1) return null`), so a single-item
  // "batch" the API route minted could never be reached there either; and it also meant a
  // genuine in-app multi-file leftover (a real batch, several jobs) became exempt from this
  // rule too — behaviour this task has no business changing. The three cases below prove
  // both halves: an API-sourced job survives, and an in-app leftover — grouped OR not —
  // still gets swept exactly as it always did.
  //
  // `queueCaptureJob` calls `requireUserId()`, which needs either real Clerk auth or Orbit's
  // demo-mode identity (`demo-user`) — the same trick `scripts/smoke-follow-up-actions.ts`
  // uses to call actions directly from a script. `ORBIT_DEMO_DATA=off` skips seeding the
  // demo workspace, which this test has no use for and would only slow it down.
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  (process.env as Record<string, string>).NODE_ENV = "development";
  process.env.ORBIT_DEMO_DATA = "off";

  await db.execute(sql`DELETE FROM capture_jobs WHERE user_id = ${DEMO_USER}`);
  await db.execute(sql`DELETE FROM api_keys WHERE user_id = ${DEMO_USER}`);
  const demoKey = await seedKey(db, DEMO_USER, "demo notes");

  // Job A: created through the real /v1/notes route, so it gets the route's own
  // `sourceKind: "api"` — exactly what a Shortcut note sitting in the queue overnight
  // looks like.
  const demoNoteRes = await notesPost(
    req("POST", "https://orbit.test/api/v1/notes", demoKey.token, { text: "Overnight note from a Shortcut" })
  );
  const demoNoteData = ((await demoNoteRes.json()) as Envelope).data as { noteId: string };
  // Fast-forward past extraction to "awaiting review", without running the real AI pipeline.
  await db.execute(sql`UPDATE capture_jobs SET status = 'ready' WHERE id = ${demoNoteData.noteId}`);

  // Job B: a plain ungrouped in-app job in the same state — stands in for a genuine
  // single-review card the discard rule is SUPPOSED to clear away, so this also proves the
  // rule still works at all rather than having been accidentally disabled entirely.
  const [inAppLoneJob] = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO capture_jobs (user_id, source_kind, status, input_text)
      VALUES (${DEMO_USER}, 'messy', 'ready', 'A lone in-app draft awaiting review')
      RETURNING id
    `)
  );

  // Job C: an in-app job that DOES carry a batchGroupId — a stand-in for a genuine
  // multi-file-drop leftover. This must be discarded just as it always was: this task does
  // not get to grant it immunity by way of a column it happens to share with the API's jobs.
  const [inAppBatchLeftover] = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO capture_jobs (user_id, source_kind, status, input_text, batch_group_id)
      VALUES (${DEMO_USER}, 'messy', 'ready', 'One leftover card from a twelve-file drop', gen_random_uuid())
      RETURNING id
    `)
  );

  // The real in-app single-note Extract: no jobId, no batchGroupId.
  // `kick()` inside `queueCaptureJob` calls Next's `after()`, which throws when there is no
  // request scope (exactly the case here — see `deferTelemetry`'s comment in
  // src/lib/api/http.ts for the same fact about this API's own routes). That throw is caught
  // by `queueCaptureJob`'s own try/catch and can turn a real success into a reported
  // `{ ok: false }` — AFTER the discard and the new job's creation have already committed.
  // So this asserts the resulting DATABASE STATE, not `result.ok`.
  await queueCaptureJob({ text: "New note typed in the app", sourceKind: "messy" });

  const demoJobStatus = rowsOf<{ status: string }>(
    await db.execute(sql`SELECT status FROM capture_jobs WHERE id = ${demoNoteData.noteId}`)
  )[0];
  check(
    "the API-created job (sourceKind \"api\") survives the app's own Extract",
    demoJobStatus.status === "ready",
    demoJobStatus.status
  );

  const inAppLoneStatus = rowsOf<{ status: string }>(
    await db.execute(sql`SELECT status FROM capture_jobs WHERE id = ${inAppLoneJob.id}`)
  )[0];
  check(
    "…while a lone in-app job is still discarded (the rule itself still works)",
    inAppLoneStatus.status === "discarded",
    inAppLoneStatus.status
  );

  const inAppBatchStatus = rowsOf<{ status: string }>(
    await db.execute(sql`SELECT status FROM capture_jobs WHERE id = ${inAppBatchLeftover.id}`)
  )[0];
  check(
    "…and a grouped in-app leftover is ALSO still discarded (no batchGroupId immunity)",
    inAppBatchStatus.status === "discarded",
    inAppBatchStatus.status
  );

  const newDemoJob = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT id FROM capture_jobs
      WHERE user_id = ${DEMO_USER} AND input_text = 'New note typed in the app'
    `)
  )[0];
  check("the in-app Extract's own new job was created", Boolean(newDemoJob));

  await db.execute(sql`DELETE FROM capture_jobs WHERE user_id = ${DEMO_USER}`);
  await db.execute(sql`DELETE FROM api_keys WHERE user_id = ${DEMO_USER}`);
  await db.execute(sql`DELETE FROM user_settings WHERE user_id = ${DEMO_USER}`);

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
