/**
 * The email-insights sweep's entry point: reads new career-relevant Gmail threads for each
 * opted-in account, then extracts events from the hiring ones with the account's own AI key.
 * Every fifteen minutes from `.github/workflows/ops.yml` at :05/:20/:35/:50.
 *
 * Its own route, schedule and `cron_runs` job name, like the work-history sweep: it makes
 * network and model calls per account, and the ten-minute ops sweep is the alerting path and
 * must never wait on it. `POST` because it mutates.
 *
 * One budget, two phases: ingest stops starting accounts at 100 s so extraction has the rest
 * (a model call can take a while), and extraction stops starting work at 240 s so leases are
 * settled before the 300 s ceiling.
 */
import { NextResponse } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { runEmailIntelExtraction, type EmailIntelExtractStats } from "@/lib/email-intel/extractor";
import { runEmailEventIndexing, type EmailEventIndexingStats } from "@/lib/email-intel/search-index";
import { runEmailIntelSweep } from "@/lib/email-intel/sweep";
import { isInternalRequest } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";

export const maxDuration = 300;

const INGEST_DEADLINE_MS = 100_000;
const START_DEADLINE_MS = 240_000;
const INDEX_DEADLINE_MS = 280_000;

/** Flat numbers for the `cron_runs` stats column. */
function flatten(prefix: string, stats: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(stats)) {
    if (typeof value === "number") out[`${prefix}${key}`] = value;
    else if (value && typeof value === "object") Object.assign(out, flatten(`${prefix}${key}_`, value as Record<string, unknown>));
  }
  return out;
}

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const handle = await startCronRun("email-intel.sweep");
  try {
    const ingest = await runEmailIntelSweep({ deadline: started + INGEST_DEADLINE_MS });

    // Extraction failing must not lose the ingest numbers or mask them as a failed run.
    let extraction: EmailIntelExtractStats | null = null;
    try {
      extraction = await runEmailIntelExtraction({ deadline: started + START_DEADLINE_MS });
    } catch (err) {
      reportError(err, { where: "email-intel.extract.run" });
    }

    // Make what was just stored searchable from chat now, not at tomorrow's backstop. No model
    // call, and a failure here is a warning, never a failed sweep.
    let indexing: EmailEventIndexingStats | null = null;
    try {
      indexing = await runEmailEventIndexing({ deadline: started + INDEX_DEADLINE_MS });
    } catch (err) {
      reportError(err, { where: "email-intel.index.run", level: "warning" });
    }

    const partial =
      ingest.partial > 0 ||
      ingest.exhausted > 0 ||
      ingest.errors > 0 ||
      extraction === null ||
      extraction.failed > 0 ||
      extraction.errors > 0 ||
      extraction.released > 0 ||
      extraction.budgetStops > 0 ||
      extraction.keyProblems > 0;
    await finishCronRun(handle, {
      // Out of time, out of daily budget, or a person's key being refused is the ordinary
      // partial shape, not a failure.
      status: partial ? "partial" : "ok",
      stats: {
        ...flatten("ingest_", ingest),
        ...(extraction ? flatten("extract_", extraction) : {}),
        ...(indexing ? flatten("index_", indexing) : {}),
      },
    });
    return NextResponse.json({ ok: true, ingest, extraction, indexing });
  } catch (err) {
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "email intel sweep failed" }, { status: 500 });
  }
}
