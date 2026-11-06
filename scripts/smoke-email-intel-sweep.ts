/**
 * The email-insights sweep: who it claims, what it stores, and every way it stops.
 * PGlite plus a fake Gmail and fake gates. No key, no network.
 * Run: npx tsx scripts/smoke-email-intel-sweep.ts
 */
import "./smoke/_env";

import { eq, inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { emailEvents, emailThreads, rateLimitBuckets, userSettings } from "../src/db/schema";
import {
  BACKFILL_DAYS,
  DEFER_MS,
  INTERVAL_MS,
  runEmailIntelSweep,
  type EmailIntelDeps,
  type EmailIntelGmail,
} from "../src/lib/email-intel/sweep";
import type { GmailHeaderSummary, GmailThreadSummary } from "../src/lib/gmail";
import { ReauthRequiredError } from "../src/lib/errors";
import { consumeBucket, RATE_LIMITS } from "../src/lib/rate-limit";
import { utcDayKey } from "../src/lib/timeline-cost";
import { ensureUserSettings } from "../src/lib/user-settings";

const ON = "smoke-eis-on";
const OFF = "smoke-eis-off";
const NOREAD = "smoke-eis-noread";
const NOELIG = "smoke-eis-noelig";
const REAUTH = "smoke-eis-reauth";
const CAPPED = "smoke-eis-capped";
const LATE = "smoke-eis-late";
const USERS = [ON, OFF, NOREAD, NOELIG, REAUTH, CAPPED, LATE];
const ME = "me@example.com";
const MIN = 60_000;
const T0 = new Date("2026-09-30T12:00:00Z");

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function msg(over: Partial<GmailHeaderSummary>): GmailHeaderSummary {
  return {
    id: "m",
    threadId: "t",
    from: "",
    to: `Me <${ME}>`,
    subject: "",
    snippet: "",
    internalDate: T0.getTime() - 60 * MIN,
    listUnsubscribe: "",
    listId: "",
    precedence: "",
    ...over,
  };
}

const threads: Record<string, GmailThreadSummary> = {
  "t-ats": {
    id: "t-ats",
    messages: [
      msg({ id: "a1", threadId: "t-ats", from: "Stripe <no-reply@stripe.com>", subject: "Thank you for applying to Stripe", snippet: "We have received your application." }),
    ],
  },
  "t-human": {
    id: "t-human",
    messages: [
      msg({ id: "h1", threadId: "t-human", from: "Dana Kim <dana@acme.com>", subject: "Software Engineer role at Acme", snippet: "I’m a technical recruiter at Acme, are you free Thursday to schedule a call?" }),
    ],
  },
  "t-news": {
    id: "t-news",
    messages: [msg({ id: "n1", threadId: "t-news", from: "News <news@substack.com>", subject: "This week", listUnsubscribe: "<mailto:x>" })],
  },
};

type Calls = { list: number; fetch: number[]; tokens: string[]; queries: string[] };
function fakeGmail(calls: Calls): EmailIntelGmail {
  return {
    accessToken: async (userId) => {
      calls.tokens.push(userId);
      if (userId === REAUTH) throw new ReauthRequiredError("expired");
      return "tok";
    },
    listPage: async (_token, opts) => {
      calls.list += 1;
      calls.queries.push(opts.query);
      const messages = Object.values(threads).map((t) => ({ id: t.messages.at(-1)!.id, threadId: t.id }));
      return { messages, nextPageToken: null };
    },
    fetchThreads: async (_token, ids) => {
      calls.fetch.push(ids.length);
      return ids.map((id) => threads[id]).filter((t): t is GmailThreadSummary => Boolean(t));
    },
  };
}

function deps(calls: Calls, now: Date, extra: Partial<EmailIntelDeps> = {}): EmailIntelDeps {
  return {
    now,
    gmail: fakeGmail(calls),
    connection: async (userId) => (userId === NOREAD ? { email: ME, canRead: false } : { email: ME, canRead: true }),
    eligible: async (userId) => userId !== NOELIG,
    ...extra,
  };
}

const freshCalls = (): Calls => ({ list: 0, fetch: [], tokens: [], queries: [] });

/** Arms exactly `armed`, clears their schedule, and leaves everyone else switched off. */
async function arm(armed: string[]) {
  const db = await getDb();
  await db.update(userSettings).set({ emailIntelEnabled: 0 }).where(inArray(userSettings.userId, USERS));
  await db
    .update(userSettings)
    .set({ emailIntelEnabled: 1, emailIntelNextAt: null, emailIntelCursorAt: null })
    .where(inArray(userSettings.userId, armed));
}

async function settingsOf(userId: string) {
  const db = await getDb();
  const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  return row!;
}

async function threadRows(userId: string) {
  const db = await getDb();
  return db.select().from(emailThreads).where(eq(emailThreads.userId, userId));
}

async function main() {
  const db = await getDb();
  await db.delete(emailThreads).where(inArray(emailThreads.userId, USERS));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "%smoke-eis-%"));
  for (const u of USERS) await ensureUserSettings(u);

  console.log("\nWho is claimed, and what they leave behind");
  await arm([ON, NOREAD, NOELIG, REAUTH]);
  let calls = freshCalls();
  let stats = await runEmailIntelSweep(deps(calls, T0));
  check("four armed accounts were claimed", stats.accounts === 4, JSON.stringify(stats));
  const off = await settingsOf(OFF);
  check("a switched-off account is never touched", off.emailIntelNextAt === null);

  const rows = await threadRows(ON);
  const byId = (id: string) => rows.find((r) => r.threadId === id);
  check("all three threads were judged", rows.length === 3);
  check("the ATS thread is done", byId("t-ats")?.status === "done");
  check("the recruiter thread waits for the extractor", byId("t-human")?.status === "pending_ai");
  check("the newsletter is remembered as skipped", byId("t-news")?.status === "skipped");
  check("the skipped thread kept no subject", byId("t-news")?.subject === "");
  const events = await db.select().from(emailEvents).where(eq(emailEvents.userId, ON));
  check("one rule event: the application stage", events.length === 1 && events[0]!.stage === "applied");

  const on = await settingsOf(ON);
  check("the watermark advanced to the sweep start", on.emailIntelCursorAt?.getTime() === T0.getTime());
  check("the next run is fifteen minutes out", on.emailIntelNextAt?.getTime() === T0.getTime() + INTERVAL_MS);
  // 2026-09-30 minus the 14-day backfill minus the 2-day overlap is 2026-09-14.
  check("a first run looks back the backfill window plus the overlap", BACKFILL_DAYS === 14 && calls.queries[0]?.includes("after:2026/9/14") === true, calls.queries[0]);

  check("no mail access: deferred a day", (await settingsOf(NOREAD)).emailIntelNextAt?.getTime() === T0.getTime() + DEFER_MS);
  check("no mail access: nothing stored", (await threadRows(NOREAD)).length === 0);
  check("plan-ineligible: deferred a day", (await settingsOf(NOELIG)).emailIntelNextAt?.getTime() === T0.getTime() + DEFER_MS);
  check("a dead grant defers that account only", (await settingsOf(REAUTH)).emailIntelNextAt?.getTime() === T0.getTime() + DEFER_MS);
  check("and did not stop the others", (await threadRows(ON)).length === 3);
  check("ineligible accounts never get a token", !calls.tokens.includes(NOELIG) && !calls.tokens.includes(NOREAD));

  console.log("\nSchedule and idempotency");
  calls = freshCalls();
  stats = await runEmailIntelSweep(deps(calls, new Date(T0.getTime() + 5 * MIN)));
  check("nothing is due five minutes later", stats.accounts === 0);

  calls = freshCalls();
  stats = await runEmailIntelSweep(deps(calls, new Date(T0.getTime() + 16 * MIN)));
  check("the armed account is due after fifteen", stats.accounts >= 1);
  check("known threads are not fetched again", calls.fetch.length === 0, JSON.stringify(calls.fetch));
  check("and are counted as unchanged", stats.unchanged >= 3, JSON.stringify(stats));

  console.log("\nA new reply");
  threads["t-human"]!.messages.push(
    msg({ id: "h2", threadId: "t-human", from: "Dana Kim <dana@acme.com>", subject: "Re: role", snippet: "Following up, are you free Thursday to schedule a call?" })
  );
  calls = freshCalls();
  await runEmailIntelSweep(deps(calls, new Date(T0.getTime() + 32 * MIN)));
  check("only the changed thread is fetched", calls.fetch.join() === "1", JSON.stringify(calls.fetch));
  check("its last message id advanced", (await threadRows(ON)).find((r) => r.threadId === "t-human")?.lastMessageId === "h2");

  console.log("\nThe daily cap");
  await arm([CAPPED]);
  const capNow = new Date(T0.getTime() + 60 * MIN);
  await consumeBucket("email-intel-daily", `${CAPPED}:${utcDayKey(capNow)}`, RATE_LIMITS.emailIntelDaily, RATE_LIMITS.emailIntelDaily.limit - 1);
  calls = freshCalls();
  stats = await runEmailIntelSweep(deps(calls, capNow));
  check("the cap stops the account", stats.exhausted === 1, JSON.stringify(stats));
  check("nothing was fetched past it", calls.fetch.length === 0);
  const capped = await settingsOf(CAPPED);
  check("the watermark did not advance", capped.emailIntelCursorAt === null);
  check("it is due again at the next UTC midnight", capped.emailIntelNextAt?.toISOString() === "2026-10-01T00:00:00.000Z", String(capped.emailIntelNextAt));

  console.log("\nThe time budget");
  await arm([LATE]);
  calls = freshCalls();
  stats = await runEmailIntelSweep(deps(calls, T0, { deadline: Date.now() - 1 }));
  const late = await settingsOf(LATE);
  check("an account that never started is handed back", stats.accounts === 1 && calls.tokens.length === 0);
  check("and is due immediately", late.emailIntelNextAt !== null && late.emailIntelNextAt.getTime() <= T0.getTime());

  await db.delete(emailThreads).where(inArray(emailThreads.userId, USERS));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "%smoke-eis-%"));
  console.log("\nAll email-intel sweep checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
