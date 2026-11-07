/**
 * Real names for contacts saved under a handle (`@/lib/contact-name-sweep`).
 *
 * Two callers, one CRON_SECRET gate:
 *   - `{ userId }`: the kick after an import. Answers at once and runs that user in `after()`,
 *     re-kicking while a backlog remains, like `/api/embeddings/backfill`.
 *   - no body: the hourly pass from `.github/workflows/ops.yml`, every user with candidates
 *     until the deadline. This is also the backfill for contacts that predate the sweep.
 */
import { NextResponse, after } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { isInternalRequest } from "@/lib/internal-auth";
import { kickNameSweep, runNameSweep, usersWithNameCandidates } from "@/lib/contact-name-sweep";
import { reportError } from "@/lib/report-error";

export const maxDuration = 300;

/** Stop starting users here; a user's pass is bounded by its own batch and AI cap. */
const START_DEADLINE_MS = 150_000;
const USERS_PER_RUN = 100;

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { userId?: string } | null;
  const userId = body?.userId;
  if (userId) {
    after(async () => {
      try {
        const stats = await runNameSweep(userId);
        // Only on progress, so a row that can never be settled cannot loop the kick.
        if (stats.more && stats.checked > 0) await kickNameSweep(userId);
      } catch (err) {
        reportError(err, { where: "job.name-sweep", userId, level: "warning" });
      }
    });
    return NextResponse.json({ ok: true });
  }

  const started = Date.now();
  const deadline = started + START_DEADLINE_MS;
  const handle = await startCronRun("contacts.name-sweep");
  try {
    const users = await usersWithNameCandidates(USERS_PER_RUN);
    const totals = { users: 0, checked: 0, renamed: 0, weak: 0, none: 0 };
    let more = users.length === USERS_PER_RUN;
    for (const u of users) {
      if (Date.now() >= deadline) {
        more = true;
        break;
      }
      const stats = await runNameSweep(u, { deadline }).catch((err) => {
        reportError(err, { where: "job.name-sweep", userId: u, level: "warning" });
        return null;
      });
      if (!stats) continue;
      totals.users++;
      totals.checked += stats.checked;
      totals.renamed += stats.renamed;
      totals.weak += stats.weak;
      totals.none += stats.none;
      more ||= stats.more;
    }
    await finishCronRun(handle, { status: more ? "partial" : "ok", stats: totals });
    return NextResponse.json({ ok: true, ...totals, more });
  } catch (err) {
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "name sweep failed" }, { status: 500 });
  }
}
