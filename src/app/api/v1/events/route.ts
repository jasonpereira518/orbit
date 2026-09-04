/**
 * Log things that happened, from anywhere.
 *
 * This is the endpoint that makes the long tail work: Zapier, Make, n8n, Pipedream, a shell
 * script on someone's laptop — anything that can POST JSON becomes a connector without Orbit
 * writing a line of per-tool code.
 *
 * It needs no `Idempotency-Key` header, and that is a property of the design rather than an
 * omission: `ingestEvents` keys on `interactions.external_id`, so the caller's own event id IS
 * the idempotency key. Re-sending a batch updates rather than duplicating.
 */
import { after } from "next/server";
import { apiHandler, apiOk, readJson, MAX_BODY_BYTES } from "@/lib/api/http";
import { eventsBody } from "@/lib/api/schemas";
import { finalizeIngest, ingestEvents, openIngestContext } from "@/lib/ingest/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = apiHandler(
  { scope: "write", bucket: "apiIngest" },
  async (request, { caller }) => {
    const body = await readJson(request, eventsBody, MAX_BODY_BYTES);

    const ctx = await openIngestContext(caller.userId, {
      // Provenance, so the timeline can show what an integration wrote and a future
      // source-aware prompt can weigh it differently from something the user typed.
      source: `api:${caller.prefix}`,
      createsContacts: body.createContacts,
    });
    const stats = await ingestEvents(
      ctx,
      body.events.map((e) => ({
        externalIdBase: `api:${e.externalId}`,
        type: e.type,
        timestamp: e.occurredAt,
        participants: e.participants,
        summary: e.summary ?? null,
        notes: e.notes ?? null,
      }))
    );

    // Cohort recalibration and embedding backfill are deferred: neither should make a
    // caller's request slower, and both are already debounced downstream.
    after(() => finalizeIngest(ctx));

    return apiOk({
      eventsReceived: stats.eventsSeen,
      interactionsLogged: stats.interactionsLogged,
      contactsCreated: stats.contactsCreated,
      contactsMatched: stats.contactsMatched,
      unmatched: stats.unmatched,
      blockedByPlan: stats.blockedByPlan,
    });
  }
);
