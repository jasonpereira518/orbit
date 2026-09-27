/**
 * The Outlook recruiter scan, end to end against PGlite with Graph and the classifier injected.
 *
 * What this pins, in order of how badly it hurts to get wrong:
 *   1. PRIVACY. A recruiter's address reaches the SHARED `recruiters` row only when the user
 *      opted in (`user_settings.recruiter_sharing`). Their own link always keeps it.
 *   2. The scan stops — and leaves no watermark — when the AI key is the problem, when
 *      senders keep failing in a row, or when the Outlook session is dead.
 *   3. The window. A first Outlook scan is FULL even when the user's Gmail scan has already
 *      completed (the shared `recruiter_scan_state` row must not be read as Outlook history),
 *      and finishing an Outlook scan must not touch that row (it would skip Gmail history).
 *   4. Triage: Junk/Deleted, out-of-window mail, newsletters (List-Unsubscribe) and job boards
 *      never become candidate senders.
 *   5. Graph plumbing: `internetMessageHeaders` is parsed, throttling is retried.
 *
 * Run: npx tsx scripts/smoke-outlook-scan.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  importJobRows,
  imports,
  recruiterScanState,
  recruiters,
  userRecruiterLinks,
  userSettings,
} from "../src/db/schema";
import { ReauthRequiredError, aiProviderErrorMessage } from "../src/lib/errors";
import {
  MAX_CONSECUTIVE_SENDER_FAILURES,
  SCAN_CONSECUTIVE_FAILURES_COPY,
  SCAN_KEY_PROBLEM_COPY,
} from "../src/lib/gmail-scan-processor";
import {
  OUTLOOK_SCAN_IMPORT_TYPE,
  runOutlookRecruiterScanJob,
  type OutlookScanDeps,
} from "../src/lib/outlook-scan-processor";
import {
  buildOutlookRecruiterQuery,
  fetchOutlookMessageHeaders,
  type OutlookHeaderSummary,
  type OutlookMessageContent,
} from "../src/lib/outlook";
import { GRAPH_MAX_RETRIES, graphFetchWithRetry } from "../src/lib/graph-fetch";
import { lastCompletedScanStart } from "../src/lib/recruiter-scan-state";

const PRIVATE = "smoke-outlook-private";
const SHARING = "smoke-outlook-sharing";
const NO_SETTINGS = "smoke-outlook-nosettings";
const ABORT = "smoke-outlook-abort";
const WINDOW = "smoke-outlook-window";
const ALL_USERS = [PRIVATE, SHARING, NO_SETTINGS, ABORT, WINDOW];
const MARK = "ZZSmokeOutlook";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A stored failure message is the copy, optionally followed by Phase 0's "(ref …)". */
function isCopy(actual: string | null | undefined, expected: string): boolean {
  return typeof actual === "string" && (actual === expected || actual.startsWith(`${expected} (ref `));
}

const DAY = 86_400_000;

function header(over: Partial<OutlookHeaderSummary> & { id: string; from: string }): OutlookHeaderSummary {
  return {
    subject: "Role at Acme",
    snippet: "Recruiter here, open role for you",
    // A minute old: newer than any incremental window a previous scan in this file created.
    internalDate: Date.now() - 60_000,
    folderId: "inbox",
    listUnsubscribe: "",
    listId: "",
    precedence: "",
    ...over,
  };
}

type Classify = OutlookScanDeps["classify"];
const recruiterVerdict = (fullName: string): Awaited<ReturnType<Classify>> => ({
  isRecruiter: true,
  confidence: 0.95,
  fullName,
  firm: MARK,
  companiesMentioned: ["Acme"],
  rolesDiscussed: ["Engineer"],
  summary: "They reached out about a role.",
});
const notRecruiter: Awaited<ReturnType<Classify>> = {
  isRecruiter: false, confidence: 0.1, fullName: null, firm: null,
  companiesMentioned: [], rolesDiscussed: [], summary: null,
};

const content = (id: string): OutlookMessageContent => ({
  id, from: "Sender <s@agency.test>", subject: "Role at Acme", snippet: "open role",
  internalDate: Date.now(), body: "We are hiring.",
});

type Harness = {
  deps: OutlookScanDeps;
  queries: string[];
  classifyCalls: () => number;
};

function harness(opts: {
  headers?: OutlookHeaderSummary[];
  classify?: Classify;
  fetchMessages?: OutlookScanDeps["fetchMessages"];
}): Harness {
  const queries: string[] = [];
  let calls = 0;
  const headers = opts.headers ?? [];
  const deps: OutlookScanDeps = {
    getAccessToken: async () => "stub-token",
    listPage: async (_token, o) => {
      queries.push(o.query);
      return { messages: headers.map((h) => ({ id: h.id })), nextLink: null };
    },
    excludedFolders: async () => new Set(["junk-folder", "deleted-folder"]),
    fetchHeaders: async () => headers,
    fetchMessages: opts.fetchMessages ?? (async (_t, ids) => ids.map(content)),
    classify: async (userId, input) => {
      calls++;
      return (opts.classify ?? (async () => notRecruiter))(userId, input);
    },
    continueLater: async () => {},
  };
  return { deps, queries, classifyCalls: () => calls };
}

async function newJob(userId: string, stats: Record<string, unknown> = {}): Promise<string> {
  const db = await getDb();
  const [job] = await db
    .insert(imports)
    .values({
      userId,
      importType: OUTLOOK_SCAN_IMPORT_TYPE,
      status: "processing",
      totalRows: null,
      stats: { discoveryComplete: false, messagesScanned: 0, ...stats },
    })
    .returning();
  return job.id;
}

async function job(importId: string) {
  const db = await getDb();
  return (await db.query.imports.findFirst({ where: eq(imports.id, importId) }))!;
}

async function sharedRow(fullName: string) {
  const db = await getDb();
  return db.query.recruiters.findFirst({ where: eq(recruiters.fullName, fullName) });
}

async function cleanup() {
  const db = await getDb();
  const rows = await db.query.recruiters.findMany({ where: eq(recruiters.firm, MARK) });
  await db.delete(userRecruiterLinks).where(inArray(userRecruiterLinks.userId, ALL_USERS));
  if (rows.length) await db.delete(recruiters).where(inArray(recruiters.id, rows.map((r) => r.id)));
  await db.delete(importJobRows).where(inArray(importJobRows.userId, ALL_USERS));
  await db.delete(imports).where(inArray(imports.userId, ALL_USERS));
  await db.delete(recruiterScanState).where(inArray(recruiterScanState.userId, ALL_USERS));
  await db.delete(userSettings).where(inArray(userSettings.userId, ALL_USERS));
}

run(async () => {
  const db = await getDb();
  await cleanup();
  await db.insert(userSettings).values([
    { userId: PRIVATE, recruiterSharing: 0 },
    { userId: SHARING, recruiterSharing: 1 },
    { userId: ABORT, recruiterSharing: 0 },
    { userId: WINDOW, recruiterSharing: 0 },
  ]);

  try {
    // -------------------------------------------------------------------------------
    console.log("privacy: the shared row only gets an address from a user who shares");
    for (const [userId, name, address, shares] of [
      [PRIVATE, `${MARK} Private Pat`, "pat.private@agency.test", false],
      [SHARING, `${MARK} Sharing Sam`, "sam.sharing@agency.test", true],
      [NO_SETTINGS, `${MARK} Default Dana`, "dana.default@agency.test", false],
    ] as const) {
      const h = harness({
        headers: [header({ id: "m1", from: `${name} <${address}>` })],
        classify: async () => recruiterVerdict(name),
      });
      const id = await newJob(userId);
      await runOutlookRecruiterScanJob(id, h.deps);

      const done = await job(id);
      check(`${userId}: the scan completes`, done.status === "completed", `${done.status} ${done.errorMessage ?? ""}`);
      const row = await sharedRow(name);
      check(`${userId}: a shared recruiter row exists`, Boolean(row));
      check(
        shares ? `${userId} (sharing = 1): the address IS on the shared row` : `${userId} (sharing = ${userId === NO_SETTINGS ? "no settings row" : "0"}): the address is NOT on the shared row`,
        shares ? row?.email === address : row?.email === null,
        String(row?.email)
      );
      check(`${userId}: the creator is recorded`, row?.createdByUserId === userId, String(row?.createdByUserId));
      const link = row
        ? await db.query.userRecruiterLinks.findFirst({ where: eq(userRecruiterLinks.recruiterId, row.id) })
        : null;
      check(`${userId}: their own link keeps the address either way`, link?.email === address, String(link?.email));
      check(`${userId}: the link is sourced from outlook`, link?.source === "outlook", String(link?.source));
    }

    // -------------------------------------------------------------------------------
    console.log("triage: only a real, in-window, in-inbox human becomes a candidate");
    {
      const h = harness({
        headers: [
          header({ id: "ok", from: "Real Rita <rita@agency.test>" }),
          header({ id: "junk", from: "Junk Jo <jo@agency.test>", folderId: "junk-folder" }),
          header({ id: "trash", from: "Trash Tom <tom@agency.test>", folderId: "deleted-folder" }),
          header({ id: "old", from: "Old Olly <olly@agency.test>", internalDate: Date.now() - 900 * DAY }),
          header({ id: "news", from: "Digest <digest@brand.test>", listUnsubscribe: "<mailto:u@brand.test>" }),
          header({ id: "list", from: "Weekly <weekly@brand.test>", listId: "<jobs.brand.test>" }),
          header({ id: "bulk", from: "Bulk <bulk@brand.test>", precedence: "bulk" }),
          header({ id: "board", from: "LinkedIn <jobs-noreply@linkedin.com>" }),
          header({ id: "nope", from: "Colleague <c@work.test>", subject: "lunch?", snippet: "sandwich" }),
        ],
      });
      const id = await newJob(NO_SETTINGS);
      await runOutlookRecruiterScanJob(id, h.deps);
      const done = await job(id);
      check("every message counts as scanned", done.stats?.messagesScanned === 9, String(done.stats?.messagesScanned));
      check("exactly one candidate sender survives", done.stats?.candidateSenders === 1, String(done.stats?.candidateSenders));
      const rows = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, id) });
      const emails = rows.map((r) => (r.payload as { email?: string }).email);
      check("and it is the human in the inbox", emails.length === 1 && emails[0] === "rita@agency.test", emails.join(","));
    }

    // -------------------------------------------------------------------------------
    console.log("window: full first, incremental after, independent of Gmail's watermark");
    {
      // A Gmail scan has completed: the shared row says "scanned a minute ago".
      const gmailMark = new Date(Date.now() - 60_000);
      await db.insert(recruiterScanState).values({
        userId: WINDOW, lastScanAt: gmailMark, lastFullScanAt: gmailMark, promptVersion: 1, windowMonths: 24,
      });

      const first = harness({ headers: [header({ id: "w1", from: "Win Wes <wes@agency.test>" })] });
      const id1 = await newJob(WINDOW);
      await runOutlookRecruiterScanJob(id1, first.deps);
      const j1 = await job(id1);
      const spanDays = (Date.now() - new Date(j1.stats!.scanAfter!).getTime()) / DAY;
      check("the first Outlook scan is FULL despite Gmail's fresh watermark", j1.stats?.scanIsFull === true, String(j1.stats?.scanIsFull));
      check("and reaches back ~24 months", spanDays > 600, `${Math.round(spanDays)} days`);
      check("the query carries the window as a KQL restriction", /received>=\d{4}-\d{2}-\d{2}/.test(first.queries[0] ?? ""), first.queries[0]);
      check("Outlook completing does not touch the shared watermark", (await db.query.recruiterScanState.findFirst({ where: eq(recruiterScanState.userId, WINDOW) }))?.lastScanAt?.getTime() === gmailMark.getTime());
      check("its own watermark is the job's start", (await lastCompletedScanStart(WINDOW, OUTLOOK_SCAN_IMPORT_TYPE))?.getTime() === new Date(j1.stats!.scanStartedAt!).getTime());

      const second = harness({ headers: [] });
      const id2 = await newJob(WINDOW);
      await runOutlookRecruiterScanJob(id2, second.deps);
      const j2 = await job(id2);
      const resumeDays = (Date.now() - new Date(j2.stats!.scanAfter!).getTime()) / DAY;
      check("the second scan is incremental", j2.stats?.scanIsFull === false, String(j2.stats?.scanIsFull));
      check("and reads back only the overlap", resumeDays < 3, `${resumeDays.toFixed(2)} days`);

      // A frozen window is read back, not re-derived, on a continuation.
      const frozen = new Date(Date.now() - 10 * DAY).toISOString();
      const third = harness({ headers: [] });
      const id3 = await newJob(WINDOW, { scanAfter: frozen, scanIsFull: false });
      await runOutlookRecruiterScanJob(id3, third.deps);
      check("a continuation reuses the frozen window", (await job(id3)).stats?.scanAfter === frozen);
    }

    // -------------------------------------------------------------------------------
    console.log("a first Outlook scan is full when the user has no shared row at all");
    check("no completed Outlook scan means no watermark", (await lastCompletedScanStart("smoke-outlook-nobody", OUTLOOK_SCAN_IMPORT_TYPE)) === null);

    // -------------------------------------------------------------------------------
    console.log("an out-of-credit key stops the scan at the first sender");
    {
      const h = harness({
        headers: Array.from({ length: 4 }, (_, i) => header({ id: `q${i}`, from: `Q${i} <q${i}@agency.test>` })),
        classify: async () => { throw new Error("429 You exceeded your current quota, please check your plan and billing details."); },
      });
      const id = await newJob(ABORT);
      await runOutlookRecruiterScanJob(id, h.deps);
      const o = await job(id);
      check("the job ends failed", o.status === "failed", o.status);
      check("with the top-up copy", isCopy(o.errorMessage, SCAN_KEY_PROBLEM_COPY.quota), String(o.errorMessage));
      check("after one classifier call", h.classifyCalls() === 1, String(h.classifyCalls()));
      check("and leaves no watermark", (await lastCompletedScanStart(ABORT, OUTLOOK_SCAN_IMPORT_TYPE)) === null);
    }

    console.log("already-rewritten provider copy passes through");
    {
      const copy = aiProviderErrorMessage(new Error("401 Unauthorized: invalid x-api-key"), "Anthropic");
      const h = harness({
        headers: [header({ id: "p1", from: "P One <p1@agency.test>" })],
        classify: async () => { throw new Error(copy); },
      });
      const id = await newJob(ABORT);
      await runOutlookRecruiterScanJob(id, h.deps);
      const o = await job(id);
      check("the job ends failed with the provider's own words", o.status === "failed" && isCopy(o.errorMessage, copy), String(o.errorMessage));
    }

    console.log(`${MAX_CONSECUTIVE_SENDER_FAILURES} failures in a row stop it too`);
    {
      const h = harness({
        headers: Array.from({ length: 8 }, (_, i) => header({ id: `f${i}`, from: `F${i} <f${i}@agency.test>` })),
        classify: async () => { throw new Error("Unexpected token < in JSON"); },
      });
      const id = await newJob(ABORT);
      await runOutlookRecruiterScanJob(id, h.deps);
      const o = await job(id);
      check("the job ends failed", o.status === "failed" && isCopy(o.errorMessage, SCAN_CONSECUTIVE_FAILURES_COPY), String(o.errorMessage));
      check(`after exactly ${MAX_CONSECUTIVE_SENDER_FAILURES} calls`, h.classifyCalls() === MAX_CONSECUTIVE_SENDER_FAILURES, String(h.classifyCalls()));
      check("and leaves no watermark", (await lastCompletedScanStart(ABORT, OUTLOOK_SCAN_IMPORT_TYPE)) === null);
    }

    console.log("a success resets the streak");
    {
      let n = 0;
      const h = harness({
        headers: Array.from({ length: 8 }, (_, i) => header({ id: `s${i}`, from: `S${i} <s${i}@agency.test>` })),
        classify: async () => {
          n++;
          if (n <= MAX_CONSECUTIVE_SENDER_FAILURES - 1) throw new Error("Unexpected token < in JSON");
          return notRecruiter;
        },
      });
      const id = await newJob(ABORT);
      await runOutlookRecruiterScanJob(id, h.deps);
      const o = await job(id);
      check("the job completes", o.status === "completed", `${o.status} ${o.errorMessage ?? ""}`);
      check("and becomes the watermark", (await lastCompletedScanStart(ABORT, OUTLOOK_SCAN_IMPORT_TYPE)) !== null);
    }

    console.log("a dead Outlook session stops the scan with the reconnect line");
    {
      const h = harness({
        headers: [header({ id: "r1", from: "R One <r1@agency.test>" })],
        fetchMessages: async () => { throw new ReauthRequiredError("Outlook session expired — reconnect"); },
      });
      const id = await newJob(ABORT);
      await runOutlookRecruiterScanJob(id, h.deps);
      const o = await job(id);
      check("the job ends failed", o.status === "failed", o.status);
      check("with the reconnect copy", isCopy(o.errorMessage, "Outlook session expired — reconnect"), String(o.errorMessage));
      check("without spending a classification", h.classifyCalls() === 0, String(h.classifyCalls()));
    }

    // -------------------------------------------------------------------------------
    console.log("Graph plumbing");
    {
      check("the query is bounded by the window", buildOutlookRecruiterQuery({ after: new Date("2026-01-04T10:00:00Z") }).includes("received>=2026-01-04"));
      check("and unbounded without one", !buildOutlookRecruiterQuery().includes("received"));

      const realFetch = globalThis.fetch;
      const seen: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        seen.push(String(url));
        return new Response(
          JSON.stringify({
            id: "m9",
            subject: "Hello",
            bodyPreview: "Recruiter here",
            receivedDateTime: "2026-01-04T10:00:00Z",
            parentFolderId: "folder-1",
            from: { emailAddress: { name: "Rita", address: "rita@agency.test" } },
            internetMessageHeaders: [
              { name: "List-Unsubscribe", value: "<mailto:u@agency.test>" },
              { name: "list-id", value: "<jobs.agency.test>" },
              { name: "Precedence", value: "bulk" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }) as typeof fetch;
      try {
        const [h] = await fetchOutlookMessageHeaders("tok", [{ id: "m9" }]);
        check("internetMessageHeaders is requested", /select=[^&]*internetMessageHeaders/.test(seen[0] ?? ""), seen[0]);
        check("List-Unsubscribe / List-Id / Precedence are read (case-insensitive)", h?.listUnsubscribe === "<mailto:u@agency.test>" && h?.listId === "<jobs.agency.test>" && h?.precedence === "bulk");
        check("from is rebuilt as a header string", h?.from === "Rita <rita@agency.test>", h?.from);
        check("the folder rides along", h?.folderId === "folder-1");
      } finally {
        globalThis.fetch = realFetch;
      }

      // A 401 is the session: it must surface, not read as "nothing recruiter-shaped".
      globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
      try {
        let threw: unknown = null;
        try { await fetchOutlookMessageHeaders("tok", [{ id: "x" }]); } catch (e) { threw = e; }
        check("a 401 on a message fetch throws ReauthRequiredError", threw instanceof ReauthRequiredError);
      } finally {
        globalThis.fetch = realFetch;
      }

      const sleeps: number[] = [];
      let n = 0;
      const throttled = (async () =>
        ++n <= 2
          ? new Response("", { status: 429, headers: { "retry-after": "2" } })
          : new Response("{}", { status: 200 })) as unknown as typeof fetch;
      const res = await graphFetchWithRetry("https://example.test/a", { timeoutMs: 1000, fetchImpl: throttled, sleep: async (ms) => { sleeps.push(ms); } });
      check("a 429 is retried, honouring Retry-After", res.ok && n === 3 && sleeps.every((ms) => ms === 2000), `${n} calls, sleeps ${sleeps}`);

      let m = 0;
      const always503 = (async () => { m++; return new Response("", { status: 503 }); }) as unknown as typeof fetch;
      const last = await graphFetchWithRetry("https://example.test/b", { timeoutMs: 1000, fetchImpl: always503, sleep: async () => {} });
      check("a 503 is retried, then given up on", last.status === 503 && m === GRAPH_MAX_RETRIES + 1, `${m} calls`);

      let k = 0;
      const notFound = (async () => { k++; return new Response("", { status: 404 }); }) as unknown as typeof fetch;
      await graphFetchWithRetry("https://example.test/c", { timeoutMs: 1000, fetchImpl: notFound, sleep: async () => {} });
      check("a 404 is not retried", k === 1);
    }
  } finally {
    await cleanup();
  }

  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Outlook scan checks passed.");
});
