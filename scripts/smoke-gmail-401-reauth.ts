/**
 * A revoked Gmail grant fails the recruiter scan with needs_reconnect — it is not "no mail".
 *
 * Pins: `fetchGmailMessages`, `fetchGmailMessageLinks` and `fetchGmailThread`
 * (src/lib/gmail.ts) throw `ReauthRequiredError` on a 401, like `fetchGmailHeaders` and
 * Outlook's `fetchOutlookMessages`; and `runGmailRecruiterScanJob`
 * (src/lib/gmail-scan-processor.ts) fails the import with errorCode `needs_reconnect`, leaves
 * the unread senders pending, and does not advance the mailbox watermark.
 *
 * Why: the readers used to return null for any non-ok answer, so when Google stopped honouring
 * the token mid-scan (access revoked, password changed, a Workspace admin pulling the grant)
 * every sender read as having no messages, was recorded as "not a recruiter", and the scan
 * completed — stepping the watermark past the whole window with no reconnect prompt, so those
 * senders were never read again. The fix throws on 401 in the three readers and has the
 * scan's sender catch stop on `ReauthRequiredError` the way the Outlook scan does.
 *
 * Run: npx tsx scripts/smoke-gmail-401-reauth.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { importJobRows, imports, recruiterScanState } from "../src/db/schema";
import { ReauthRequiredError } from "../src/lib/errors";
import { fetchGmailMessageLinks, fetchGmailMessages, fetchGmailThread } from "../src/lib/gmail";
import { runGmailRecruiterScanJob, type ScanDeps } from "../src/lib/gmail-scan-processor";
import { fetchOutlookMessages } from "../src/lib/outlook";
import { checker } from "./smoke/check";
import { fakeUserId, makeContact, purgeUsers } from "./smoke/factories";
import { json, mockFetch, route, status } from "./smoke/http-mock";

const t = checker();
const USER = fakeUserId("gmail401");
const TOKEN = "ya29.revoked-token-not-real";

/** Google's real 401 body for an access token it no longer honours. */
const GOOGLE_401 = {
  error: {
    code: 401,
    message: "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
    errors: [{ message: "Invalid Credentials", domain: "global", reason: "authError", location: "Authorization", locationType: "header" }],
    status: "UNAUTHENTICATED",
  },
};
const GRAPH_401 = { error: { code: "InvalidAuthenticationToken", message: "Lifetime validation failed, the token is expired." } };

async function seedScan(senders: number): Promise<string> {
  const db = await getDb();
  await db.delete(importJobRows).where(eq(importJobRows.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(recruiterScanState).where(eq(recruiterScanState.userId, USER));
  // Discovery already ran in an earlier invocation; this one only reads and classifies senders.
  const [job] = await db
    .insert(imports)
    .values({
      userId: USER,
      importType: "gmail_recruiter_scan",
      status: "processing",
      totalRows: senders,
      stats: {
        discoveryComplete: true,
        scanAfter: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        scanIsFull: false,
        scanStartedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    })
    .returning();
  await db.insert(importJobRows).values(
    Array.from({ length: senders }, (_, i) => {
      const c = makeContact(i);
      return {
        importId: job.id,
        userId: USER,
        rowIndex: i,
        status: "pending",
        payload: { kind: "gmail_sender" as const, email: c.email, name: c.fullName, firm: c.company, messageIds: [`18c2f0a1b2c3d4${i}0`, `18c2f0a1b2c3d4${i}1`] },
      };
    })
  );
  return job.id;
}

run(async () => {
  const db = await getDb();
  await purgeUsers(db, [USER]);

  console.log("The readers, one 401 each");
  {
    const http = mockFetch([
      route("GET", /gmail\/v1\/users\/me\/messages\//, () => status(401, GOOGLE_401)),
      route("GET", /gmail\/v1\/users\/me\/threads\//, () => status(401, GOOGLE_401)),
      route("GET", /graph\.microsoft\.com\/v1\.0\/me\/messages\//, () => status(401, GRAPH_401)),
    ]);
    try {
      // Outlook's twin, which always got this right.
      await t.rejects("Outlook: fetchOutlookMessages turns a 401 into ReauthRequiredError", () => fetchOutlookMessages(TOKEN, ["AAMkAD-test"]), (e) =>
        e instanceof ReauthRequiredError
      );

      let messagesErr: unknown = null;
      let messages: unknown = null;
      try {
        messages = await fetchGmailMessages(TOKEN, ["18c2f0a1b2c3d400"]);
      } catch (e) {
        messagesErr = e;
      }
      t.check(
        "fetchGmailMessages turns a 401 into ReauthRequiredError",
        messagesErr instanceof ReauthRequiredError,
        `returned ${JSON.stringify(messages)}`
      );

      let linksErr: unknown = null;
      let links: unknown = null;
      try {
        links = await fetchGmailMessageLinks(TOKEN, ["18c2f0a1b2c3d400"]);
      } catch (e) {
        linksErr = e;
      }
      t.check(
        "fetchGmailMessageLinks turns a 401 into ReauthRequiredError",
        linksErr instanceof ReauthRequiredError,
        `returned ${JSON.stringify(links)}`
      );

      let threadErr: unknown = null;
      let thread: unknown = "unset";
      try {
        thread = await fetchGmailThread(TOKEN, "thr-1");
      } catch (e) {
        threadErr = e;
      }
      t.check(
        "fetchGmailThread turns a 401 into ReauthRequiredError",
        threadErr instanceof ReauthRequiredError,
        `returned ${JSON.stringify(thread)}`
      );
    } finally {
      http.restore();
    }
  }

  console.log("\nEnd to end: the recruiter scan on a token Google has revoked");
  {
    const SENDERS = 4;
    const id = await seedScan(SENDERS);
    let classified = 0;
    const deps: ScanDeps = {
      getAccessToken: async () => TOKEN,
      listPage: async () => {
        throw new Error("discovery already ran");
      },
      fetchHeaders: async () => {
        throw new Error("discovery already ran");
      },
      // The real reader, against a Gmail that answers 401 to everything.
      fetchMessages: fetchGmailMessages,
      classify: async () => {
        classified++;
        throw new Error("the classifier must not be reached without messages");
      },
      submit: async () => null,
      continueLater: async () => {},
    };
    const http = mockFetch([route("GET", /gmail\/v1\/users\/me\/messages\//, () => status(401, GOOGLE_401))]);
    try {
      await runGmailRecruiterScanJob(id, deps);
    } finally {
      http.restore();
    }

    const job = await db.query.imports.findFirst({ where: eq(imports.id, id) });
    const rows = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, id) });
    const mark = await db.query.recruiterScanState.findFirst({ where: eq(recruiterScanState.userId, USER) });

    t.check("Gmail was asked for the senders' messages", http.calls.length >= 1, String(http.calls.length));
    t.check("the classifier was never reached", classified === 0, String(classified));
    t.check(
      "a revoked Gmail token fails the recruiter scan with needs_reconnect",
      job?.status === "failed" && job?.stats?.errorCode === "needs_reconnect",
      `status=${job?.status} errorCode=${String(job?.stats?.errorCode)}`
    );
    t.check(
      "senders whose mail could not be read are not recorded as rejected (skipped)",
      rows.every((r) => r.status !== "skipped"),
      `row statuses: ${rows.map((r) => r.status).join(",")}`
    );
    t.check(
      "the mailbox watermark does not advance past the unread window",
      !mark?.lastScanAt,
      `lastScanAt=${mark?.lastScanAt?.toISOString?.() ?? String(mark?.lastScanAt)}`
    );
  }

  // Sanity: the same mock with a 200 makes the reader work, so the 401 above is what changed.
  {
    const http = mockFetch([
      route("GET", /gmail\/v1\/users\/me\/messages\//, () =>
        json({ id: "18c2f0a1b2c3d400", threadId: "t", internalDate: "1760000000000", snippet: "hi", payload: { headers: [{ name: "From", value: "a@example.com" }] } })
      ),
    ]);
    try {
      const out = await fetchGmailMessages(TOKEN, ["18c2f0a1b2c3d400"]);
      t.check("control: a 200 from the same route is read", out.length === 1 && out[0].from === "a@example.com");
    } finally {
      http.restore();
    }
  }

  await purgeUsers(db, [USER]);
  t.done("gmail 401 reauth");
});
