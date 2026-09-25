/**
 * The shared tool registry: same tools, two surfaces, and the difference written down.
 *
 * The rule this exists to enforce is in the security comment at the top of
 * `src/lib/mcp/server.ts`: free text an attacker can write into a note must not fan out to
 * an outside model through `search_contacts`, which touches many contacts at once. That used
 * to be guaranteed by a field simply not being typed into a closure — safe, but invisible,
 * and exactly the kind of guarantee that evaporates when somebody refactors.
 *
 * So it is a test now, and a deep one: every MCP read tool is actually RUN against a contact
 * whose note contains a marker, and the payload is walked at every depth looking for it. A
 * top-level allowlist check would pass while a note leaked through a nested `interactions`
 * array; this would not.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-tool-registry.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions } from "../src/db/schema";
import { ORBIT_TOOLS } from "../src/lib/tools/definitions";
import {
  MCP_FAN_OUT_DENIED_FIELDS,
  project,
  runTool,
  toolsFor,
  type OrbitTool,
} from "../src/lib/tools/registry";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-tool-registry-user";

/** Text planted in every free-text field, so a leak is unmistakable wherever it surfaces. */
const NOTE_MARKER = "CANARY-NOTE-TEXT-MUST-NOT-FAN-OUT";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/**
 * Every tool the MCP surface offers. Spelled out rather than derived, so a tool that silently
 * stops being registered — or silently starts — fails here instead of in somebody's
 * assistant. It was the 16 the server shipped with; `get_timeline`, `get_goals` and
 * `find_path_to` joined them. `search_notes` and `list_open_commitments` are deliberately NOT
 * here: both return free text taken from notes, across many contacts.
 */
const EXPECTED_MCP_TOOLS = [
  "search_contacts",
  "get_contact",
  "who_do_i_know_at",
  "due_followups",
  "list_reminders",
  "get_network_overview",
  "log_interaction",
  "request_send",
  "get_send_status",
  "update_contact",
  "add_note",
  "create_reminder",
  "complete_reminder",
  "snooze_reminder",
  "schedule_follow_up",
  "create_contact",
  "get_timeline",
  "get_goals",
  "find_path_to",
].sort();

/** Every string anywhere in a payload, however deeply nested. */
function deepStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) deepStrings(v, out);
  else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) deepStrings(v, out);
  }
  return out;
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await ensureUserSettings(USER);

  // --- the registered set is exactly what shipped ---------------------------------------

  const mcpNames = toolsFor(ORBIT_TOOLS, "mcp", ["read", "write"]).map((t) => t.name).sort();
  check(
    `the MCP surface registers exactly the ${EXPECTED_MCP_TOOLS.length} tools it should`,
    JSON.stringify(mcpNames) === JSON.stringify(EXPECTED_MCP_TOOLS),
    `got ${mcpNames.length}: ${mcpNames.join(", ")}`
  );

  const readOnly = toolsFor(ORBIT_TOOLS, "mcp", ["read"]).map((t) => t.name);
  check(
    "a read-only scope is offered no write tool",
    !readOnly.includes("create_contact") && !readOnly.includes("log_interaction"),
    readOnly.join(", ")
  );

  // --- chat gets reads, and no writes ----------------------------------------------------

  const chatTools = toolsFor(ORBIT_TOOLS, "chat", ["read", "write"]);
  check(
    "no write tool is exposed to Orbit's own chat — a write is proposed there, not executed",
    chatTools.every((t) => t.scope === "read"),
    chatTools.filter((t) => t.scope !== "read").map((t) => t.name).join(", ")
  );
  check(
    "chat gets every shared read tool plus its own two",
    chatTools.length === 11,
    chatTools.map((t) => t.name).join(", ")
  );
  check(
    "list_open_commitments is chat-only too — action items are note text, fanned out across contacts",
    chatTools.some((t) => t.name === "list_open_commitments") &&
      !toolsFor(ORBIT_TOOLS, "mcp", ["read", "write"]).some((t) => t.name === "list_open_commitments")
  );
  check(
    "search_notes is chat-only — free-text fan-out over notes is what MCP must never offer",
    chatTools.some((t) => t.name === "search_notes") &&
      !toolsFor(ORBIT_TOOLS, "mcp", ["read", "write"]).some((t) => t.name === "search_notes"),
    chatTools.map((t) => t.name).join(", ")
  );

  // --- the projection actually strips ----------------------------------------------------

  const projected = project({ id: "1", name: "A", notes: NOTE_MARKER }, ["id", "name"]);
  check(
    "project() keeps only what the allowlist names",
    JSON.stringify(projected) === JSON.stringify({ id: "1", name: "A" }),
    JSON.stringify(projected)
  );
  const projectedList = project([{ id: "1", notes: NOTE_MARKER }], ["id"]) as unknown[];
  check(
    "project() walks an array of records",
    JSON.stringify(projectedList) === JSON.stringify([{ id: "1" }]),
    JSON.stringify(projectedList)
  );
  check(
    "a field the allowlist has never heard of is dropped, not passed through",
    !JSON.stringify(project({ id: "1", somethingNew: "x" }, ["id"])).includes("somethingNew")
  );

  // --- the real thing: run every MCP read tool and hunt for the canary -------------------

  const [contact] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Ada Lovelace",
      company: "Acme",
      title: "Engineer",
      notes: NOTE_MARKER,
      aiSummary: "Works on analytical engines.",
    })
    .returning();
  await db.insert(interactions).values({
    userId: USER,
    contactId: contact.id,
    interactionType: "note",
    rawNotes: NOTE_MARKER,
    interactionDate: new Date(),
  });

  const readTools = toolsFor(ORBIT_TOOLS, "mcp", ["read"]);
  const argsFor: Record<string, unknown> = {
    search_contacts: { query: "Ada", limit: 10 },
    get_contact: { contactId: contact.id },
    who_do_i_know_at: { company: "Acme", limit: 10 },
    due_followups: { limit: 10 },
    list_reminders: { view: "today", limit: 20 },
    get_network_overview: {},
    get_timeline: { contactId: contact.id, limit: 20 },
    get_goals: {},
    find_path_to: { target: "Acme", limit: 8 },
  };

  for (const tool of readTools) {
    const payload = await runTool(tool, USER, argsFor[tool.name], { surface: "mcp" });
    const strings = deepStrings(payload);
    const leaked = strings.some((s) => s.includes(NOTE_MARKER));
    if (tool.name === "get_contact") {
      // The one documented exception: one person, asked for by id, truncated. It is the
      // reason this loop checks by tool rather than asserting a blanket rule.
      check("get_contact does return the note — one person, asked for by id", leaked);
    } else {
      check(`${tool.name} does not fan out free-text notes over MCP`, !leaked, JSON.stringify(payload).slice(0, 200));
    }
  }

  // --- and the same search, on the chat surface, DOES carry the note ---------------------

  const searchTool = ORBIT_TOOLS.find((t) => t.name === "search_contacts") as OrbitTool;
  const chatSearch = await runTool(searchTool, USER, { query: "Ada", limit: 10 }, { surface: "chat" });
  check(
    "the same search on the chat surface carries the note — the text is already in that prompt",
    deepStrings(chatSearch).some((s) => s.includes(NOTE_MARKER)),
    JSON.stringify(chatSearch).slice(0, 200)
  );
  // The same asymmetry for the timeline, stated both ways. Without the chat half, "MCP does
  // not leak" above would pass just as happily on an empty result.
  const timelineTool = ORBIT_TOOLS.find((t) => t.name === "get_timeline") as OrbitTool;
  const timelineArgs = { contactId: contact.id, limit: 20 };
  const chatTimeline = await runTool(timelineTool, USER, timelineArgs, { surface: "chat" });
  check(
    "get_timeline carries the note in chat — so withholding it over MCP is a real difference",
    deepStrings(chatTimeline).some((str) => str.includes(NOTE_MARKER)),
    JSON.stringify(chatTimeline).slice(0, 200)
  );
  const mcpTimeline = (await runTool(timelineTool, USER, timelineArgs, { surface: "mcp" })) as {
    total?: number;
    entries?: unknown[];
  };
  check(
    "and MCP still gets the dates it needs to say when and how often",
    mcpTimeline.total === 1 && mcpTimeline.entries?.length === 1,
    JSON.stringify(mcpTimeline).slice(0, 200)
  );

  const mcpSearch = await runTool(searchTool, USER, { query: "Ada", limit: 10 }, { surface: "mcp" });
  check(
    "one tool, two answers — the MCP allowlist is what makes the difference",
    JSON.stringify(mcpSearch) !== JSON.stringify(chatSearch)
  );

  // --- the denied list is not empty, or every check above passes vacuously ---------------

  check(
    "the fan-out denied list still names the free-text fields",
    MCP_FAN_OUT_DENIED_FIELDS.includes("notes") && MCP_FAN_OUT_DENIED_FIELDS.includes("rawNotes"),
    MCP_FAN_OUT_DENIED_FIELDS.join(", ")
  );

  await db.delete(contacts).where(eq(contacts.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll tool-registry checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
