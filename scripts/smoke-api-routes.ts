/**
 * The public API's route behaviour, exercised through the real handlers.
 *
 * The properties here are the ones an integration author hits on their first bad day: an
 * unauthenticated call must answer JSON they can parse rather than an HTML sign-in page, an
 * oversized body must be refused before it is read, and a malformed one must say which field
 * was wrong. None of these are visible from the happy path.
 *
 * No network: every case either fails before a fetch or is rejected by the SSRF guard, so this
 * runs in CI without reaching anything.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { generateApiKey } from "../src/lib/api/keys";
import { GET as meGet } from "../src/app/api/v1/me/route";
import { POST as eventsPost } from "../src/app/api/v1/events/route";
import { GET as contactsGet, POST as contactsPost } from "../src/app/api/v1/contacts/route";
import { POST as endpointsPost } from "../src/app/api/v1/webhook-endpoints/route";
import { GET as openapiGet } from "../src/app/api/v1/openapi.json/route";

const USER = "api-routes-smoke-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Envelope = { ok: boolean; data?: unknown; error?: { code: string; message: string; param?: string } };

function post(url: string, token: string | null, body: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

run(async () => {
  const db = await getDb();
  await db.execute(sql`DELETE FROM api_keys WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM user_settings WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM webhook_endpoints WHERE user_id = ${USER}`);

  const key = generateApiKey();
  await db.execute(sql`
    INSERT INTO api_keys (user_id, name, kind, prefix, key_hash, scopes)
    VALUES (${USER}, 'routes', 'api', ${key.prefix}, ${key.keyHash}, '["read","write"]'::jsonb)
  `);
  // The API is a paid feature; comp the account so the routes are reachable.
  await db.execute(sql`
    INSERT INTO user_settings (user_id, comped_plan, comped_at)
    VALUES (${USER}, 'orbit', now())
    ON CONFLICT (user_id) DO UPDATE SET comped_plan = 'orbit', comped_at = now()
  `);

  // --- An unauthenticated call answers JSON, not a redirect ---------------------------------
  const anon = await meGet(new Request("https://orbit.test/api/v1/me"));
  check("unauthenticated is 401", anon.status === 401, String(anon.status));
  check(
    "unauthenticated is JSON, not an HTML sign-in page",
    (anon.headers.get("content-type") ?? "").includes("application/json"),
    String(anon.headers.get("content-type"))
  );
  const anonBody = (await anon.json()) as Envelope;
  check("the error envelope has a machine-readable code", anonBody.error?.code === "unauthorized");

  // --- A valid key gets through ----------------------------------------------------------------
  const me = await meGet(
    new Request("https://orbit.test/api/v1/me", {
      headers: { authorization: `Bearer ${key.token}` },
    })
  );
  check("a valid key reaches /me", me.status === 200, String(me.status));
  const meBody = (await me.json()) as Envelope;
  const meData = meBody.data as { plan: string; scopes: string[]; keyPrefix: string };
  check("it reports the plan", meData.plan === "orbit", meData.plan);
  check("it reports the key's scopes", meData.scopes.includes("write"));
  check("it identifies the key without revealing it", meData.keyPrefix === key.prefix);

  // --- Body limits are enforced before the body is read --------------------------------------------
  const oversized = post("https://orbit.test/api/v1/events", key.token, { events: [] }, {
    "content-length": String(50_000_000),
  });
  const tooBig = await eventsPost(oversized);
  check("an oversized Content-Length is refused", tooBig.status === 413, String(tooBig.status));

  // --- Malformed input says what was wrong ----------------------------------------------------------
  const badJson = new Request("https://orbit.test/api/v1/events", {
    method: "POST",
    headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
    body: "{not json",
  });
  const malformed = await eventsPost(badJson);
  check("malformed JSON is a 400", malformed.status === 400, String(malformed.status));

  const missingField = await eventsPost(
    post("https://orbit.test/api/v1/events", key.token, {
      events: [{ externalId: "e1", participants: [{ email: "a@b.c" }] }],
    })
  );
  check("a missing required field is a 400", missingField.status === 400);
  const missingBody = (await missingField.json()) as Envelope;
  check(
    "the error names the offending field",
    (missingBody.error?.param ?? "").includes("occurredAt"),
    String(missingBody.error?.param)
  );

  // --- A well-formed batch is accepted ---------------------------------------------------------------
  const ok = await eventsPost(
    post("https://orbit.test/api/v1/events", key.token, {
      events: [
        {
          externalId: "smoke-evt-1",
          type: "meeting",
          occurredAt: "2026-03-10T15:00:00Z",
          participants: [{ name: "Ada Lovelace", email: "ada-api@example.com" }],
          summary: "Coffee",
        },
      ],
      createContacts: true,
    })
  );
  check("a valid batch is accepted", ok.status === 200, String(ok.status));
  const okBody = (await ok.json()) as Envelope;
  const stats = okBody.data as { eventsReceived: number; interactionsLogged: number };
  check("it reports what it did", stats.eventsReceived === 1 && stats.interactionsLogged === 1, JSON.stringify(stats));

  // Re-sending the identical batch must not duplicate — externalId is the idempotency key.
  await eventsPost(
    post("https://orbit.test/api/v1/events", key.token, {
      events: [
        {
          externalId: "smoke-evt-1",
          type: "meeting",
          occurredAt: "2026-03-10T15:00:00Z",
          participants: [{ name: "Ada Lovelace", email: "ada-api@example.com" }],
          summary: "Coffee",
        },
      ],
      createContacts: true,
    })
  );
  const interactionCount = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM interactions WHERE user_id = ${USER}`)
  )[0];
  check("re-sending the same event does not duplicate", Number(interactionCount.n) === 1, String(interactionCount.n));

  // --- Scope is enforced at the route, not just in the verifier ---------------------------------------
  const readKey = generateApiKey();
  await db.execute(sql`
    INSERT INTO api_keys (user_id, name, kind, prefix, key_hash, scopes)
    VALUES (${USER}, 'read only', 'api', ${readKey.prefix}, ${readKey.keyHash}, '["read"]'::jsonb)
  `);
  const readWrite = await eventsPost(
    post("https://orbit.test/api/v1/events", readKey.token, {
      events: [
        {
          externalId: "nope",
          occurredAt: "2026-03-10T15:00:00Z",
          participants: [{ email: "x@y.z" }],
        },
      ],
    })
  );
  check("a read-only key cannot write", readWrite.status === 403, String(readWrite.status));
  const readRead = await contactsGet(
    new Request("https://orbit.test/api/v1/contacts", {
      headers: { authorization: `Bearer ${readKey.token}` },
    })
  );
  check("a read-only key can still read", readRead.status === 200, String(readRead.status));

  // --- POST /contacts duplicate check is bounded, not a full-table scan ------------------------------
  //
  // Both used to be one `findMany` of the whole account, run on every single write. This
  // seeds enough contacts that an accidental full scan would still pass functionally but is
  // the regression this guards: the checks below assert the *outcomes* the bounded rewrite
  // must still produce, not the query shape (that's `smoke-related-contacts-scale.ts`'s job
  // for the sibling function it shares `contact-resolve.ts` with).
  for (let i = 0; i < 30; i++) {
    await eventsPost(
      post("https://orbit.test/api/v1/events", key.token, {
        events: [
          {
            externalId: `filler-${i}`,
            occurredAt: "2026-01-01T00:00:00Z",
            participants: [{ name: `Filler Person ${i}`, email: `filler-${i}@example.com` }],
          },
        ],
        createContacts: true,
      })
    );
  }

  const created = await contactsPost(
    post("https://orbit.test/api/v1/contacts", key.token, {
      fullName: "Duplicate Probe",
      email: "dup-probe@example.com",
      linkedinUrl: "https://www.linkedin.com/in/dup-probe/",
    })
  );
  check("first POST creates a contact", created.status === 201, String(created.status));

  const byIdentifier = await contactsPost(
    post("https://orbit.test/api/v1/contacts", key.token, {
      // Different name, same LinkedIn URL — the identifier tier must still catch this.
      fullName: "Dupe P.",
      linkedinUrl: "https://www.linkedin.com/in/dup-probe/",
    })
  );
  check("identifier match reports matched, not created", byIdentifier.status === 200, String(byIdentifier.status));
  const byIdentifierBody = (await byIdentifier.json()) as Envelope;
  check(
    "identifier match does not create a second row",
    (byIdentifierBody.data as { created: boolean }).created === false
  );

  const byName = await contactsPost(
    post("https://orbit.test/api/v1/contacts", key.token, {
      // No email/linkedin this time, so only the bare-name tier (0.60) can fire — below
      // DUPLICATE_MERGE_CONFIDENCE, so this must create rather than report a match.
      fullName: "Duplicate Probe",
    })
  );
  check(
    "a bare full-name match (0.60) is below the merge threshold and still creates",
    byName.status === 201,
    String(byName.status)
  );

  const forced = await contactsPost(
    post("https://orbit.test/api/v1/contacts", key.token, {
      fullName: "Dupe P.",
      linkedinUrl: "https://www.linkedin.com/in/dup-probe/",
      force: true,
    })
  );
  check(
    "force:true creates despite a confident identifier match",
    forced.status === 201,
    String(forced.status)
  );

  const genuinelyNew = await contactsPost(
    post("https://orbit.test/api/v1/contacts", key.token, { fullName: "Nobody Seen Before" })
  );
  check("an unrelated name creates normally", genuinelyNew.status === 201, String(genuinelyNew.status));

  // --- GET /contacts cursor is applied, not silently ignored ------------------------------------------
  const firstPage = await contactsGet(
    new Request("https://orbit.test/api/v1/contacts?limit=5", {
      headers: { authorization: `Bearer ${key.token}` },
    })
  );
  const firstPageBody = (await firstPage.json()) as Envelope;
  const firstData = firstPageBody.data as { contacts: { id: string }[]; nextCursor: string | null };
  check("a page under the limit-or-more has a nextCursor", Boolean(firstData.nextCursor));

  const secondPage = await contactsGet(
    new Request(
      `https://orbit.test/api/v1/contacts?limit=5&cursor=${encodeURIComponent(firstData.nextCursor ?? "")}`,
      { headers: { authorization: `Bearer ${key.token}` } }
    )
  );
  const secondData = ((await secondPage.json()) as Envelope).data as {
    contacts: { id: string }[];
  };
  const firstIds = new Set(firstData.contacts.map((c) => c.id));
  check(
    "the second page does not repeat the first page's rows",
    secondData.contacts.every((c) => !firstIds.has(c.id))
  );
  check("the second page returns rows", secondData.contacts.length > 0);

  const badCursor = await contactsGet(
    new Request("https://orbit.test/api/v1/contacts?cursor=not-a-real-cursor", {
      headers: { authorization: `Bearer ${key.token}` },
    })
  );
  check("a malformed cursor is a 400, not a crash", badCursor.status === 400, String(badCursor.status));

  // --- Registering a webhook rejects an unreachable target, with a usable message -------------------
  for (const [url, why] of [
    ["http://example.com/hook", "http://"],
    ["https://127.0.0.1/hook", "loopback"],
    ["https://169.254.169.254/hook", "the metadata endpoint"],
    ["https://localtest.me/hook", "a host that resolves to loopback"],
  ] as const) {
    const res = await endpointsPost(
      post("https://orbit.test/api/v1/webhook-endpoints", key.token, {
        url,
        eventTypes: ["contact.created"],
      })
    );
    check(`registering ${why} is refused`, res.status === 400, `${url} -> ${res.status}`);
  }
  const stored = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM webhook_endpoints WHERE user_id = ${USER}`)
  )[0];
  check("no refused endpoint was persisted", Number(stored.n) === 0, String(stored.n));

  // --- The generated spec is real ---------------------------------------------------------------------
  const spec = await openapiGet();
  check("the OpenAPI document is served", spec.status === 200);
  const doc = (await spec.json()) as {
    openapi: string;
    paths: Record<string, unknown>;
    components: { securitySchemes: Record<string, unknown> };
  };
  check("it declares its OpenAPI version", doc.openapi.startsWith("3."), doc.openapi);
  for (const path of [
    "/me",
    "/events",
    "/contacts",
    "/followups",
    "/followups/{id}",
    "/notes",
    "/interactions",
    "/webhook-endpoints",
  ]) {
    check(`it documents ${path}`, Boolean(doc.paths[path]));
  }
  check("it documents bearer auth", Boolean(doc.components.securitySchemes.bearerAuth));

  await db.execute(sql`DELETE FROM interactions WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM api_keys WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM webhook_endpoints WHERE user_id = ${USER}`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll API route checks passed.");
});
