/**
 * The operations `efficiency-bench.ts` measures, against the account it seeds.
 *
 * The account is `demo-user` because request-bound loaders (`requireUserId()`) resolve to
 * it on a local server with no Clerk keys — which needs NODE_ENV=development, set here.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../src/db";
import { contacts } from "../../src/db/schema";
import { getDashboardData } from "../../src/lib/reminders";
import { loadGraphData } from "../../src/lib/graph-data";
import { loadNotificationPanel } from "../../src/lib/notification-panel";
import { loadKnowledgeBase } from "../../src/lib/knowledge-base";
import { listContactsPage } from "../../src/lib/contacts-page-query";
import { POST as MCP_POST } from "../../src/app/api/mcp/route";
import { GET as EXT_ME } from "../../src/app/api/extension/me/route";
import { POST as EXT_RESOLVE } from "../../src/app/api/extension/resolve/route";
import { GET as EXT_SEARCH } from "../../src/app/api/extension/contacts/route";
import { BENCH_USER, benchApiKey, type BenchOp } from "./efficiency-bench-shared";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
env.ORBIT_DEMO_DATA = "off";
env.EXTENSION_DEV_SECRET = "bench-secret";
env.EXTENSION_DEV_USER_ID = BENCH_USER;

export async function benchOps(): Promise<BenchOp[]> {
  const db = await getDb();
  const token = await benchApiKey(BENCH_USER);
  const sarah = await db.query.contacts.findFirst({
    where: and(eq(contacts.userId, BENCH_USER), eq(contacts.fullName, "Sarah Chen")),
    columns: { id: true, linkedinUrl: true, title: true, company: true },
  });
  if (!sarah) throw new Error("run `seed` first");

  const tool = (name: string, args: Record<string, unknown>) => async () => {
    const res = await MCP_POST(
      new Request("https://orbit.test/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      })
    );
    return res.text();
  };
  const ext = (handler: (req: Request) => Promise<Response>, method: string, path: string, body?: unknown) =>
    async () => {
      const res = await handler(
        new Request(`https://orbit.test${path}`, {
          method,
          headers: { "content-type": "application/json", "x-orbit-dev-secret": "bench-secret" },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      );
      return res.json();
    };
  const field = (value: string | null | undefined) => (value ? { value, source: "h1", confidence: "high" } : null);
  const url = sarah.linkedinUrl ?? "https://www.linkedin.com/in/sarah-chen";

  return [
    { name: "dashboard", run: () => getDashboardData(BENCH_USER) },
    { name: "graph", run: () => loadGraphData(BENCH_USER, { profile: null }) },
    { name: "notification panel", run: () => loadNotificationPanel(BENCH_USER, new Date(), { withAlerts: true }) },
    { name: "knowledge base", run: () => loadKnowledgeBase(BENCH_USER) },
    { name: "contacts page", run: () => listContactsPage(BENCH_USER, { limit: 50 }) },
    { name: "contacts search", run: () => listContactsPage(BENCH_USER, { q: "hopper", limit: 50 }) },
    { name: "mcp search_contacts", run: tool("search_contacts", { query: "Acme engineer", limit: 10 }) },
    { name: "mcp get_contact", run: tool("get_contact", { contactId: sarah.id }) },
    { name: "mcp who_do_i_know_at", run: tool("who_do_i_know_at", { company: "Globex" }) },
    { name: "mcp due_followups", run: tool("due_followups", { limit: 25 }) },
    { name: "mcp list_reminders", run: tool("list_reminders", { view: "upcoming", limit: 50 }) },
    { name: "mcp get_network_overview", run: tool("get_network_overview", {}) },
    { name: "mcp get_timeline", run: tool("get_timeline", { contactId: sarah.id, limit: 20 }) },
    { name: "mcp find_path_to", run: tool("find_path_to", { target: "Stanford" }) },
    { name: "ext me", run: ext(EXT_ME, "GET", "/api/extension/me") },
    {
      name: "ext resolve",
      run: ext(EXT_RESOLVE, "POST", "/api/extension/resolve", {
        page: {
          schemaVersion: 1, site: "linkedin", adapterVersion: "bench", kind: "person",
          url, sourceUrl: url, capturedAt: "2026-01-01T00:00:00.000Z",
          identity: {
            name: field("Sarah Chen"), headline: null, title: field(sarah.title), company: field(sarah.company),
            location: null, school: null, email: null, handle: null, profileUrl: field(url), photoUrl: null,
          },
          text: { blob: "Sarah Chen", truncated: false, charCount: 10, fromSelection: false },
          warnings: [],
        },
      }),
    },
    { name: "ext search", run: ext(EXT_SEARCH, "GET", "/api/extension/contacts?q=hopper") },
  ];
}
