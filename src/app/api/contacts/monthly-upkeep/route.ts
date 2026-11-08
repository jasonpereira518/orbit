/**
 * Monthly maintenance sweep for contacts across all accounts:
 * - Audits contact avatars, replacing generic aero, broken, or stale (>30 days) images
 *   with authentic LinkedIn profile photos saved to the shared database.
 * - Resolves verified real names for contacts saved under handles or email usernames.
 *
 * Two callers, one CRON_SECRET gate:
 *   - `{ userId }`: on-demand kick for a specific user. Answers at once and runs in `after()`,
 *     re-kicking while a candidate backlog remains.
 *   - no body: the monthly system pass from `.github/workflows/ops.yml`, processing every user
 *     with candidates until the deadline.
 */
import { NextResponse, after } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { isInternalRequest } from "@/lib/internal-auth";
import {
  kickMonthlyUpkeep,
  runMonthlyContactUpkeep,
  usersWithMonthlyUpkeepCandidates,
} from "@/lib/contact-monthly-upkeep";
import { reportError } from "@/lib/report-error";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Stop starting users when approaching ceiling; each user pass is bounded by batch size. */
const START_DEADLINE_MS = 200_000;
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
        const stats = await runMonthlyContactUpkeep(userId);
        if (stats.more && stats.checked > 0) {
          await kickMonthlyUpkeep(userId);
        }
      } catch (err) {
        reportError(err, { where: "job.monthly-upkeep", userId, level: "warning" });
      }
    });
    return NextResponse.json({ ok: true });
  }

  const started = Date.now();
  const deadline = started + START_DEADLINE_MS;
  const handle = await startCronRun("contacts.monthly-upkeep");

  try {
    const users = await usersWithMonthlyUpkeepCandidates(USERS_PER_RUN);
    const totals = { users: 0, checked: 0, avatarsUpdated: 0, namesFixed: 0 };
    let more = users.length === USERS_PER_RUN;

    for (const u of users) {
      if (Date.now() >= deadline) {
        more = true;
        break;
      }

      const stats = await runMonthlyContactUpkeep(u, { deadline }).catch((err) => {
        reportError(err, { where: "job.monthly-upkeep", userId: u, level: "warning" });
        return null;
      });

      if (!stats) continue;
      totals.users++;
      totals.checked += stats.checked;
      totals.avatarsUpdated += stats.avatarsUpdated;
      totals.namesFixed += stats.namesFixed;
      more ||= stats.more;
    }

    await finishCronRun(handle, { status: more ? "partial" : "ok", stats: totals });
    return NextResponse.json({ ok: true, ...totals, more });
  } catch (err) {
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "monthly upkeep failed" }, { status: 500 });
  }
}
