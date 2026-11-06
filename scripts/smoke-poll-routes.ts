/**
 * The capture-job and import-progress polls, as route handlers (LATENCY_PLAN SRV-5).
 *
 * Both used to be Server Actions. A tab runs its actions one at a time, so a poll every 1.5 s
 * put itself in front of every click made during an extraction or an import. The routes call
 * the same functions; this checks they are the same operation behind a different door:
 *   - same answer as calling the action directly;
 *   - the caller's own rows only (another user's job is "not found", never its contents);
 *   - a cross-site Origin is refused, as Server Actions refuse it.
 *
 * Runs against a throwaway PGlite. Run: npx tsx scripts/smoke-poll-routes.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { POST as capturePoll } from "../src/app/api/capture/jobs/[id]/status/route";
import { POST as importPoll } from "../src/app/api/imports/[id]/status/route";
import { getCaptureJob } from "../src/actions/capture-jobs";
import { getImportJobStatus } from "../src/actions/imports";
import { getDb } from "../src/db";
import { captureJobs, imports } from "../src/db/schema";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const req = (path: string, origin: string, body?: unknown) =>
  new Request(`https://orbit.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "orbit.test", origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

run(async () => {
  const env = process.env as Record<string, string | undefined>;
  env.NODE_ENV = "development"; // demo mode: requireUserId() is demo-user
  env.ORBIT_DEMO_DATA = "off";
  const db = await getDb();

  const [mineJob] = await db.insert(captureJobs).values({ userId: "demo-user", sourceKind: "text", status: "ready" } as never).returning();
  const [theirJob] = await db.insert(captureJobs).values({ userId: "poll-routes-other", sourceKind: "text", status: "ready" } as never).returning();
  const [mineImport] = await db.insert(imports).values({ userId: "demo-user", importType: "linkedin", status: "processing", totalRows: 40, rowsProcessed: 12 } as never).returning();
  const [theirImport] = await db.insert(imports).values({ userId: "poll-routes-other", importType: "linkedin", status: "processing" } as never).returning();

  try {
    console.log("Capture job poll...");
    {
      const foreign = await capturePoll(req(`/api/capture/jobs/${mineJob!.id}/status`, "https://evil.example", {}), params(mineJob!.id));
      check("a cross-site Origin is refused", foreign.status === 403, String(foreign.status));

      const viaRoute = await (await capturePoll(req(`/api/capture/jobs/${mineJob!.id}/status`, "https://orbit.test", { since: null }), params(mineJob!.id))).json();
      const direct = await getCaptureJob(mineJob!.id, null);
      check("the route answers exactly what the action answers", JSON.stringify(viaRoute) === JSON.stringify(direct));
      check("and it is the job", viaRoute.ok === true && viaRoute.job?.id === mineJob!.id);

      const unchanged = await (await capturePoll(req(`/api/capture/jobs/${mineJob!.id}/status`, "https://orbit.test", { since: viaRoute.job.updatedAt }), params(mineJob!.id))).json();
      check("the unchanged shortcut still works", unchanged.ok === true && unchanged.unchanged === true, JSON.stringify(unchanged));

      const other = await (await capturePoll(req(`/api/capture/jobs/${theirJob!.id}/status`, "https://orbit.test", {}), params(theirJob!.id))).json();
      check("another user's job is not served", other.ok === false && !("job" in other), JSON.stringify(other));
    }

    console.log("\nImport progress poll...");
    {
      const foreign = await importPoll(req(`/api/imports/${mineImport!.id}/status`, "https://evil.example"), params(mineImport!.id));
      check("a cross-site Origin is refused", foreign.status === 403, String(foreign.status));

      const res = await importPoll(req(`/api/imports/${mineImport!.id}/status`, "https://orbit.test"), params(mineImport!.id));
      const viaRoute = await res.json();
      const direct = await getImportJobStatus(mineImport!.id);
      check("the route answers exactly what the action answers", res.status === 200 && JSON.stringify(viaRoute) === JSON.stringify(direct));
      check("and it is the import's progress", viaRoute.rowsProcessed === 12 && viaRoute.totalRows === 40);

      const other = await importPoll(req(`/api/imports/${theirImport!.id}/status`, "https://orbit.test"), params(theirImport!.id));
      const otherBody = await other.json();
      check("another user's import is an error, not its progress", other.status === 500 && !("rowsProcessed" in otherBody), JSON.stringify(otherBody));
    }
  } finally {
    await db.delete(captureJobs).where(eq(captureJobs.id, mineJob!.id));
    await db.delete(captureJobs).where(eq(captureJobs.id, theirJob!.id));
    await db.delete(imports).where(eq(imports.id, mineImport!.id));
    await db.delete(imports).where(eq(imports.id, theirImport!.id));
  }

  console.log(failures === 0 ? "\nAll poll route checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures) process.exit(1);
});
