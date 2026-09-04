/**
 * Request shapes for the public API.
 *
 * Every body and query goes through one of these, so a handler never inspects raw input. The
 * schemas are also what `/api/v1/openapi.json` is generated from, which is why the descriptions
 * matter — they become the documentation an integration author reads.
 */
import { z } from "zod";

/**
 * A URL Orbit will fetch, for webhook endpoints.
 *
 * https only. The same reasoning `src/lib/extension/contract.schema.ts` records for its own
 * URL fields applies with more force here, because Orbit is the one making the request: a
 * user-supplied http:// URL is both a plaintext leak of the signed payload and a step toward
 * reaching things that are only reachable from inside the network. Host-level checks live in
 * the delivery path, where DNS is resolved immediately before the fetch.
 */
export const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:") return false;
      // Credentials in a webhook URL are almost always a mistake, and they would be logged.
      if (parsed.username || parsed.password) return false;
      return true;
    } catch {
      return false;
    }
  }, "Must be an https:// URL without embedded credentials");

const participant = z.object({
  email: z.string().trim().email().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  linkedinUrl: z.string().trim().max(500).optional(),
  handle: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(50).optional(),
  company: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
});

/**
 * One thing that happened with someone.
 *
 * `externalId` is the idempotency key — the same id sent twice updates one interaction rather
 * than creating a second — so callers are told to make it stable and unique in their own
 * system. This is why `/v1/events` needs no `Idempotency-Key` header.
 */
export const eventInput = z.object({
  externalId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Stable unique id for this event in your system. Re-sending updates, never duplicates."),
  type: z.enum(["meeting", "email", "message", "call"]).default("message"),
  occurredAt: z.coerce.date().describe("ISO-8601 timestamp of when it happened."),
  participants: z.array(participant).min(1).max(50),
  summary: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(5000).optional(),
});

/** Batch size is bounded so one request cannot become an unbounded unit of work. */
export const eventsBody = z.object({
  events: z.array(eventInput).min(1).max(500),
  /**
   * Whether unknown participants become contacts. Defaults to false: an integration firing on
   * every calendar invite or email should annotate the network, not silently populate it.
   */
  createContacts: z.boolean().default(false),
});

export const contactCreateBody = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().optional(),
  company: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
  linkedinUrl: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(50).optional(),
  location: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(5000).optional(),
  howMet: z.string().trim().max(500).optional(),
  /**
   * Create even when an existing contact matches confidently.
   *
   * Off by default so an integration that re-sends the same person cannot quietly fork them
   * into two records — the failure mode a CRM cares about most.
   */
  force: z.boolean().default(false),
});

export const contactsQuery = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().max(200).optional(),
});

export const followupsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const webhookEndpointBody = z.object({
  url: httpsUrl,
  eventTypes: z
    .array(z.enum(["contact.created", "contact.updated", "interaction.created", "followup.due"]))
    .min(1),
  description: z.string().trim().max(200).optional(),
});

export type EventsBody = z.infer<typeof eventsBody>;
export type ContactCreateBody = z.infer<typeof contactCreateBody>;
export type WebhookEndpointBody = z.infer<typeof webhookEndpointBody>;

/** Parse a URL's query string against a schema, with the same error shape as a body. */
export function parseQuery<T>(url: string, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false; message: string; param?: string } {
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  const result = schema.safeParse(params);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      message: issue?.message ?? "Invalid query parameters.",
      param: issue?.path.join("."),
    };
  }
  return { ok: true, data: result.data };
}
