/**
 * The `product_events` taxonomy as zod schemas: the one list of events Orbit records, and the
 * only shape their properties may take. Validated by `track()` in `src/lib/product-events.ts`.
 *
 * Rules enforced by construction:
 *   - every property schema admits only ids (uuid / Clerk id), closed enums, integers,
 *     booleans and durations. No `z.string()` without a format: free text never enters
 *     analytics (names, note contents, prompts, URLs with queries, email bodies).
 *   - `name` is object_action, past tense for completed facts.
 *   - `version` bumps when a property's MEANING changes; adding an optional property does not.
 *
 * See TRACKING_PLAN.md §4 and analytics/events/README.md for ownership and definitions. A smoke
 * test (scripts/smoke-product-events.ts) asserts every event here has a README section.
 */
import { z } from "zod";

const uuid = z.string().uuid();
/** A Clerk user id (`user_…`) or the literal demo id. Never an email. */
const clerkId = z.string().regex(/^(user_[A-Za-z0-9]+|demo-user)$/);
const count = z.number().int().min(0);
const ms = z.number().int().min(0);
const days = z.number().int().min(0);

export const SURFACES = ["web", "extension", "mcp", "api", "cron", "webhook"] as const;
export const ACTORS = ["user", "system"] as const;

export const CHANNELS = [
  "direct", "referral_link", "search", "social", "newsletter", "product_hunt",
  "extension", "mcp", "waitlist", "other",
] as const;
export const ONBOARDING_PATHS = ["capture", "import", "tour"] as const;
export const AI_PROVIDERS = ["gemini", "openai", "anthropic", "openrouter", "typesafe", "deepgram"] as const;
export const CAPTURE_SOURCES = ["text", "voice", "photo", "file", "meeting", "paste", "drive"] as const;
export const IMPORT_PROVIDERS = [
  "linkedin_connections", "linkedin_messages", "google_contacts", "outlook_contacts",
  "apple_contacts", "vcard", "csv", "calendar", "drive_notes", "other",
] as const;
export const FOLLOWUP_ORIGINS = ["manual", "suggestion", "capture", "extension", "mcp"] as const;
export const FOLLOWUP_VIA = ["list", "dashboard", "touch", "bulk", "extension", "mcp"] as const;
export const MCP_CLIENTS = ["claude", "chatgpt", "other"] as const;
export const PLANS = ["free", "orbit", "max", "lifetime"] as const;
export const INTERVALS = ["month", "year", "once"] as const;
export const GATES = [
  "contacts", "outreach", "hostedSending", "hostedEnrichment", "recruiters", "sync", "extension",
  "api", "meetings", "creditPacks", "extraConnections", "managedCredits", "backgroundFloor",
  "speechShortform", "speechMeeting",
] as const;
export const FAILURE_FLOWS = ["capture", "import", "sync", "voice", "ai", "email", "checkout"] as const;
export const SURVEYS = ["post_first_capture", "day7_not_activated", "followup_useful", "pmf", "cancellation"] as const;
export const CANCEL_REASONS = ["too_expensive", "not_using", "missing_feature", "privacy", "season_over", "other"] as const;
export const SHARE_CHANNELS = ["copy", "x", "linkedin", "native", "ticket"] as const;

/** Properties per event name. Keys are the closed event list. */
export const eventSchemas = {
  // Acquisition and access
  waitlist_shared: z.object({ signup_id: uuid, channel: z.enum(SHARE_CHANNELS) }),
  invite_sent: z.object({ invite_id: uuid, wave_id: z.string().regex(/^w\d{1,3}$/), source: z.enum(["waitlist", "manual"]) }),
  invite_accepted: z.object({ invite_id: uuid, days_since_sent: days }),
  first_app_load: z.object({ session_id: uuid, landing_route: z.string().regex(/^\/[a-z0-9\-\/\[\]\.]*$/) }),

  // Setup and activation
  onboarding_path_chosen: z.object({ path: z.enum(ONBOARDING_PATHS) }),
  onboarding_step_completed: z.object({ path: z.enum(ONBOARDING_PATHS), step: z.string().regex(/^[a-z_]{1,32}$/) }),
  ai_key_added: z.object({ provider: z.enum(AI_PROVIDERS), plan: z.enum(PLANS), seconds_since_signup: count }),
  ai_key_check_failed: z.object({ provider: z.enum(AI_PROVIDERS), error_kind: z.string().regex(/^[a-z_]{1,32}$/) }),
  capture_saved: z.object({
    capture_job_id: uuid,
    source_kind: z.enum(CAPTURE_SOURCES),
    people_created: count,
    people_updated: count,
    duration_ms: ms.optional(),
  }),
  capture_failed: z.object({ capture_job_id: uuid, source_kind: z.enum(CAPTURE_SOURCES), stage: z.enum(["ingest", "parse", "save"]), error_kind: z.string().regex(/^[a-z_]{1,32}$/) }),
  capture_discarded: z.object({ capture_job_id: uuid, people_proposed: count }),
  import_failed: z.object({ import_id: uuid, provider: z.enum(IMPORT_PROVIDERS), error_kind: z.string().regex(/^[a-z_]{1,32}$/), rows_failed: count }),
  followup_set: z.object({ reminder_id: uuid, origin: z.enum(FOLLOWUP_ORIGINS), has_due_date: z.boolean() }),
  followup_completed: z.object({ reminder_id: uuid, days_late: z.number().int().optional(), via: z.enum(FOLLOWUP_VIA) }),
  followup_snoozed: z.object({ reminder_id: uuid }),
  followup_dismissed: z.object({ reminder_id: uuid }),
  chat_answer_landed: z.object({ message_id: uuid, duration_ms: ms, tool_rounds: count, evidence_count: count }),
  chat_answer_failed: z.object({ thread_id: uuid, error_kind: z.string().regex(/^[a-z_]{1,32}$/) }),

  // Habit surfaces
  mcp_connected: z.object({ client: z.enum(MCP_CLIENTS), via: z.enum(["oauth", "api_key"]) }),
  mcp_tool_called: z.object({ tool: z.string().regex(/^[a-z_]{1,48}$/), client: z.enum(MCP_CLIENTS), ok: z.boolean(), duration_ms: ms, result_count: count.optional() }),
  mcp_disconnected: z.object({ client: z.enum(MCP_CLIENTS) }),
  extension_installed: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), browser: z.enum(["chrome", "edge", "brave", "arc", "other"]) }),
  extension_action: z.object({ action: z.enum(["save_person", "log_interaction", "open_profile", "event_roster", "starters"]), site: z.enum(["linkedin", "gmail", "luma", "partiful", "other"]), ok: z.boolean() }),
  extension_uninstalled: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }),

  // Monetization
  checkout_started: z.object({ plan: z.enum(PLANS), interval: z.enum(INTERVALS), from_gate: z.enum(GATES).optional() }),
  subscription_canceled: z.object({ reason: z.enum(CANCEL_REASONS).optional(), tenure_days: days }),

  // Quality and trust
  error_shown: z.object({ where: z.string().regex(/^[a-z_.]{1,48}$/), error_kind: z.string().regex(/^[a-z_]{1,32}$/) }),
  sync_failed: z.object({ provider: z.enum(["gmail", "outlook", "google_calendar", "microsoft_calendar", "icloud", "caldav", "eventbrite", "luma"]), error_kind: z.string().regex(/^[a-z_]{1,32}$/) }),
  email_send_failed: z.object({ provider: z.enum(["resend", "gmail", "outlook"]), kind: z.enum(["outreach", "followup", "digest", "notice"]) }),
  survey_shown: z.object({ survey_id: z.enum(SURVEYS) }),
  survey_dismissed: z.object({ survey_id: z.enum(SURVEYS) }),
  survey_answered: z.object({ survey_id: z.enum(SURVEYS), question_id: z.string().regex(/^[a-z_]{1,32}$/), answer: z.union([z.number().int().min(1).max(5), z.string().regex(/^[a-z_]{1,32}$/)]) }),
  account_deleted: z.object({ tenure_days: days, plan: z.enum(PLANS), reason: z.enum(CANCEL_REASONS).optional() }),
} as const;

export type EventName = keyof typeof eventSchemas;
export type EventProps<N extends EventName> = z.infer<(typeof eventSchemas)[N]>;

/** The envelope the helper fills; call sites supply only `name` and `props`. */
export const envelopeSchema = z.object({
  id: uuid,
  name: z.enum(Object.keys(eventSchemas) as [EventName, ...EventName[]]),
  version: z.number().int().min(1),
  occurred_at: z.date(),
  user_id: clerkId.nullable(),
  session_id: uuid.nullable(),
  surface: z.enum(SURFACES),
  actor: z.enum(ACTORS),
  is_internal: z.boolean(),
});

/** Current schema version per event. Bump when a property's meaning changes. */
export const eventVersions: Record<EventName, number> = Object.fromEntries(
  Object.keys(eventSchemas).map((k) => [k, 1])
) as Record<EventName, number>;

/**
 * Shape of the proposed helper (lives in src/lib/product-events.ts once approved):
 *
 *   track("capture_saved", { capture_job_id, source_kind: "text", people_created: 3, people_updated: 0 })
 *
 * - compile error on a missing or extra property;
 * - in development and under the smoke suite, a zod failure THROWS;
 * - in production it drops the event and calls reportError(err, { where: "analytics.track" }), throttled.
 */
export type Track = <N extends EventName>(
  name: N,
  props: EventProps<N>,
  options?: { userId?: string | null; sessionId?: string | null; surface?: (typeof SURFACES)[number]; actor?: (typeof ACTORS)[number]; occurredAt?: Date; id?: string }
) => Promise<void>;

/** Lint helper for the smoke suite: every leaf schema must be an id, enum, number, boolean or regex-bounded string. Works on zod 3 (`typeName`) and zod 4 (`type`). */
export function assertNoFreeText(schema: z.ZodTypeAny, path = "root"): string[] {
  const problems: string[] = [];
  const def = (schema as unknown as { _def: Record<string, unknown> })._def;
  const raw = (def.type as string | undefined) ?? (def.typeName as string | undefined) ?? "";
  const t = raw.replace(/^Zod/, "").toLowerCase();
  if (t === "object") {
    const shape = typeof def.shape === "function" ? (def.shape as () => Record<string, z.ZodTypeAny>)() : (def.shape as Record<string, z.ZodTypeAny>);
    for (const [k, v] of Object.entries(shape ?? {})) problems.push(...assertNoFreeText(v, `${path}.${k}`));
  } else if (t === "optional" || t === "nullable") {
    problems.push(...assertNoFreeText(def.innerType as z.ZodTypeAny, path));
  } else if (t === "union") {
    for (const o of def.options as z.ZodTypeAny[]) problems.push(...assertNoFreeText(o, path));
  } else if (t === "string") {
    const checks = (def.checks ?? []) as Array<{ kind?: string; _zod?: { def?: { check?: string; format?: string } } }>;
    const bounded = checks.some((c) => {
      const kind = c.kind ?? c._zod?.def?.format ?? c._zod?.def?.check;
      return kind === "uuid" || kind === "regex" || kind === "string_format";
    }) || (def.format as string | undefined) === "uuid" || (def.format as string | undefined) === "regex";
    if (!bounded) problems.push(`${path}: unbounded string`);
  }
  return problems;
}
