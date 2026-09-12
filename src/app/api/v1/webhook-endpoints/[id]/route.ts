/**
 * Remove one webhook endpoint — Zapier's `performUnsubscribe`.
 *
 * A hard delete rather than a status change: the queued deliveries cascade with it, which is
 * what someone turning a Zap off means. A disabled-but-retained endpoint would keep its
 * pending queue and start firing again if it were ever re-enabled.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { webhookEndpoints } from "@/db/schema";
import { apiError, apiHandler, apiOk } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = apiHandler(
  { scope: "write", bucket: "apiWrite" },
  async (request, { caller }) => {
    const id = new URL(request.url).pathname.split("/").pop() ?? "";
    const db = await getDb();
    const removed = (
      await db
        .delete(webhookEndpoints)
        // Scoped by userId as well as id, so one user can never delete another's endpoint.
        .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.userId, caller.userId)))
        .returning()
    )[0];

    if (!removed) {
      return apiError({ code: "not_found", message: "No such webhook endpoint." });
    }
    return apiOk({ deleted: true, id: removed.id });
  }
);
