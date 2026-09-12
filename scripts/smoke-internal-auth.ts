/**
 * Asserts the shared-secret gate on Orbit's internal job routes is fail-CLOSED.
 *
 * Four routes are hit by Vercel Cron, by the ops scheduler, and by the app's own
 * self-continuation `fetch` — never by a browser: `/api/imports/process-stalled`,
 * `/api/imports/[id]/continue`, `/api/embeddings/backfill` and
 * `/api/linkedin/timeline-events/backfill`. Each used to carry its own inline check that
 * returned `true` whenever `CRON_SECRET` was unset, so forgetting one env var in production
 * turned all four into anonymous triggers. `isInternalRequest()` in `src/lib/internal-auth.ts`
 * replaces those copies: it opens the door without a secret only in local development.
 *
 * Run: npx tsx scripts/smoke-internal-auth.ts
 */
import "./smoke/_env";

import { internalAuthHeaders, internalFetch, isInternalRequest } from "../src/lib/internal-auth";
import { GET as processStalled } from "../src/app/api/imports/process-stalled/route";
import { POST as continueImport } from "../src/app/api/imports/[id]/continue/route";
import { POST as embeddingBackfill } from "../src/app/api/embeddings/backfill/route";
import { POST as timelineBackfill } from "../src/app/api/linkedin/timeline-events/backfill/route";

const SECRET = "smoke-internal-auth-secret";

function check(label: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${label} FAILED${detail ? `: ${detail}` : ""}`);
  console.log("  ok  " + label);
}

function req(authorization?: string, method = "POST") {
  return new Request("http://localhost/internal", {
    method,
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify({ userId: "smoke-internal-auth-user" }),
  });
}

/** Env is read at call time by design, so each block sets exactly the shape it asserts. */
function env(over: { CRON_SECRET?: string; VERCEL?: string; NODE_ENV?: string; APP_BASE_URL?: string }) {
  const bag = process.env as Record<string, string | undefined>;
  for (const key of ["CRON_SECRET", "VERCEL", "NODE_ENV", "APP_BASE_URL"]) delete bag[key];
  Object.assign(process.env, over);
}

async function main() {
  console.log("Internal-route auth (isInternalRequest)...");

  env({ CRON_SECRET: SECRET });
  check("correct bearer is accepted", isInternalRequest(req(`Bearer ${SECRET}`)));
  check("wrong bearer is rejected", !isInternalRequest(req("Bearer nope")));
  check(
    "bearer of a different length is rejected, not thrown",
    !isInternalRequest(req(`Bearer ${SECRET}-and-more`))
  );
  check("missing header is rejected", !isInternalRequest(req()));
  check(
    "internalAuthHeaders() carries the bearer",
    internalAuthHeaders().Authorization === `Bearer ${SECRET}`
  );

  env({ CRON_SECRET: SECRET, APP_BASE_URL: "http://orbit.test" });
  let seen: { url: string; auth: string | null } | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), auth: new Headers(init?.headers).get("authorization") };
    return new Response("{}");
  }) as typeof fetch;
  try {
    await internalFetch("/api/imports/imp_x/continue", { method: "POST" });
  } finally {
    globalThis.fetch = realFetch;
  }
  check(
    "internalFetch targets the app base URL with the bearer",
    seen !== null &&
      (seen as { url: string; auth: string | null }).url === "http://orbit.test/api/imports/imp_x/continue" &&
      (seen as { url: string; auth: string | null }).auth === `Bearer ${SECRET}`,
    JSON.stringify(seen)
  );

  env({ VERCEL: "1", NODE_ENV: "production" });
  check("no secret on Vercel → closed", !isInternalRequest(req()));
  check("internalAuthHeaders() is empty without a secret", Object.keys(internalAuthHeaders()).length === 0);

  env({ NODE_ENV: "production" });
  check("no secret in production off Vercel → closed", !isInternalRequest(req()));

  env({ NODE_ENV: "development" });
  check("no secret in local development → open", isInternalRequest(req()));

  env({ NODE_ENV: "development", VERCEL: "1" });
  check("no secret in a Vercel dev build → closed", !isInternalRequest(req()));

  console.log("\nRoutes reject unauthenticated calls when no secret is configured on Vercel...");
  env({ VERCEL: "1", NODE_ENV: "production" });
  const stalled = await processStalled(req(undefined, "GET"));
  check("process-stalled → 401", stalled.status === 401, `got ${stalled.status}`);
  const cont = await continueImport(req(), { params: Promise.resolve({ id: "smoke-import" }) });
  check("imports/[id]/continue → 401", cont.status === 401, `got ${cont.status}`);
  const emb = await embeddingBackfill(req());
  check("embeddings/backfill → 401", emb.status === 401, `got ${emb.status}`);
  const tl = await timelineBackfill(req());
  check("linkedin/timeline-events/backfill → 401", tl.status === 401, `got ${tl.status}`);

  console.log("\nRoutes reject a wrong bearer when a secret is configured...");
  env({ CRON_SECRET: SECRET, VERCEL: "1", NODE_ENV: "production" });
  const wrong = await Promise.all([
    processStalled(req("Bearer nope", "GET")),
    continueImport(req("Bearer nope"), { params: Promise.resolve({ id: "smoke-import" }) }),
    embeddingBackfill(req("Bearer nope")),
    timelineBackfill(req("Bearer nope")),
  ]);
  check(
    "all four → 401",
    wrong.every((r) => r.status === 401),
    wrong.map((r) => r.status).join(",")
  );

  console.log("\nAll internal-auth checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
