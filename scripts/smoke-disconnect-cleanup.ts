/**
 * "Disconnect Gmail" takes the confirmation-email scan it fed with it.
 *
 * The scan is an opt-in row in `event_provider_connections` (provider="gmail", authKind=
 * "google_grant") that carries no token of its own — it borrows the Gmail connection's.
 * Deleting the Gmail connection without also deleting that row left the scheduler
 * claiming it every pass, failing "Gmail is not connected", and working through a
 * six-step backoff while reporting a warning each time (Task 6, defect 1).
 *
 * Verified through the real `disconnectGmail` action, not the underlying delete alone, so
 * a regression that drops the cleanup (or scopes it to the wrong provider) fails here.
 *
 * Run: npx tsx scripts/smoke-disconnect-cleanup.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

// disconnectGmail() calls requireUserId(), which resolves to "demo-user" only when Clerk
// is unconfigured (demo mode) — the same route smoke-clear-api-key.ts already uses. Set
// before the "use server" action module below is imported.
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";
process.env.ORBIT_DEMO_DATA = "off";
process.env.GOOGLE_CLIENT_ID ||= "smoke-client.apps.googleusercontent.com";
process.env.GOOGLE_REDIRECT_URI ||= "http://localhost:3001/api/gmail/callback";

import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { gmailConnections } from "../src/db/schema";
import { disconnectGmail } from "../src/actions/gmail";
import { upsertGmailConnection } from "../src/lib/gmail";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import {
  deleteEventConnection,
  listEventConnections,
  upsertEventConnection,
} from "../src/lib/events/connections";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "demo-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function tokensWithScope(scope: string) {
  return { access_token: "at-disconnect-cleanup", refresh_token: "rt-disconnect-cleanup", scope, expires_in: 3600 };
}

async function cleanup() {
  const db = await getDb();
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, USER));
  await db.execute(sql`DELETE FROM event_provider_connections WHERE user_id = ${USER}`);
}

async function readGmailRow() {
  const db = await getDb();
  return db.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, USER) });
}

run(async () => {
  await cleanup();
  await ensureUserSettings(USER);

  console.log("\ndisconnecting Google takes its event scan with it");
  await upsertGmailConnection(USER, tokensWithScope(GOOGLE_SCOPES.gmailRead), "jo@gmail.com");
  await upsertEventConnection(USER, { provider: "gmail", authKind: "google_grant", secret: "", label: "jo@gmail.com" });
  // An unrelated event connection for the same user must survive — deleteEventConnection is
  // scoped by provider, not a blanket wipe of the user's row(s).
  await upsertEventConnection(USER, { provider: "luma_ics", authKind: "ics", secret: "https://lu.ma/ics/smoke-disconnect-cleanup" });

  // The revoke call is best-effort and never throws on its own (see oauth-revoke.ts), but it
  // does reach the network for a real token — stub it so this smoke stays hermetic and fast.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
  try {
    await disconnectGmail({});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // revalidatePath has no router cache to invalidate outside a real Next.js request —
    // the same invariant smoke-import-engine.ts's `runJob` swallows. Every write
    // disconnectGmail makes has already landed by the time this fires.
    if (!message.startsWith("Invariant: static generation store missing")) throw err;
  } finally {
    globalThis.fetch = realFetch;
  }

  check("the sign-in is gone", (await readGmailRow()) === undefined);
  check(
    "and the confirmation-email scan it fed is gone too",
    (await listEventConnections(USER)).every((c) => c.provider !== "gmail")
  );
  check(
    "an unrelated event connection for the same user survives",
    (await listEventConnections(USER)).some((c) => c.provider === "luma_ics")
  );

  console.log("\nconnecting a different mailbox takes the old one's event scan with it");
  await cleanup();
  await upsertGmailConnection(USER, tokensWithScope(GOOGLE_SCOPES.gmailRead), "jo@gmail.com");
  await upsertEventConnection(USER, { provider: "gmail", authKind: "google_grant", secret: "", label: "jo@gmail.com" });
  await upsertEventConnection(USER, { provider: "luma_ics", authKind: "ics", secret: "https://lu.ma/ics/smoke-switch" });

  // What the Gmail callback does on a switch. The route itself needs a Clerk session and a
  // live token exchange, so this drives the two steps it takes: the upsert reports the
  // switch, and the callback acts on that report.
  const { switchedFrom } = await upsertGmailConnection(
    USER,
    tokensWithScope(GOOGLE_SCOPES.gmailRead),
    "jo@newjob.com"
  );
  check("the upsert reports the account change", switchedFrom === "jo@gmail.com", String(switchedFrom));
  if (switchedFrom) await deleteEventConnection(USER, "gmail");

  check(
    "the previous mailbox's confirmation-email scan is gone",
    (await listEventConnections(USER)).every((c) => c.provider !== "gmail")
  );
  check(
    "an unrelated event connection for the same user survives the switch",
    (await listEventConnections(USER)).some((c) => c.provider === "luma_ics")
  );
  check("and the new sign-in is the one that stands", (await readGmailRow())?.emailAddress === "jo@newjob.com");

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll disconnect-cleanup checks passed.");
});
