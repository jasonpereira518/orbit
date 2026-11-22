/**
 * A Server Action is a public endpoint, so its arguments are whatever got posted. This calls
 * the first-wave actions with wrong-typed arguments and pins what a person (or `curl`) gets:
 * a returned `{ ok: false }` — never a throw, never a database write, and never a fault
 * report, because a malformed request is not a bug in the server.
 *
 * Each action also gets a well-formed positive control, so a refusal here means the input was
 * judged and not that the action refuses everything.
 *
 * The actions run as `demo-user`, which `requireUserId()` resolves to when there are no Clerk
 * keys (the same trick `smoke-behavior-golden.ts` uses).
 *
 * Run: npx tsx scripts/smoke-action-malformed-input.ts
 */
import "./smoke/_env";

process.env.ORBIT_DEMO_DATA = "off";
(process.env as Record<string, string>).NODE_ENV = "development";

import { createRequire } from "node:module";
import { count, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { captureJobs, contactOpportunities, contacts, imports, meetingSessions } from "../src/db/schema";
import { createOpportunity, updateOpportunity } from "../src/actions/opportunities";
import { analyzeMeetingSession, createMeetingSession } from "../src/actions/meetings";
import { discardCaptureJob, queueCaptureJob, recordCaptureChoices } from "../src/actions/capture-jobs";
import { beginChatImport } from "../src/actions/chat-imports";

// `after()` only works inside a request; outside one it throws, which the actions' catch blocks
// turn into a failure after the write. Run the callback inline so the happy path can finish.
// The real module object (not an ESM namespace): the app reads the property at call time.
(createRequire(__filename)("next/server") as { after: (fn: () => unknown) => void }).after = (fn) => {
  void Promise.resolve(typeof fn === "function" ? fn() : fn).catch(() => {});
};

(createRequire(__filename)("next/cache") as { revalidatePath: () => void }).revalidatePath = () => {};

const USER = "demo-user";
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) return void console.log(`  ok   ${label}`);
  failures++;
  console.log(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
}

// A fault report is a console.error line starting `[orbit:`; collect them per call.
const realError = console.error;
const realWarn = console.warn;
let faults: string[] = [];
console.error = (...args: unknown[]) => {
  faults.push(String(args[0]));
};
console.warn = () => {};

async function tableCounts() {
  const db = await getDb();
  const rows = await Promise.all([
    db.select({ c: count() }).from(contactOpportunities).where(eq(contactOpportunities.userId, USER)),
    db.select({ c: count() }).from(meetingSessions).where(eq(meetingSessions.userId, USER)),
    db.select({ c: count() }).from(captureJobs).where(eq(captureJobs.userId, USER)),
    db.select({ c: count() }).from(imports).where(eq(imports.userId, USER)),
  ]);
  return rows.map((r) => Number(r[0].c)).join("/");
}

type Refused = { ok?: boolean; error?: string } | null | undefined;
const refused = (r: Refused) => Boolean(r && (r.ok === false || (r.ok === undefined && typeof r.error === "string")));

/** One malformed call: returns a refusal, writes nothing, reports nothing. */
async function malformed(label: string, call: () => Promise<unknown>) {
  const before = await tableCounts();
  faults = [];
  let result: Refused;
  let threw: unknown;
  try {
    result = (await call()) as Refused;
  } catch (err) {
    threw = err;
  }
  const after = await tableCounts();
  check(`${label}: does not throw`, threw === undefined, String(threw));
  check(`${label}: returns a refusal`, refused(result), result);
  check(`${label}: writes nothing`, before === after, { before, after });
  check(`${label}: is not reported as a fault`, faults.length === 0, faults);
}

async function main() {
  const db = await getDb();
  const [contact] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Ada Lovelace" })
    .returning();
  const GOOD_UUID = "11111111-1111-4111-8111-111111111111";

  // Opportunities
  const ok = await createOpportunity({ contactId: contact.id, kind: "intro", label: "Intro to Grace" });
  check("createOpportunity: well-formed input saves", ok.ok === true, ok);
  const oppId = ok.ok ? ok.opportunity.id : GOOD_UUID;
  await malformed("createOpportunity(null)", () => createOpportunity(null as never));
  await malformed("createOpportunity(contactId: number)", () =>
    createOpportunity({ contactId: 7, kind: "intro", label: "x" } as never));
  await malformed("createOpportunity(label: array)", () =>
    createOpportunity({ contactId: contact.id, kind: "intro", label: ["x"] } as never));
  await malformed("createOpportunity(kind: object)", () =>
    createOpportunity({ contactId: contact.id, kind: {}, label: "x" } as never));
  await malformed("updateOpportunity(patch: null)", () => updateOpportunity(oppId, null as never));
  await malformed("updateOpportunity(patch.label: number)", () => updateOpportunity(oppId, { label: 5 } as never));
  await malformed("updateOpportunity(id: object)", () => updateOpportunity({} as never, { label: "x" }));

  // Meetings
  const meeting = await createMeetingSession({ includesMic: true, recorderId: "rec-1" });
  check("createMeetingSession: well-formed input starts", meeting.ok === true, meeting);
  await malformed("createMeetingSession(null)", () => createMeetingSession(null as never));
  await malformed("createMeetingSession(recorderId: number)", () =>
    createMeetingSession({ includesMic: true, recorderId: 5 } as never));
  await malformed("createMeetingSession(includesMic: string)", () =>
    createMeetingSession({ includesMic: "yes", recorderId: "r" } as never));
  await malformed("createMeetingSession(attendees: string)", () =>
    createMeetingSession({ includesMic: true, recorderId: "r", attendees: "everyone" } as never));
  await malformed("analyzeMeetingSession(opts: null)", () => analyzeMeetingSession(GOOD_UUID, null as never));
  await malformed("analyzeMeetingSession(opts.notes: number)", () =>
    analyzeMeetingSession(GOOD_UUID, { notes: 5 } as never));
  await malformed("analyzeMeetingSession(id: object)", () => analyzeMeetingSession({} as never));

  // Capture jobs
  await malformed("queueCaptureJob(null)", () => queueCaptureJob(null as never));
  await malformed("queueCaptureJob(text: number)", () =>
    queueCaptureJob({ text: 5, sourceKind: "messy" } as never));
  await malformed("queueCaptureJob(sourceKind: unknown)", () =>
    queueCaptureJob({ text: "met Ada", sourceKind: "carrier-pigeon" } as never));
  await malformed("queueCaptureJob(hints: string)", () =>
    queueCaptureJob({ text: "met Ada", sourceKind: "messy", hints: "none" } as never));
  await malformed("recordCaptureChoices(choices: null)", () => recordCaptureChoices(GOOD_UUID, null as never));
  await malformed("recordCaptureChoices(choices.reminders: string)", () =>
    recordCaptureChoices(GOOD_UUID, { reminders: "all" } as never));
  await malformed("discardCaptureJob(jobId: object)", () => discardCaptureJob({} as never));
  await malformed("discardCaptureJob(opts: string)", () => discardCaptureJob(GOOD_UUID, "stop" as never));

  // Chat imports
  await malformed("beginChatImport(null)", () => beginChatImport(null as never));
  await malformed("beginChatImport(source: unknown)", () =>
    beginChatImport({ source: "slack", fileName: "x.txt", selfNames: [] } as never));
  await malformed("beginChatImport(selfNames: string)", () =>
    beginChatImport({ source: "whatsapp", fileName: "x.txt", selfNames: "me" } as never));
  await malformed("beginChatImport(fileName: number)", () =>
    beginChatImport({ source: "whatsapp", fileName: 5, selfNames: [] } as never));

  console.error = realError;
  console.warn = realWarn;
  if (failures) {
    console.log(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("All malformed-input checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error = realError;
  console.error(err);
  process.exit(1);
});
