/**
 * Characterization snapshot: what Orbit's core read paths and external contracts return
 * RIGHT NOW, recorded to `scripts/fixtures/behavior-golden.json` and diffed on every run.
 *
 * This is not a spec. It asserts nothing about what the output should be — only that it is
 * the same as when the golden was recorded. It exists for behavior-preserving work
 * (efficiency passes, refactors): record on the old code, change the code, rerun, and any
 * byte of difference in a probe's output fails with the probe's name.
 *
 * Covered:
 *   - The MCP server through its real route handler: `tools/list` (the full schema an
 *     external client sees) and every read and write tool, in a fixed order.
 *   - The extension API through its real route handlers: /me, /resolve (confident, none),
 *     contact search, save, log interaction, follow-up.
 *   - The page loaders behind the dashboard, constellation, notification panel and
 *     knowledge base.
 *
 * All of it runs against the demo workspace (`seedDemoWorkspace`), which is the richest
 * fixture in the repo. Its ids are random and its dates are relative to now, so output is
 * normalized before comparing: every uuid becomes `<table:label>` (the row it names),
 * timestamps and bare dates become placeholders, and fractional numbers keep six
 * significant digits. Ids the app mints in JS come from a seeded counter, so ranking ties
 * broken by id sort the same way every run.
 *
 * Run:     npx tsx scripts/smoke-behavior-golden.ts
 * Record:  npx tsx scripts/smoke-behavior-golden.ts --update   (only on code you trust)
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { generateApiKey } from "../src/lib/api/keys";
import { seedDemoWorkspace } from "../src/lib/demo-data/seed";
import { POST as MCP_POST } from "../src/app/api/mcp/route";
import { GET as EXT_ME } from "../src/app/api/extension/me/route";
import { POST as EXT_RESOLVE } from "../src/app/api/extension/resolve/route";
import {
  GET as EXT_CONTACTS_SEARCH,
  POST as EXT_CONTACTS_SAVE,
} from "../src/app/api/extension/contacts/route";
import { POST as EXT_INTERACTIONS } from "../src/app/api/extension/interactions/route";
import { POST as EXT_FOLLOW_UPS } from "../src/app/api/extension/follow-ups/route";
import { getDashboardData } from "../src/lib/reminders";
import { loadGraphData } from "../src/lib/graph-data";
import { loadNotificationPanel } from "../src/lib/notification-panel";
import { loadKnowledgeBase } from "../src/lib/knowledge-base";
import { logExtensionInteraction, saveContactFromExtension } from "../src/lib/extension/writes";
import type { PageContext } from "../src/lib/extension/contract";

const USER = "behavior-golden-user";
const GOLDEN = join(__dirname, "fixtures", "behavior-golden.json");
const UPDATE = process.argv.includes("--update");
const DEV_SECRET = "behavior-golden-secret";

// The extension API's local-dev auth: NODE_ENV=development plus a shared secret, resolving
// to EXTENSION_DEV_USER_ID. The demo workspace is seeded explicitly below, so the
// automatic one-on-first-request seeding is switched off.
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
env.EXTENSION_DEV_SECRET = DEV_SECRET;
env.EXTENSION_DEV_USER_ID = USER;
env.ORBIT_DEMO_DATA = "off";

// Ids the app mints in JS (the demo seeder's contacts, among others) come from a counter
// instead of randomness. Several outputs break ranking ties by id, so random ids made the
// ORDER of equal-scored rows differ run to run. Only the id values change; the app still
// sees well-formed, unique v4 uuids.
let uuidCounter = 0;
// The real module object (not an ESM namespace, whose bindings are read-only): the app's
// compiled `import { randomUUID }` reads the property off it at call time.
const cryptoModule = createRequire(__filename)("node:crypto") as typeof import("node:crypto");
(cryptoModule as { randomUUID: () => string }).randomUUID = () => {
  const h = cryptoModule.createHash("sha256").update(`golden-${uuidCounter++}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/* ------------------------------------------------------------------ normalization ---- */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
/**
 * uuid → `<table:label>`, built from the database after every probe has run. The demo
 * seeder's ids are random, so numbering them by first appearance would make the snapshot
 * depend on how ties happened to sort; a label names the row by what it is instead.
 */
const uuidLabels = new Map<string, string>();
/** Tried in order; the first a table has becomes its label. */
const LABEL_COLUMNS = ["full_name", "title", "name", "text", "subject", "summary", "raw_notes", "description", "kind", "type"];

async function buildUuidLabels() {
  const db = await getDb();
  const cols = (await db.execute(sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND (column_name = 'id' AND data_type = 'uuid' OR column_name IN (${sql.join(LABEL_COLUMNS.map((c) => sql`${c}`), sql`, `)}))
  `)) as unknown as { rows: Array<{ table_name: string; column_name: string }> };
  const byTable = new Map<string, Set<string>>();
  for (const r of cols.rows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Set());
    byTable.get(r.table_name)!.add(r.column_name);
  }
  for (const [table, set] of [...byTable].sort(([a], [b]) => a.localeCompare(b))) {
    if (!set.has("id")) continue;
    const label = LABEL_COLUMNS.find((c) => set.has(c));
    const rows = (await db.execute(
      sql`SELECT id::text AS id, ${label ? sql.raw(`left(${label}::text, 60)`) : sql`NULL`} AS label FROM ${sql.raw(table)}`
    )) as unknown as { rows: Array<{ id: string; label: string | null }> };
    for (const r of rows.rows) {
      uuidLabels.set(r.id.toLowerCase(), `<${table}:${(r.label ?? "?").replace(/\s+/g, " ")}>`);
    }
  }
}

function normalizeString(s: string): string {
  return s
    .replace(UUID_RE, (id) => uuidLabels.get(id.toLowerCase()) ?? "<uuid>")
    .replace(ISO_RE, "<ts>")
    // Bare calendar days (a follow-up item's key, say) are relative to the day the
    // workspace was seeded, which is the day the suite runs.
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>");
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return "<ts>";
  if (typeof value === "string") return normalizeString(value);
  // Scores decay continuously with time since the seeded interactions, so their last few
  // digits depend on how many milliseconds the run took. Six significant digits is far
  // finer than any real change in behavior would move them.
  if (typeof value === "number" && !Number.isInteger(value)) return Number(value.toPrecision(6));
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[normalizeString(k)] = normalize(v);
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------------ helpers ---- */

let rpcId = 0;
async function mcp(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await MCP_POST(
    new Request("https://orbit.test/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    })
  );
  const text = await res.text();
  const line =
    text.startsWith("event:") || text.startsWith("data:")
      ? (text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5).trim()
      : text;
  let body: unknown = text;
  try {
    body = line ? JSON.parse(line) : null;
  } catch {
    // Kept as raw text: a shape change there is still a change.
  }
  // The JSON-RPC id is a counter of this script, not server output.
  if (body && typeof body === "object") delete (body as Record<string, unknown>).id;
  return { status: res.status, body };
}

async function ext(
  handler: (req: Request) => Promise<Response>,
  method: "GET" | "POST",
  path: string,
  body?: unknown
) {
  const res = await handler(
    new Request(`https://orbit.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-orbit-dev-secret": DEV_SECRET,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}

function field(value: string | null | undefined, source = "h1") {
  return value ? { value, source, confidence: "high" as const } : null;
}

function page(p: {
  name?: string;
  title?: string;
  company?: string;
  handle?: string;
  url: string;
}): PageContext {
  return {
    schemaVersion: 1,
    site: "linkedin",
    adapterVersion: "golden",
    kind: "person",
    url: p.url,
    sourceUrl: p.url,
    capturedAt: "2026-01-01T00:00:00.000Z",
    identity: {
      name: field(p.name),
      headline: field(p.title && p.company ? `${p.title} at ${p.company}` : null),
      title: field(p.title),
      company: field(p.company),
      location: null,
      school: null,
      email: null,
      handle: field(p.handle, "url"),
      profileUrl: field(p.url, "url"),
      photoUrl: null,
    },
    text: { blob: `${p.name ?? ""} ${p.title ?? ""}`.trim(), truncated: false, charCount: `${p.name ?? ""} ${p.title ?? ""}`.trim().length, fromSelection: false },
    warnings: [],
  } as PageContext;
}

async function mintKey(scopes: Array<"read" | "write">): Promise<string> {
  const db = await getDb();
  const key = generateApiKey("api");
  await db.execute(sql`
    INSERT INTO api_keys (user_id, name, kind, prefix, key_hash, scopes)
    VALUES (${USER}, 'golden', 'api', ${key.prefix}, ${key.keyHash}, ${JSON.stringify(scopes)}::jsonb)
  `);
  return key.token;
}

/* ------------------------------------------------------------------------- probes ---- */

run(async () => {
  const db = await getDb();
  const seeded = await seedDemoWorkspace(USER);
  const writeKey = await mintKey(["read", "write"]);

  const idOf = async (fullName: string) => {
    const row = await db.query.contacts.findFirst({
      where: and(eq(contacts.userId, USER), eq(contacts.fullName, fullName)),
      columns: { id: true, linkedinUrl: true, company: true, title: true },
    });
    if (!row) throw new Error(`demo person missing: ${fullName}`);
    return row;
  };
  const sarah = await idOf("Sarah Chen");
  const tool = (name: string, args: Record<string, unknown>) =>
    mcp(writeKey, "tools/call", { name, arguments: args });

  // Order matters: writes come after every read they could affect, and the reads that
  // follow them are deliberate (they characterize the post-write state).
  const probes: Array<[string, () => Promise<unknown>]> = [
    ["seed summary", async () => seeded],

    // --- page loaders ------------------------------------------------------------------
    ["loader: dashboard", () => getDashboardData(USER)],
    ["loader: graph", () => loadGraphData(USER, { profile: null })],
    ["loader: notification panel", () => loadNotificationPanel(USER, new Date(), { withAlerts: true })],
    ["loader: knowledge base", () => loadKnowledgeBase(USER)],

    // --- MCP: protocol and read tools ---------------------------------------------------
    ["mcp initialize", () => mcp(writeKey, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "golden", version: "1.0.0" },
    })],
    ["mcp tools/list", () => mcp(writeKey, "tools/list")],
    ["mcp search_contacts", () => tool("search_contacts", { query: "OpenAI", limit: 10 })],
    ["mcp search_contacts (name)", () => tool("search_contacts", { query: "Sarah" })],
    ["mcp get_contact", () => tool("get_contact", { contactId: sarah.id })],
    ["mcp get_contact (missing)", () => tool("get_contact", { contactId: "00000000-0000-4000-8000-000000000000" })],
    ["mcp who_do_i_know_at", () => tool("who_do_i_know_at", { company: "Stripe" })],
    ["mcp due_followups", () => tool("due_followups", { limit: 25 })],
    ["mcp list_reminders upcoming", () => tool("list_reminders", { view: "upcoming", limit: 50 })],
    ["mcp list_reminders today", () => tool("list_reminders", { view: "today", limit: 50 })],
    ["mcp list_reminders anytime", () => tool("list_reminders", { view: "anytime", query: "intro" })],
    ["mcp list_reminders contact", () => tool("list_reminders", { contactId: sarah.id })],
    ["mcp get_network_overview", () => tool("get_network_overview", {})],
    ["mcp get_timeline", () => tool("get_timeline", { contactId: sarah.id, limit: 20 })],
    ["mcp get_goals", () => tool("get_goals", {})],
    ["mcp find_path_to company", () => tool("find_path_to", { target: "Google" })],
    ["mcp find_path_to school", () => tool("find_path_to", { target: "UNC" })],
    ["mcp search_notes", () => tool("search_notes", { query: "hiring" })],
    ["mcp list_open_commitments", () => tool("list_open_commitments", { limit: 25 })],

    // --- extension: reads ---------------------------------------------------------------
    ["ext me", () => ext(EXT_ME, "GET", "/api/extension/me")],
    ["ext resolve confident", () =>
      ext(EXT_RESOLVE, "POST", "/api/extension/resolve", {
        page: page({
          name: "Sarah Chen",
          title: sarah.title ?? undefined,
          company: sarah.company ?? undefined,
          url: sarah.linkedinUrl ?? "https://www.linkedin.com/in/sarah-chen-golden",
        }),
      })],
    ["ext resolve none", () =>
      ext(EXT_RESOLVE, "POST", "/api/extension/resolve", {
        page: page({ name: "Nobody Atall", url: "https://www.linkedin.com/in/nobody-atall-golden" }),
      })],
    ["ext search", () => ext(EXT_CONTACTS_SEARCH, "GET", "/api/extension/contacts?q=chen")],
    ["ext search empty", () => ext(EXT_CONTACTS_SEARCH, "GET", "/api/extension/contacts?q=")],

    // --- writes, then the reads they change ---------------------------------------------
    // Save and log call the library directly: their routes hand it `after`, which throws
    // outside a request scope. The default defer runs the deferred work inline instead.
    ["ext save new", () =>
      saveContactFromExtension(USER, {
        mode: "create",
        page: page({ name: "Golden Newperson", title: "Engineer", company: "Acme", url: "https://www.linkedin.com/in/golden-newperson" }),
        note: { rawNotes: "Golden: met at the extension test." },
        followUp: { inDays: 14 },
        fields: { fullName: "Golden Newperson", company: "Acme", title: "Engineer" },
      })],
    ["ext save invalid (route)", () =>
      ext(EXT_CONTACTS_SAVE, "POST", "/api/extension/contacts", { mode: "merge" })],
    ["ext log interaction", () =>
      logExtensionInteraction(USER, {
        contactId: sarah.id,
        rawNotes: "Golden: caught up about the launch.",
      })],
    ["ext log interaction invalid (route)", () =>
      ext(EXT_INTERACTIONS, "POST", "/api/extension/interactions", { contactId: sarah.id, rawNotes: " " })],
    ["ext follow-up", () =>
      ext(EXT_FOLLOW_UPS, "POST", "/api/extension/follow-ups", { contactId: sarah.id, inDays: 5 })],
    ["mcp log_interaction", () => tool("log_interaction", { contactId: sarah.id, notes: "Golden MCP note", externalId: "golden-1" })],
    ["mcp add_note", () => tool("add_note", { contactId: sarah.id, note: "Golden add_note", externalId: "golden-2" })],
    ["mcp add_note (repeat)", () => tool("add_note", { contactId: sarah.id, note: "Golden add_note", externalId: "golden-2" })],
    ["mcp update_contact", () => tool("update_contact", { contactId: sarah.id, title: "Golden Title" })],
    ["mcp create_contact", () => tool("create_contact", { fullName: "Golden Mcpperson", email: "golden-mcp@example.com" })],
    ["mcp create_contact (dupe)", () => tool("create_contact", { fullName: "G. Mcpperson", email: "golden-mcp@example.com" })],
    ["mcp create_reminder", () => tool("create_reminder", { title: "Golden reminder", contactId: sarah.id })],
    ["mcp schedule_follow_up", () => tool("schedule_follow_up", { contactId: sarah.id, days: 3 })],
    ["mcp get_contact (after writes)", () => tool("get_contact", { contactId: sarah.id })],
    ["mcp get_timeline (after writes)", () => tool("get_timeline", { contactId: sarah.id, limit: 20 })],
    ["mcp due_followups (after writes)", () => tool("due_followups", { limit: 25 })],
    ["loader: dashboard (after writes)", () => getDashboardData(USER)],
    ["loader: graph (after writes)", () => loadGraphData(USER, { profile: null })],
  ];

  // Map and Set serialize as {} through JSON, so turn them into arrays first.
  const plain = (v: unknown) =>
    JSON.parse(
      JSON.stringify(v, (_k, x) =>
        x instanceof Map ? { __map: [...x.entries()] } : x instanceof Set ? { __set: [...x] } : x
      )
    ) as unknown;
  const raw: Record<string, unknown> = {};
  for (const [name, probe] of probes) {
    // Rate-limit counters are bookkeeping, not behavior under test: without this, adding
    // probes would eventually turn the later ones into 429s.
    await db.execute(sql`DELETE FROM rate_limit_buckets`);
    await db.execute(sql`DELETE FROM extension_usage`);
    try {
      raw[name] = plain(await probe());
    } catch (err) {
      raw[name] = { __threw: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
  }
  await buildUuidLabels();
  const actual: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) actual[name] = normalize(value);

  if (UPDATE || !existsSync(GOLDEN)) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + "\n");
    console.log(`  recorded ${Object.keys(actual).length} probes → ${GOLDEN}`);
    return;
  }

  const expected = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>;
  let failures = 0;
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const name of names) {
    const a = JSON.stringify(actual[name], null, 2) ?? "(missing)";
    const e = JSON.stringify(expected[name], null, 2) ?? "(missing)";
    if (a === e) {
      console.log(`  ok    ${name}`);
      continue;
    }
    failures++;
    const al = a.split("\n");
    const el = e.split("\n");
    const at = al.findIndex((line, i) => line !== el[i]);
    console.log(`  FAIL  ${name} — first difference at line ${at + 1}:`);
    for (let i = Math.max(0, at - 3); i < Math.min(Math.max(al.length, el.length), at + 4); i++) {
      if (el[i] !== al[i]) {
        console.log(`          - ${el[i] ?? ""}`);
        console.log(`          + ${al[i] ?? ""}`);
      } else console.log(`            ${el[i] ?? ""}`);
    }
  }
  if (failures) throw new Error(`${failures} probe(s) differ from the recorded behavior`);
  console.log(`\nAll ${names.size} probes match the recorded behavior`);
});
