import { clerkClient } from "@clerk/nextjs/server";
import { count, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { adminProviderSnapshots, userSettings } from "@/db/schema";
import { probeDeepgramKey } from "@/lib/deepgram";
import { getStripe, LIFETIME_METADATA_KEY, LIFETIME_METADATA_VALUE } from "@/lib/stripe";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";

export type ProviderName =
  | "vercel"
  | "neon"
  | "clerk"
  | "stripe"
  | "blob"
  | "resend"
  | "slack"
  | "deepgram"
  | "anthropic"
  | "openai"
  | "google"
  | "microsoft";
export type ProviderState =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "unconfigured";

export type ProviderStatus = {
  provider: ProviderName;
  label: string;
  status: ProviderState;
  detail: string;
  checkedAt: Date;
  stale: boolean;
  href: string;
  metrics: Record<string, string | number | boolean | null>;
};

const LABELS: Record<ProviderName, string> = {
  vercel: "Vercel",
  neon: "Neon",
  clerk: "Clerk",
  stripe: "Stripe",
  blob: "Vercel Blob",
  resend: "Resend",
  slack: "Slack alerts",
  deepgram: "Deepgram",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google sign-in",
  microsoft: "Microsoft sign-in",
};
const DEFAULT_LINKS: Record<ProviderName, string> = {
  vercel: "https://vercel.com/dashboard",
  neon: "https://console.neon.tech/app/projects",
  clerk: "https://dashboard.clerk.com/",
  stripe: "https://dashboard.stripe.com/",
  blob: "https://vercel.com/dashboard/stores",
  resend: "https://resend.com/emails",
  slack: "https://api.slack.com/apps",
  deepgram: "https://console.deepgram.com/",
  anthropic: "https://status.claude.com/",
  openai: "https://status.openai.com/",
  google: "https://console.cloud.google.com/apis/credentials",
  microsoft: "https://entra.microsoft.com/",
};

/**
 * Providers Orbit does not run and cannot fix: a partial outage there is worth showing
 * but not worth a banner on the Health page. Only `unavailable` raises it for these.
 */
const UPSTREAM: ReadonlySet<ProviderName> = new Set(["anthropic", "openai", "google", "microsoft"]);

/** Whether a row should count toward the Health banner's "providers down" total. */
export function isProviderProblem(row: Pick<ProviderStatus, "provider" | "status">): boolean {
  if (row.status === "unavailable") return true;
  return row.status === "degraded" && !UPSTREAM.has(row.provider);
}

const ALL_PROVIDERS = Object.keys(LABELS) as ProviderName[];
const FRESH_MS = 60_000;
const TIMEOUT_MS = 3_500;

function configuredLink(provider: ProviderName): string {
  // ADMIN_<PROVIDER>_DASHBOARD_URL, e.g. ADMIN_STRIPE_DASHBOARD_URL.
  const override = process.env[`ADMIN_${provider.toUpperCase()}_DASHBOARD_URL`]?.trim();
  return override || DEFAULT_LINKS[provider];
}

function summaryOf(status: ProviderStatus) {
  return {
    detail: status.detail,
    href: status.href,
    ...status.metrics,
  };
}

function fromSnapshot(
  row: typeof adminProviderSnapshots.$inferSelect,
  stale: boolean
): ProviderStatus {
  const provider = row.provider as ProviderName;
  const summary = row.summary ?? {};
  const { detail, href, ...metrics } = summary;
  return {
    provider,
    label: LABELS[provider],
    status: stale && row.status === "healthy" ? "degraded" : row.status,
    detail:
      typeof detail === "string"
        ? stale
          ? `${detail} Last successful check is stale.`
          : detail
        : stale
          ? "The latest live check failed; showing the last safe summary."
          : "No provider detail is available.",
    checkedAt: row.checkedAt,
    stale,
    href: typeof href === "string" ? href : configuredLink(provider),
    metrics: metrics as Record<string, string | number | boolean | null>,
  };
}

async function withTimeout<T>(label: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchJson(url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function checkVercel(): Promise<ProviderStatus> {
  const token = process.env.VERCEL_API_TOKEN?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  const checkedAt = new Date();
  if (!token || !projectId) {
    return {
      provider: "vercel",
      label: LABELS.vercel,
      status: "unconfigured",
      detail: "Add VERCEL_API_TOKEN and VERCEL_PROJECT_ID for deployment summaries.",
      checkedAt,
      stale: false,
      href: configuredLink("vercel"),
      metrics: {},
    };
  }
  const query = new URLSearchParams({ projectId, target: "production", limit: "1" });
  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  if (teamId) query.set("teamId", teamId);
  const payload = (await fetchJson(
    `https://api.vercel.com/v6/deployments?${query}`,
    token
  )) as {
    deployments?: Array<{
      uid?: string;
      name?: string;
      url?: string;
      state?: string;
      readyState?: string;
      createdAt?: number;
      meta?: Record<string, unknown>;
    }>;
  };
  const deployment = payload.deployments?.[0];
  if (!deployment) {
    return {
      provider: "vercel",
      label: LABELS.vercel,
      status: "degraded",
      detail: "No production deployment was returned for this project.",
      checkedAt,
      stale: false,
      href: configuredLink("vercel"),
      metrics: {},
    };
  }
  const state = deployment.readyState ?? deployment.state ?? "UNKNOWN";
  const healthy = state === "READY";
  const commitSha = deployment.meta?.githubCommitSha;
  let buildEvents: number | null = null;
  let buildErrors: number | null = null;
  if (deployment.uid) {
    try {
      const eventPayload = await fetchJson(
        `https://api.vercel.com/v3/deployments/${deployment.uid}/events?limit=100${teamId ? `&teamId=${encodeURIComponent(teamId)}` : ""}`,
        token
      );
      const events = Array.isArray(eventPayload) ? eventPayload : [];
      buildEvents = events.length;
      buildErrors = events.filter((item) => {
        const event = item as { type?: string; level?: string };
        return event.type === "stderr" || event.level === "error";
      }).length;
    } catch {
      // Deployment reachability is still useful when the event stream is unavailable.
    }
  }
  return {
    provider: "vercel",
    label: LABELS.vercel,
    status: healthy ? "healthy" : "degraded",
    detail: healthy
      ? "The latest production deployment is ready."
      : `The latest production deployment is ${state.toLowerCase()}.`,
    checkedAt,
    stale: false,
    href: configuredLink("vercel"),
    metrics: {
      deploymentId: deployment.uid ?? null,
      deploymentState: state,
      deploymentUrl: deployment.url ? `https://${deployment.url}` : null,
      deployedAt: deployment.createdAt
        ? new Date(deployment.createdAt).toISOString()
        : null,
      commit: typeof commitSha === "string" ? commitSha.slice(0, 12) : null,
      buildEvents,
      buildErrors,
    },
  };
}

async function checkNeon(): Promise<ProviderStatus> {
  const checkedAt = new Date();
  const started = Date.now();
  const db = await getDb();
  await db.select({ count: count() }).from(userSettings);
  const latencyMs = Date.now() - started;
  const token = process.env.NEON_API_KEY?.trim();
  const projectId = process.env.NEON_PROJECT_ID?.trim();
  if (!token || !projectId) {
    return {
      provider: "neon",
      label: LABELS.neon,
      status: "unconfigured",
      detail: `Database reachable in ${latencyMs} ms; add Neon API credentials for control-plane status.`,
      checkedAt,
      stale: false,
      href: configuredLink("neon"),
      metrics: { queryLatencyMs: latencyMs },
    };
  }
  const [projectPayload, operationsPayload] = await Promise.all([
    fetchJson(`https://console.neon.tech/api/v2/projects/${projectId}`, token),
    fetchJson(
      `https://console.neon.tech/api/v2/projects/${projectId}/operations?limit=10`,
      token
    ),
  ]);
  const project = (projectPayload as { project?: Record<string, unknown> }).project ?? {};
  const operations =
    (operationsPayload as { operations?: Array<Record<string, unknown>> }).operations ?? [];
  const failing = operations.filter((operation) => operation.status === "error").length;
  return {
    provider: "neon",
    label: LABELS.neon,
    status: failing > 0 ? "degraded" : "healthy",
    detail:
      failing > 0
        ? `${failing} recent Neon operation${failing === 1 ? "" : "s"} failed.`
        : "Database and recent control-plane operations are healthy.",
    checkedAt,
    stale: false,
    href: configuredLink("neon"),
    metrics: {
      queryLatencyMs: latencyMs,
      recentOperations: operations.length,
      failedOperations: failing,
      dataTransferBytes:
        typeof project.data_transfer_bytes === "number"
          ? project.data_transfer_bytes
          : null,
    },
  };
}

async function checkClerk(): Promise<ProviderStatus> {
  const checkedAt = new Date();
  if (!process.env.CLERK_SECRET_KEY?.trim()) {
    return {
      provider: "clerk",
      label: LABELS.clerk,
      status: "unconfigured",
      detail: "Add CLERK_SECRET_KEY for canonical identity checks.",
      checkedAt,
      stale: false,
      href: configuredLink("clerk"),
      metrics: {},
    };
  }
  const client = await clerkClient();
  const [canonical, db] = await Promise.all([
    client.users.getUserList({ limit: 1 }),
    getDb(),
  ]);
  const [mirrored] = await db.select({ count: count() }).from(userSettings);
  const drift = Math.abs(canonical.totalCount - Number(mirrored?.count ?? 0));
  return {
    provider: "clerk",
    label: LABELS.clerk,
    status: drift > 0 ? "degraded" : "healthy",
    detail:
      drift > 0
        ? `${drift} account${drift === 1 ? "" : "s"} differ between Clerk and Orbit.`
        : "Canonical and mirrored account totals agree.",
    checkedAt,
    stale: false,
    href: configuredLink("clerk"),
    metrics: {
      canonicalUsers: canonical.totalCount,
      mirroredUsers: Number(mirrored?.count ?? 0),
      drift,
    },
  };
}

async function checkStripe(): Promise<ProviderStatus> {
  const checkedAt = new Date();
  if (!process.env.STRIPE_SECRET_KEY?.trim()) {
    return {
      provider: "stripe",
      label: LABELS.stripe,
      status: "unconfigured",
      detail: "Add STRIPE_SECRET_KEY for Lifetime purchase events.",
      checkedAt,
      stale: false,
      href: configuredLink("stripe"),
      metrics: {},
    };
  }
  const events = await getStripe().events.list({ limit: 50 });
  const lifetime = events.data.filter((event) => {
    if (
      event.type !== "checkout.session.completed" &&
      event.type !== "checkout.session.async_payment_succeeded"
    ) {
      return false;
    }
    const object = event.data.object as { metadata?: Record<string, string> };
    return object.metadata?.[LIFETIME_METADATA_KEY] === LIFETIME_METADATA_VALUE;
  });
  const pending = events.data.filter((event) => event.pending_webhooks > 0).length;
  return {
    provider: "stripe",
    label: LABELS.stripe,
    status: pending > 0 ? "degraded" : "healthy",
    detail:
      pending > 0
        ? `${pending} recent Stripe event${pending === 1 ? " has" : "s have"} pending webhook delivery.`
        : "Recent Stripe event delivery is clear.",
    checkedAt,
    stale: false,
    href: configuredLink("stripe"),
    metrics: {
      recentEvents: events.data.length,
      lifetimeEvents: lifetime.length,
      pendingWebhooks: pending,
      latestEventAt: events.data[0]
        ? new Date(events.data[0].created * 1000).toISOString()
        : null,
    },
  };
}


/* ------------------------------------------------------------ newer providers ------- */

function row(
  provider: ProviderName,
  status: ProviderState,
  detail: string,
  metrics: ProviderStatus["metrics"] = {}
): ProviderStatus {
  return {
    provider,
    label: LABELS[provider],
    status,
    detail,
    checkedAt: new Date(),
    stale: false,
    href: configuredLink(provider),
    metrics,
  };
}

/** GET with a timeout that hands back the status code instead of throwing on non-2xx. */
async function fetchRaw(
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      signal: controller.signal,
      cache: "no-store",
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/** Atlassian Statuspage's `status.indicator`, as a provider state. Pure, for the smoke. */
export function stateFromStatuspageIndicator(indicator: unknown): ProviderState {
  if (indicator === "none") return "healthy";
  if (indicator === "minor" || indicator === "maintenance") return "degraded";
  if (indicator === "major" || indicator === "critical") return "unavailable";
  return "degraded";
}

/**
 * A provider's public Statuspage feed. No credential, so it is never "unconfigured" — and
 * it answers "is the provider up", not "does our key work", which is the honest scope of
 * a check that needs no secret.
 */
function statuspageCheck(provider: ProviderName, url: string): () => Promise<ProviderStatus> {
  return async () => {
    const { status, json } = await fetchRaw(url);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const body = json as { status?: { indicator?: string; description?: string } } | null;
    const indicator = body?.status?.indicator;
    if (!indicator) throw new Error("unexpected status payload");
    const state = stateFromStatuspageIndicator(indicator);
    return row(
      provider,
      state,
      state === "healthy"
        ? `${LABELS[provider]} reports all systems operational.`
        : `${LABELS[provider]} reports: ${body?.status?.description ?? indicator}.`,
      { indicator }
    );
  };
}

/** An OAuth provider's public discovery document: is the sign-in endpoint reachable. */
function discoveryCheck(
  provider: ProviderName,
  envKey: string,
  url: string
): () => Promise<ProviderStatus> {
  return async () => {
    if (!process.env[envKey]?.trim()) {
      return row(provider, "unconfigured", `Add ${envKey} to connect ${LABELS[provider]} accounts.`);
    }
    const started = Date.now();
    const { status } = await fetchRaw(url);
    const latencyMs = Date.now() - started;
    return status === 200
      ? row(provider, "healthy", `Sign-in endpoint reachable in ${latencyMs} ms.`, { latencyMs })
      : row(provider, "unavailable", `Sign-in endpoint answered HTTP ${status}.`, { httpStatus: status });
  };
}

async function checkSlack(): Promise<ProviderStatus> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) {
    return row("slack", "unconfigured", "Add SLACK_BOT_TOKEN to check the alert bot.");
  }
  // auth.test is read-only and posts nothing. A revoked token fails here, which is the
  // failure that silences every ops alert without anything else noticing.
  const { status, json } = await fetchRaw("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = json as { ok?: boolean; error?: string; team?: string } | null;
  if (status !== 200 || !body) throw new Error(`HTTP ${status}`);
  return body.ok
    ? row("slack", "healthy", "The alert bot's token is valid.", { workspace: body.team ?? null })
    : row("slack", "unavailable", `Slack rejected the alert bot's token (${body.error ?? "unknown"}).`, {
        error: body.error ?? null,
      });
}

async function checkBlob(): Promise<ProviderStatus> {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    return row("blob", "unconfigured", "Add BLOB_READ_WRITE_TOKEN; avatars are inlined in Postgres without it.");
  }
  const { list } = await import("@vercel/blob");
  const started = Date.now();
  await list({ limit: 1, token });
  const latencyMs = Date.now() - started;
  return row("blob", "healthy", `Blob store reachable in ${latencyMs} ms.`, { latencyMs });
}

async function checkDeepgram(): Promise<ProviderStatus> {
  const feed = await statuspageCheck("deepgram", "https://status.deepgram.com/api/v2/status.json")();
  // The key probe lives in deepgram.ts, the only file allowed to read that key.
  const key = await probeDeepgramKey();
  if (key === "unconfigured") {
    return { ...feed, detail: `${feed.detail} Add the Deepgram key to check it too.` };
  }
  if (key === "rejected") {
    return row("deepgram", "unavailable", "Deepgram rejected Orbit's API key; voice notes will fail.");
  }
  return feed;
}

const CHECKS: Record<ProviderName, () => Promise<ProviderStatus>> = {
  vercel: checkVercel,
  neon: checkNeon,
  clerk: checkClerk,
  stripe: checkStripe,
  blob: checkBlob,
  resend: statuspageCheck("resend", "https://resend-status.com/api/v2/status.json"),
  slack: checkSlack,
  deepgram: checkDeepgram,
  anthropic: statuspageCheck("anthropic", "https://status.anthropic.com/api/v2/status.json"),
  openai: statuspageCheck("openai", "https://status.openai.com/api/v2/status.json"),
  google: discoveryCheck(
    "google",
    "GOOGLE_CLIENT_ID",
    "https://accounts.google.com/.well-known/openid-configuration"
  ),
  microsoft: discoveryCheck(
    "microsoft",
    "MICROSOFT_CLIENT_ID",
    "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration"
  ),
};

async function saveSnapshot(status: ProviderStatus): Promise<void> {
  const db = await getDb();
  const expiresAt = new Date(status.checkedAt.getTime() + FRESH_MS);
  await db
    .insert(adminProviderSnapshots)
    .values({
      provider: status.provider,
      status: status.status,
      summary: summaryOf(status),
      checkedAt: status.checkedAt,
      expiresAt,
      errorKind: null,
    })
    .onConflictDoUpdate({
      target: adminProviderSnapshots.provider,
      set: {
        status: status.status,
        summary: summaryOf(status),
        checkedAt: status.checkedAt,
        expiresAt,
        errorKind: null,
      },
    });
}

async function checkOne(
  provider: ProviderName,
  cached: typeof adminProviderSnapshots.$inferSelect | undefined,
  force: boolean,
  check: () => Promise<ProviderStatus>
): Promise<ProviderStatus> {
  const now = new Date();
  if (!force && cached && cached.expiresAt > now) return fromSnapshot(cached, false);
  try {
    const status = await withTimeout(provider, check);
    await saveSnapshot(status);
    return status;
  } catch (error) {
    const errorKind = error instanceof Error && /timed out|abort/i.test(error.message)
      ? "timeout"
      : "request_failed";
    // Recorded on main's `error_events` rather than a telemetry table of its own. This
    // failure meets that module's admission test: it is otherwise invisible (the panel
    // just shows a stale or unavailable row), it is recorded nowhere else, and its volume
    // is bounded by a twelve-provider poll behind a cache.
    await recordErrorEvent({
      source: ERROR_SOURCES.providerHealthCheck,
      kind: errorKind,
      message: `${LABELS[provider]} health check failed.`,
      context: { provider },
    });
    if (cached) return fromSnapshot(cached, true);
    return {
      provider,
      label: LABELS[provider],
      status: "unavailable",
      detail: "The live provider check failed and no previous summary is available.",
      checkedAt: now,
      stale: false,
      href: configuredLink(provider),
      metrics: { errorKind },
    };
  }
}

export async function loadProviderStatuses(options: {
  force?: boolean;
  /** Deterministic connector substitutes used by the operations smoke suite. */
  checks?: Partial<Record<ProviderName, () => Promise<ProviderStatus>>>;
} = {}): Promise<ProviderStatus[]> {
  const db = await getDb();
  const cachedRows = await db.query.adminProviderSnapshots.findMany();
  const cached = new Map(cachedRows.map((row) => [row.provider, row]));
  const providers = ALL_PROVIDERS;
  const settled = await Promise.allSettled(
    providers.map((provider) =>
      checkOne(
        provider,
        cached.get(provider),
        Boolean(options.force),
        options.checks?.[provider] ?? CHECKS[provider]
      )
    )
  );
  return settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const provider = providers[index];
    return {
      provider,
      label: LABELS[provider],
      status: "unavailable",
      detail: "The provider check failed before a safe summary could be loaded.",
      checkedAt: new Date(),
      stale: false,
      href: configuredLink(provider),
      metrics: { errorKind: "internal_failure" },
    };
  });
}

export async function pruneProviderSnapshots(
  olderThan = new Date(Date.now() - 24 * 60 * 60 * 1000)
): Promise<number> {
  const db = await getDb();
  const removed = await db
    .delete(adminProviderSnapshots)
    .where(lt(adminProviderSnapshots.checkedAt, olderThan))
    .returning();
  return removed.length;
}
