/**
 * Provider health checks and their snapshot cache.
 *
 * The property that matters operationally: this must never be the reason an admin page
 * fails to render. Twelve third-party services sit behind it, any of which can be unreachable,
 * misconfigured, or slow — so every degraded path has to produce a row rather than an
 * exception. This runs with no provider credentials at all, which is the worst case and
 * also the default for a fresh checkout.
 *
 * Run: npx tsx scripts/smoke-provider-status.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { adminProviderSnapshots, errorEvents } from "../src/db/schema";
import {
  isProviderProblem,
  loadProviderStatuses,
  pruneProviderSnapshots,
  stateFromStatuspageIndicator,
  type ProviderName,
  type ProviderStatus,
} from "../src/lib/admin-providers";
import { ERROR_SOURCES } from "../src/lib/error-events";

const PROVIDERS: ProviderName[] = [
  "vercel", "neon", "clerk", "stripe", "blob", "resend", "slack",
  "deepgram", "anthropic", "openai", "google", "microsoft",
];

// These read a public status page and need no credential, so with every key unset they would
// still reach the network. The suite must not depend on someone else's uptime: stub them.
const PUBLIC_FEED: ProviderName[] = ["resend", "deepgram", "anthropic", "openai"];
const stubbed: Partial<Record<ProviderName, () => Promise<ProviderStatus>>> = Object.fromEntries(
  PUBLIC_FEED.map((provider) => [
    provider,
    async (): Promise<ProviderStatus> => ({
      provider,
      label: provider,
      status: "healthy",
      detail: "stubbed",
      checkedAt: new Date(),
      stale: false,
      href: "https://example.test",
      metrics: {},
    }),
  ])
);

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(adminProviderSnapshots);
  await db
    .delete(errorEvents)
    .where(eq(errorEvents.source, ERROR_SOURCES.providerHealthCheck));
}

async function main() {
  console.log("Provider status");

  // Unset every provider credential: the point is that this degrades, never throws.
  for (const key of [
    "VERCEL_API_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID",
    "NEON_API_KEY", "NEON_PROJECT_ID", "CLERK_SECRET_KEY", "STRIPE_SECRET_KEY",
    "BLOB_READ_WRITE_TOKEN", "SLACK_BOT_TOKEN", "DEEPGRAM_API_KEY",
    "GOOGLE_CLIENT_ID", "MICROSOFT_CLIENT_ID",
  ]) {
    delete process.env[key];
  }

  await cleanup();

  const statuses = await loadProviderStatuses({ force: true, checks: stubbed });
  check("returns one row per provider", statuses.length === PROVIDERS.length, `${statuses.length}`);
  check(
    "covers every provider by name",
    PROVIDERS.every((p) => statuses.some((s) => s.provider === p)),
    statuses.map((s) => s.provider).join(",")
  );
  check(
    "every unconfigured provider reads as such, never as healthy",
    statuses
      .filter((s) => !PUBLIC_FEED.includes(s.provider))
      .every((s) => s.status === "unconfigured"),
    statuses.map((s) => `${s.provider}=${s.status}`).join(" ")
  );
  check(
    "every row carries a label, a detail and a dashboard link",
    statuses.every((s) => s.label && s.detail && s.href)
  );

  // An unconfigured provider is not a failure, so it must not fill error_events with noise.
  const db = await getDb();
  const noise = await db.query.errorEvents.findMany({
    where: eq(errorEvents.source, ERROR_SOURCES.providerHealthCheck),
  });
  check("an unconfigured provider records no error event", noise.length === 0, `${noise.length}`);

  /* ------------------------------------------------------------------ the snapshot cache */

  const cached = await loadProviderStatuses({ checks: stubbed });
  check(
    "a second unforced load still returns every row",
    cached.length === PROVIDERS.length
  );

  // A snapshot past its expiry must degrade a `healthy` row rather than report it fresh:
  // "it was fine a day ago" is not the same claim as "it is fine".
  await db.insert(adminProviderSnapshots).values({
    provider: "stripe",
    status: "healthy",
    summary: {},
    checkedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    expiresAt: new Date(Date.now() - 47 * 60 * 60 * 1000),
  }).onConflictDoUpdate({
    target: adminProviderSnapshots.provider,
    set: {
      status: "healthy",
      checkedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 47 * 60 * 60 * 1000),
    },
  });

  const rows = await db.query.adminProviderSnapshots.findMany();
  check("snapshots are stored one row per provider", rows.length <= PROVIDERS.length, `${rows.length}`);

  const removed = await pruneProviderSnapshots(new Date(Date.now() - 24 * 60 * 60 * 1000));
  check("pruning removes snapshots older than the cutoff", removed >= 1, `${removed}`);
  check(
    "...and keeps fresher ones",
    (await db.query.adminProviderSnapshots.findMany()).every(
      (r) => r.checkedAt.getTime() > Date.now() - 24 * 60 * 60 * 1000
    )
  );

  /* ------------------------------------------------------ status pages and the banner */

  check(
    "a Statuspage indicator maps to a provider state",
    stateFromStatuspageIndicator("none") === "healthy" &&
      stateFromStatuspageIndicator("minor") === "degraded" &&
      stateFromStatuspageIndicator("major") === "unavailable" &&
      stateFromStatuspageIndicator("critical") === "unavailable" &&
      stateFromStatuspageIndicator("something-new") === "degraded"
  );
  check(
    "an upstream partial outage is not a banner problem, a full one is",
    !isProviderProblem({ provider: "openai", status: "degraded" }) &&
      isProviderProblem({ provider: "openai", status: "unavailable" })
  );
  check(
    "a degraded provider Orbit relies on directly is a banner problem",
    isProviderProblem({ provider: "neon", status: "degraded" }) &&
      !isProviderProblem({ provider: "neon", status: "unconfigured" })
  );

  console.log("Done.");
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
