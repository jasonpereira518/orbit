/**
 * Data scale: a 20,000-contact / 40,000-interaction account on PGlite. Times the hot
 * read paths that load whole networks into memory, walks every page of the contacts list
 * to prove the keyset is a total order, and measures the export.
 *
 * Absolute times on PGlite are not production times (Neon over HTTP is slower per statement,
 * faster per row). What matters is the SHAPE: a loader whose cost tracks network size is the
 * finding, and the numbers make the growth visible.
 *
 *   npx tsx stress-tests/scale-20k.ts
 */
import { check, finding, run, summary } from "./_harness";
import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contacts, interactions } from "../src/db/schema";
import { scaleContactRows } from "../scripts/lib/scale-fixture";
import { ensureUserSettings } from "../src/lib/user-settings";
import { loadGraphData } from "../src/lib/graph-data";
import { getDashboardData } from "../src/lib/reminders";
import { loadKnowledgeBase } from "../src/lib/knowledge-base";
import { listContactsPage } from "../src/lib/contacts-page-query";
import { collectUserExport } from "../src/lib/data-export";
import { recalibrateCloseness } from "../src/lib/closeness-cohort";
import { loadNotificationPanel } from "../src/lib/notification-panel";

const USER = "stress-scale-20k";
const N = Number(process.env.SCALE_N ?? 20_000);

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  const ms = Math.round(performance.now() - t0);
  console.log(`  ⏱  ${label}: ${ms} ms`);
  return { ms, value };
}

run(async () => {
  const db = await getDb();
  await ensureUserSettings(USER);
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));

  console.log(`Seeding ${N} contacts + ${N * 2} interactions...`);
  const rows = scaleContactRows(USER, N, { longNotesShare: 0.2, inlineAvatarShare: 0.1 });
  const t0 = Date.now();
  for (let i = 0; i < rows.length; i += 500) await db.insert(contacts).values(rows.slice(i, i + 500));
  const ids = rowsOf<{ id: string }>(await db.execute(sql`select id from contacts where user_id = ${USER}`)).map((r) => r.id);
  const ix = ids.flatMap((id, i) => [
    { userId: USER, contactId: id, rawNotes: `Coffee chat ${i} about hiring and the reorg.`, interactionType: "note", interactionDate: new Date(Date.now() - (i % 400) * 86400000) },
    { userId: USER, contactId: id, rawNotes: `Follow-up ${i}.`, interactionType: "email", interactionDate: new Date(Date.now() - (i % 90) * 86400000) },
  ]);
  for (let i = 0; i < ix.length; i += 1000) await db.insert(interactions).values(ix.slice(i, i + 1000));
  console.log(`  seeded in ${Date.now() - t0} ms`);

  const heapBefore = process.memoryUsage().heapUsed;
  const graph = await timed("loadGraphData (constellation; findMany with no limit + tags join)", () => loadGraphData(USER, { profile: null }));
  const heapAfter = process.memoryUsage().heapUsed;
  check(`graph returned ${(graph.value as { nodes?: unknown[] }).nodes?.length ?? "?"} nodes, heap +${Math.round((heapAfter - heapBefore) / 1048576)} MB`, true);
  finding("SCALE-GRAPH", "constellation load stays under 5 s at 20k contacts (cost tracks network size: every row + tags is loaded then filtered in JS)", graph.ms < 5000, `${graph.ms} ms`);

  const dash = await timed("getDashboardData", () => getDashboardData(USER));
  finding("SCALE-DASH", "dashboard stays under 5 s at 20k contacts", dash.ms < 5000, `${dash.ms} ms`);
  void dash.value;

  const kb = await timed("loadKnowledgeBase (q='a')", () => loadKnowledgeBase(USER, { q: "a" } as never));
  finding("SCALE-KB", "knowledge base search stays under 5 s", kb.ms < 5000, `${kb.ms} ms`);

  const panel = await timed("loadNotificationPanel", () => loadNotificationPanel(USER, new Date(), { withAlerts: false }));
  check(`notification panel ${panel.ms} ms`, true);

  const recal = await timed("recalibrateCloseness (full network rescore)", () => recalibrateCloseness(USER));
  finding("SCALE-CLOSENESS", "full closeness recalibration stays under 10 s (runs after bulk writes, in-request)", recal.ms < 10_000, `${recal.ms} ms`);

  console.log("\nKeyset pagination: walk every page of the name sort...");
  {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let dupes = 0;
    const tw = performance.now();
    for (;;) {
      const page = await listContactsPage(USER, { sort: "name", limit: 200, cursor } as never);
      for (const c of page.items as { id: string }[]) {
        if (seen.has(c.id)) dupes++;
        seen.add(c.id);
      }
      pages++;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (pages > 1000) break;
    }
    const ms = Math.round(performance.now() - tw);
    finding("SCALE-PAGE", `walking ${pages} pages yields every contact exactly once`, seen.size === N && dupes === 0, `${seen.size}/${N} seen, ${dupes} duplicates, ${ms} ms total, ${Math.round(ms / pages)} ms/page`);
  }

  console.log("\nLIKE metacharacters in search terms...");
  {
    const pct = await listContactsPage(USER, { q: "%", limit: 50 } as never);
    const und = await listContactsPage(USER, { q: "____", limit: 50 } as never);
    const none = await listContactsPage(USER, { q: "zzqxjv-no-such-person", limit: 50 } as never);
    check(`q='%' → ${pct.items.length} rows; q='____' → ${und.items.length}; nonsense → ${none.items.length}`, true);
    finding("SCALE-LIKE", "a bare '%' search term does not match every contact (LIKE escaping)", pct.items.length === 0 || pct.items.length < 50, `${pct.items.length} rows`);
    const kbPct = await loadKnowledgeBase(USER, { q: "%" } as never);
    const kbCount = (kbPct as { entries?: unknown[]; items?: unknown[]; results?: unknown[] });
    const n = (kbCount.entries ?? kbCount.items ?? kbCount.results ?? []).length;
    finding("SCALE-LIKE-KB", "knowledge base: a '%' query does not match everything (`like = \\`%${q}%\\`` is unescaped in knowledge-base.ts)", n === 0, `${n} results for q='%' (keys: ${Object.keys(kbPct as object).join(",")})`);
  }

  console.log("\nExport...");
  {
    const exp = await timed("collectUserExport", () => collectUserExport(USER));
    const bytes = Buffer.byteLength(JSON.stringify(exp.value));
    check(`export is ${(bytes / 1048576).toFixed(1)} MB for ${N} contacts`, true);
    finding("SCALE-EXPORT", "export completes under 60 s", exp.ms < 60_000, `${exp.ms} ms`);
  }

  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  summary();
});
