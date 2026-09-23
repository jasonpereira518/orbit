import { NextResponse } from "next/server";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { speechUsage } from "@/db/schema";
import { fetchDeepgramUsage } from "@/lib/deepgram";
import { isInternalRequest } from "@/lib/internal-auth";
import { notifySlack } from "@/lib/ops-notify";
import { userIdForSpeechTagId } from "@/lib/speech-tag-id";
import { parseMeetingTag, parseShortformTag } from "@/lib/speech-usage-tag";
import { reportError } from "@/lib/report-error";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Deepgram reporting more than this fraction of what we recorded is worth a look. */
const OVERREPORT_THRESHOLD = 1.1;
/**
 * …and, for short-form, more than this many seconds of it. A meeting is metered once, as one
 * row, so a percentage alone is a fair test there. Dictation is dozens of tiny sessions a day,
 * each rounded to a whole second at both ends, so a percentage alone would fire on rounding.
 * Two minutes a day is the smallest gap worth a human's attention.
 */
const MIN_SHORTFORM_GAP_SECONDS = 120;

/**
 * Nightly reconciliation between what Deepgram billed and what the browser told us it used.
 *
 * Meetings stream straight from the browser to Deepgram on Orbit's key, and the browser
 * self-reports its seconds into `speech_usage` — so a tampered client could under-report and
 * ride the key for free. This job is the check: it reads yesterday's Deepgram usage (tagged
 * `meeting:<sessionId>` — see `listenParams` in `src/lib/deepgram-params.ts`), compares each
 * meeting's Deepgram total against its `speech_usage` row, and alerts on anything Deepgram
 * says cost more than 110% of what we recorded. It never suspends anyone: a single divergent
 * meeting could be a legitimate reconnect or retry, not proof of abuse, so this only raises
 * the alert a human looks at.
 *
 * Dictation (the chat mic) is reconciled the same way but in AGGREGATE PER USER, not per
 * session. Its seconds reach `speech_usage` only through a best-effort `navigator.sendBeacon`
 * from a closing tab — a crashed tab or a blocked beacon bills Orbit and moves the meter by
 * zero, repeatably — so its connections are tagged `shortform:<speechTagId>` and this job
 * compares Deepgram's per-account total for the window against the short-form seconds
 * recorded in it. Per account rather than per session because a dictation session has no id
 * to key on: the connection is opened by the browser and lives and dies inside one tab.
 *
 * That id is opaque and per-account (`src/lib/speech-tag-id.ts`), not the Clerk user id — a
 * tag persists in Deepgram's usage records, which zero retention does not cover — so this job
 * resolves it back to an account with one indexed lookup before reading any meter.
 *
 * Returns `{checked, overreported, shortformChecked, shortformOverreported, pagesRead,
 * requestsSeen, invalidTags}`. The last three exist so a run that silently checked nothing is
 * distinguishable from an actually quiet night — see the comment above the `requestsSeen === 0`
 * check below.
 *
 * Called daily by the GitHub Actions scheduler (`.github/workflows/ops.yml`), same
 * shared-secret gate and shape as `/api/ops/sweep`.
 */
export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return new NextResponse(null, { status: 401 });
  }

  try {
    const until = new Date();
    const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);

    let usage: Awaited<ReturnType<typeof fetchDeepgramUsage>>;
    try {
      usage = await fetchDeepgramUsage({ since, until });
    } catch (err) {
      // Deepgram's usage API being unreachable or unconfigured (no key, no project id) is
      // "we couldn't check today", not "the job is broken" — log it and return quietly
      // rather than throwing the way the outer catch below would treat as a 503.
      const ref = reportError(err, { where: "job.speech-usage.fetch" });
      return NextResponse.json(
        { checked: 0, overreported: 0, shortformChecked: 0, shortformOverreported: 0, pagesRead: 0, requestsSeen: 0, invalidTags: 0, ref },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Deepgram's docs never say whether `page` is 0- or 1-based. A wrong starting index could
    // mean every page comes back empty with no error at all — indistinguishable from a quiet
    // night if all we looked at were `usage.totals`. Surface the raw counts so that ambiguity
    // is visible instead of silent: a night with real meetings and `requestsSeen: 0` means
    // "the paging is wrong", not "nobody had a meeting" — check the page-index assumption in
    // `fetchDeepgramUsage` against a real Deepgram account before trusting a clean run again.
    if (usage.requestsSeen === 0) {
      reportError(new Error("Deepgram usage: first page returned zero requests"), {
        where: "job.speech-usage.empty",
        level: "warning",
        extra: { pagesRead: usage.pagesRead, since: since.toISOString(), until: until.toISOString() },
      });
    }

    const db = await getDb();
    let checked = 0;
    let overreported = 0;
    let invalidTags = 0;
    let shortformChecked = 0;
    let shortformOverreported = 0;

    for (const { tag, seconds: deepgramSeconds } of usage.totals) {
      const shortform = parseShortformTag(tag);
      if (shortform.kind === "malformed") {
        invalidTags += 1;
        reportError(new Error("Deepgram usage: malformed shortform tag"), {
          where: "job.speech-usage.malformed-tag",
          level: "warning",
          extra: { tag },
        });
        continue;
      }
      if (shortform.kind === "ok") {
        // The tag carries the account's opaque id, so the account is one indexed lookup away
        // (`user_settings_speech_tag_uidx`). Nobody claiming it is an ordinary outcome, not a
        // malformed tag: an account that deleted its data dropped the column and minted a new
        // value, so yesterday's tags no longer point anywhere. Counted with the invalid ones
        // — both mean "this spend could not be attributed" — but reported under its own
        // `where` so the two are separable in Sentry.
        const userId = await userIdForSpeechTagId(shortform.speechTagId);
        if (!userId) {
          invalidTags += 1;
          reportError(new Error("Deepgram usage: unknown shortform tag id"), {
            where: "job.speech-usage.unknown-tag",
            level: "warning",
            extra: { tag },
          });
          continue;
        }
        shortformChecked += 1;
        // Summed over the window, not read from one row: short-form usage is one row per
        // voice note and one per dictation session, unlike a meeting's single growing row.
        const [row] = await db
          .select({ seconds: sql<number>`coalesce(sum(${speechUsage.seconds}), 0)` })
          .from(speechUsage)
          .where(
            and(
              eq(speechUsage.userId, userId),
              eq(speechUsage.kind, "shortform"),
              gte(speechUsage.createdAt, since),
              lt(speechUsage.createdAt, until),
            ),
          );
        const recordedSeconds = Number(row?.seconds ?? 0);
        const gap = deepgramSeconds - recordedSeconds;
        if (gap <= MIN_SHORTFORM_GAP_SECONDS) continue;
        if (deepgramSeconds <= recordedSeconds * OVERREPORT_THRESHOLD) continue;

        shortformOverreported += 1;
        const text =
          `:warning: *Deepgram dictation usage exceeds what was recorded* for user \`${userId}\`\n` +
          `Deepgram reports ${deepgramSeconds}s in the last 24h; Orbit recorded ${recordedSeconds}s ` +
          `(a ${gap}s gap). Usually a beacon that never arrived — a crashed tab, an ad blocker — ` +
          `rather than abuse; go look before acting.`;
        await notifySlack(text).catch((err) => {
          reportError(err, { where: "job.speech-usage.alert", extra: { userId } });
        });
        continue;
      }

      const parsed = parseMeetingTag(tag);
      if (parsed.kind === "not-a-meeting-tag") continue;
      if (parsed.kind === "malformed") {
        // A tag Deepgram echoed back does not parse as `meeting:<uuid>` — untrusted, echoed
        // input, so skip this one tag rather than let a bad id reach a uuid-typed WHERE clause
        // and abort the whole run with a Postgres cast error.
        invalidTags += 1;
        reportError(new Error("Deepgram usage: malformed meeting tag"), {
          where: "job.speech-usage.malformed-tag",
          level: "warning",
          extra: { tag },
        });
        continue;
      }
      const sessionId = parsed.sessionId;
      checked += 1;

      const [row] = await db
        .select({ userId: speechUsage.userId, seconds: speechUsage.seconds })
        .from(speechUsage)
        .where(eq(speechUsage.sessionId, sessionId))
        .limit(1);

      const recordedSeconds = row?.seconds ?? 0;
      if (deepgramSeconds <= recordedSeconds * OVERREPORT_THRESHOLD) continue;

      overreported += 1;
      const who = row ? `user \`${row.userId}\`` : "no speech_usage row (unknown user)";
      const text =
        `:warning: *Deepgram usage exceeds what was recorded* for meeting \`${sessionId}\` (${who})\n` +
        `Deepgram reports ${deepgramSeconds}s; Orbit recorded ${recordedSeconds}s ` +
        `(${recordedSeconds > 0 ? Math.round((deepgramSeconds / recordedSeconds) * 100) : "∞"}% of recorded).`;
      await notifySlack(text).catch((err) => {
        reportError(err, { where: "job.speech-usage.alert", extra: { sessionId } });
      });
    }

    return NextResponse.json(
      {
        checked,
        overreported,
        shortformChecked,
        shortformOverreported,
        pagesRead: usage.pagesRead,
        requestsSeen: usage.requestsSeen,
        invalidTags,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // Same posture as /api/ops/sweep: the database being unreachable or the job itself
    // breaking must not look like a quiet, clean run.
    const ref = reportError(err, { where: "job.speech-usage" });
    return NextResponse.json({ status: "failed", ref }, { status: 503 });
  }
}
