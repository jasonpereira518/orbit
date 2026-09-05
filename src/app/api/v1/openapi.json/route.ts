/**
 * The API's own description, generated from the zod schemas that validate it.
 *
 * Generated rather than hand-written, deliberately: a hand-maintained spec drifts from the
 * code the first time someone adds a field, and a drifted spec is worse than none because
 * integration authors trust it. `z.toJSONSchema` reads the same objects `readJson` validates
 * against, so the two cannot disagree.
 *
 * Worth more than it looks. Make can import this to bootstrap an integration, n8n and
 * Pipedream users get a working generic HTTP node from it immediately, and it doubles as the
 * reference someone reads before writing a Zapier app. It is the cheapest breadth in the plan.
 *
 * Public and unauthenticated: it describes the shape of the API, never anyone's data.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  contactCreateBody,
  eventsBody,
  webhookEndpointBody,
} from "@/lib/api/schemas";
import { getAppBaseUrl } from "@/lib/app-url";

export const runtime = "nodejs";

/** Cached: it is identical for every caller and changes only when the code does. */
export const revalidate = 3600;

function body(schema: z.ZodType) {
  return {
    required: true,
    content: { "application/json": { schema: z.toJSONSchema(schema) } },
  };
}

const OK = { description: "Success" };

export async function GET() {
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Orbit API",
      version: "2026-09-01",
      description:
        "Log interactions and manage contacts in a personal networking CRM. " +
        "Authenticate with a bearer API key created in Orbit's Settings.",
    },
    servers: [{ url: `${getAppBaseUrl()}/api/v1` }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "orb_live_…" },
      },
    },
    paths: {
      "/me": {
        get: {
          summary: "Who this key belongs to",
          description:
            "Use as the connection test when building an integration. Returns the account's " +
            "email, plan and the scopes this key carries.",
          responses: { "200": OK },
        },
      },
      "/events": {
        post: {
          summary: "Log interactions",
          description:
            "Record things that happened with people. `externalId` is the idempotency key: " +
            "re-sending the same id updates that interaction rather than creating a second, " +
            "so a replayed batch is safe.",
          requestBody: body(eventsBody),
          responses: { "200": OK },
        },
      },
      "/contacts": {
        get: {
          summary: "Search or list contacts",
          description:
            "With `q`, runs Orbit's hybrid search. Without it, returns the most recently " +
            "created contacts — the polling shape a 'new contact' trigger needs.",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          ],
          responses: { "200": OK },
        },
        post: {
          summary: "Create a contact",
          description:
            "Checks for an existing match first and returns it instead of creating a " +
            "duplicate, unless `force` is set.",
          requestBody: body(contactCreateBody),
          responses: { "201": OK },
        },
      },
      "/followups": {
        get: {
          summary: "Who to follow up with",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          ],
          responses: { "200": OK },
        },
      },
      "/webhook-endpoints": {
        get: { summary: "List webhook endpoints", responses: { "200": OK } },
        post: {
          summary: "Register a webhook endpoint",
          description:
            "Orbit immediately POSTs a signed `endpoint.verified` event to the URL and only " +
            "activates it on a 2xx. The response includes the signing secret, once.",
          requestBody: body(webhookEndpointBody),
          responses: { "201": OK },
        },
      },
      "/webhook-endpoints/{id}": {
        delete: {
          summary: "Remove a webhook endpoint",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: { "200": OK },
        },
      },
    },
    "x-webhooks": {
      description:
        "Deliveries carry `Orbit-Signature: t=<unix>,v1=<hex>`, an HMAC-SHA256 of " +
        "`${t}.${rawBody}` using the endpoint secret. Reject if |now - t| exceeds 300 seconds. " +
        "The timestamp is inside the signed string, so it cannot be rewritten by a replay.",
      events: ["contact.created", "interaction.created", "followup.due", "endpoint.verified"],
    },
  };

  return NextResponse.json(spec);
}
