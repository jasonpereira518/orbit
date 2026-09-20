/**
 * Drains the connector outbox. Rides the ten-minute ops schedule like the webhook drain: a
 * write that failed can wait ten minutes, and its own route keeps its latency off the sweep.
 *
 * Delivery is dispatched through the registry, so this route never learns a provider's API.
 */
import { NextResponse } from "next/server";
import { connectorById } from "@/lib/connectors/registry";
import { drainOutbox } from "@/lib/connectors/outbox";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { isInternalRequest } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const handle = await startCronRun("connectors.outbox");
  try {
    // 40s of a 60s budget, leaving room for the ledger write.
    const stats = await drainOutbox({
      budgetMs: 40_000,
      max: 200,
      deliver: async (item) => {
        const manifest = connectorById(item.connectorId);
        if (!manifest) {
          // The connector was removed. Fail it out rather than retrying forever.
          return { ok: false, error: "That connector is no longer available" };
        }
        const { deliverOutboxItem } = await import("@/lib/connectors/deliver");
        return deliverOutboxItem(manifest, item);
      },
    });
    await finishCronRun(handle, {
      status: stats.failed > 0 ? "partial" : "ok",
      stats,
    });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    const ref = reportError(err, { where: "job.connector-outbox" });
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "drain failed", ref }, { status: 500 });
  }
}
