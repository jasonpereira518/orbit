import { NextResponse } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { isInternalRequest } from "@/lib/internal-auth";
import { notifySlack } from "@/lib/ops-notify";
import { reportError } from "@/lib/report-error";
import { formatWeeklyDigest, loadWeeklyDigest } from "@/lib/weekly-digest";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Mondays: the weekly product digest, posted to the ops Slack channel.
 *
 * Same shared-secret gate and scheduler as the other `/api/ops` jobs. `?dry=1` returns the
 * message without posting, for checking the wording by hand. Counts and totals only: no
 * account is named, no email appears. A missing Slack webhook is `partial`, not a failure: an
 * environment with nowhere to post has nothing to deliver.
 */
export async function POST(request: Request) {
  if (!isInternalRequest(request)) return new NextResponse(null, { status: 401 });

  const dry = new URL(request.url).searchParams.get("dry") === "1";
  const run = dry ? null : await startCronRun("product.digest");
  try {
    const text = formatWeeklyDigest(await loadWeeklyDigest(new Date()));
    if (dry) return NextResponse.json({ text }, { headers: { "Cache-Control": "no-store" } });

    if (!process.env.SLACK_OPS_WEBHOOK_URL?.trim()) {
      await finishCronRun(run!, { status: "partial", stats: { delivered: false, chars: text.length } });
      return NextResponse.json({ delivered: false, reason: "SLACK_OPS_WEBHOOK_URL is not set" });
    }
    await notifySlack(text);
    await finishCronRun(run!, { status: "ok", stats: { delivered: true, chars: text.length } });
    return NextResponse.json({ delivered: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const ref = reportError(err, { where: "job.weekly-digest" });
    if (run) await finishCronRun(run, { status: "failed", error: err });
    return NextResponse.json({ error: "digest failed", ref }, { status: 503 });
  }
}
