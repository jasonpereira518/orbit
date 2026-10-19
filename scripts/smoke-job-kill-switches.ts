/**
 * The scheduled-work kill switches: hiding a switch surface in /admin/product makes its cron
 * route stand down (records a `standDown` run, does nothing) with no deploy; showing it again
 * resumes. Everything else about the route is unchanged, including its auth.
 *
 * Run: npx tsx scripts/smoke-job-kill-switches.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { cronRuns } from "../src/db/schema";
import {
  BACKGROUND_SYNC_SURFACE_KEY, EMAIL_DRAIN_SURFACE_KEY, SURFACES, WEBHOOK_DRAIN_SURFACE_KEY,
  WORK_HISTORY_SWEEP_SURFACE_KEY,
} from "../src/lib/surfaces";
import { invalidateHiddenSurfaceKeys, setSurfaceHidden } from "../src/lib/surface-visibility";
import { POST as syncRun } from "../src/app/api/sync/run/route";
import { POST as emailDrain } from "../src/app/api/email/drain/route";
import { POST as webhookDrain } from "../src/app/api/webhooks/outbound/drain/route";
import { POST as workHistory } from "../src/app/api/work-history/sweep/route";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const ADMIN = "smoke-kill-switch-admin";
const SECRET = "smoke-cron-secret-0123456789abcdef";

const SWITCHES = [
  { key: BACKGROUND_SYNC_SURFACE_KEY, job: "sync.run", post: syncRun, path: "/api/sync/run" },
  { key: EMAIL_DRAIN_SURFACE_KEY, job: "email.drain", post: emailDrain, path: "/api/email/drain" },
  { key: WEBHOOK_DRAIN_SURFACE_KEY, job: "webhooks.drain", post: webhookDrain, path: "/api/webhooks/outbound/drain" },
  { key: WORK_HISTORY_SWEEP_SURFACE_KEY, job: "work-history.sweep", post: workHistory, path: "/api/work-history/sweep" },
] as const;

const call = (s: (typeof SWITCHES)[number], auth = true) =>
  s.post(new Request(`http://localhost${s.path}`, { method: "POST", headers: auth ? { authorization: `Bearer ${SECRET}` } : {} }));

run(async () => {
  const prior = { admins: process.env.ADMIN_USER_IDS, secret: process.env.CRON_SECRET };
  process.env.ADMIN_USER_IDS = ADMIN;
  process.env.CRON_SECRET = SECRET;
  const db = await getDb();
  try {
    for (const s of SWITCHES) {
      console.log(`\n${s.key} -> ${s.path}`);
      check("it is registered as a feature surface (so /admin/product lists it)",
        SURFACES.some((x) => x.key === s.key && x.kind === "feature"));
      check("an unauthenticated call is still refused", (await call(s, false)).status === 401);

      await setSurfaceHidden(ADMIN, s.key, true);
      invalidateHiddenSurfaceKeys();
      const res = await call(s);
      const body = await res.json();
      check("hidden: the route stands down", res.status === 200 && body.standDown === true, JSON.stringify(body));
      const [last] = await db.select().from(cronRuns).where(eq(cronRuns.job, s.job)).orderBy(desc(cronRuns.startedAt)).limit(1);
      check("…and the ledger says so, as an ok run", last?.status === "ok" && (last.stats as { standDown?: boolean })?.standDown === true, JSON.stringify(last?.stats));

      await setSurfaceHidden(ADMIN, s.key, false);
      invalidateHiddenSurfaceKeys();
      const back = await call(s);
      const backBody = await back.json().catch(() => ({}));
      check("shown again: the route does its work", back.status !== 401 && backBody.standDown !== true, `${back.status} ${JSON.stringify(backBody).slice(0, 80)}`);
    }
  } finally {
    for (const s of SWITCHES) await setSurfaceHidden(ADMIN, s.key, false).catch(() => {});
    if (prior.admins === undefined) delete process.env.ADMIN_USER_IDS; else process.env.ADMIN_USER_IDS = prior.admins;
    if (prior.secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prior.secret;
  }
  console.log(failures === 0 ? "\nAll kill-switch checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
});
