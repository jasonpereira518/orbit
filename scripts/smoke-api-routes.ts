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
import { GET as contactsGet } from "../src/app/api/v1/contacts/route";
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
  for (const path of ["/me", "/events", "/contacts", "/followups", "/webhook-endpoints"]) {
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
