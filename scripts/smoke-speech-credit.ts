/**
 * The Deepgram credit: pricing seconds into dollars, the degradation ladder, and the gate every
 * Deepgram call site asks, against a throwaway PGlite database.
 * Run: npx tsx scripts/smoke-speech-credit.ts
 */
import "./smoke/_env";
import { run, setDeepgramEnabledForSmoke } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { speechUsage, userSettings } from "../src/db/schema";
import {
  DEEPGRAM_CREDIT,
  SPEECH_CREDIT_LADDER,
  creditAllows,
  creditRunwayDays,
  deepgramMicrosPerSecond,
  speechCostMicros,
} from "../src/lib/speech-cost";
import { deepgramOpenFor, forgetSpeechCredit, speechCreditState, speechSpendMicros } from "../src/lib/speech-credit";

const USER = "smoke-speech-credit";
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

function pricing() {
  console.log("\npricing");
  // Streaming 0.0077 x2 + keyterm 0.0013 + diarize 0.002 = $0.0187/min.
  check("a live meeting minute is $0.0187", near(deepgramMicrosPerSecond("meeting", "stream") * 60, 18_700));
  // Dictation streams without diarization: 0.0077 x2 + 0.0013 = $0.0167/min.
  check("a dictation minute is $0.0167", near(deepgramMicrosPerSecond("shortform", "stream") * 60, 16_700));
  // A file (voice note, meeting chunk recovery) never diarizes: 0.0043 x2 + 0.0013 = $0.0099/min.
  check("a voice-note minute is $0.0099", near(deepgramMicrosPerSecond("shortform", "file") * 60, 9_900));
  check("…and so is a recovered meeting chunk", near(deepgramMicrosPerSecond("meeting", "file") * 60, 9_900));
  check(
    "an hour of each adds up",
    near(speechCostMicros([
      { kind: "meeting", source: "stream", seconds: 3600 },
      { kind: "shortform", source: "file", seconds: 3600 },
    ]), (18_700 + 9_900) * 60, 2),
  );
  check("negative seconds cost nothing", speechCostMicros([{ kind: "meeting", source: "stream", seconds: -60 }]) === 0);
}

function ladder() {
  console.log("\nthe ladder degrades in order");
  const at = (share: number, plan: "free" | "orbit", kind: "meeting" | "shortform", meetingInProgress = false) =>
    creditAllows({ share, plan, kind, meetingInProgress });
  check("below every rung, Free voice notes run", at(0.5, "free", "shortform"));
  check("at 90%, Free voice notes stop", !at(SPEECH_CREDIT_LADDER.freeOffShare, "free", "shortform"));
  check("…while Pro voice notes still run", at(SPEECH_CREDIT_LADDER.freeOffShare, "orbit", "shortform"));
  check("at 97%, Pro voice notes stop too", !at(SPEECH_CREDIT_LADDER.shortformOffShare, "orbit", "shortform"));
  check("…while new meetings still start", at(SPEECH_CREDIT_LADDER.shortformOffShare, "orbit", "meeting"));
  check("at 100%, no new meeting starts", !at(SPEECH_CREDIT_LADDER.newMeetingsOffShare, "orbit", "meeting"));
  check("…but a meeting already recording finishes", at(1.5, "orbit", "meeting", true));
  check("the cap keeps 5% headroom below the credit", DEEPGRAM_CREDIT.capMicros === DEEPGRAM_CREDIT.creditMicros * 0.95);
  check("runway at $100/day with $1,000 left is 10 days", near(creditRunwayDays(DEEPGRAM_CREDIT.capMicros - 1_000_000_000, 100_000_000) ?? -1, 10, 0.001));
  check("no spend means no runway figure", creditRunwayDays(0, 0) === null);
}

async function gate() {
  console.log("\nthe gate");
  const db = await getDb();
  // The whole table: the credit gauge sums every account, this is the throwaway PGlite
  // (`smoke/_env`), and other scripts' speech rows would otherwise move the rungs under us.
  await db.delete(speechUsage);
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER });

  setDeepgramEnabledForSmoke(true);
  const before = await speechSpendMicros(new Date(DEEPGRAM_CREDIT.since));
  forgetSpeechCredit();
  check("with room left, a Free account may use Deepgram", await deepgramOpenFor(USER, "shortform"));

  // Spend to just past the Free rung, as one enormous file row.
  const microsPerSecond = deepgramMicrosPerSecond("shortform", "file");
  const toFreeRung = DEEPGRAM_CREDIT.capMicros * SPEECH_CREDIT_LADDER.freeOffShare - before;
  const seconds = Math.ceil(toFreeRung / microsPerSecond) + 60;
  await db.insert(speechUsage).values({ userId: USER, kind: "shortform", seconds, source: "file" });
  forgetSpeechCredit();
  const state = await speechCreditState();
  check("the gauge reads the new spend", state.share >= SPEECH_CREDIT_LADDER.freeOffShare, `share=${state.share}`);
  check("past 90%, the Free account falls back", !(await deepgramOpenFor(USER, "shortform")));
  check("…but may still start a meeting where its plan has them", await deepgramOpenFor(USER, "meeting"));

  // Past 100%: a meeting with audio already on Deepgram keeps going, a fresh one does not.
  await db.insert(speechUsage).values({ userId: USER, kind: "shortform", seconds: Math.ceil(DEEPGRAM_CREDIT.capMicros / microsPerSecond), source: "file" });
  const sessionId = "22222222-2222-4222-8222-222222222222";
  await db.insert(speechUsage).values({ userId: USER, kind: "meeting", seconds: 120, source: "stream", sessionId });
  forgetSpeechCredit();
  check("past 100%, a new meeting falls back", !(await deepgramOpenFor(USER, "meeting")));
  check("…a meeting with no audio yet falls back", !(await deepgramOpenFor(USER, "meeting", { sessionId: "33333333-3333-4333-8333-333333333333" })));
  check("…a meeting already recording keeps Deepgram", await deepgramOpenFor(USER, "meeting", { sessionId }));

  const prior = process.env.ORBIT_DEEPGRAM;
  process.env.ORBIT_DEEPGRAM = "off";
  check("the kill switch still wins over everything", !(await deepgramOpenFor(USER, "meeting", { sessionId })));
  if (prior === undefined) delete process.env.ORBIT_DEEPGRAM;
  else process.env.ORBIT_DEEPGRAM = prior;

  await db.delete(speechUsage).where(eq(speechUsage.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  forgetSpeechCredit();
}

run(async () => {
  pricing();
  ladder();
  try {
    await gate();
  } finally {
    // Always: a run that failed partway must not leave a spent credit for the next script.
    const db = await getDb();
    await db.delete(speechUsage).where(eq(speechUsage.userId, USER));
    forgetSpeechCredit();
  }
  if (failures) throw new Error(`smoke-speech-credit: ${failures} failure(s)`);
  console.log("\nsmoke-speech-credit: all checks passed");
});
