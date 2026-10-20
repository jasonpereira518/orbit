/**
 * The shared route error funnel (FIX_PLAN 3.2) and the error scrubbing behind it (audit L-14).
 *
 *  1. `classifyRouteError` / `routeError`: Orbit's words → 400, a rate limit or a cap → 429
 *     with `Retry-After`, a paywall → 403, signed out → 401, a cross-site request → 403/415,
 *     and anything else → 500 carrying only the caller's fallback and a reference, never the
 *     error's own text.
 *  2. Real route handlers fed malformed input (demo mode, so no session plumbing): each
 *     answers a 4xx with `{ error }`, never a 500, and refuses a cross-site or non-JSON post.
 *  3. Model and provider text is scrubbed out of `error_events.message`, its context, and
 *     `reportError`'s extras.
 *
 * Run: npx tsx scripts/smoke-route-errors.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../src/db";
import { errorEvents, rateLimitBuckets } from "../src/db/schema";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
}

const SECRET_TEXT = "relation \"contacts\" violates constraint; key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function helper() {
  const { classifyRouteError, routeError, authErrorResponse, rateLimitGuard } = await import("../src/lib/api/route-error");
  const { UserFacingError } = await import("../src/lib/errors");
  const { RateLimitedError, CapReachedError } = await import("../src/lib/rate-limit");
  const { PaywallError } = await import("../src/lib/entitlements");
  const { RequestRefusedError } = await import("../src/lib/api/same-origin");
  const { UnauthorizedError, AccountSuspendedError, AccountHeldError } = await import("../src/lib/auth");

  console.log("The mapping");
  const opts = { fallback: "Couldn’t do that", where: "smoke.route-errors" };
  const body = async (res: Response) => (await res.json()) as { error?: string; ref?: string; param?: string };

  let res = routeError(new UserFacingError("Give it a title first"), opts);
  check("UserFacingError → 400 with its own words", res.status === 400 && (await body(res)).error === "Give it a title first");

  const zodErr = z.object({ contactId: z.string().uuid() }).safeParse({ contactId: 7 }).error;
  res = routeError(zodErr, opts);
  const zb = await body(res);
  check("ZodError → 400 naming the field, not zod's internals", res.status === 400 && zb.param === "contactId" && !/expected/i.test(zb.error ?? ""), zb);

  res = routeError(new RateLimitedError("draft", 125), opts);
  check("RateLimitedError → 429", res.status === 429);
  check("…with Retry-After in seconds", res.headers.get("Retry-After") === "125", res.headers.get("Retry-After"));
  check("…and the limit's own message", /AI draft limit/.test((await body(res)).error ?? ""));

  const cap = new CapReachedError("reminderDaily", "You've reached the daily reminder limit (500). Try again tomorrow.", 3600);
  check("a cap is a UserFacingError (server actions show it)", cap instanceof UserFacingError);
  res = routeError(cap, opts);
  check("…but a route answers it 429, not 400", res.status === 429 && res.headers.get("Retry-After") === "3600");

  res = routeError(new PaywallError("api", "free", "The API is on Pro"), opts);
  check("PaywallError → 403 with the plan's copy", res.status === 403 && (await body(res)).error === "The API is on Pro");
  check("UnauthorizedError → 401", routeError(new UnauthorizedError(), opts).status === 401);
  check("AccountHeldError → 401", routeError(new AccountHeldError(), opts).status === 401);
  check("AccountSuspendedError → 403", routeError(new AccountSuspendedError(new Date()), opts).status === 403);
  check("a cross-site refusal → 403", routeError(new RequestRefusedError(403, "Cross-origin request refused"), opts).status === 403);
  check("a non-JSON body → 415", routeError(new RequestRefusedError(415, "Send this request as JSON"), opts).status === 415);

  const quietError = console.error;
  const quietWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    res = routeError(new Error(SECRET_TEXT), opts);
    const fb = await body(res);
    check("anything else → 500", res.status === 500);
    check("…carrying the fallback, never the raw message", fb.error?.startsWith("Couldn’t do that") === true && !fb.error.includes("contacts") && !fb.error.includes("sk-ant"), fb);
    check("…and an 8-character reference", typeof fb.ref === "string" && fb.ref.length === 8, fb);
    check("…in the message too, so the person can quote it", fb.error?.includes(fb.ref ?? "@@") === true, fb);
    check("a fault may answer 502 where the route always did", routeError(new Error("upstream"), { ...opts, faultStatus: 502 }).status === 502);
  } finally {
    console.error = quietError;
    console.warn = quietWarn;
  }
  check("an unrecognised error is not classified", classifyRouteError(new TypeError("x")) === null);

  console.log("\nThe auth gate and the rate-limit guard");
  res = authErrorResponse(new UnauthorizedError(), "Sign in to chat");
  check("signed out → 401 with the route's sign-in line", res.status === 401 && (await body(res)).error === "Sign in to chat");
  res = authErrorResponse(new PaywallError("page", "free", "Chat is on Pro"), "Sign in to chat");
  check("a hidden surface (paywall) → 403 with its copy", res.status === 403 && (await body(res)).error === "Chat is on Pro");
  check("a suspended account → 403", authErrorResponse(new AccountSuspendedError(new Date()), "x").status === 403);
  check("a fault in the gate fails closed → 401", authErrorResponse(new Error("db down"), "x").status === 401);
  check("rateLimitGuard: allowed → null", (await rateLimitGuard(async () => ({ remaining: 3 }))) === null);
  const limited = await rateLimitGuard(async () => {
    throw new RateLimitedError("chat", 30);
  });
  check("rateLimitGuard: limited → 429 + Retry-After", limited?.status === 429 && limited.headers.get("Retry-After") === "30");
  let rethrown = false;
  await rateLimitGuard(async () => {
    throw new Error("database is down");
  }).catch(() => {
    rethrown = true;
  });
  check("rateLimitGuard: a limiter fault is rethrown, not read as allowed", rethrown);
}

/** A request the way a same-origin page sends one. */
function post(path: string, init: { body?: string; headers?: Record<string, string> } = {}) {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json", ...init.headers },
    body: init.body,
  });
}

async function realRoutes() {
  console.log("\nReal routes, malformed input");
  // Demo mode (no Clerk keys, development) resolves every request to `demo-user`.
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  const db = await getDb();
  await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, "knowledgeRefresh:demo-user"));
  await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, "chat:demo-user"));
  const read = async (res: Response) => (await res.json().catch(() => null)) as { error?: string } | null;

  const knowledge = await import("../src/app/api/knowledge/refresh/route");
  let res = await knowledge.POST(post("/api/knowledge/refresh", { body: "{not json" }));
  check("knowledge/refresh: broken JSON → 400, not 500", res.status === 400, res.status);
  res = await knowledge.POST(post("/api/knowledge/refresh", { body: JSON.stringify({ contactId: "../../etc" }) }));
  check("knowledge/refresh: a malformed id → 400", res.status === 400 && (await read(res))?.error === "contactId required");
  res = await knowledge.POST(post("/api/knowledge/refresh", { body: "contactId=x", headers: { "content-type": "application/x-www-form-urlencoded" } }));
  check("knowledge/refresh: a form post → 415", res.status === 415, res.status);
  res = await knowledge.POST(post("/api/knowledge/refresh", { body: "{}", headers: { origin: "https://evil.example" } }));
  check("knowledge/refresh: another site's Origin → 403", res.status === 403 && /Cross-origin/.test((await read(res))?.error ?? ""));

  const chat = await import("../src/app/api/chat/route");
  res = await chat.POST(post("/api/chat", { body: JSON.stringify({ question: "hi" }), headers: { origin: "https://evil.example" } }));
  check("chat: another site's Origin → 403 (audit L-01)", res.status === 403, res.status);
  res = await chat.POST(post("/api/chat", { body: "question=hi", headers: { "content-type": "text/plain;charset=UTF-8" } }));
  check("chat: a text/plain body (the no-preflight CSRF shape) → 415", res.status === 415, res.status);
  res = await chat.POST(post("/api/chat", { body: "{\"question\": " }));
  check("chat: broken JSON → 400 'Question is required'", res.status === 400 && (await read(res))?.error === "Question is required");
  res = await chat.POST(post("/api/chat", { body: JSON.stringify({ question: 42, versionOf: { assistantMessageId: 7 } }) }));
  check("chat: wrong types → 400, not a 500", res.status === 400, res.status);

  const research = await import("../src/app/api/research/route");
  res = await research.POST(post("/api/research", { body: "{}" }));
  check("research: no custom header → 400 (or 401/403 when the surface is hidden)", [400, 401, 403].includes(res.status), res.status);
  if (res.status === 400) {
    res = await research.POST(post("/api/research", { body: "[1,2", headers: { "x-orbit-research": "1" } }));
    check("research: broken JSON → 400", res.status === 400, res.status);
    res = await research.POST(post("/api/research", { body: "x".repeat(5_000), headers: { "x-orbit-research": "1" } }));
    check("research: an oversized body → 413", res.status === 413, res.status);
  }

  const usage = await import("../src/app/api/speech/usage/route");
  res = await usage.POST(post("/api/speech/usage", { body: "{\"seconds\": \"lots\", \"grants\": [1, null]}" }));
  check("speech/usage: nonsense numbers and grant ids → 204, nothing recorded or raised", [204, 401, 403].includes(res.status), res.status);

  const claim = await import("../src/app/api/plan-upgrades/claim/route");
  res = await claim.POST(post("/api/plan-upgrades/claim", { headers: { origin: "null" } }));
  check("plan-upgrades/claim: Origin null → 403", res.status === 403, res.status);
  res = await claim.POST(post("/api/plan-upgrades/claim"));
  check("plan-upgrades/claim: same origin → 200", res.status === 200, res.status);

  await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, "knowledgeRefresh:demo-user"));
  await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, "chat:demo-user"));
}

async function scrubbing() {
  console.log("\nModel and provider text never reaches error_events or reportError extras (L-14)");
  const { scrubModelText, scrubText } = await import("../src/lib/sentry-scrub");
  const { recordErrorEvent } = await import("../src/lib/error-events");
  const { reportError } = await import("../src/lib/report-error");

  const parse = "Failed to parse AI JSON: {\"summary\": \"Priya said her divorce is final\", \"standing\"";
  check("a parse failure keeps what failed and drops the model's excerpt",
    scrubModelText(parse) === "Failed to parse AI JSON: [model output omitted]", scrubModelText(parse));
  const provider = "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt mentions ada@example.com\"}}";
  check("a provider's JSON body is replaced whole", scrubText(provider) === "400 {…}", scrubText(provider));
  check("plain diagnostics stay readable", scrubText("Gmail returned 429") === "Gmail returned 429");
  check("the chat route reports the parse failure scrubbed",
    (await import("node:fs")).readFileSync("src/app/api/chat/route.ts", "utf8").includes("scrubModelText(`chat answer JSON did not parse"));

  const db = await getDb();
  await recordErrorEvent({
    source: "smoke.route-errors",
    kind: "parse",
    message: new Error(parse),
    context: { detail: provider, count: 3 },
  });
  const [row] = await db
    .select()
    .from(errorEvents)
    .where(eq(errorEvents.source, "smoke.route-errors"))
    .orderBy(desc(errorEvents.createdAt))
    .limit(1);
  check("error_events.message holds no model output", Boolean(row) && !String(row?.message).includes("divorce"), row?.message);
  const ctx = (row?.context ?? {}) as Record<string, unknown>;
  check("…nor does its context", ctx.detail === "400 {…}" && ctx.count === 3, ctx);
  await db.delete(errorEvents).where(eq(errorEvents.source, "smoke.route-errors"));

  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    reportError(new Error("boom"), { where: "smoke.route-errors", extra: { reply: parse, to: "ada@example.com", n: 1 } });
  } finally {
    console.error = original;
  }
  const extra = (logged[0]?.[2] ?? {}) as Record<string, unknown>;
  check("reportError extras are scrubbed of model text", extra.reply === "Failed to parse AI JSON: [model output omitted]", extra);
  check("…and of addresses", extra.to === "[email]" && extra.n === 1, extra);
}

run(async () => {
  const prior = { NODE_ENV: process.env.NODE_ENV, pk: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, sk: process.env.CLERK_SECRET_KEY };
  try {
    await helper();
    await realRoutes();
    await scrubbing();
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = prior.NODE_ENV;
    if (prior.pk !== undefined) process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = prior.pk;
    if (prior.sk !== undefined) process.env.CLERK_SECRET_KEY = prior.sk;
  }
  if (failures) throw new Error(`${failures} route-error check(s) failed`);
  console.log("\nsmoke-route-errors: all checks passed");
});
