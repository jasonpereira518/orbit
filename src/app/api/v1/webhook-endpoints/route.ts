/**
 * Register and list webhook endpoints.
 *
 * This is the "trigger" half of a Zapier, Make or n8n integration: their `performSubscribe`
 * posts here when someone turns a Zap on, and `performUnsubscribe` deletes it when they turn
 * it off. Without these two routes the whole outbound webhook system is plumbing with no tap.
 *
 * A new endpoint is verified before it goes live — see `verifyEndpoint`. The alternative,
 * trusting the URL, means a typo sits collecting nothing and looks identical to "nothing has
 * happened yet".
 */
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { webhookEndpoints } from "@/db/schema";
import { apiError, apiHandler, apiOk, readJson } from "@/lib/api/http";
import { webhookEndpointBody } from "@/lib/api/schemas";
import { encrypt } from "@/lib/crypto";
import { generateWebhookSecret } from "@/lib/webhooks/sign";
import { assertDeliverable, verifyEndpoint } from "@/lib/webhooks/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiHandler({ scope: "read", bucket: "apiRead" }, async (_request, { caller }) => {
  const db = await getDb();
  const rows = await db.query.webhookEndpoints.findMany({
    where: eq(webhookEndpoints.userId, caller.userId),
    orderBy: [desc(webhookEndpoints.createdAt)],
    columns: {
      id: true,
      url: true,
      eventTypes: true,
      status: true,
      description: true,
      consecutiveFailures: true,
      disabledReason: true,
      createdAt: true,
    },
  });
  // `secretEncrypted` is deliberately absent: it is shown once at creation and never again.
  return apiOk({ endpoints: rows });
});

export const POST = apiHandler({ scope: "write", bucket: "apiWrite" }, async (request, { caller }) => {
  const body = await readJson(request, webhookEndpointBody);

  // Checked here as well as at delivery time. This one is for the user's benefit — a clear
  // "that address is not allowed" now, rather than an endpoint that registers cleanly and then
  // silently fails every delivery.
  try {
    await assertDeliverable(body.url);
  } catch (err) {
    return apiError({
      code: "invalid_request",
      message: err instanceof Error ? err.message : "That URL cannot be used.",
      param: "url",
    });
  }

  const db = await getDb();
  const secret = generateWebhookSecret();
  const [created] = await db
    .insert(webhookEndpoints)
    .values({
      userId: caller.userId,
      url: body.url,
      secretEncrypted: encrypt(secret),
      eventTypes: body.eventTypes,
      description: body.description,
      status: "pending",
    })
    .returning();

  // Inline rather than deferred: the caller needs to know whether their endpoint works, and
  // a Zapier subscribe that returns "pending, check back later" has nowhere to check back to.
  const verified = await verifyEndpoint(created.id);

  return apiOk(
    {
      id: created.id,
      url: created.url,
      eventTypes: created.eventTypes,
      status: verified.ok ? "active" : "pending",
      verified: verified.ok,
      verificationError: verified.ok ? null : (verified.error ?? null),
      // Shown once. Receivers need it to validate the Orbit-Signature header.
      secret,
    },
    { status: 201 }
  );
});
