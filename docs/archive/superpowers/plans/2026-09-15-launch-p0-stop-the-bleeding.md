# Launch Phase 0 — Stop the Bleeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every Phase 0 launch blocker from the 2026-09-15 audit that code can close — backups that fail loudly, account deletion that deletes, refunds that revoke, a rollback that stays green, no email to invented people, no cross-tenant recruiter or outreach reads, honest BYOK key errors, reply-to on outreach, JSON 401s for signed-out API calls, a valid Opus preset, email-less admin delete and quiet dev logs — without a schema change.
**Architecture:** Each fix lands in the module that already owns the behaviour. Decisions go into pure modules (`src/lib/billing-stripe.ts`, `src/lib/outreach-quality.ts`, `src/lib/errors.ts`, `src/lib/ops-alerts.ts`, and the new `src/lib/ai-key-check.ts`) with pure smoke coverage; drivers (webhook routes, server actions, `src/proxy.ts`) only wire them. Where a fix would normally want a new column (who contributed a recruiter's email, which purchase a refund belongs to), it is derived from data that already exists — link timestamps, the ledger's `detail` jsonb, one Stripe lookup — so the phase merges past the open branches that hold schema version 56.
**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle over Neon (neon-http) / PGlite, Clerk, Stripe, tsx smoke scripts
**Spec:** docs/production-readiness-audit-2026-09-15.md (items: A1 code half, A2, A4, A5, A7, A8 short-term (recruiter pool + outreach preview), A9, A11 code half, B1, B8 Opus id + temperature, B11 dev logging, B12 email-less admin delete (+ CSP flip as a manual step))
**Roadmap:** docs/superpowers/plans/2026-09-15-launch-readiness-roadmap.md

## Global Constraints

- Branch: create `claude/launch-<phase>` off `origin/main` in a fresh worktree; run `npm ci` in it (worktrees share no node_modules). Commit after every task; commit messages end with the line `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Next.js 16 has breaking changes versus common training data: before using any Next API (route handlers, `proxy.ts`, `after()`, server actions, config), read the matching guide under `node_modules/next/dist/docs/`.
- Tests are tsx smoke scripts `scripts/smoke-<name>.ts`, each an executable spec that prints `ok`/`FAIL` lines and exits nonzero on failure. Pure scripts touch no database. Database scripts MUST start with `import "./smoke/_env";` (deletes DATABASE_URL, uses a throwaway PGlite dir) and wrap main in `run()` from that module. EVERY new smoke script must be added to `MANIFEST` in `scripts/run-smoke.ts` with tier `"pure"` or `"pglite"` or the whole suite refuses to run. Run one: `npx tsx scripts/smoke-<name>.ts`. Run all: `npm test`.
- Every task ends green on: the task's smoke script, `npm run typecheck`, `npm run lint` (baseline is 0 errors; any error is yours), and `npx tsx scripts/smoke-toast-copy.ts` when user-facing copy changed.
- tsx scripts must exit explicitly (`run()` or `process.exit(0)`); PGlite keeps the loop alive. Never import `next/server` into a low-level `src/lib/*` module that scripts import — the import alone hangs every script.
- A `"use server"` module may export ONLY async functions; a const/type export silently breaks every export in it. Put shared constants/types in `src/lib/*-types.ts`.
- A client component must not import anything that reaches `@/db` (build fails with a node:fs chunk error). Pure metadata goes in a DB-free module.
- User-facing errors: throw `new UserFacingError("…")` for copy you want shown; across a server-action boundary return it as data via `asActionResult`; catch sites use `friendlyError(err, fallback)` from `src/lib/errors.ts`, never `err.message`. Toast/copy voice (enforced by `scripts/smoke-toast-copy.ts`): curly apostrophes (’), "Couldn’t" not "Could not", never the word "failed", no trailing period, " — " as the one connector.
- Drizzle: use bare `.returning()` (partial returning does not typecheck across the driver union); read `db.execute()` results with `rowsOf<T>()` from `@/db`; `db.transaction` does not exist on neon-http — use `runAtomicWrite` (src/db/index.ts) or accept sequential idempotent writes; a column interpolated into a `sql```` template inside `.select()` loses its table prefix.
- Schema changes: table in `src/db/schema.ts`; `CREATE TABLE IF NOT EXISTS` in the `DDL` template in `src/db/index.ts` (the template has ZERO `--` comments, no backticks, no `;` inside comments — explanations go on the Drizzle table); new columns ALSO go in the `alters` list; new tables go in `EXPECTED_TABLES` in `scripts/setup-db.ts`; bump `export const SCHEMA_VERSION` with a changelog comment line; then `npx tsx scripts/smoke-schema-ddl.ts --update` and `npm run db:setup` (read the printed table list). NEVER hardcode the new version in the plan: compute it at execution time as one more than the highest value claimed by any remote branch:
  `git fetch -q --all && for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do git show "${b}:src/db/index.ts" 2>/dev/null | grep -oE 'export const SCHEMA_VERSION = [0-9]+'; done | grep -oE '[0-9]+$' | sort -n | tail -1`
  (56 is already claimed by three open branches as of 2026-09-15.) Re-run the scan immediately before pushing. Never put backticks in comments inside the `alters`/`SCALE_DDL` arrays.
- Tailwind compiles utility classes it finds in comments: never write an arbitrary-value class (e.g. `w-[123px]`) in a code comment.
- UI changes are verified in the browser: start the `orbit-web` configuration from `.claude/launch.json` (port 3001, demo mode on local PGlite when no Clerk keys are set). Controlled React inputs must be driven with real keystrokes, not DOM value writes.
- Do not add dependencies unless a task explicitly says so and gives the exact package and version.
- Scope: implement only the audit items assigned to this plan. Do not refactor neighbours.

### Plan-specific constraints

- **No schema change in this phase.** Do not touch `src/db/schema.ts`, the `DDL` template, `alters`, `SCALE_DDL`, `EXPECTED_TABLES` or `SCHEMA_VERSION`. Task 6 edits the *logic* of two functions in `src/db/index.ts` (`schemaIsCurrent`, `recordSchemaVersion`) and nothing else there. The branch must merge without a version bump; if a step seems to need a column, stop — every item below already has a column-free design, and the column-shaped follow-ups are listed under "Deferred to later phases".
- **Billing ledger invariant** (header of `src/lib/billing-stripe.ts`): cash rows are keyed by the Stripe object, MRR rows by the event id, and no single `billing_events` row ever carries both a non-zero `amountCents` and a non-zero `mrrDeltaCents`. Task 2's smoke asserts it for every decision it makes.
- Line numbers were read at `33a213c`. If `main` has moved, find the quoted code; do not trust the number.
- Dependencies between tasks: Task 3 needs Task 2; Task 5 needs Task 4; Task 9 needs Task 8; Tasks 11 and 12 need Task 10. Everything else is independent and ordered smallest-highest-harm first.
- Demo-mode server actions in smoke scripts: an action body calls `requireUserId()`, which returns `"demo-user"` when `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`/`CLERK_SECRET_KEY` are unset and `NODE_ENV === "development"` (see `scripts/smoke-follow-up-actions.ts:74-80`). `revalidatePath` throws outside a request ("static generation store"), after the action's writes have landed — tests that reach it tolerate exactly that error (same rule as `src/lib/reminder-paths.ts:15-24`).

---

### Task 1: A Clerk `user.deleted` webhook deletes the settings row too (A2)

**Files:**
- Modify: `src/app/api/webhooks/clerk/route.ts:99-102` (the `user.deleted` branch)
- Create: `scripts/smoke-account-deletion.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST, pglite section, after `"smoke-account-alerts": "pglite",`)

Verified and deliberately NOT changed: `src/lib/admin-operations.ts` `hardDeleteAccount` (:531-567) already calls `purgeUserData(input.targetUserId, { keepSettings: false })`; `deleteAccount` (:478-495) is documented as "delete their data, keep the login" and `scripts/smoke-admin-actions.ts:480-487` pins that its settings row survives — the person can still sign in there, so it is correct to keep.

**Interfaces:** Consumes `purgeUserData(userId: string, opts?: { keepSettings?: boolean; only?: readonly DataCategory[] })` from `src/lib/user-data.ts:518`. Produces nothing new.

- [ ] **Step 0: Create the branch and confirm the baseline**

```bash
cd /Users/jasonpereira/Projects/orbit
git fetch -q origin
git worktree add .claude/worktrees/launch-p0 -b claude/launch-p0 origin/main
cd .claude/worktrees/launch-p0
npm ci
npm run typecheck && npm run lint
```

Expected: typecheck exits 0; lint prints 0 errors (warnings are baseline). All later commands run from `.claude/worktrees/launch-p0`.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-account-deletion.ts`:

```ts
/**
 * Asserts that deleting an account in Clerk deletes it here too — including the settings
 * row — while the Settings "Delete data" path keeps that row on purpose.
 *
 * The two paths look alike and must not behave alike. "Delete data" runs for someone who is
 * still signed in, so their email, name and encrypted provider keys survive it
 * (`purgeUserData`'s default `keepSettings: true`). A `user.deleted` webhook means the
 * account no longer exists; keeping the row there left the person's identity, live
 * third-party API keys and Stripe customer id in the admin roster forever (audit A2).
 *
 * Drives the real webhook route with a real Standard Webhooks signature computed here —
 * no Clerk account, no network.
 *
 * Run: npx tsx scripts/smoke-account-deletion.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { createHmac } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, userSettings, webhookDeliveries } from "../src/db/schema";
import { purgeUserData } from "../src/lib/user-data";
import { ensureUserSettings } from "../src/lib/user-settings";
import { POST as clerkPost } from "../src/app/api/webhooks/clerk/route";

// A real base64 secret: `verifyWebhook` strips `whsec_` and base64-decodes the rest, so the
// HMAC below is a signature it genuinely accepts. It reads the variable at call time, so
// setting it after the imports is fine.
const SECRET_BYTES = Buffer.from("orbit-smoke-clerk-signing-secret");
process.env.CLERK_WEBHOOK_SIGNING_SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

const GONE = "smoke-deletion-webhook-user";
const KEPT = "smoke-deletion-settings-user";
const DELIVERY_IDS = ["msg_smoke_deletion_1", "msg_smoke_deletion_2"];
const CIPHERTEXT = "smoke-ciphertext-not-a-real-key";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function signedClerkRequest(payload: unknown, deliveryId: string) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", SECRET_BYTES)
    .update(`${deliveryId}.${timestamp}.${body}`)
    .digest("base64");
  return new Request("http://localhost/api/webhooks/clerk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": deliveryId,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body,
  });
}

// The route is typed for NextRequest but only reads headers and text, which Request has.
const post = (req: Request) =>
  clerkPost(req as unknown as Parameters<typeof clerkPost>[0]);

async function cleanup() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, [GONE, KEPT]));
  await db.delete(userSettings).where(inArray(userSettings.userId, [GONE, KEPT]));
  await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.eventId, DELIVERY_IDS));
}

async function seed(userId: string) {
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({
      email: `${userId}@example.test`,
      firstName: "Fixture",
      geminiApiKeyEncrypted: CIPHERTEXT,
      stripeCustomerId: `cus_${userId}`,
    })
    .where(eq(userSettings.userId, userId));
  await db.insert(contacts).values({ userId, fullName: "Deletion Fixture" });
}

async function settingsRows(userId: string) {
  const db = await getDb();
  return db.select().from(userSettings).where(eq(userSettings.userId, userId));
}

async function contactRows(userId: string) {
  const db = await getDb();
  return db.select().from(contacts).where(eq(contacts.userId, userId));
}

run(async () => {
  await cleanup();
  await seed(GONE);
  await seed(KEPT);

  console.log("Clerk user.deleted — the account is gone, so nothing of it stays");
  const event = {
    type: "user.deleted",
    object: "event",
    data: { id: GONE, object: "user", deleted: true },
  };
  const res = await post(signedClerkRequest(event, DELIVERY_IDS[0]));
  check("the signed webhook is accepted", res.status === 200, String(res.status));
  const gone = await settingsRows(GONE);
  check(
    "a user.deleted webhook leaves no user_settings row",
    gone.length === 0,
    JSON.stringify(gone.map((r) => ({ email: r.email, key: r.geminiApiKeyEncrypted })))
  );
  check("…and no contacts", (await contactRows(GONE)).length === 0);

  const again = await post(signedClerkRequest(event, DELIVERY_IDS[1]));
  check(
    "a redelivery is harmless",
    again.status === 200 && (await settingsRows(GONE)).length === 0,
    String(again.status)
  );

  console.log("\nSettings → Delete data — still signed in, so the row stays");
  await purgeUserData(KEPT);
  const kept = await settingsRows(KEPT);
  check("the settings row survives", kept.length === 1, String(kept.length));
  check(
    "…with the saved provider key intact",
    kept[0]?.geminiApiKeyEncrypted === CIPHERTEXT,
    String(kept[0]?.geminiApiKeyEncrypted)
  );
  check("…and the identity mirror intact", kept[0]?.email === `${KEPT}@example.test`);
  check("…while the data itself is gone", (await contactRows(KEPT)).length === 0);

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll account-deletion checks passed.");
});
```

- [ ] **Step 2: Register it**

In `scripts/run-smoke.ts`, in the `// pglite ---` block, add directly after `"smoke-account-alerts": "pglite",`:

```ts
  "smoke-account-deletion": "pglite",
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx scripts/smoke-account-deletion.ts`
Expected: `FAIL a user.deleted webhook leaves no user_settings row` with a detail showing the preserved email and `smoke-ciphertext-not-a-real-key`; exit code 1.

- [ ] **Step 4: Implement**

In `src/app/api/webhooks/clerk/route.ts`, replace:

```ts
    } else if (evt.type === "user.deleted") {
      const userId = evt.data.id;
      if (userId) {
        await purgeUserData(userId);
```

with:

```ts
    } else if (evt.type === "user.deleted") {
      const userId = evt.data.id;
      if (userId) {
        // The account no longer exists in Clerk, so nothing of it may outlive it here:
        // `keepSettings: false` deletes the settings row too — email, name, avatar, every
        // encrypted provider key and the Stripe customer id. The Settings "Delete data" path
        // keeps that row on purpose (its person is still signed in); this one must not.
        await purgeUserData(userId, { keepSettings: false });
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx tsx scripts/smoke-account-deletion.ts && npx tsx scripts/smoke-purge.ts && npx tsx scripts/smoke-admin-actions.ts`
Expected: every line `ok`, `All account-deletion checks passed.`, exit 0 for all three.

- [ ] **Step 6: Typecheck, lint, manifest guard**

Run: `npm run typecheck && npm run lint && npx tsx scripts/run-smoke.ts --check`
Expected: exit 0; 0 lint errors; the check prints no problems.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/webhooks/clerk/route.ts scripts/smoke-account-deletion.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Delete the settings row when Clerk says the account is gone

A user.deleted webhook purged with keepSettings defaulting to true, so a
deleted person kept their email, name, encrypted provider keys and Stripe
customer id in user_settings forever. The Settings "Delete data" path keeps
the row on purpose (the person is still signed in); the webhook now does not.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Refunds and lost disputes decide a revocation (A4, pure half)

**Files:**
- Modify: `src/lib/billing-stripe.ts` — header comment (:29-46), types `MirrorInstruction` (:68-80) and `DecideContext` (:91-99), new shape readers after `customerIdOf` (:114-120), the Lifetime booking `detail` (:340-344), `charge.refunded` (:593-638), `charge.dispute.closed` (:674-704)
- Create: `scripts/smoke-stripe-revocation.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST, pure section)

**How a refund is tied to what it bought (decided here, applied in Task 3).** Stripe's current API (`stripe@22.5.0`, `ApiVersion = '2026-07-29.dahlia'`) has no `invoice` on a `Charge` — `node_modules/stripe/esm/resources/Charges.d.ts` lists `payment_intent` but no `invoice` — and the existing refund booking only reads `charge.refunds`, `charge.id` and `charge.currency`. What every charge and dispute does carry is `payment_intent`. A Lifetime Checkout Session (`mode: "payment"`, `src/actions/billing.ts:56`) has that same `payment_intent`; a Pro charge's payment intent pays an invoice. So:

1. This task records `paymentIntentId` on the Lifetime `cs:` booking's `detail` (jsonb — no column).
2. The pure decision takes a `chargePurpose` in its context and never looks anything up itself.
3. Task 3's driver resolves the purpose: ledger first (free, covers every purchase made after this ships), then `checkout.sessions.list({ payment_intent })` (covers older Lifetime purchases), then `invoicePayments.list({ payment: { type: "payment_intent", payment_intent } })` (a subscription).

Only a **full** refund (`charge.refunded === true`, or `amount_refunded >= amount_captured`) or a **lost** dispute revokes. A Lifetime revocation books no MRR (Lifetime never had any). A subscription revocation books one `churn` row keyed by the event id carrying only `mrrDeltaCents`, next to the cash rows keyed by their objects carrying only `amountCents` — one event, two rows, never both on one row. A later `customer.subscription.deleted` then reads `beforeCents = 0` (the mirror now says canceled with a past period end) and books nothing, so churn is never counted twice.

**Interfaces:**
- Produces (exported from `src/lib/billing-stripe.ts`):
  - `type ChargePurpose = "lifetime" | "subscription" | "unknown"`
  - `type RevocationReason = "refund" | "dispute_lost"`
  - `MirrorInstruction` gains `{ type: "lifetime_revoked"; userId: string; reason: RevocationReason }` and `{ type: "subscription_revoked"; userId: string; periodEnd: number; reason: RevocationReason }` (`periodEnd` in epoch seconds)
  - `DecideContext.chargePurpose?: ChargePurpose`
  - `paymentIntentIdOf(obj: { payment_intent?: string | { id: string } | null }): string | null`
  - `isFullRefund(charge: { refunded?: boolean | null; amount_refunded?: number | null; amount_captured?: number | null }): boolean`
  - `revocationPaymentIntent(event: Pick<Stripe.Event, "type" | "data">): string | null`
  - Lifetime `cs:` bookings carry `detail.paymentIntentId: string | null`
- Consumed by: Task 3 (`src/app/api/webhooks/stripe/route.ts`, `src/lib/stripe-charge-purpose.ts`).

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-stripe-revocation.ts`:

```ts
/**
 * Pins what a refund or a lost dispute MEANS, in the pure Stripe decision module.
 *
 * Before this, `charge.refunded` and `charge.dispute.closed` returned `mirror: null`: a
 * refunded Lifetime kept Lifetime forever and a charged-back Pro kept Pro until the
 * subscription lapsed on its own (audit A4). The decision now withdraws access on a FULL
 * refund or a LOST dispute — and only once the driver has said what the charge paid for,
 * because this module never looks anything up.
 *
 * Also re-asserts the ledger invariant on every decision it makes: no booking row carries
 * both cash and MRR.
 *
 * Pure: no database, no network. Run: npx tsx scripts/smoke-stripe-revocation.ts
 */
import type Stripe from "stripe";
import {
  decideStripeEvent,
  isFullRefund,
  revocationPaymentIntent,
  type ChargePurpose,
  type DecideContext,
  type StripeDecision,
} from "../src/lib/billing-stripe";
import { LIFETIME_METADATA_KEY, LIFETIME_METADATA_VALUE } from "../src/lib/stripe";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-09-15T12:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const USER = "user_revocation";

function ctx(chargePurpose?: ChargePurpose, beforeCents = 500): DecideContext {
  return { userId: USER, beforeCents, hadPriorRevenue: true, now: NOW, chargePurpose };
}

function event(type: string, object: Record<string, unknown>, id = `evt_${type}`): Stripe.Event {
  return {
    id,
    object: "event",
    type,
    created: NOW_SECONDS,
    data: { object },
  } as unknown as Stripe.Event;
}

function charge(over: Record<string, unknown> = {}) {
  return {
    id: "ch_1",
    object: "charge",
    customer: "cus_1",
    currency: "usd",
    payment_intent: "pi_1",
    amount: 2500,
    amount_captured: 2500,
    amount_refunded: 2500,
    refunded: true,
    refunds: {
      object: "list",
      data: [{ id: "re_1", object: "refund", amount: 2500, created: NOW_SECONDS, reason: "requested_by_customer" }],
    },
    ...over,
  };
}

function dispute(over: Record<string, unknown> = {}) {
  return {
    id: "dp_1",
    object: "dispute",
    charge: "ch_1",
    payment_intent: "pi_1",
    customer: "cus_1",
    amount: 2500,
    reason: "fraudulent",
    status: "lost",
    ...over,
  };
}

const refunded = (purpose?: ChargePurpose, over: Record<string, unknown> = {}, before = 500) =>
  decideStripeEvent(event("charge.refunded", charge(over), "evt_refund"), ctx(purpose, before));
const disputeClosed = (purpose?: ChargePurpose, over: Record<string, unknown> = {}, before = 500) =>
  decideStripeEvent(event("charge.dispute.closed", dispute(over), "evt_dispute"), ctx(purpose, before));

function neverBoth(d: StripeDecision): boolean {
  return d.bookings.every((b) => !((b.amountCents ?? 0) !== 0 && (b.mrrDeltaCents ?? 0) !== 0));
}

async function main() {
  console.log("Which events even need a lookup");
  check("a full refund names its payment intent",
    revocationPaymentIntent(event("charge.refunded", charge())) === "pi_1");
  check("a partial refund needs none",
    revocationPaymentIntent(event("charge.refunded", charge({ refunded: false, amount_refunded: 1000 }))) === null);
  check("a full refund without Stripe's flag is still full (amounts)",
    isFullRefund({ refunded: false, amount_refunded: 2500, amount_captured: 2500 }));
  check("an uncaptured charge is never 'fully refunded'",
    !isFullRefund({ refunded: false, amount_refunded: 0, amount_captured: 0 }));
  check("a lost dispute names its payment intent",
    revocationPaymentIntent(event("charge.dispute.closed", dispute())) === "pi_1");
  check("a won dispute needs none",
    revocationPaymentIntent(event("charge.dispute.closed", dispute({ status: "won" }))) === null);
  check("an expanded payment intent object is read by id",
    revocationPaymentIntent(event("charge.refunded", charge({ payment_intent: { id: "pi_obj" } }))) === "pi_obj");
  check("other event types need none",
    revocationPaymentIntent(event("invoice.paid", { id: "in_1" })) === null);

  console.log("\nA full refund of the Lifetime charge");
  const life = refunded("lifetime");
  check("withdraws Lifetime",
    life.mirror?.type === "lifetime_revoked" && life.mirror.userId === USER && life.mirror.reason === "refund",
    JSON.stringify(life.mirror));
  check("still books the refund cash, keyed on the refund",
    life.bookings.some((b) => b.eventId === "re:re_1" && b.amountCents === 2500 && (b.mrrDeltaCents ?? 0) === 0));
  check("books no MRR row (Lifetime never had recurring revenue)",
    life.bookings.every((b) => (b.mrrDeltaCents ?? 0) === 0));
  check("is handled", life.outcome === "handled");

  console.log("\nA full refund of a subscription charge");
  const sub = refunded("subscription");
  check("cancels the subscription as of now",
    sub.mirror?.type === "subscription_revoked" && sub.mirror.periodEnd === NOW_SECONDS && sub.mirror.reason === "refund",
    JSON.stringify(sub.mirror));
  const churn = sub.bookings.find((b) => b.kind === "churn");
  check("books one churn row, keyed on the event",
    churn?.eventId === "evt_refund" && churn.mrrDeltaCents === -500 && (churn.amountCents ?? 0) === 0,
    JSON.stringify(churn));
  check("keeps the cash row separate", sub.bookings.some((b) => b.eventId === "re:re_1"));
  const already = refunded("subscription", {}, 0);
  check("an already-lapsed subscription is canceled but churns nothing twice",
    already.mirror?.type === "subscription_revoked" && !already.bookings.some((b) => b.kind === "churn"));

  console.log("\nWhat does NOT revoke");
  check("purpose unknown → no mirror", refunded("unknown").mirror === null);
  check("no purpose at all (the backfill replays like this) → no mirror", refunded(undefined).mirror === null);
  check("a partial refund of the Lifetime charge → no mirror",
    refunded("lifetime", { refunded: false, amount_refunded: 1000 }).mirror === null);
  const unexpanded = refunded("lifetime", { refunds: { object: "list", data: [] } });
  check("a full refund whose refunds were not expanded still revokes",
    unexpanded.outcome === "handled" && unexpanded.mirror?.type === "lifetime_revoked",
    JSON.stringify(unexpanded));
  const quiet = refunded("unknown", { refunds: { object: "list", data: [] } });
  check("…but with nothing to book and nothing to revoke it is still ignored",
    quiet.outcome === "ignored" && quiet.mirror === null);

  console.log("\nDisputes");
  const lostLife = disputeClosed("lifetime");
  check("a lost dispute on the Lifetime charge withdraws Lifetime",
    lostLife.mirror?.type === "lifetime_revoked" && lostLife.mirror.reason === "dispute_lost");
  check("…and still books the lost cash on the dispute",
    lostLife.bookings.some((b) => b.eventId === "dp:dp_1" && b.amountCents === 2500));
  const lostSub = disputeClosed("subscription");
  check("a lost dispute on a subscription charge cancels it now",
    lostSub.mirror?.type === "subscription_revoked" && lostSub.mirror.reason === "dispute_lost");
  const won = disputeClosed("lifetime", { status: "won" });
  check("a won dispute changes nothing", won.mirror === null && won.outcome === "ignored");

  console.log("\nThe Lifetime purchase remembers how it was paid");
  const purchase = decideStripeEvent(
    event("checkout.session.completed", {
      id: "cs_1",
      object: "checkout.session",
      client_reference_id: USER,
      payment_status: "paid",
      customer: "cus_1",
      payment_intent: "pi_life",
      amount_total: 2500,
      currency: "usd",
      metadata: { [LIFETIME_METADATA_KEY]: LIFETIME_METADATA_VALUE },
    }),
    ctx()
  );
  check("the cs: booking carries paymentIntentId",
    purchase.bookings[0]?.detail.paymentIntentId === "pi_life",
    JSON.stringify(purchase.bookings[0]?.detail));

  console.log("\nThe ledger invariant");
  const all = [life, sub, already, unexpanded, lostLife, lostSub, won, purchase];
  check("no booking row anywhere carries both cash and MRR", all.every(neverBoth));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Stripe revocation checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Register it**

In `scripts/run-smoke.ts`, in the `// pure ---` block, add after `"smoke-security-headers": "pure",`:

```ts
  "smoke-stripe-revocation": "pure",
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx scripts/smoke-stripe-revocation.ts`
Expected: exits nonzero before the first check with a `TypeError` naming `revocationPaymentIntent` (it is not exported yet).

- [ ] **Step 4: Implement the types**

In `src/lib/billing-stripe.ts`, append to the header comment (after the paragraph ending "or with any row already written.", before the closing `*/` at :46):

```ts
 *
 * ONE EXCEPTION AT THE EVENT LEVEL, NONE AT THE ROW LEVEL. A full refund or a lost dispute
 * that ends a SUBSCRIPTION books its cash rows (keyed by the refund / dispute object) and
 * one churn row (keyed by the event). Each row still carries exactly one of the two
 * columns, which is the property every sum relies on. A later
 * `customer.subscription.deleted` reads a zero "before" from the already-canceled mirror,
 * so it books nothing and the churn is never counted twice.
```

Replace the `MirrorInstruction` type (:68-80) with:

```ts
/**
 * What a refunded or disputed charge originally paid for. Resolved by the DRIVER
 * (`src/lib/stripe-charge-purpose.ts`), because it needs the ledger and the Stripe API and
 * this module may touch neither. "unknown" revokes nothing.
 */
export type ChargePurpose = "lifetime" | "subscription" | "unknown";

/** Why access was withdrawn. Carried on the mirror and the churn row. */
export type RevocationReason = "refund" | "dispute_lost";

export type MirrorInstruction =
  | {
      type: "subscription";
      userId: string;
      plan: "orbit" | null;
      status: "active" | "past_due" | "canceled" | null;
      periodEnd: number | null;
      monthlyCents: number | null;
      interval: BillingInterval | null;
      stripeCustomerId: string | null;
    }
  | { type: "lifetime"; userId: string; stripeCustomerId: string | null }
  /** A full refund or lost dispute of the Lifetime charge: clear `lifetime_purchased_at`. */
  | { type: "lifetime_revoked"; userId: string; reason: RevocationReason }
  /**
   * A full refund or lost dispute of a subscription charge: status `canceled`, paid through
   * `periodEnd` (epoch seconds, = now), so `resolvePlan` drops to free immediately.
   */
  | { type: "subscription_revoked"; userId: string; periodEnd: number; reason: RevocationReason }
  | null;
```

In `DecideContext` (:91-99), add after `now: Date;`:

```ts
  /**
   * What the charge behind a full refund or a lost dispute paid for. Only read for
   * `charge.refunded` and `charge.dispute.closed`. Absent means "unknown" — which is what
   * the billing backfill passes, so a replay of history never revokes anything.
   */
  chargePurpose?: ChargePurpose;
```

- [ ] **Step 5: Implement the shape readers**

Directly after `customerIdOf` (ends :120), add:

```ts
/** `payment_intent` arrives as an id, an expanded object, or null. */
export function paymentIntentIdOf(obj: {
  payment_intent?: string | { id: string } | null;
}): string | null {
  const intent = obj.payment_intent;
  if (!intent) return null;
  return typeof intent === "string" ? intent : intent.id;
}

/**
 * Whether a charge has been refunded in full. `refunded` is Stripe's own flag; the amount
 * comparison covers a payload that omits it. A charge that captured nothing is never
 * "fully refunded" — there was nothing to give back.
 */
export function isFullRefund(charge: {
  refunded?: boolean | null;
  amount_refunded?: number | null;
  amount_captured?: number | null;
}): boolean {
  if (charge.refunded === true) return true;
  const captured = charge.amount_captured ?? 0;
  return captured > 0 && (charge.amount_refunded ?? 0) >= captured;
}

/**
 * The payment intent whose purpose the driver must resolve before deciding this event, or
 * null when the event cannot revoke anything (a partial refund, a won dispute, any other
 * type). Lets the driver skip the lookup on every common path.
 */
export function revocationPaymentIntent(
  event: Pick<Stripe.Event, "type" | "data">
): string | null {
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    return isFullRefund(charge) ? paymentIntentIdOf(charge) : null;
  }
  if (event.type === "charge.dispute.closed") {
    const dispute = event.data.object as Stripe.Dispute;
    return dispute.status === "lost" ? paymentIntentIdOf(dispute) : null;
  }
  return null;
}
```

- [ ] **Step 6: Implement the revocation decision**

Directly after `secondsToDate` (:298-299), add:

```ts
type Revocation = { mirror: MirrorInstruction; bookings: Booking[] };

const NO_REVOCATION: Revocation = { mirror: null, bookings: [] };

/**
 * What withdrawing access means for a charge whose purpose the driver resolved. Books no
 * cash — the caller already books that on the refund / dispute object.
 */
function revocationFor(
  reason: RevocationReason,
  event: Pick<Stripe.Event, "id">,
  ctx: DecideContext,
  userId: string,
  eventAt: Date,
  detail: Record<string, unknown>
): Revocation {
  if (ctx.chargePurpose === "lifetime") {
    // No MRR row: Lifetime never contributed recurring revenue.
    return { mirror: { type: "lifetime_revoked", userId, reason }, bookings: [] };
  }
  if (ctx.chargePurpose === "subscription") {
    const movement = classifyMovement(ctx.beforeCents, 0, {
      hadPriorRevenue: ctx.hadPriorRevenue,
    });
    return {
      mirror: {
        type: "subscription_revoked",
        userId,
        reason,
        periodEnd: Math.floor(ctx.now.getTime() / 1000),
      },
      // Keyed by the EVENT and carrying only MRR; the cash rows beside it are keyed by
      // their own objects and carry only cash.
      bookings: movement
        ? [
            {
              eventId: event.id,
              kind: "churn",
              userId,
              amountCents: 0,
              mrrDeltaCents: movement.deltaCents,
              effectiveAt: eventAt,
              detail: { ...detail, revoked: reason, beforeCents: ctx.beforeCents, afterCents: 0 },
            },
          ]
        : [],
    };
  }
  return NO_REVOCATION;
}
```

- [ ] **Step 7: Record the payment intent on the Lifetime booking**

In the Lifetime branch of `checkout.session.completed` (:340-344), replace:

```ts
              detail: {
                checkoutSessionId: session.id,
                customerId,
                currency: session.currency ?? null,
              },
```

with:

```ts
              detail: {
                checkoutSessionId: session.id,
                customerId,
                currency: session.currency ?? null,
                // How a later refund or dispute is tied back to THIS purchase: charges carry
                // a payment intent, never a session id. See `src/lib/stripe-charge-purpose.ts`.
                paymentIntentId: paymentIntentIdOf(session),
              },
```

- [ ] **Step 8: Revoke on a full refund**

Replace the tail of the `charge.refunded` case — from `if (bookings.length === 0) {` (:624) through the case's closing `}` (:638) — with:

```ts
      const revoke = isFullRefund(charge)
        ? revocationFor("refund", event, ctx, userId, eventAt, {
            chargeId: charge.id,
            paymentIntentId: paymentIntentIdOf(charge),
          })
        : NO_REVOCATION;

      if (bookings.length === 0 && !revoke.mirror) {
        // A charge whose refunds were not expanded. Falling back to `amount_refunded`
        // keyed on the charge would double-count the moment a second partial arrives, so
        // record nothing and say why rather than book a number that can grow wrong. A full
        // refund still revokes above — that needs no amount.
        return ignored(STRIPE_IGNORE_REASONS.zeroAmount, userId, resourceId);
      }

      return {
        mirror: revoke.mirror,
        bookings: [...bookings, ...revoke.bookings],
        outcome: "handled",
        targetUserId: userId,
        resourceId,
      };
    }
```

- [ ] **Step 9: Revoke on a lost dispute**

In the `charge.dispute.closed` case, replace from `return {` after the `status !== "lost"` guard (:680) through the case's closing `}` (:704) with:

```ts
      const revoke = revocationFor("dispute_lost", event, ctx, userId, eventAt, {
        disputeId: dispute.id,
        paymentIntentId: paymentIntentIdOf(dispute),
      });
      return {
        mirror: revoke.mirror,
        bookings: [
          {
            eventId: `dp:${dispute.id}`,
            kind: "refund",
            userId,
            amountCents: dispute.amount ?? 0,
            mrrDeltaCents: 0,
            effectiveAt: eventAt,
            detail: {
              disputeId: dispute.id,
              chargeId:
                typeof dispute.charge === "string"
                  ? dispute.charge
                  : (dispute.charge?.id ?? null),
              outcome: "lost",
            },
          },
          ...revoke.bookings,
        ],
        outcome: "handled",
        targetUserId: userId,
        resourceId,
      };
    }
```

- [ ] **Step 10: Run it and watch it pass**

Run: `npx tsx scripts/smoke-stripe-revocation.ts && npx tsx scripts/smoke-stripe-webhook.ts`
Expected: `All Stripe revocation checks passed.` and `All Stripe webhook checks passed.`; exit 0 both. (The webhook route ignores the new mirror types until Task 3, and its existing refund/dispute fixtures carry no payment intent, so nothing there changes yet.)

- [ ] **Step 11: Typecheck, lint, manifest guard**

Run: `npm run typecheck && npm run lint && npx tsx scripts/run-smoke.ts --check`
Expected: exit 0, 0 lint errors. (`scripts/backfill-billing-events.ts` also calls `decideStripeEvent`; it passes no `chargePurpose`, which is exactly "never revoke on replay".)

- [ ] **Step 12: Commit**

```bash
git add src/lib/billing-stripe.ts scripts/smoke-stripe-revocation.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Decide a revocation for full refunds and lost disputes

charge.refunded and charge.dispute.closed returned mirror: null, so a refunded
Lifetime kept Lifetime and a charged-back Pro kept Pro. The pure decision now
withdraws access when the driver says what the charge paid for, books a churn
row (event-keyed, MRR only) for subscriptions, and records the payment intent
on every new Lifetime booking so refunds can be tied back without a column.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The Stripe webhook applies the revocation (A4, driver half)

**Files:**
- Create: `src/lib/stripe-charge-purpose.ts`
- Modify: `src/lib/user-settings.ts` — add `revokeLifetimePurchase` after `setLifetimePurchase` (:280-312)
- Modify: `src/app/api/webhooks/stripe/route.ts` — imports (:7-21), the decide/apply block (:129-185)
- Modify: `scripts/smoke-stripe-revocation.ts` (resolver cases), `scripts/smoke-stripe-webhook.ts` (`sessionEvent` fixture :54-72, new section after the async-fulfil check at :693)
- Modify: `docs/RUNBOOK.md` — new "Refund or chargeback" section before "## Rotate a secret" (:48)

**Interfaces:**
- Consumes from Task 2: `ChargePurpose`, `revocationPaymentIntent`, mirror types `lifetime_revoked` / `subscription_revoked`, `DecideContext.chargePurpose`, `detail.paymentIntentId` on `cs:` bookings.
- Consumes: `setSubscriptionState(userId, mirror: SubscriptionMirror, opts?)` (`src/lib/user-settings.ts:217`), `getStripe()` and `LIFETIME_METADATA_KEY` / `LIFETIME_METADATA_VALUE` (`src/lib/stripe.ts:33-34, 83`).
- Produces:
  - `revokeLifetimePurchase(userId: string): Promise<boolean>` in `src/lib/user-settings.ts`
  - `type ChargePurposeLookups = { lifetimeOnLedger(pi: string): Promise<boolean>; checkoutSessionPlan(pi: string): Promise<string | null>; hasInvoicePayment(pi: string): Promise<boolean> }`
  - `stripeChargePurposeLookups: ChargePurposeLookups`
  - `resolveChargePurpose(paymentIntentId: string | null, lookups?: ChargePurposeLookups): Promise<ChargePurpose>`

- [ ] **Step 1: Write the failing tests**

(a) In `scripts/smoke-stripe-revocation.ts`, add to the imports:

```ts
import {
  resolveChargePurpose,
  type ChargePurposeLookups,
} from "../src/lib/stripe-charge-purpose";
```

and insert this block immediately before `console.log("\nThe ledger invariant");`:

```ts
  console.log("\nResolving what a charge paid for (fake lookups)");
  function fakes(answers: { ledger?: boolean; plan?: string | null; invoice?: boolean }) {
    const calls: string[] = [];
    const lookups: ChargePurposeLookups = {
      async lifetimeOnLedger() { calls.push("ledger"); return answers.ledger ?? false; },
      async checkoutSessionPlan() { calls.push("session"); return answers.plan ?? null; },
      async hasInvoicePayment() { calls.push("invoice"); return answers.invoice ?? false; },
    };
    return { lookups, calls };
  }
  const none = fakes({});
  check("no payment intent → unknown, and nothing is asked",
    (await resolveChargePurpose(null, none.lookups)) === "unknown" && none.calls.length === 0);
  const onLedger = fakes({ ledger: true });
  check("a purchase on our own ledger is Lifetime without asking Stripe",
    (await resolveChargePurpose("pi_1", onLedger.lookups)) === "lifetime" && onLedger.calls.join() === "ledger",
    onLedger.calls.join());
  const oldPurchase = fakes({ plan: LIFETIME_METADATA_VALUE });
  check("an older purchase is found through its Checkout Session",
    (await resolveChargePurpose("pi_1", oldPurchase.lookups)) === "lifetime" && oldPurchase.calls.join() === "ledger,session");
  const subscription = fakes({ plan: null, invoice: true });
  check("a payment intent that paid an invoice is a subscription",
    (await resolveChargePurpose("pi_1", subscription.lookups)) === "subscription");
  check("nothing matches → unknown",
    (await resolveChargePurpose("pi_1", fakes({ plan: "something-else" }).lookups)) === "unknown");
  let propagated = false;
  await resolveChargePurpose("pi_1", {
    ...fakes({}).lookups,
    async checkoutSessionPlan() { throw new Error("stripe is down"); },
  }).catch(() => { propagated = true; });
  check("a lookup failure propagates (so the webhook 500s and Stripe retries)", propagated);
```

(b) In `scripts/smoke-stripe-webhook.ts`, in `sessionEvent` (:54-72) add `payment_intent: "pi_smoke_lifetime_1",` directly after `customer: "cus_smoke_1",`. Add this helper after `disputeEvent` (ends :175):

```ts
/** A charge on the Lifetime purchase's own payment intent. */
function lifetimeChargeEvent(over: Record<string, unknown>, eventId: string) {
  return {
    id: eventId,
    object: "event",
    type: "charge.refunded",
    created: 1_700_000_500,
    data: {
      object: {
        id: "ch_smoke_lt_1",
        object: "charge",
        customer: "cus_smoke_1",
        currency: "usd",
        payment_intent: "pi_smoke_lifetime_1",
        amount: 2500,
        amount_captured: 2500,
        amount_refunded: 0,
        refunded: false,
        // Unexpanded, as current API versions send it: revocation must not depend on it.
        refunds: { object: "list", data: [] },
        ...over,
      },
    },
  };
}
```

Then insert this section after the `check("the async fulfil event does not double-book the purchase", …)` call (:690-693) and before `/* ---- delivery telemetry ---- */`:

```ts
  /* ------------------------------------------------- refunds revoke ------------- */
  console.log("\nwithdraws Lifetime on a full refund, not a partial one");
  const lifetimeRow = (await ledgerFor(USER)).find((r) => r.kind === "lifetime");
  check(
    "the Lifetime booking remembers its payment intent",
    lifetimeRow?.detail?.paymentIntentId === "pi_smoke_lifetime_1",
    JSON.stringify(lifetimeRow?.detail)
  );
  await post(signedRequest(lifetimeChargeEvent({ amount_refunded: 1000 }, "evt_smoke_lt_partial")));
  check("a partial refund keeps Lifetime", (await lifetimeAt()) !== null);

  const fullRefund = lifetimeChargeEvent({ refunded: true, amount_refunded: 2500 }, "evt_smoke_lt_full");
  const refundRes = await post(signedRequest(fullRefund));
  check("full refund -> 200", refundRes.status === 200, String(refundRes.status));
  check("a full refund of the Lifetime charge withdraws Lifetime", (await lifetimeAt()) === null);
  const afterRefund = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("…so the account resolves to free", resolvePlan(afterRefund).plan === "free", resolvePlan(afterRefund).plan);
  const refundRetry = await post(signedRequest(fullRefund));
  check("a redelivered refund is harmless", refundRetry.status === 200 && (await lifetimeAt()) === null);

  console.log("\nwithdraws Lifetime on a lost dispute");
  const regrant = sessionEvent({ id: "cs_test_smoke_2", payment_intent: "pi_smoke_lifetime_2" }) as Record<string, unknown>;
  regrant.id = "evt_smoke_lt_regrant";
  await post(signedRequest(regrant));
  check("a second purchase grants Lifetime again", (await lifetimeAt()) !== null);
  const lost = await post(
    signedRequest(
      disputeEvent(
        "charge.dispute.closed",
        {
          id: "dp_smoke_lt",
          charge: "ch_smoke_lt_2",
          customer: "cus_smoke_1",
          payment_intent: "pi_smoke_lifetime_2",
          amount: 2500,
          status: "lost",
        },
        "evt_smoke_lt_dispute"
      )
    )
  );
  check("lost dispute -> 200", lost.status === 200, String(lost.status));
  check("a lost dispute on the Lifetime charge withdraws Lifetime", (await lifetimeAt()) === null);
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx scripts/smoke-stripe-revocation.ts`
Expected: exits nonzero with a module-not-found error for `../src/lib/stripe-charge-purpose`.

Run: `npx tsx scripts/smoke-stripe-webhook.ts`
Expected: `FAILED: Error: a full refund of the Lifetime charge withdraws Lifetime FAILED` (the route still ignores the revocation mirror), exit 1.

- [ ] **Step 3: Implement the revoke helper**

In `src/lib/user-settings.ts`, directly after `setLifetimePurchase` (ends :312), add:

```ts
/**
 * Withdraws a Lifetime purchase after a full refund or a lost dispute.
 *
 * Idempotent: Stripe retries, and a second revocation of an already-withdrawn grant is a
 * no-op. Comps are untouched — `comped_plan` outranks this column in `resolvePlan`, and an
 * operator's grant is not something a refund can take back. Queues no plan transition:
 * the celebration watcher only ever looks upward.
 *
 * Returns whether a grant was actually removed.
 */
export async function revokeLifetimePurchase(userId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(userSettings)
    .set({ lifetimePurchasedAt: null, updatedAt: new Date() })
    .where(
      and(eq(userSettings.userId, userId), isNotNull(userSettings.lifetimePurchasedAt))
    )
    .returning();
  return rows.length > 0;
}
```

(`and`, `eq`, `isNotNull` are already imported at :2.)

- [ ] **Step 4: Implement the resolver**

Create `src/lib/stripe-charge-purpose.ts`:

```ts
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { billingEvents } from "@/db/schema";
import type { ChargePurpose } from "@/lib/billing-stripe";
import {
  getStripe,
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
} from "@/lib/stripe";

/**
 * What a refunded or disputed charge originally paid for — the one fact the pure decision
 * in `billing-stripe.ts` needs before it can withdraw access, and cannot look up itself.
 *
 * A Charge on current Stripe API versions carries a `payment_intent` and no invoice. So:
 *
 *   1. Our own ledger. Every Lifetime `cs:` booking written since the refund work records
 *      its `paymentIntentId` in `detail` — free, and it covers every new purchase.
 *   2. The Checkout Session that created the payment intent. Covers Lifetime purchases
 *      booked before (1) existed; its `orbit_plan` metadata says what was bought.
 *   3. An invoice payment for the payment intent. Only Orbit Pro raises invoices, so any
 *      match is a subscription charge.
 *
 * Anything else — a manual charge made in the dashboard, say — is "unknown" and revokes
 * nothing. A lookup that throws propagates on purpose: the webhook answers 500 and Stripe
 * retries, rather than silently keeping a refunded buyer's access.
 *
 * No `next/server`: the webhook route and tsx scripts both import this.
 */
export type ChargePurposeLookups = {
  /** A Lifetime booking on our own ledger was paid with this payment intent. */
  lifetimeOnLedger(paymentIntentId: string): Promise<boolean>;
  /** `orbit_plan` metadata of the Checkout Session that created this payment intent. */
  checkoutSessionPlan(paymentIntentId: string): Promise<string | null>;
  /** This payment intent paid an invoice. */
  hasInvoicePayment(paymentIntentId: string): Promise<boolean>;
};

export const stripeChargePurposeLookups: ChargePurposeLookups = {
  async lifetimeOnLedger(paymentIntentId) {
    const db = await getDb();
    const rows = await db
      .select({ id: billingEvents.id })
      .from(billingEvents)
      .where(
        and(
          eq(billingEvents.source, "stripe"),
          eq(billingEvents.kind, "lifetime"),
          sql`${billingEvents.detail}->>'paymentIntentId' = ${paymentIntentId}`
        )
      )
      .limit(1);
    return rows.length > 0;
  },
  async checkoutSessionPlan(paymentIntentId) {
    const page = await getStripe().checkout.sessions.list({
      payment_intent: paymentIntentId,
      limit: 1,
    });
    return page.data[0]?.metadata?.[LIFETIME_METADATA_KEY] ?? null;
  },
  async hasInvoicePayment(paymentIntentId) {
    const page = await getStripe().invoicePayments.list({
      payment: { type: "payment_intent", payment_intent: paymentIntentId },
      limit: 1,
    });
    return page.data.length > 0;
  },
};

export async function resolveChargePurpose(
  paymentIntentId: string | null,
  lookups: ChargePurposeLookups = stripeChargePurposeLookups
): Promise<ChargePurpose> {
  if (!paymentIntentId) return "unknown";
  if (await lookups.lifetimeOnLedger(paymentIntentId)) return "lifetime";
  const plan = await lookups.checkoutSessionPlan(paymentIntentId);
  if (plan === LIFETIME_METADATA_VALUE) return "lifetime";
  if (await lookups.hasInvoicePayment(paymentIntentId)) return "subscription";
  return "unknown";
}
```

- [ ] **Step 5: Wire it into the driver**

In `src/app/api/webhooks/stripe/route.ts`, replace the import block `import { findUserIdByStripeCustomerId, setLifetimePurchase, setSubscriptionState } from "@/lib/user-settings";` (:7-11) with:

```ts
import {
  findUserIdByStripeCustomerId,
  revokeLifetimePurchase,
  setLifetimePurchase,
  setSubscriptionState,
} from "@/lib/user-settings";
```

replace the `@/lib/billing-stripe` import (:17-21) with:

```ts
import {
  decideStripeEvent,
  revocationPaymentIntent,
  stripeEventSubject,
  type DecideContext,
} from "@/lib/billing-stripe";
import { resolveChargePurpose } from "@/lib/stripe-charge-purpose";
```

Replace the block from `const now = new Date();` (:130) through the end of the `recordWebhookDelivery({...})` call inside the `try` (:185) with:

```ts
    const now = new Date();
    const userId = await attribute(event);
    const beforeCents = userId ? await readBeforeCents(userId, now) : 0;
    // Only a full refund or a lost dispute can withdraw access, and only those need to know
    // what the charge paid for — so the lookup (ledger first, then Stripe) runs for nothing
    // else. A lookup that throws lands in the catch below: 500, and Stripe retries.
    const revocationPi = userId ? revocationPaymentIntent(event) : null;
    const chargePurpose = revocationPi
      ? await resolveChargePurpose(revocationPi)
      : undefined;
    const ctx: DecideContext = {
      userId,
      beforeCents,
      // Only consulted when there is nothing to lose by asking: a 0-to-positive move is
      // the sole case where new and reactivation differ.
      hadPriorRevenue:
        userId && beforeCents === 0 ? await hasPriorRevenue(userId) : false,
      now,
      chargePurpose,
    };

    const decision = decideStripeEvent(event, ctx);

    if (decision.mirror?.type === "lifetime") {
      // Idempotent by design: Stripe retries for up to three days, and both fulfil event
      // types fire for the same session. `setLifetimePurchase` keeps the first timestamp.
      await setLifetimePurchase(decision.mirror.userId, {
        stripeCustomerId: decision.mirror.stripeCustomerId,
      });
    } else if (decision.mirror?.type === "subscription") {
      await setSubscriptionState(
        decision.mirror.userId,
        {
          plan: decision.mirror.plan,
          status: decision.mirror.status,
          periodEnd: decision.mirror.periodEnd,
          monthlyCents: decision.mirror.monthlyCents,
          interval: decision.mirror.interval,
        },
        { stripeCustomerId: decision.mirror.stripeCustomerId }
      );
    } else if (decision.mirror?.type === "lifetime_revoked") {
      await revokeLifetimePurchase(decision.mirror.userId);
    } else if (decision.mirror?.type === "subscription_revoked") {
      // monthlyCents and interval are omitted, so the stored price stays for display;
      // status canceled + a period end of now is what drops `resolvePlan` to free.
      await setSubscriptionState(decision.mirror.userId, {
        plan: "orbit",
        status: "canceled",
        periodEnd: decision.mirror.periodEnd,
      });
    }

    for (const booking of decision.bookings) {
      await recordBillingEvent({ source: "stripe", ...booking });
    }

    if (decision.outcome === "ignored" && decision.reason === "missing_user_id") {
      console.error(
        `Stripe ${event.type} (${event.id}) could not be attributed to a user.`
      );
    }

    const revoked =
      decision.mirror?.type === "lifetime_revoked" ||
      decision.mirror?.type === "subscription_revoked"
        ? decision.mirror.reason
        : null;
    await recordWebhookDelivery({
      source: "stripe",
      eventId: event.id,
      eventType: event.type,
      outcome: decision.outcome,
      reason: decision.reason ?? null,
      targetUserId: decision.targetUserId,
      resourceId: decision.resourceId,
      detail: {
        bookings: decision.bookings.length,
        ...(chargePurpose ? { chargePurpose } : {}),
        ...(revoked ? { revoked } : {}),
      },
      durationMs: Date.now() - startedAt,
    });
```

- [ ] **Step 6: Say it in the runbook**

In `docs/RUNBOOK.md`, insert before `## Rotate a secret` (:48):

```markdown
## Refund or chargeback

A **full** refund in Stripe, or a dispute that closes **lost**, withdraws access by itself:
Lifetime is cleared, a Pro subscription is marked canceled as of that moment (the webhook
resolves which one through the charge's payment intent). A partial refund changes nothing.
When refunding a Pro charge, **also cancel the subscription in Stripe** — otherwise its
next renewal re-grants Pro, correctly, because the customer is being charged again.
`/admin/health` → webhook deliveries shows `revoked: refund` / `revoked: dispute_lost` in
the delivery detail when it happened.
```

- [ ] **Step 7: Run them and watch them pass**

Run: `npx tsx scripts/smoke-stripe-revocation.ts && npx tsx scripts/smoke-stripe-webhook.ts && npx tsx scripts/smoke-webhook-guard.ts`
Expected: all checks `ok`; `All Stripe revocation checks passed.`, `All Stripe webhook checks passed.`; exit 0. No network is touched: the partial refund needs no lookup, and both revocations resolve from the ledger.

- [ ] **Step 8: Typecheck, lint**

Run: `npm run typecheck && npm run lint`
Expected: exit 0, 0 lint errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/stripe-charge-purpose.ts src/lib/user-settings.ts src/app/api/webhooks/stripe/route.ts scripts/smoke-stripe-revocation.ts scripts/smoke-stripe-webhook.ts docs/RUNBOOK.md
git commit -m "$(cat <<'EOF'
Withdraw Lifetime or Pro when a charge is refunded in full or a dispute is lost

The webhook resolves what the charge paid for (our ledger, then the Checkout
Session, then an invoice payment) and applies the pure decision: Lifetime is
cleared, a subscription is canceled as of now. Partial refunds and won
disputes change nothing, and a failed lookup 500s so Stripe retries.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Orbit never emails a prospect it invented (A7)

**Files:**
- Modify: `src/lib/outreach-quality.ts` (whole file, 112 lines: new helpers, `isDemo` row field, `demo_prospect` code)
- Modify: `src/lib/apollo.ts:309-314` (`mockDomain`)
- Modify: `src/lib/outreach-send.ts:83-98` (placeholder-address guard at the top of `sendOutreachMessage`)
- Modify: `src/actions/outreach.ts` — import (:44), search status (:370), send action (:1037-1122), preview rows (:1147-1156), bulk loop call (:1197), `saveProspectAsContact` (:1236-1249)
- Modify: `src/components/outreach/outreach-actions.tsx:97-108` (`handleSend`)
- Create: `scripts/smoke-outreach-guards.ts`; Modify: `scripts/run-smoke.ts` (pglite section)

**Interfaces:**
- Produces in `src/lib/outreach-quality.ts`: `isDemoProspect(enrichment: unknown): boolean`, `isPlaceholderAddress(email: string | null | undefined): boolean`, `prospectSearchStatus(input: { matchesOrg: boolean; isDemo: boolean }): "selected" | "suggested" | "excluded"`, `DEMO_PROSPECT_SEND_MESSAGE`, `PLACEHOLDER_ADDRESS_SEND_MESSAGE`, `QualityGateRow.isDemo?: boolean`, issue code `"demo_prospect"` (blocking).
- Changes: `sendOutreachMessageAction(messageId)` now returns `ActionResult<OutreachMessage>` (`{ ok: true, value } | { ok: false, error }`) so the refusal copy survives production; the throwing body moves to a non-exported `sendOutreachMessageNow(messageId)` that `bulkSendOutreach` keeps calling. Only caller outside the module: `outreach-actions.tsx`.
- Consumed by Task 5 (preview rows) and Task 14 (outreach-send).

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-outreach-guards.ts`:

```ts
/**
 * Pins the guards that stop Orbit emailing people who do not exist (audit A7).
 *
 * Without an Apollo key, `searchPeople` invents sample prospects. They used to get the
 * model-guessed REAL company domain (alex.chen@capitalone.com), were stored pre-selected,
 * and nothing on the send paths looked at `enrichment.demo`. Runs the real server actions
 * as demo mode's `demo-user`, like smoke-follow-up-actions.
 *
 * Run: npx tsx scripts/smoke-outreach-guards.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { outreachCampaigns, outreachMessages, outreachProspects, userSettings } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import {
  DEMO_PROSPECT_SEND_MESSAGE,
  PLACEHOLDER_ADDRESS_SEND_MESSAGE,
  isPlaceholderAddress,
  prospectSearchStatus,
} from "../src/lib/outreach-quality";
import { sendOutreachMessage } from "../src/lib/outreach-send";
import { bulkSendOutreach, searchProspects, sendOutreachMessageAction } from "../src/actions/outreach";
import type { AudienceFilters } from "../src/db/schema";

// FIRST, so no run of this script — including the failing one — can reach a real inbox:
// with no key anywhere, a send that slips past a guard fails on "not configured".
delete process.env.RESEND_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.APOLLO_API_KEY; // forces the demo prospect search
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
process.env.ORBIT_DEMO_DATA = "off";
(process.env as Record<string, string>).NODE_ENV = "development";

const USER = "demo-user";
const OTHER = "smoke-outreach-other-tenant";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** `revalidatePath` throws outside a request, after the action's writes have landed. */
async function outsideRequest<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof Error && err.message.includes("static generation store")) return undefined;
    throw err;
  }
}

async function cleanup() {
  const db = await getDb();
  // Prospects and messages cascade from the campaign.
  await db.delete(outreachCampaigns).where(inArray(outreachCampaigns.userId, [USER, OTHER]));
  await db.delete(userSettings).where(inArray(userSettings.userId, [USER, OTHER]));
}

async function seedCampaign(userId: string, name: string, filters: AudienceFilters) {
  const db = await getDb();
  const [campaign] = await db
    .insert(outreachCampaigns)
    .values({ userId, name, audienceQuery: "recruiters at Capital One", audienceFilters: filters, status: "active" })
    .returning();
  return campaign;
}

async function seedProspectWithMessage(
  campaignId: string,
  p: { externalId: string; fullName: string; email: string; status: string; enrichment: Record<string, unknown>; subject?: string; body?: string }
) {
  const db = await getDb();
  const first = p.fullName.split(" ")[0];
  const [prospect] = await db
    .insert(outreachProspects)
    .values({ campaignId, externalId: p.externalId, fullName: p.fullName, email: p.email, status: p.status, enrichment: p.enrichment })
    .returning();
  const [message] = await db
    .insert(outreachMessages)
    .values({
      prospectId: prospect.id,
      channel: "email",
      subject: p.subject ?? `Quick question, ${first}`,
      body: p.body ?? `Hi ${first}, I saw your work on the platform team and wanted to ask how you hire for it.`,
      status: "generated",
    })
    .returning();
  return { prospect, message };
}

run(async () => {
  await cleanup();
  await ensureUserSettings(USER);
  const db = await getDb();

  console.log("Sample search results are never pre-selected, and never at a real domain");
  const campaign = await seedCampaign(USER, "Smoke guards", {
    organizationNames: ["Capital One"],
    organizationDomains: ["capitalone.com"],
  });
  await outsideRequest(searchProspects(campaign.id));
  const found = await db.query.outreachProspects.findMany({ where: eq(outreachProspects.campaignId, campaign.id) });
  check("the sample search produced prospects", found.length > 0, String(found.length));
  check("none is selected", found.every((p) => p.status !== "selected"), found.map((p) => p.status).join(","));
  check("every one is marked demo", found.every((p) => (p.enrichment as { demo?: unknown } | null)?.demo === true));
  check(
    "every address is at a reserved example domain",
    found.every((p) => !p.email || isPlaceholderAddress(p.email)),
    found.map((p) => p.email).join(",")
  );
  check("prospectSearchStatus: a matching sample is suggested", prospectSearchStatus({ matchesOrg: true, isDemo: true }) === "suggested");
  check("prospectSearchStatus: a matching real prospect is selected", prospectSearchStatus({ matchesOrg: true, isDemo: false }) === "selected");
  check("prospectSearchStatus: a company mismatch is excluded", prospectSearchStatus({ matchesOrg: false, isDemo: false }) === "excluded");
  check("isPlaceholderAddress: a real domain is not a placeholder", !isPlaceholderAddress("jordan@capitalone.com"));
  check("isPlaceholderAddress: .test and example.org are", isPlaceholderAddress("a@b.test") && isPlaceholderAddress("a@example.org"));

  console.log("\nA sample prospect cannot be emailed, one at a time or in bulk");
  // The exact shape already in production: demo, selected, at a real company domain.
  const legacy = await seedProspectWithMessage(campaign.id, {
    externalId: "demo-legacy-1",
    fullName: "Alex Chen",
    email: "alex.chen@capitalone.com",
    status: "selected",
    enrichment: { demo: true },
  });
  const single = await sendOutreachMessageAction(legacy.message.id).catch((err: unknown) => ({
    ok: false as const,
    error: `threw: ${String(err)}`,
  }));
  check(
    "the single send refuses with the sample-prospect copy",
    single.ok === false && single.error === DEMO_PROSPECT_SEND_MESSAGE,
    JSON.stringify(single)
  );
  const afterSingle = await db.query.outreachMessages.findFirst({ where: eq(outreachMessages.id, legacy.message.id) });
  check("…and leaves the draft untouched (not sent, not failed)", afterSingle?.status === "generated", String(afterSingle?.status));
  const bulk = await outsideRequest(
    bulkSendOutreach({ campaignId: campaign.id, messageIds: [legacy.message.id], ignoreWarnings: true })
  );
  check(
    "the bulk send is blocked with the same reason",
    bulk?.status === "blocked" && bulk.reason.includes(DEMO_PROSPECT_SEND_MESSAGE),
    JSON.stringify(bulk)
  );

  console.log("\nA placeholder address is refused below the actions too");
  const direct = await sendOutreachMessage({
    userId: USER,
    channel: "email",
    toEmail: "someone@acme.example.com",
    subject: "Hi",
    body: "Hello",
  }).then(
    () => "sent",
    (err: unknown) => (err instanceof Error ? err.message : String(err))
  );
  check("sendOutreachMessage refuses an example.com address", direct === PLACEHOLDER_ADDRESS_SEND_MESSAGE, direct);

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll outreach guard checks passed.");
});
```

- [ ] **Step 2: Register it** — in `scripts/run-smoke.ts` pglite block, after `"smoke-migration-guards": "pglite", // …`, add `  "smoke-outreach-guards": "pglite",`.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx scripts/smoke-outreach-guards.ts`
Expected: `FAIL none is selected` (the sample search still pre-selects), then the run aborts with `TypeError: … isPlaceholderAddress is not a function` because the helpers do not exist yet; exit 1. No email can be sent: every provider key is deleted first.

- [ ] **Step 4: Implement the pure guards**

In `src/lib/outreach-quality.ts`, after the `import` line add:

```ts
/** Prospects Orbit invented because no Apollo key was available (`enrichment.demo`). */
export function isDemoProspect(enrichment: unknown): boolean {
  return Boolean(
    enrichment &&
      typeof enrichment === "object" &&
      (enrichment as Record<string, unknown>).demo === true
  );
}

/**
 * Domains reserved so that nobody can receive mail there (RFC 2606, RFC 6761). Sample
 * prospects live under example.com, so this is also the last line of defence for a sample
 * whose `demo` flag was lost on the way to a contact.
 */
export function isPlaceholderAddress(email: string | null | undefined): boolean {
  const domain = email?.trim().toLowerCase().split("@")[1] ?? "";
  if (!domain) return false;
  return (
    /(^|\.)example\.(com|net|org)$/.test(domain) ||
    /\.(example|test|invalid|localhost)$/.test(domain)
  );
}

export const DEMO_PROSPECT_SEND_MESSAGE =
  "This is a sample prospect Orbit made up, so there’s no real inbox to send to";
export const PLACEHOLDER_ADDRESS_SEND_MESSAGE =
  "That’s a placeholder address, so there’s no real inbox to send to";

/**
 * Where a searched prospect lands. "selected" is the queue drafts and sends work from, so a
 * sample is never put there — someone has to pick it by hand, and even then it cannot send.
 */
export function prospectSearchStatus(input: {
  matchesOrg: boolean;
  isDemo: boolean;
}): "selected" | "suggested" | "excluded" {
  if (!input.matchesOrg) return "excluded";
  return input.isDemo ? "suggested" : "selected";
}
```

In `QualityGateRow` add `  isDemo?: boolean;` after `body: string;`. In `QualityIssue["code"]` add `| "demo_prospect"`. In `assessOutreachQuality`, as the first statement inside `for (const row of rows) {`, add:

```ts
    if (row.isDemo) {
      issues.push({
        messageId: row.messageId,
        prospectId: row.prospectId,
        prospectName: row.prospectName,
        code: "demo_prospect",
        message: DEMO_PROSPECT_SEND_MESSAGE,
      });
    }
```

and change `const blockingCodes = new Set(["empty_body", "empty_subject"]);` to `const blockingCodes = new Set(["empty_body", "empty_subject", "demo_prospect"]);`.

- [ ] **Step 5: Samples live under example.com**

In `src/lib/apollo.ts`, replace `mockDomain` (:309-314) with:

```ts
/**
 * A sample prospect's email domain — ALWAYS under example.com, which is reserved so mail to
 * it can never be delivered. This used to return the real organisation domain from the
 * audience filters (capitalone.com), turning every sample into a plausible stranger.
 */
function mockDomain(filters: AudienceFilters, company: string) {
  const base =
    filters.organizationDomains?.[0]?.trim().replace(/^www\./, "").split(".")[0] || company;
  const label = base.toLowerCase().replace(/[^a-z0-9]+/g, "") || "demo";
  return `${label}.example.com`;
}
```

- [ ] **Step 6: The lib send refuses placeholder addresses**

In `src/lib/outreach-send.ts`, add imports:

```ts
import { UserFacingError } from "@/lib/errors";
import { isPlaceholderAddress, PLACEHOLDER_ADDRESS_SEND_MESSAGE } from "@/lib/outreach-quality";
```

and in `sendOutreachMessage`, directly after the `linkedin` guard (:91-93), add:

```ts
  // Every caller (campaign sends, contact follow-ups) passes through here, so a sample's
  // example.com address is refused even after it was copied onto a contact.
  if (input.channel === "email" && isPlaceholderAddress(input.toEmail)) {
    throw new UserFacingError(PLACEHOLDER_ADDRESS_SEND_MESSAGE);
  }
```

- [ ] **Step 7: The actions refuse samples**

In `src/actions/outreach.ts`:

(a) Replace the import at :34 `import { assessOutreachQuality } from "@/lib/outreach-quality";` with:

```ts
import {
  assessOutreachQuality,
  DEMO_PROSPECT_SEND_MESSAGE,
  isDemoProspect,
  prospectSearchStatus,
} from "@/lib/outreach-quality";
```

and change `import { friendlyError, UserFacingError } from "@/lib/errors";` (:44) to `import { asActionResult, friendlyError, UserFacingError } from "@/lib/errors";`.

(b) In `searchProspects`, replace `const status = matchesOrg ? "selected" : "excluded";` (:370) with:

```ts
    const isDemo = source === "demo" || Boolean(prospect.enrichment?.demo);
    const status = prospectSearchStatus({ matchesOrg, isDemo });
```

and replace both `demo: source === "demo" || Boolean(prospect.enrichment?.demo),` lines in the insert and the `onConflictDoUpdate` set with `demo: isDemo,`.

(c) Replace the first lines of the single-send action (:1037-1052, from `export async function sendOutreachMessageAction(messageId: string) {` through the ownership `throw new Error("Message not found");` and its closing `}`) with:

```ts
/**
 * Returns the refusal as data: a thrown message is a digest in production, and "this is a
 * sample prospect" is exactly the sentence the person needs to read.
 */
export async function sendOutreachMessageAction(messageId: string) {
  return asActionResult(() => sendOutreachMessageNow(messageId));
}

/** The send itself. Throws; `bulkSendOutreach` catches per message. */
async function sendOutreachMessageNow(messageId: string) {
  const userId = await requireOutreachUser();
  const db = await getDb();

  const message = await db.query.outreachMessages.findFirst({
    where: eq(outreachMessages.id, messageId),
    with: {
      prospect: {
        with: { campaign: true },
      },
    },
  });

  if (!message || message.prospect.campaign.userId !== userId) {
    throw new Error("Message not found");
  }

  // Before anything else, and outside the try below: a refusal is not a failed send, so
  // the draft must not be marked "failed".
  if (isDemoProspect(message.prospect.enrichment)) {
    throw new UserFacingError(DEMO_PROSPECT_SEND_MESSAGE);
  }
```

The rest of the old body (from `const quality = assessOutreachQuality([` to the final `}`) is unchanged; inside that `assessOutreachQuality([{ … }])` call add `isDemo: false,` after `body: message.body,` (samples already returned above).

(d) In `previewBulkSendQuality`, inside the `messages.map((m) => ({ … }))`, add `isDemo: isDemoProspect(m.prospect.enrichment),` after `body: m.body,`.

(e) In `bulkSendOutreach`'s loop, replace `await sendOutreachMessageAction(messageId);` with `await sendOutreachMessageNow(messageId);`.

(f) In `saveProspectAsContact`, replace the block from `let email = prospect.email;` through the closing `}` of `if (!email || !phone) { … }` (:1236-1249) with:

```ts
  // A sample's email, phone and profile URL were made up: never copy them into the network.
  const demo = isDemoProspect(prospect.enrichment);
  let email = demo ? null : prospect.email;
  let phone = demo ? null : prospect.phone;

  if (!demo && (!email || !phone)) {
    const enriched = await enrichPerson(userId, prospect.externalId, {
      email: prospect.email ?? undefined,
      linkedinUrl: prospect.linkedinUrl ?? undefined,
      fullName: prospect.fullName,
    });
    if (enriched) {
      email = email || enriched.email;
      phone = phone || enriched.phone;
    }
  }
```

and in the `createContact({ … })` call below it change `linkedinUrl: prospect.linkedinUrl ?? undefined,` to `linkedinUrl: demo ? undefined : (prospect.linkedinUrl ?? undefined),`.

- [ ] **Step 8: The client reads the result**

In `src/components/outreach/outreach-actions.tsx`, replace the body of `handleSend` (:97-108) with:

```ts
  function handleSend() {
    start(async () => {
      try {
        const res = await sendOutreachMessageAction(messageId);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(`${channelLabel(channel)} sent`);
        setDangerOpen(false);
        refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.sendFailed));
      }
    });
  }
```

- [ ] **Step 9: Run it and watch it pass**

Run: `npx tsx scripts/smoke-outreach-guards.ts`
Expected: every line `ok`, `All outreach guard checks passed.`, exit 0.

- [ ] **Step 10: Typecheck, lint, voice, manifest**

Run: `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts && npx tsx scripts/run-smoke.ts --check`
Expected: exit 0, 0 lint errors, `every message follows the house voice`.

- [ ] **Step 11: Commit**

```bash
git add src/lib/outreach-quality.ts src/lib/apollo.ts src/lib/outreach-send.ts src/actions/outreach.ts src/components/outreach/outreach-actions.tsx scripts/smoke-outreach-guards.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Refuse to send outreach to sample prospects Orbit invented

Samples now live under example.com, are never stored pre-selected, are
blocked on the single and bulk send paths (the refusal comes back as data so
it reads in production), and a placeholder address is refused in the shared
send function. Saving a sample as a contact no longer copies its fake details.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The bulk-send preview reads only the campaign's own messages (A8b)

**Files:**
- Modify: `src/actions/outreach.ts` — `previewBulkSendQuality` (:1135-1157) and the id list in `bulkSendOutreach` (:1192)
- Modify: `scripts/smoke-outreach-guards.ts` (new section before the final `await cleanup();`)

**Interfaces:** Consumes Task 4's `isDemoProspect` preview mapping. Produces a non-exported `campaignMessages(campaignId: string, messageIds: string[])` in `src/actions/outreach.ts` (non-exported async functions are allowed in a `"use server"` file — `requireCampaign` at :46 is one). `previewBulkSendQuality`'s signature and return type are unchanged.

- [ ] **Step 1: Write the failing test**

In `scripts/smoke-outreach-guards.ts`, add `previewBulkSendQuality` to the `../src/actions/outreach` import, and insert before the final `await cleanup();`:

```ts
  console.log("\nThe bulk-send preview only reads this campaign's messages");
  await ensureUserSettings(OTHER);
  const victimCampaign = await seedCampaign(OTHER, "Someone else's campaign", {});
  // Empty subject and body: had the preview read this row, it would come back blocking.
  const victim = await seedProspectWithMessage(victimCampaign.id, {
    externalId: "victim-1",
    fullName: "Victoria Private",
    email: "victoria@private.example.com",
    status: "selected",
    enrichment: {},
    subject: "",
    body: "",
  });
  const leaked = await previewBulkSendQuality({ campaignId: campaign.id, messageIds: [victim.message.id] });
  check("another tenant's message id yields nothing", leaked.issues.length === 0, JSON.stringify(leaked));
  check("…and never names their prospect", !JSON.stringify(leaked).includes("Victoria"));

  const sibling = await seedCampaign(USER, "Sibling campaign", {});
  const siblingMsg = await seedProspectWithMessage(sibling.id, {
    externalId: "sibling-1",
    fullName: "Sam Sibling",
    email: "sam@sibling.example.com",
    status: "selected",
    enrichment: {},
    subject: "",
    body: "",
  });
  const scoped = await previewBulkSendQuality({ campaignId: campaign.id, messageIds: [siblingMsg.message.id] });
  check("a message from another of your own campaigns is out of scope too", scoped.issues.length === 0, JSON.stringify(scoped));
  // A sendable draft (passes quality) in the sibling campaign: if the bulk loop reached it,
  // its send would be refused (placeholder address) and mark it "failed".
  const sendable = await seedProspectWithMessage(sibling.id, {
    externalId: "sibling-2",
    fullName: "Sasha Sibling",
    email: "sasha@sibling.example.org",
    status: "selected",
    enrichment: {},
  });
  await outsideRequest(
    bulkSendOutreach({ campaignId: campaign.id, messageIds: [sendable.message.id], ignoreWarnings: true })
  );
  const sendableAfter = await db.query.outreachMessages.findFirst({ where: eq(outreachMessages.id, sendable.message.id) });
  check("…and bulk send under this campaign never touches it", sendableAfter?.status === "generated", String(sendableAfter?.status));
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-outreach-guards.ts`
Expected: `FAIL another tenant's message id yields nothing` (two issues naming Victoria come back), `FAIL a message from another of your own campaigns is out of scope too`, and `FAIL …and bulk send under this campaign never touches it` (the sendable sibling draft ends `failed` — the loop reached it); exit 1.

- [ ] **Step 3: Implement**

In `src/actions/outreach.ts`, replace `previewBulkSendQuality` (:1135-1157) with:

```ts
/**
 * The requested messages that belong to this campaign — and so, because the campaign was
 * already checked against the caller, to this user. An id from anywhere else is dropped
 * silently rather than refused, so the answer cannot confirm that a guessed id exists.
 */
async function campaignMessages(campaignId: string, messageIds: string[]) {
  if (messageIds.length === 0) return [];
  const db = await getDb();
  return db.query.outreachMessages.findMany({
    where: and(
      inArray(outreachMessages.id, messageIds),
      inArray(
        outreachMessages.prospectId,
        db
          .select({ id: outreachProspects.id })
          .from(outreachProspects)
          .where(eq(outreachProspects.campaignId, campaignId))
      )
    ),
    with: { prospect: true },
  });
}

export async function previewBulkSendQuality(input: {
  campaignId: string;
  messageIds: string[];
}) {
  const userId = await requireOutreachUser();
  await requireCampaign(userId, input.campaignId);

  const messages = await campaignMessages(input.campaignId, input.messageIds);

  return assessOutreachQuality(
    messages.map((m) => ({
      messageId: m.id,
      prospectId: m.prospectId,
      prospectName: m.prospect.fullName,
      channel: m.channel as OutreachChannel,
      subject: m.subject,
      body: m.body,
      isDemo: isDemoProspect(m.prospect.enrichment),
    }))
  );
}
```

In `bulkSendOutreach`, replace `const ids = input.messageIds.slice(0, BULK_SEND_LIMIT);` (:1192) with:

```ts
  // Same scope as the preview above: only this campaign's messages are ever sent from here.
  const inCampaign = new Set(
    (await campaignMessages(input.campaignId, input.messageIds)).map((m) => m.id)
  );
  const ids = input.messageIds.filter((id) => inCampaign.has(id)).slice(0, BULK_SEND_LIMIT);
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-outreach-guards.ts`
Expected: all `ok`, `All outreach guard checks passed.`, exit 0.

- [ ] **Step 5: Typecheck, lint**

Run: `npm run typecheck && npm run lint`
Expected: exit 0, 0 lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/actions/outreach.ts scripts/smoke-outreach-guards.ts
git commit -m "$(cat <<'EOF'
Scope the bulk-send preview and send to the campaign's own messages

previewBulkSendQuality loaded messages by id alone, so a leaked message UUID
returned another user's prospect name, subject and body facts. Both the
preview and the bulk loop now only see messages whose prospect belongs to the
already-authorised campaign.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: A rollback stays green and never downgrades the schema version (A5)

**Files:**
- Modify: `src/lib/health.ts` — header (:9-22), `HealthReport.schema` (:35), `checkHealth` probe block and report (:116-136)
- Modify: `src/db/index.ts` — `schemaIsCurrent` (:1757-1782) and `recordSchemaVersion` (:1807-1818). Logic only; no DDL, no version bump.
- Modify: `scripts/smoke-health.ts` (:49-50 and after), `scripts/smoke-scale-schema.ts` (:333-336)
- Modify: `docs/RUNBOOK.md` "## Roll back" (:22-25)

**Interfaces:** `HealthReport.schema` becomes `{ expected: number; recorded: number | null; ahead: boolean }` (only consumer: `src/app/api/health/route.ts:13`, which passes the report through). `schemaIsCurrent(run)` returns true for `recorded >= SCHEMA_VERSION`. `recordSchemaVersion(run)` never lowers the stored version. `HealthReason` is unchanged (`"schema_mismatch"` now means *behind* only).

Trade-off, stated so a reviewer can reject it: treating "ahead" as current means a local PGlite once migrated by a newer branch skips a sweep when an older branch runs on it. Build-time `scripts/migrate.ts` still runs `schemaCoverage()` regardless of the recorded number, so production cannot deploy with a missing column; the dev case is recovered by deleting `.data/pglite`.

- [ ] **Step 1: Write the failing tests**

In `scripts/smoke-health.ts`, replace the `behind` check (:49-50) with:

```ts
  const behind = await checkHealth({ deep: false, probeDb: async () => ({ recorded: SCHEMA_VERSION - 1 }) });
  check("a schema behind the code → 503 with schema_mismatch", behind.status === "down" && behind.db.reason === "schema_mismatch", JSON.stringify(behind));

  const unrecorded = await checkHealth({ deep: false, probeDb: async () => ({ recorded: null }) });
  check("no recorded version → 503 with schema_mismatch", unrecorded.httpStatus === 503 && unrecorded.db.reason === "schema_mismatch", JSON.stringify(unrecorded));

  // A rollback: a newer deployment migrated the database, older code is serving. The monitor
  // and the ops scheduler both key on HTTP 200, so this must not read as "down".
  const ahead = await checkHealth({ deep: false, probeDb: async () => ({ recorded: SCHEMA_VERSION + 1 }) });
  check("a schema AHEAD of the code (a rollback) → HTTP 200, status degraded",
    ahead.httpStatus === 200 && ahead.status === "degraded" && ahead.db.reason === null && ahead.schema.ahead === true, JSON.stringify(ahead));
  const aheadDeep = await checkHealth({ deep: true, probeDb: async () => ({ recorded: SCHEMA_VERSION + 1 }) });
  check("…and the deep view stays degraded, not ok", aheadDeep.httpStatus === 200 && aheadDeep.status === "degraded");
  check("a current schema is not marked ahead", shallow.schema.ahead === false);
```

In `scripts/smoke-scale-schema.ts`, replace :333-336 (the `UPDATE … SCHEMA_VERSION + 1` statement and the `"a version mismatch forces the full sweep"` check) with:

```ts
  await client.query(`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1} WHERE id = 1`);
  check("a database BEHIND this build forces the full sweep", !(await schemaIsCurrent(client.query.bind(client))));

  // A rollback: the database was migrated by a newer build and older code is serving. That
  // code must not re-run its older sweep inside a user request.
  await client.query(`UPDATE schema_migrations SET version = ${SCHEMA_VERSION + 1} WHERE id = 1`);
  check("a database AHEAD of this build is current (a rollback does not re-sweep)", await schemaIsCurrent(client.query.bind(client)));

  await recordSchemaVersion(client.query.bind(client));
  const kept = await client.query<{ version: number }>(`SELECT version FROM schema_migrations WHERE id = 1`);
  check(
    "recording an older build's version never lowers the stored one",
    Number(kept.rows[0]?.version) === SCHEMA_VERSION + 1,
    JSON.stringify(kept.rows)
  );
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx scripts/smoke-health.ts; npx tsx scripts/smoke-scale-schema.ts`
Expected: smoke-health prints `FAIL a schema AHEAD of the code (a rollback) → HTTP 200, status degraded` (it answers 503) and `FAIL a current schema is not marked ahead`; smoke-scale-schema prints `FAIL a database AHEAD of this build is current` and `FAIL recording an older build's version never lowers the stored one`; both exit 1.

- [ ] **Step 3: Implement health**

In `src/lib/health.ts`, in the header replace `(the database is unreachable, or the schema is behind the code)` with `(the database is unreachable, or the schema is BEHIND the code; a schema AHEAD of the code is a rollback and answers 200 "degraded", because promoting the previous deployment must not page and must not stop the scheduler)`.

Replace `schema: { expected: number; recorded: number | null };` (:35) with:

```ts
  /** `ahead` is a rollback: the database was migrated by a newer deployment than this one. */
  schema: { expected: number; recorded: number | null; ahead: boolean };
```

Replace :116-136 (from `let recorded: number | null = null;` through the closing `};` of `const report`) with:

```ts
  let recorded: number | null = null;
  let reason: HealthReason | null = null;
  let ahead = false;
  try {
    ({ recorded } = await withTimeout(probe(), timeoutMs));
    if (recorded === null || recorded < SCHEMA_VERSION) reason = "schema_mismatch";
    else if (recorded > SCHEMA_VERSION) ahead = true;
  } catch (err) {
    reason = err instanceof TimeoutError ? "db_timeout" : "db_error";
  }
  const latencyMs = reason === "db_error" || reason === "db_timeout" ? null : Date.now() - started;

  const report: HealthReport = {
    status: reason ? "down" : ahead ? "degraded" : "ok",
    httpStatus: reason ? 503 : 200,
    checkedAt: now.toISOString(),
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    builtAt: process.env.BUILD_TIME ?? null,
    env: process.env.VERCEL_ENV ?? null,
    schema: { expected: SCHEMA_VERSION, recorded, ahead },
    db: { ok: !reason || reason === "schema_mismatch", latencyMs, reason },
  };
```

(The deep block's final `if (degraded) report.status = "degraded";` only ever sets degraded, so an `ahead` report can never be promoted back to `ok`.)

- [ ] **Step 4: Implement the version functions**

In `src/db/index.ts`, replace the `schemaIsCurrent` doc comment and its return line:

```ts
/**
 * Whether the recorded schema version already covers this build.
 *
 * One SELECT standing in for the whole DDL sweep. AT OR ABOVE counts as current: above is a
 * rollback — a newer deployment migrated the database and this older one is serving — and
 * re-running the older sweep inside a user request would only cost time and then (before
 * `recordSchemaVersion` learned GREATEST) write the lower number back. Anything unexpected
 * (no table yet, a fresh database, a permissions problem) answers "no" and the caller does
 * the full pass — being wrong here costs a slow boot, never a wrong schema.
 */
```

and change `return Number(rows[0]?.version) === SCHEMA_VERSION;` to `return Number(rows[0]?.version) >= SCHEMA_VERSION;` (`Number(undefined)` is `NaN`, and `NaN >= n` is false, so a missing row still takes the sweep).

Replace the body of `recordSchemaVersion` (:1807-1818) with:

```ts
export async function recordSchemaVersion(run: StatementRunner) {
  try {
    // GREATEST: an older deployment (a rollback) must never lower the recorded version, or
    // the next boot of the newer code would re-sweep and health would flap.
    await run(
      `INSERT INTO schema_migrations (id, version, applied_at)
       VALUES (1, ${SCHEMA_VERSION}, now())
       ON CONFLICT (id) DO UPDATE
         SET version = GREATEST(schema_migrations.version, EXCLUDED.version),
             applied_at = CASE
               WHEN EXCLUDED.version > schema_migrations.version THEN EXCLUDED.applied_at
               ELSE schema_migrations.applied_at
             END`
    );
  } catch (err) {
    // A boot that cannot record its version just re-runs the idempotent sweep next time.
    console.error("[db] could not record schema version\n", err);
  }
}
```

In the `reconcileSchema` doc comment, change `A version mismatch — or any error reading it — takes the full pass.` to `A version behind this build — or any error reading it — takes the full pass; a version ahead of it (a rollback) is left alone.`

- [ ] **Step 5: Say what a rollback does**

In `docs/RUNBOOK.md`, replace the body of `## Roll back` (:24-25) with:

```markdown
Vercel → Deployments → the last good one → **Promote to Production**. Schema changes are
additive and idempotent, so old code runs fine on a newer schema. What happens next:

- `/api/health` answers **200 with `status: "degraded"`** and `schema.ahead: true` (the
  database was migrated by the newer build). The uptime monitor stays green and the `ops`
  workflow keeps running the sweep, the stalled-import job, the webhook drain and sync.
- The older code sees a recorded version at or above its own, so it does **not** re-run its
  schema sweep, and it never writes its lower number back.
- Nothing is undone: columns the newer build added stay, and old code ignores them.

Then fix forward. The next deploy from `main` carries a version at or above the recorded
one and health returns to `ok`. A **503 `schema_mismatch`** still means the database is
BEHIND the code — a build whose migration did not run — and is worth waking up for.
```

- [ ] **Step 6: Run them and watch them pass**

Run: `npx tsx scripts/smoke-health.ts && npx tsx scripts/smoke-scale-schema.ts && npx tsx scripts/smoke-migration-guards.ts`
Expected: `All health checks passed.`, `all checks passed`, migration guards green; exit 0.

- [ ] **Step 7: Typecheck, lint, schema coverage unchanged**

Run: `npm run typecheck && npm run lint && npx tsx scripts/smoke-schema-ddl.ts && git diff --stat origin/main -- src/db/schema.ts`
Expected: exit 0; smoke-schema-ddl passes without `--update`; the diff stat for `schema.ts` is empty.

- [ ] **Step 8: Commit**

```bash
git add src/lib/health.ts src/db/index.ts scripts/smoke-health.ts scripts/smoke-scale-schema.ts docs/RUNBOOK.md
git commit -m "$(cat <<'EOF'
Keep health green on a rollback and never lower the schema version

A promoted older deployment saw recorded > expected, answered 503, paged, and
stopped every scheduled job; then it re-swept and wrote its lower version back.
Health now treats "ahead" as 200 degraded, schemaIsCurrent accepts >=, and
recordSchemaVersion uses GREATEST. The runbook says what a rollback does.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The backup workflow fails loudly and pages (A1, code half)

**Files:**
- Modify: `.github/workflows/backup.yml` (whole file, 53 lines)
- Modify: `docs/RUNBOOK.md` — append a "Restore drill log" after "## Restore the database" (:56-68)
- Create: `scripts/smoke-backup-workflow.ts`; Modify: `scripts/run-smoke.ts` (pure section)

No script in `scripts/` reads `.github/` today (checked: no `readFileSync` of a workflow), so the smoke uses plain string positions — no YAML dependency. The secrets themselves and the drill are Manual steps M1/M2 at the end.

Three holes, all in this file: an empty `BACKUP_AGE_PUBLIC_KEY` surfaced as `age: unknown recipient type ""` and an empty `DATABASE_URL` as `pg_dump` trying a local socket; GitHub's default `bash -e` has no `pipefail`, so a failed `pg_dump` piped into `age` still produces (and would upload) an encrypted empty file; and nothing told anyone.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-backup-workflow.ts`:

```ts
/**
 * Pins the shape of `.github/workflows/backup.yml`, which failed on every run it ever had
 * (both secrets empty) while nothing said so (audit A1).
 *
 * Text positions on purpose: no YAML dependency, and what matters is ORDER — the secrets
 * guard must run before the dump, and the page must run when anything fails.
 *
 * Pure. Run: npx tsx scripts/smoke-backup-workflow.ts
 */
import { readFileSync } from "node:fs";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const src = readFileSync(".github/workflows/backup.yml", "utf8");

/** The text of the step starting at `at`, up to the next step. */
function stepAt(at: number): string {
  if (at < 0) return "";
  const next = src.indexOf("\n      - ", at + 1);
  return src.slice(at, next === -1 ? undefined : next);
}

const guardAt = src.indexOf("- name: Refuse to run without the backup secrets");
const installAt = src.indexOf("- name: Install pg_dump");
const dumpAt = src.indexOf("- name: Dump and encrypt");
const uploadAt = src.indexOf("- uses: actions/upload-artifact");
const pageAt = src.indexOf("- name: Page on a failed backup");
const guard = stepAt(guardAt);
const dump = stepAt(dumpAt);
const page = stepAt(pageAt);

console.log("The secrets are checked before anything else");
check("a guard step exists", guardAt !== -1);
check("…and runs before the install and the dump", guardAt < installAt && guardAt < dumpAt, `${guardAt} ${installAt} ${dumpAt}`);
check("…tests DATABASE_URL is non-empty", guard.includes('[ -n "$DATABASE_URL" ]'));
check("…tests BACKUP_AGE_PUBLIC_KEY is non-empty", guard.includes('[ -n "$BACKUP_AGE_PUBLIC_KEY" ]'));
check("…checks the key is an age recipient", guard.includes("age1*"));
check("…fails the job with a readable error", guard.includes("::error") && guard.includes("exit 1"));
check("…and actually receives both secrets", guard.includes("secrets.DATABASE_URL") && guard.includes("secrets.BACKUP_AGE_PUBLIC_KEY"));

console.log("\nA failed pg_dump cannot upload an empty encrypted file");
const pipefailAt = dump.indexOf("set -o pipefail");
check("the dump step sets pipefail before piping pg_dump into age", pipefailAt !== -1 && pipefailAt < dump.indexOf("pg_dump --format"));

console.log("\nAny failure pages #orbit-ops-critical");
check("a failure step exists", pageAt !== -1);
check("…gated on failure()", page.includes("if: failure()"));
check("…placed after the upload, so a missing artifact pages too", pageAt > uploadAt && uploadAt !== -1);
check("…posts to SLACK_OPS_CRITICAL_WEBHOOK_URL", page.includes("secrets.SLACK_OPS_CRITICAL_WEBHOOK_URL") && page.includes('"$SLACK_OPS_CRITICAL_WEBHOOK_URL"'));
check("…and skips quietly when the webhook is unset", page.includes('[ -z "$SLACK_OPS_CRITICAL_WEBHOOK_URL" ]') && page.includes("exit 0"));

console.log("\nThe schedule is unchanged");
check("still daily", src.includes('cron: "0 6 * * *"'));
check("still runnable by hand", src.includes("workflow_dispatch:"));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll backup-workflow checks passed.");
process.exit(0);
```

- [ ] **Step 2: Register it** — in `scripts/run-smoke.ts` pure block, after `"smoke-backdrop-filter": "pure",`, add `  "smoke-backup-workflow": "pure",`.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx scripts/smoke-backup-workflow.ts`
Expected: `FAIL a guard step exists`, `FAIL the dump step sets pipefail…`, `FAIL a failure step exists` and the checks under them; exit 1.

- [ ] **Step 4: Implement**

Replace `.github/workflows/backup.yml` with:

```yaml
# Daily logical backup of the production database, plus a button to take one on demand
# (run it before any risky migration).
#
# Neon's own point-in-time restore window on the free tier is short (verify it under
# Project → Settings; it has been 6 hours). This keeps 90 days of daily `pg_dump`s as
# encrypted workflow artifacts — encrypted with `age` to a public key, so the artifact
# store never holds readable customer data and the private key never leaves the password
# manager. Restore steps and the drill log are in docs/RUNBOOK.md.
#
# Secrets: DATABASE_URL (the production Neon URL, direct host, not -pooler),
# BACKUP_AGE_PUBLIC_KEY (an age recipient, `age1...`; keep the matching private key
# somewhere safe and OFF GitHub), SLACK_OPS_CRITICAL_WEBHOOK_URL (optional; pages on failure).
#
# It fails LOUDLY. Every run from Sep 6 to Sep 14 2026 failed with both secrets empty and
# nobody heard: an empty key read as `age: unknown recipient type ""`, an empty URL as
# pg_dump trying a local socket. Now a guard names the missing secret before anything runs,
# the dump runs under pipefail (a failed pg_dump used to be piped into age as an empty,
# "successful" file), and any failure pages #orbit-ops-critical.
name: backup

on:
  schedule:
    # Daily, not weekly. Neon's free-tier PITR window is hours, so the gap between dumps IS
    # the worst-case data loss: weekly meant corruption noticed on day six lost six days of
    # every user's contacts. Daily makes that at most 24 hours. It is not free — 90 days of
    # daily dumps is 90 artifacts instead of 13 — but artifact storage is the cheapest thing
    # in this stack and the alternative is explaining a week of lost work to a paying user.
    - cron: "0 6 * * *"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  dump:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Refuse to run without the backup secrets
        run: |
          missing=""
          [ -n "$DATABASE_URL" ] || missing="$missing DATABASE_URL"
          [ -n "$BACKUP_AGE_PUBLIC_KEY" ] || missing="$missing BACKUP_AGE_PUBLIC_KEY"
          if [ -n "$missing" ]; then
            echo "::error title=Backup secrets missing::Set the repository secret(s)$missing under Settings > Secrets and variables > Actions. No backup was taken."
            exit 1
          fi
          case "$BACKUP_AGE_PUBLIC_KEY" in
            age1*) ;;
            *)
              echo "::error title=Backup key malformed::BACKUP_AGE_PUBLIC_KEY must be an age recipient starting with age1. No backup was taken."
              exit 1
              ;;
          esac
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          BACKUP_AGE_PUBLIC_KEY: ${{ secrets.BACKUP_AGE_PUBLIC_KEY }}
      - name: Install pg_dump (Postgres 17 client) and age
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y -qq postgresql-client-17 age >/dev/null 2>&1 || \
            sudo apt-get install -y -qq postgresql-client age
          pg_dump --version; age --version
      - name: Dump and encrypt
        run: |
          set -o pipefail
          stamp=$(date -u +%F-%H%M)
          pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
            | age -r "$BACKUP_AGE_PUBLIC_KEY" > "orbit-$stamp.pgc.age"
          ls -la orbit-*.pgc.age
          echo "name=orbit-$stamp" >> "$GITHUB_ENV"
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          BACKUP_AGE_PUBLIC_KEY: ${{ secrets.BACKUP_AGE_PUBLIC_KEY }}
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ env.name }}
          path: orbit-*.pgc.age
          retention-days: 90
          if-no-files-found: error
      - name: Page on a failed backup
        if: failure()
        run: |
          if [ -z "$SLACK_OPS_CRITICAL_WEBHOOK_URL" ]; then
            echo "SLACK_OPS_CRITICAL_WEBHOOK_URL not set, skipping"
            exit 0
          fi
          run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
          curl -sS --max-time 10 -X POST -H 'content-type: application/json' \
            --data "{\"text\":\":rotating_light: *[critical] The database backup failed* and no dump was stored. $run_url\"}" \
            "$SLACK_OPS_CRITICAL_WEBHOOK_URL"
        env:
          SLACK_OPS_CRITICAL_WEBHOOK_URL: ${{ secrets.SLACK_OPS_CRITICAL_WEBHOOK_URL }}
```

In `docs/RUNBOOK.md`, directly after the paragraph ending `once it looks right.` (:67-68), add:

~~~markdown
### Restore drill log

A backup you have never restored is a hope. Run the restore above into a throwaway Neon
branch after any change to `backup.yml` and at least once a quarter, then delete the branch.
Check the same three counts against production each time:

```sql
SELECT (SELECT count(*) FROM contacts)      AS contacts,
       (SELECT count(*) FROM interactions)  AS interactions,
       (SELECT count(*) FROM user_settings) AS accounts;
```

| Date | Artifact | Download → restore finished | Row counts (contacts / interactions / accounts), restored vs prod | Who | Notes |
|---|---|---|---|---|---|
| _not yet run_ | | | | | |
~~~

- [ ] **Step 5: Run it and watch it pass**

Run: `npx tsx scripts/smoke-backup-workflow.ts`
Expected: every check `ok`, `All backup-workflow checks passed.`, exit 0.

- [ ] **Step 6: Lint the workflow and the repo**

Run: `npm run typecheck && npm run lint && npx tsx scripts/run-smoke.ts --check`
Expected: exit 0. If `actionlint` is installed locally, `actionlint .github/workflows/backup.yml` prints nothing (optional; not a dependency).

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/backup.yml docs/RUNBOOK.md scripts/smoke-backup-workflow.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Make the backup workflow fail loudly, and page when it does

Every backup run has failed because both secrets are empty, and nothing said
so. The workflow now names a missing secret before running anything, dumps
under pipefail so a failed pg_dump cannot upload an empty encrypted file,
and pages #orbit-ops-critical on any failure. The runbook gains a drill log.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Recruiter contact details unlock only for their contributor or with consent (A8a, part 1)

**Files:**
- Modify: `src/lib/recruiters.ts` — import (:1), `toPublicRecruiter` (:69-99), `mergeRecruiterFields` (:101-147), `upsertCanonicalRecruiter` (:247-298), new helpers after `pooledRecruiterIds` (:191-206)
- Modify: `src/actions/recruiters.ts` — `listDiscoverRecruiters` (:38-52), `listMyRecruiters` (:54-63), `getRecruiter` (:65-90), `logRecruiter` (:160-221), `loadRecruitersForChat` (:269-310)
- Modify: `src/lib/gmail-scan-processor.ts:29` (import) and `:217-222` (`upsertCanonicalRecruiter` call)
- Modify: `scripts/smoke-recruiter-sharing.ts:92-101` (the two `upsertCanonicalRecruiter` calls take the new options)
- Create: `scripts/smoke-recruiter-pii.ts`; Modify: `scripts/run-smoke.ts` (pglite section)

**Why this design (no column).** `user_recruiter_links` (`src/db/schema.ts:1704-1753`) has no email/phone/LinkedIn columns and `recruiters` has no owner, so "the viewer's own link carries the value" cannot be evaluated, and per-link PII needs a schema change (deferred to Phase 2, "A8 properly"). What the data does say: both writers — `logRecruiter` and the Gmail scan — create the row and then the creator's link back to back. So:

- **Creator link:** the viewer's link was made within `CREATOR_LINK_WINDOW_SECONDS` (120 s) after the row. The creator typed (or received) those details, so they see them.
- **Consented pool:** the viewer is sharing AND the row's *creator link* is pooled (creator sharing, link `shared_to_pool = 1`). PII follows its contributor's consent — linking a row yourself (even while sharing) no longer unlocks someone else's private details.
- **Write guard:** a caller who is not sharing never writes email/phone/LinkedIn onto an EXISTING row; firm and specialty still merge.

Accepted limitation until Phase 2: a non-creator who types an email for a recruiter someone else created does not get to keep it (it is not stored anywhere), and a row whose creator deleted their data has contact details nobody can see.

**Interfaces:**
- Produces (in `src/lib/recruiters.ts`): `CREATOR_LINK_WINDOW_SECONDS = 120`; `isCreatorLink(row: Pick<Recruiter, "createdAt">, link: Pick<UserRecruiterLink, "createdAt"> | null): boolean`; `piiPooledRecruiterIds(ids: string[]): Promise<Set<string>>`; `unlockedRecruiterIds(viewerUserId: string, rows: Array<Pick<Recruiter, "id" | "createdAt">>): Promise<Set<string>>`.
- Changes: `toPublicRecruiter(row, link, piiUnlocked = false)` — the third argument now means "unlocked", and a link alone no longer unlocks. `mergeRecruiterFields(existing, incoming, opts: { includePii: boolean })`. `upsertCanonicalRecruiter(input, opts: { callerIsSharing: boolean })` — required, so no caller can forget it.
- Consumed by Task 9 (`unlockedRecruiterIds` in `src/actions/recruiter-messages.ts`).

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-recruiter-pii.ts`:

```ts
/**
 * The recruiter directory's contact-detail boundary (audit A8).
 *
 * `recruiters` is global. Linking any row by id, or by name + firm, used to unlock its
 * email, phone and LinkedIn for anyone — whether or not the person who contributed them
 * had sharing on — and anyone could fill a row's empty contact fields. Now details unlock
 * for the row's creator, or for a sharing viewer when the creator shares; a private caller
 * never writes details onto an existing row.
 *
 * Run: npx tsx scripts/smoke-recruiter-pii.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { recruiters, userRecruiterLinks, userSettings } from "../src/db/schema";
import {
  ensureUserLink,
  isCreatorLink,
  toPublicRecruiter,
  unlockedRecruiterIds,
  upsertCanonicalRecruiter,
} from "../src/lib/recruiters";

const A = "smoke-pii-a";
const B = "smoke-pii-b";
const FIRM = "ZZSmokePii";
const NAME = `${FIRM} Recruiter`;
const A_EMAIL = "alex@zzsmokepii.test";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function cleanup() {
  const db = await getDb();
  await db.delete(userRecruiterLinks).where(inArray(userRecruiterLinks.userId, [A, B]));
  await db.delete(recruiters).where(eq(recruiters.firm, FIRM));
  await db.delete(userSettings).where(inArray(userSettings.userId, [A, B]));
}

async function setSharing(userId: string, on: boolean) {
  const db = await getDb();
  await db.update(userSettings).set({ recruiterSharing: on ? 1 : 0 }).where(eq(userSettings.userId, userId));
}

async function row(id: string) {
  const db = await getDb();
  return (await db.query.recruiters.findFirst({ where: eq(recruiters.id, id) }))!;
}

async function unlockedFor(userId: string, id: string) {
  return (await unlockedRecruiterIds(userId, [await row(id)])).has(id);
}

run(async () => {
  await cleanup();
  const db = await getDb();
  for (const userId of [A, B]) await db.insert(userSettings).values({ userId, recruiterSharing: 0 });

  console.log("The creator sees what they contributed");
  // What logRecruiter does: create the row, then the creator's link.
  const created = await upsertCanonicalRecruiter({ fullName: NAME, firm: FIRM, email: A_EMAIL }, { callerIsSharing: false });
  await ensureUserLink({ userId: A, recruiterId: created.id });
  // Age the row and A's link by an hour, so B's link (made now) is unambiguously not the creator's.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await db.update(recruiters).set({ createdAt: hourAgo }).where(eq(recruiters.id, created.id));
  await db
    .update(userRecruiterLinks)
    .set({ createdAt: new Date(hourAgo.getTime() + 1000) })
    .where(and(eq(userRecruiterLinks.userId, A), eq(userRecruiterLinks.recruiterId, created.id)));
  check("A (private, creator) sees the email", await unlockedFor(A, created.id));

  console.log("\nB, sharing off, links the same row by id");
  const { link: linkB } = await ensureUserLink({ userId: B, recruiterId: created.id });
  check("B's link is not the creator's", !isCreatorLink(await row(created.id), linkB));
  check("B cannot read A's email", !(await unlockedFor(B, created.id)));
  check("toPublicRecruiter hides it from B", toPublicRecruiter(await row(created.id), linkB, false).email === null);

  console.log("\nB logs the same person by name + firm with their own details");
  const matched = await upsertCanonicalRecruiter(
    { fullName: NAME, firm: FIRM, email: "other@zzsmokepii.test", phone: "+15555550100", specialty: ["Platform"] },
    { callerIsSharing: false }
  );
  const afterB = await row(created.id);
  check("it matched A's row", matched.id === created.id);
  check("B's phone was NOT written onto the shared row", afterB.phone === null, String(afterB.phone));
  check("A's email is unchanged", afterB.email === A_EMAIL);
  check("non-contact fields still merge (specialty)", (afterB.specialty ?? []).includes("Platform"));
  check("B still cannot read A's email", !(await unlockedFor(B, created.id)));

  console.log("\nConsent follows the contributor");
  await setSharing(B, true);
  check("B sharing alone does not unlock A's private details", !(await unlockedFor(B, created.id)));
  await setSharing(A, true);
  check("once A shares, sharing B sees them", await unlockedFor(B, created.id));
  await setSharing(B, false);
  check("B opting out loses them again", !(await unlockedFor(B, created.id)));

  console.log("\nA sharing caller may still fill an empty field");
  await upsertCanonicalRecruiter({ fullName: NAME, firm: FIRM, phone: "+15555550199" }, { callerIsSharing: true });
  check("the phone was filled", (await row(created.id)).phone === "+15555550199");

  console.log("\nisCreatorLink edges");
  const t = new Date("2026-09-15T12:00:00Z");
  check("same instant counts", isCreatorLink({ createdAt: t }, { createdAt: t }));
  check("two minutes later counts", isCreatorLink({ createdAt: t }, { createdAt: new Date(t.getTime() + 120_000) }));
  check("three minutes later does not", !isCreatorLink({ createdAt: t }, { createdAt: new Date(t.getTime() + 180_000) }));
  check("a link older than the row does not", !isCreatorLink({ createdAt: t }, { createdAt: new Date(t.getTime() - 1000) }));
  check("no link does not", !isCreatorLink({ createdAt: t }, null));

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll recruiter PII checks passed.");
});
```

- [ ] **Step 2: Register it** — pglite block, after `"smoke-recruiter-sharing": "pglite",`, add `  "smoke-recruiter-pii": "pglite",`.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx scripts/smoke-recruiter-pii.ts`
Expected: aborts with `TypeError: … isCreatorLink is not a function` (not exported yet); exit 1. On the old code the leak itself shows as `FAIL B's phone was NOT written onto the shared row`.

- [ ] **Step 4: Implement the rule in `src/lib/recruiters.ts`**

Change line 1 to `import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";`.

Replace `toPublicRecruiter` and its doc comment (:69-99) with:

```ts
/**
 * Shape a canonical row for a specific viewer.
 *
 * `piiUnlocked` must come from `unlockedRecruiterIds` — never from "the viewer has a link".
 * A link used to unlock the row's email, phone and LinkedIn for anyone who logged it, which
 * handed one user's private contact details to any other user who typed the same name and
 * firm (audit A8).
 *
 * Note what is absent: `notes` and `aiSummary` reach the caller only inside `myLink`,
 * which is null for anyone but the owner. They are never derived from `row`.
 */
export function toPublicRecruiter(
  row: Recruiter,
  link: UserRecruiterLink | null,
  piiUnlocked = false
): PublicRecruiter {
  return {
    id: row.id,
    fullName: row.fullName,
    firm: row.firm,
    specialty: row.specialty || [],
    avgRating: row.avgRating,
    ratingCount: row.ratingCount,
    logCount: row.logCount,
    email: piiUnlocked ? row.email : null,
    linkedinUrl: piiUnlocked ? row.linkedinUrl : null,
    phone: piiUnlocked ? row.phone : null,
    piiUnlocked,
    myLink: link,
  };
}
```

In `PublicRecruiter` (:21), change the comment `/** Present only when the viewer has a personal link. */` to `/** Present only when unlockedRecruiterIds unlocked this row for the viewer. */`.

Replace `mergeRecruiterFields` (:101-147) with:

```ts
/**
 * Fill empty fields only — never overwrite existing non-empty values.
 *
 * `includePii: false` (a caller who is not sharing) merges firm and specialty but never
 * email, phone or LinkedIn: the row is shared, and a private caller's contact details
 * would otherwise become visible to whoever the row is unlocked for.
 */
export function mergeRecruiterFields(
  existing: Recruiter,
  incoming: {
    fullName?: string;
    firm?: string | null;
    specialty?: string[];
    email?: string | null;
    linkedinUrl?: string | null;
    phone?: string | null;
  },
  opts: { includePii: boolean }
): Partial<typeof recruiters.$inferInsert> {
  const patch: Partial<typeof recruiters.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (!existing.firm && incoming.firm?.trim()) {
    patch.firm = incoming.firm.trim();
    patch.firmNormalized = normalizeFirm(incoming.firm);
  }
  if (opts.includePii) {
    if (!existing.email && incoming.email?.trim()) {
      patch.email = incoming.email.trim();
      patch.emailNormalized = normalizeEmail(incoming.email);
    }
    if (!existing.linkedinUrl && incoming.linkedinUrl?.trim()) {
      patch.linkedinUrl = normalizeLinkedinUrl(incoming.linkedinUrl);
    }
    if (!existing.phone && incoming.phone?.trim()) {
      patch.phone = incoming.phone.trim();
    }
  }
  if (incoming.specialty?.length) {
    const current = new Set(existing.specialty || []);
    for (const s of incoming.specialty) {
      const t = s.trim();
      if (t) current.add(t);
    }
    patch.specialty = Array.from(current);
  }

  return patch;
}
```

Directly after `pooledRecruiterIds` (ends :206), add:

```ts
/**
 * How long after a row's creation its creator's link can be made. `logRecruiter` and the
 * Gmail scan both create the row and then the link back to back, so a link inside this
 * window is the creator's — the person who supplied the row's contact details.
 */
export const CREATOR_LINK_WINDOW_SECONDS = 120;

export function isCreatorLink(
  row: Pick<Recruiter, "createdAt">,
  link: Pick<UserRecruiterLink, "createdAt"> | null
): boolean {
  if (!link) return false;
  const gapMs = link.createdAt.getTime() - row.createdAt.getTime();
  return gapMs >= 0 && gapMs <= CREATOR_LINK_WINDOW_SECONDS * 1000;
}

/**
 * Rows whose contact details their CREATOR has put in the pool: the creator is sharing and
 * their link is not excluded. Pooling a row by linking it yourself does not count — the
 * details were not yours to share.
 */
export async function piiPooledRecruiterIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const db = await getDb();
  const rows = await db
    .selectDistinct({ recruiterId: userRecruiterLinks.recruiterId })
    .from(userRecruiterLinks)
    .innerJoin(recruiters, eq(recruiters.id, userRecruiterLinks.recruiterId))
    .innerJoin(userSettings, eq(userSettings.userId, userRecruiterLinks.userId))
    .where(
      and(
        inArray(userRecruiterLinks.recruiterId, ids),
        eq(userRecruiterLinks.sharedToPool, 1),
        eq(userSettings.recruiterSharing, 1),
        gte(userRecruiterLinks.createdAt, recruiters.createdAt),
        lte(
          userRecruiterLinks.createdAt,
          sql`${recruiters.createdAt} + make_interval(secs => ${CREATOR_LINK_WINDOW_SECONDS})`
        )
      )
    );
  return new Set(rows.map((r) => r.recruiterId));
}

/**
 * Which of these rows' contact details this viewer may read: the ones they created, plus —
 * when they are sharing — the ones whose creator shares. The one function every read
 * surface asks; nothing else may decide it.
 */
export async function unlockedRecruiterIds(
  viewerUserId: string,
  rows: Array<Pick<Recruiter, "id" | "createdAt">>
): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const db = await getDb();
  const ids = rows.map((r) => r.id);
  const links = await db
    .select({ recruiterId: userRecruiterLinks.recruiterId, createdAt: userRecruiterLinks.createdAt })
    .from(userRecruiterLinks)
    .where(
      and(eq(userRecruiterLinks.userId, viewerUserId), inArray(userRecruiterLinks.recruiterId, ids))
    );
  const linkByRecruiter = new Map(links.map((l) => [l.recruiterId, l]));

  const unlocked = new Set<string>();
  for (const row of rows) {
    if (isCreatorLink(row, linkByRecruiter.get(row.id) ?? null)) unlocked.add(row.id);
  }
  const rest = ids.filter((id) => !unlocked.has(id));
  if (rest.length > 0 && (await isViewerSharing(viewerUserId))) {
    for (const id of await piiPooledRecruiterIds(rest)) unlocked.add(id);
  }
  return unlocked;
}
```

In `upsertCanonicalRecruiter`, change the signature to take `opts: { callerIsSharing: boolean }` as a second parameter:

```ts
export async function upsertCanonicalRecruiter(
  input: {
    fullName: string;
    firm?: string | null;
    specialty?: string[];
    email?: string | null;
    linkedinUrl?: string | null;
    phone?: string | null;
  },
  /** Required: a private caller never writes contact details onto an existing row. */
  opts: { callerIsSharing: boolean }
): Promise<Recruiter> {
```

and change `const patch = mergeRecruiterFields(existing, input);` to `const patch = mergeRecruiterFields(existing, input, { includePii: opts.callerIsSharing });`. (A NEW row still stores the caller's details — they are its creator.)

- [ ] **Step 5: Every read and write surface uses it**

In `src/actions/recruiters.ts`, add `unlockedRecruiterIds,` to the `@/lib/recruiters` import, then:

`listDiscoverRecruiters` — replace `return rows.map((r) => toPublicRecruiter(r, null, true));` with:

```ts
  // Pooled rows the viewer never linked: their details show only where the creator shares.
  const unlocked = await unlockedRecruiterIds(userId, rows);
  return rows.map((r) => toPublicRecruiter(r, null, unlocked.has(r.id)));
```

`listMyRecruiters` — replace `return links.map((l) => toPublicRecruiter(l.recruiter, l));` with:

```ts
  const unlocked = await unlockedRecruiterIds(userId, links.map((l) => l.recruiter));
  return links.map((l) => toPublicRecruiter(l.recruiter, l, unlocked.has(l.recruiter.id)));
```

`getRecruiter` — replace from `if (!link) {` to the end of the function with:

```ts
  if (!link) {
    const sharing = await isViewerSharing(userId);
    if (!sharing) return null;
    const pooled = await pooledRecruiterIds([id]);
    if (!pooled.has(id)) return null;
  }

  const unlocked = await unlockedRecruiterIds(userId, [row]);
  return toPublicRecruiter(row, link ?? null, unlocked.has(id));
}
```

`logRecruiter` — directly after `const userId = await requireRecruitersUser();` add `const callerIsSharing = await isViewerSharing(userId);`, and pass `{ callerIsSharing }` as the second argument to BOTH `upsertCanonicalRecruiter({ … })` calls (:177 and :187).

`loadRecruitersForChat` — directly after the `personal` query (:280) add:

```ts
  const unlocked = await unlockedRecruiterIds(userId, personal.map((l) => l.recruiter));
```

and in `scoredPersonal`'s object replace

```ts
        piiUnlocked: true,
        email: r.email,
        linkedinUrl: r.linkedinUrl,
```

with

```ts
        piiUnlocked: unlocked.has(r.id),
        email: unlocked.has(r.id) ? r.email : null,
        linkedinUrl: unlocked.has(r.id) ? r.linkedinUrl : null,
```

In `src/lib/gmail-scan-processor.ts`, change :29 to `import { ensureUserLink, isViewerSharing, upsertCanonicalRecruiter } from "@/lib/recruiters";` and the call at :217-222 to:

```ts
  // The sender's address came from THIS user's inbox; it lands on a shared row only when
  // the row is new (this user is its creator) or this user shares.
  const recruiter = await upsertCanonicalRecruiter(
    {
      fullName: result.fullName || payload.name,
      firm: result.firm || payload.firm,
      email: payload.email,
      specialty: result.rolesDiscussed,
    },
    { callerIsSharing: await isViewerSharing(userId) }
  );
```

In `scripts/smoke-recruiter-sharing.ts`, add `, { callerIsSharing: false }` as the second argument to both `upsertCanonicalRecruiter({ … })` calls (:92-101). Its `toPublicRecruiter(row, null, true/false)` assertions keep their meaning (third argument = unlocked).

- [ ] **Step 6: Run and watch it pass**

Run: `npx tsx scripts/smoke-recruiter-pii.ts && npx tsx scripts/smoke-recruiter-sharing.ts && npx tsx scripts/smoke-recruiter-scan.ts`
Expected: `All recruiter PII checks passed.`, `all recruiter sharing checks passed`, scan smoke green; exit 0.

- [ ] **Step 7: Typecheck, lint** — `npm run typecheck && npm run lint`. Expected: exit 0 (typecheck is what finds any `upsertCanonicalRecruiter` caller missing the options).

- [ ] **Step 8: Commit**

```bash
git add src/lib/recruiters.ts src/actions/recruiters.ts src/lib/gmail-scan-processor.ts scripts/smoke-recruiter-pii.ts scripts/smoke-recruiter-sharing.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Unlock a recruiter's contact details only for its creator or with their consent

Any link to the global recruiters table unlocked its email, phone and LinkedIn,
so a second user linking by id or by name + firm read the first user's private
details, and could fill empty fields on a row others relied on. Details now
unlock for the row's creator, or for a sharing viewer when the creator shares;
a caller who is not sharing never writes contact details onto an existing row.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Recruiter drafts and sends honour the same unlock rule (A8a, part 2)

**Files:**
- Modify: `src/actions/recruiter-messages.ts` — imports (:6-28), `toDraft` (:33-49), `generateRecruiterDrafts` (:154-157), `listRecruiterDrafts` (:168-183), `sendRecruiterDrafts` (:266-284)
- Modify: `scripts/smoke-recruiter-pii.ts` (imports, `cleanup`, a new section before the final `await cleanup();`)

**Interfaces:** Consumes Task 8's `unlockedRecruiterIds(viewerUserId, rows)`. `toDraft(row, recruiter, emailVisible: boolean)` gains a third parameter (module-private). `RecruiterDraft.recruiterEmail` is `null` when locked. Before this, `sendRecruiterDrafts` mailed whatever email was on the shared row (audit A8: "`sendRecruiterDrafts` mails whatever email is on the row").

- [ ] **Step 1: Write the failing test**

In `scripts/smoke-recruiter-pii.ts`: extend the schema import to `import { gmailConnections, recruiterMessages, recruiters, userRecruiterLinks, userSettings } from "../src/db/schema";`, add `import { ensureUserSettings } from "../src/lib/user-settings";` and `import { listRecruiterDrafts, sendRecruiterDrafts } from "../src/actions/recruiter-messages";`, add `const VIEWER = "demo-user";` under the other ids, and replace `cleanup` with:

```ts
async function cleanup() {
  const db = await getDb();
  await db.delete(recruiterMessages).where(eq(recruiterMessages.userId, VIEWER));
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, VIEWER));
  await db.delete(userRecruiterLinks).where(inArray(userRecruiterLinks.userId, [A, B, VIEWER]));
  await db.delete(recruiters).where(eq(recruiters.firm, FIRM));
  await db.delete(userSettings).where(inArray(userSettings.userId, [A, B, VIEWER]));
}
```

Insert before the final `await cleanup();`:

```ts
  console.log("\nDrafts and sends honour the same rule (as demo mode's demo-user)");
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  process.env.ORBIT_DEMO_DATA = "off";
  (process.env as Record<string, string>).NODE_ENV = "development";
  await setSharing(A, false);
  await ensureUserSettings(VIEWER);
  await ensureUserLink({ userId: VIEWER, recruiterId: created.id });
  const [draft] = await db
    .insert(recruiterMessages)
    .values({
      userId: VIEWER,
      recruiterId: created.id,
      intent: "set_up_chat",
      subject: "Coffee next week?",
      body: "Hi — would you have twenty minutes next week?",
      status: "draft",
    })
    .returning();
  // A connection row so the send gets past "Connect Gmail first". Its token is junk: a send
  // that got as far as Gmail would fail and mark the draft "failed".
  await db.insert(gmailConnections).values({
    userId: VIEWER,
    emailAddress: "demo@orbit.local",
    accessTokenEncrypted: "not-a-real-token",
    status: "active",
  });

  const listed = (await listRecruiterDrafts()).find((d) => d.id === draft.id);
  check("the draft list hides A's email from the viewer", listed?.recruiterEmail === null, JSON.stringify(listed));
  await sendRecruiterDrafts([draft.id]).catch((err: unknown) => {
    if (!(err instanceof Error && err.message.includes("static generation store"))) throw err;
  });
  const afterSend = await db.query.recruiterMessages.findFirst({ where: eq(recruiterMessages.id, draft.id) });
  check("sending to a locked recruiter attempts nothing — the draft stays a draft", afterSend?.status === "draft", String(afterSend?.status));
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-recruiter-pii.ts`
Expected: `FAIL the draft list hides A's email from the viewer` (it shows `alex@zzsmokepii.test`) and `FAIL sending to a locked recruiter attempts nothing` (status `failed`: the send reached Gmail with the junk token); exit 1.

- [ ] **Step 3: Implement**

In `src/actions/recruiter-messages.ts`, add after the `@/lib/recruiter-message-types` import:

```ts
import { unlockedRecruiterIds } from "@/lib/recruiters";
```

Replace `toDraft` (:33-49) with:

```ts
function toDraft(
  row: RecruiterMessage,
  recruiter: { fullName: string; firm: string | null; email: string | null },
  /** From `unlockedRecruiterIds`: a draft never reveals an address its sender cannot see. */
  emailVisible: boolean
): RecruiterDraft {
  return {
    id: row.id,
    recruiterId: row.recruiterId,
    recruiterName: recruiter.fullName,
    recruiterFirm: recruiter.firm,
    recruiterEmail: emailVisible ? recruiter.email : null,
    intent: row.intent as RecruiterIntent,
    subject: row.subject,
    body: row.body,
    status: row.status,
    errorMessage: row.errorMessage,
  };
}
```

In `generateRecruiterDrafts`, directly before `const created: RecruiterDraft[] = [];` (:154) add `const unlocked = await unlockedRecruiterIds(userId, links.map((l) => l.recruiter));` and change `created.push(toDraft(row, links[i].recruiter));` to `created.push(toDraft(row, links[i].recruiter, unlocked.has(links[i].recruiterId)));`.

In `listRecruiterDrafts`, replace `return rows.map((r) => toDraft(r.message, r.recruiter));` with:

```ts
  const unlocked = await unlockedRecruiterIds(userId, rows.map((r) => r.recruiter));
  return rows.map((r) => toDraft(r.message, r.recruiter, unlocked.has(r.recruiter.id)));
```

In `sendRecruiterDrafts`, directly after the `rows` query (ends :278 with `.orderBy(asc(recruiterMessages.createdAt));`) add:

```ts
    // The shared row's email is only ever an address this user may read.
    const unlocked = await unlockedRecruiterIds(userId, rows.map((r) => r.recruiter));
```

and change `const to = row.recruiter.email;` (:283) to `const to = unlocked.has(row.recruiter.id) ? row.recruiter.email : null;`. The existing `if (!to)` branch reports "has no email address on file" and never reaches Gmail.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-recruiter-pii.ts`
Expected: all `ok`, `All recruiter PII checks passed.`, exit 0. No network: the locked draft never reaches `sendGmailMessage`.

- [ ] **Step 5: Typecheck, lint** — `npm run typecheck && npm run lint`. Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/actions/recruiter-messages.ts scripts/smoke-recruiter-pii.ts
git commit -m "$(cat <<'EOF'
Keep recruiter drafts and sends inside the contact-detail unlock rule

Drafts showed, and sends mailed, whatever email sat on the shared recruiter
row. Both now go through unlockedRecruiterIds, so a locked recruiter reads as
"no email on file" and nothing is sent.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: A key the provider refused is no longer called a missing key (A9c)

**Files:**
- Modify: `src/lib/errors.ts` — `MISSING_AI_API_KEY_MESSAGE` doc (:1-8), `isMissingAiApiKeyError` (:35-38), new `AI_KEY_REJECTED_MESSAGE` / `isAiKeyRejectedError`, `OWN_WORDS` (:148-156), `friendlyError` (:238)
- Modify: `src/app/api/capture/meetings/[id]/chunks/route.ts:3` (import) and `:105-115` (the 422 branch)
- Modify: `scripts/smoke-friendly-error.ts` (imports :16-27; new section after the "a missing AI key is worth saying out loud" block, :63-64)

**Why.** `isMissingAiApiKeyError` is `/api key/i`, which matches the raw Gemini body "API key not valid", OpenAI's "Incorrect API key provided" and Orbit's own auth template ("…didn’t accept your API key…"). So a saved-but-refused key showed "Add your AI API key in Settings", bounced the chat question and hid the mic. The detector now matches only Orbit's own no-key errors; refusals get their own detector and copy. The seven call sites of `isMissingAiApiKeyError` (chunks route, capture jobs route, capture-flow, bulk-notes-panel ×3, log-interaction-sheet, use-capture-ingest) need no edit: each shows `res.error` when the key is not missing, which is now the refusal copy.

**Interfaces:** Produces in `src/lib/errors.ts`: `AI_KEY_REJECTED_MESSAGE: string`; `isAiKeyRejectedError(message: string | null | undefined): boolean`. `isMissingAiApiKeyError` keeps its signature with a narrower meaning. Consumed by Task 11 (`asAiProviderError` lives next to these) and Task 12 (`ai-key-check.ts`).

- [ ] **Step 1: Write the failing test**

In `scripts/smoke-friendly-error.ts`, add to the `../src/lib/errors` import: `AI_KEY_REJECTED_MESSAGE, isAiKeyRejectedError, isMissingAiApiKeyError,`. After the `check("no-key error → the key message", …)` line (:64) insert:

```ts
console.log("a key the provider refused is not a missing key");
const refused: [string, string][] = [
  ["Gemini", 'got status: 400 Bad Request. {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}'],
  ["OpenAI", "401 Incorrect API key provided: sk-abc***wxyz. You can find your API key at https://platform.openai.com/account/api-keys."],
  ["Anthropic", '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
];
for (const [label, raw] of refused) {
  check(`${label}: not classified as a missing key`, !isMissingAiApiKeyError(raw));
  check(`${label}: recognised as a refused key`, isAiKeyRejectedError(raw));
  check(`${label}: provider copy is the auth template`,
    aiProviderErrorMessage(new Error(raw), label) === `${label} didn’t accept your API key — check it in Settings`,
    aiProviderErrorMessage(new Error(raw), label));
  check(`${label}: friendlyError says refused, not missing`, friendlyError(new Error(raw), FB) === AI_KEY_REJECTED_MESSAGE, friendlyError(new Error(raw), FB));
  check(`${label}: telemetry still files it as auth`, classifyAiError(new Error(raw)) === "auth");
}
console.log("Orbit's own no-key errors are still missing keys");
for (const own of [
  "No Google Gemini API key configured. Add your own key in Settings.",
  "No OpenAI API key configured for embeddings. Add your own key in Settings.",
  "No Gemini API key configured for embeddings. Add your own key in Settings.",
  "Voice capture needs an OpenAI, Gemini, or Wispr API key in Settings for transcription.",
  MISSING_AI_API_KEY_MESSAGE,
]) {
  check(`missing: ${own.slice(0, 48)}`, isMissingAiApiKeyError(own));
}
check("an Apollo key is not an AI key", !isMissingAiApiKeyError("No Apollo API key configured"));
check("the auth template is not a missing key", !isMissingAiApiKeyError("Gemini didn’t accept your API key — check it in Settings"));
check("…but it is a refused key", isAiKeyRejectedError("Gemini didn’t accept your API key — check it in Settings"));
check("AI_KEY_REJECTED_MESSAGE passes through friendlyError", friendlyError(new Error(AI_KEY_REJECTED_MESSAGE), FB) === AI_KEY_REJECTED_MESSAGE);
check("AI_KEY_REJECTED_MESSAGE keeps the house voice",
  !AI_KEY_REJECTED_MESSAGE.includes("'") && !AI_KEY_REJECTED_MESSAGE.endsWith(".") && classifyAiError(new Error(AI_KEY_REJECTED_MESSAGE)) === "auth");
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-friendly-error.ts`
Expected: `FAIL Gemini: not classified as a missing key` (the old `/api key/i` matches it), then the run aborts with `TypeError: … isAiKeyRejectedError is not a function`; exit 1.

- [ ] **Step 3: Implement**

In `src/lib/errors.ts`, replace the `MISSING_AI_API_KEY_MESSAGE` doc comment (:1-6) with:

```ts
/**
 * Shown whenever AI features fail because the user has NO provider key.
 *
 * `isMissingAiApiKeyError` recognises this exact string (call sites run it on text a
 * server action handed back) alongside Orbit's own "No … API key configured" errors — and
 * nothing a provider says. A key that exists and was refused is `AI_KEY_REJECTED_MESSAGE`.
 */
```

Replace `isMissingAiApiKeyError` (:35-38) with:

```ts
/** Orbit's own no-key errors, thrown from `lib/ai.ts` before any provider is called. */
const MISSING_KEY_PATTERNS = [
  /\bno (?:(?:google )?gemini |openai |anthropic )?api key configured\b/i,
  /\bneeds an? (?:openai|gemini|wispr)\b[^.]*\bapi key\b/i,
];

export function isMissingAiApiKeyError(message: string | null | undefined) {
  if (!message) return false;
  const text = message.trim();
  return (
    text === MISSING_AI_API_KEY_MESSAGE || MISSING_KEY_PATTERNS.some((re) => re.test(text))
  );
}

/**
 * A key IS saved and the provider refused it. Distinct from the missing-key message on
 * purpose: "add your key" sends someone who already has one to the wrong fix. Keeps the
 * words "API key" so `classifyAiError` still files it as `auth`.
 */
export const AI_KEY_REJECTED_MESSAGE =
  "Your AI provider didn’t accept your API key — check it in Settings";

/** Raw provider bodies for a refused key (Gemini, OpenAI, Anthropic). */
const PROVIDER_KEY_REJECTED =
  /api key not valid|api_key_invalid|incorrect api key|invalid x-api-key|invalid api key|authentication_error/i;

/** A refused key: a raw provider body, or Orbit's own rewrite of one. */
export function isAiKeyRejectedError(message: string | null | undefined) {
  if (!message) return false;
  return PROVIDER_KEY_REJECTED.test(message) || /didn’t accept your api key/i.test(message);
}
```

In `OWN_WORDS`, add `AI_KEY_REJECTED_MESSAGE,` after `MISSING_AI_API_KEY_MESSAGE,`. In `friendlyError`, directly after `if (raw && isMissingAiApiKeyError(raw)) return MISSING_AI_API_KEY_MESSAGE;` (:238) add:

```ts
  if (raw && PROVIDER_KEY_REJECTED.test(raw)) return AI_KEY_REJECTED_MESSAGE;
```

In `src/app/api/capture/meetings/[id]/chunks/route.ts`, change the import (:3) to `import { AI_KEY_REJECTED_MESSAGE, friendlyError, isAiKeyRejectedError, isMissingAiApiKeyError, MISSING_AI_API_KEY_MESSAGE } from "@/lib/errors";` and replace the 422 branch (:105-115) with:

```ts
    // No key is not a transient failure: retrying every chunk of an hour-long call against
    // it would be a thousand identical errors. A refused key is just as terminal — before
    // the missing-key detector was narrowed, the /api key/ regex made it one by accident.
    // 422 tells the recorder to stop and say so. (Distinct recorder copy for a refused key
    // is Phase 3a's chunk-route work; the message below is already the right one.)
    if (isMissingAiApiKeyError(message) || isAiKeyRejectedError(message)) {
      return NextResponse.json(
        {
          error: isMissingAiApiKeyError(message)
            ? MISSING_AI_API_KEY_MESSAGE
            : friendlyError(err, AI_KEY_REJECTED_MESSAGE),
          code: "no-transcription-key",
        },
        { status: 422 }
      );
    }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-friendly-error.ts && npx tsx scripts/smoke-toast-copy.ts`
Expected: `ALL PASS`; toast copy green; exit 0.

- [ ] **Step 5: Typecheck, lint** — `npm run typecheck && npm run lint`. Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/errors.ts "src/app/api/capture/meetings/[id]/chunks/route.ts" scripts/smoke-friendly-error.ts
git commit -m "$(cat <<'EOF'
Tell a refused AI key apart from a missing one

isMissingAiApiKeyError matched /api key/, so a provider's "API key not valid"
read as "add your key": chat bounced the question and voice capture hid the
mic. It now matches only Orbit's own no-key errors; a refused key gets its own
detector and copy, and stays terminal in the meeting-chunk route.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Streaming chat, transcription and embeddings translate provider errors (A9b)

**Files:**
- Modify: `src/lib/errors.ts` (new `asAiProviderError` after `aiProviderErrorMessage`, :122-141)
- Modify: `src/lib/ai.ts` — import (:25-30), a private helper, and five `withUsage` callbacks: `streamText` (:1866 / :1935-1936), `transcribeAudioWithAI` OpenAI (:956 / :983-984) and Gemini (:1000 / :1041-1042), `createEmbedding` (:1549 / :1573-1574), `createEmbeddingsBatch` (:1597 / :1627-1628). (The audit's line hints for these three functions were swapped; these are the real ones at `33a213c`.)
- Modify: `scripts/smoke-friendly-error.ts` (new section before the "house voice" block, :101)

**Why.** `completeJson` (:654-664) and `completeMultimodalJsonInner` (:838-847) rethrow `aiProviderErrorMessage(err, label)`. These five paths threw raw provider bodies, so chat showed missing-key copy for a refused key and embedding failures were unreadable in telemetry. Wrapping *inside* the `withUsage` callback (as `completeJson` does) keeps `usage_events.error_kind` classifying the rewritten message. Orbit's own sentinels ("Empty AI response", "Empty transcription", "Empty embedding response", "Incomplete embedding batch response", `AI_INCOMPLETE_MESSAGE`) pass through untouched — `classifyAiError` keys on the first.

**Interfaces:** Consumes Task 10's `isAiKeyRejectedError` indirectly (via `aiProviderErrorMessage`'s auth branch). Produces `asAiProviderError(err: unknown, provider: string): Error` in `src/lib/errors.ts`.

- [ ] **Step 1: Write the failing test**

In `scripts/smoke-friendly-error.ts`, add `asAiProviderError, AI_INCOMPLETE_MESSAGE,` to the errors import and `import { readFileSync } from "node:fs";` at the top; insert before `console.log("house voice");`:

```ts
console.log("the streaming, transcription and embedding paths speak the same language");
const refusedStream = asAiProviderError(new Error("401 Incorrect API key provided: sk-abc"), "OpenAI");
check("a refused key on a stream → the auth template", refusedStream.message === "OpenAI didn’t accept your API key — check it in Settings", refusedStream.message);
check("…which friendlyError passes through", friendlyError(refusedStream, FB) === refusedStream.message);
const hung = new Error("The operation was aborted."); hung.name = "AbortError";
check("a timeout → the timeout template", asAiProviderError(hung, "Gemini").message === "Gemini timed out — try again, or ask something shorter");
for (const sentinel of ["Empty AI response", "Empty transcription", "Empty embedding response", "Incomplete embedding batch response", AI_INCOMPLETE_MESSAGE]) {
  const e = new Error(sentinel);
  check(`sentinel untouched: ${sentinel}`, asAiProviderError(e, "Gemini") === e);
}
check("a truncated JSON transcript → the incomplete-answer copy",
  asAiProviderError(new Error('Failed to parse AI JSON: {"te'), "Gemini").message === AI_INCOMPLETE_MESSAGE);
const aiSource = readFileSync("src/lib/ai.ts", "utf8");
const wrapped = aiSource.match(/translatingProviderErrors\(/g)?.length ?? 0;
// The definition is `translatingProviderErrors<T>(`, which this pattern does not match.
check("all five bypassing paths are wrapped (streamText, 2× transcription, 2× embeddings)", wrapped === 5, `${wrapped} call sites`);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-friendly-error.ts`
Expected: aborts with `TypeError: … asAiProviderError is not a function`; exit 1.

- [ ] **Step 3: Implement the translator**

In `src/lib/errors.ts`, directly after `aiProviderErrorMessage` (ends :141), add:

```ts
/** Orbit's own failures inside `lib/ai.ts`: already worded, never rewritten as a provider fault. */
const AI_SENTINEL_MESSAGES = new Set<string>([
  "Empty AI response",
  "Empty transcription",
  "Empty embedding response",
  "Incomplete embedding batch response",
  AI_INCOMPLETE_MESSAGE,
]);

/**
 * The error a provider call rethrows, so every AI path reads like `completeJson`: the
 * person sees `AI_FAILURE_COPY`, telemetry classifies it, and no raw provider body or key
 * fragment travels any further.
 */
export function asAiProviderError(err: unknown, provider: string): Error {
  if (err instanceof Error && AI_SENTINEL_MESSAGES.has(err.message)) return err;
  if (err instanceof Error && err.message.startsWith("Failed to parse AI JSON")) {
    return new Error(AI_INCOMPLETE_MESSAGE);
  }
  return new Error(aiProviderErrorMessage(err, provider));
}
```

- [ ] **Step 4: Wrap the five callbacks**

In `src/lib/ai.ts`, add `asAiProviderError,` to the `@/lib/errors` import (:25-30), and add after `aiSignal` (ends near :70):

```ts
/**
 * Runs the body of a `withUsage` callback so any provider failure is rethrown as Orbit's
 * copy. Inside the callback on purpose: `withUsage` then classifies the rewritten error for
 * `usage_events.error_kind`, exactly as it does for `completeJson`.
 */
async function translatingProviderErrors<T>(provider: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw asAiProviderError(err, provider);
  }
}
```

Then make five mechanical edits. Each replaces the callback's opening line and its closing line; the body between them does not change.

1. `streamText`: the line `    async (report) => {` at :1866 becomes

```ts
    (report) => translatingProviderErrors(aiProviderLabel(provider), async () => {
```

and the callback's close — the lines `      return full;` / `    }` / `  );` at :1935-1937 — becomes `      return full;` / `    })` / `  );`.

2. `transcribeAudioWithAI`, OpenAI branch: `      async () => {` at :956 becomes

```ts
      () => translatingProviderErrors("OpenAI", async () => {
```

and its close — `        return { text, engine: "whisper" as const };` / `      },` / `    );` at :982-984 — becomes the same first line, then `      }),`, then `    );`.

3. `transcribeAudioWithAI`, Gemini branch: `      async (report) => {` at :1000 becomes

```ts
      (report) => translatingProviderErrors("Gemini", async () => {
```

and its close — `        return { text, engine: "gemini" as const };` / `      },` / `    );` at :1040-1042 — becomes the same first line, then `      }),`, then `    );`.

4. `createEmbedding`: `    async (report) => {` at :1549 becomes

```ts
    (report) => translatingProviderErrors(aiProviderLabel(backend), async () => {
```

and its close — `      return values;` / `    },` / `  );` at :1572-1574 — becomes `      return values;` / `    }),` / `  );`.

5. `createEmbeddingsBatch`: `    async (report) => {` at :1597 becomes

```ts
    (report) => translatingProviderErrors(aiProviderLabel(backend), async () => {
```

and its close — `      return values;` / `    },` / `  );` at :1626-1628 — becomes `      return values;` / `    }),` / `  );`.

(`report` stays in scope inside each inner arrow. `aiProviderLabel` takes `"gemini" | "openai" | "anthropic"`, which covers both `AiProvider` and `EmbeddingBackend`.)

- [ ] **Step 5: Run it and watch it pass**

Run: `npx tsx scripts/smoke-friendly-error.ts && npx tsx scripts/smoke-chat-pipeline.ts && npx tsx scripts/smoke-embedding-cache.ts && npx tsx scripts/smoke-usage-events.ts`
Expected: `ALL PASS` and the other three green; exit 0.

- [ ] **Step 6: Typecheck, lint** — `npm run typecheck && npm run lint`. Expected: exit 0.

- [ ] **Step 7: Verify in the browser** — start `orbit-web` (demo mode uses the dev server's own key), open `/chat`, ask "Who do I know at Stripe?" and confirm the answer still streams in. The refused-key path is exercised end to end in Task 12's browser step.

- [ ] **Step 8: Commit**

```bash
git add src/lib/errors.ts src/lib/ai.ts scripts/smoke-friendly-error.ts
git commit -m "$(cat <<'EOF'
Translate provider errors in streaming chat, transcription and embeddings

Only completeJson and the multimodal path rewrote provider failures; these
five threw raw provider bodies, so a refused key read as a missing key in
chat and voice capture. They now rethrow the same copy inside withUsage, so
telemetry classifies them too.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: A new BYOK key is checked with one cheap call before it is saved (A9a, A9d)

**Files:**
- Create: `src/lib/ai-key-check.ts`
- Modify: `src/actions/settings.ts` — import block (:32-38), `saveAiSettings` (:191-261)
- Modify: `src/components/settings/ai-settings.tsx` — state (:40), provider change (:67-74), key input (:109-121), save handler (:183-203)
- Modify: `src/components/onboarding/wizard/wizard-ai-key.tsx:36-48` (`save`)
- Create: `scripts/smoke-ai-key-check.ts`; Modify: `scripts/run-smoke.ts` (pure section)

**SDK calls (checked in `node_modules`):** Gemini `@google/genai@2.12.0` `client.models.get({ model, config: { abortSignal } })` (genai.d.ts:10078); OpenAI `openai@6.48.0` `client.models.list(options?: RequestOptions)` (resources/models.d.ts:18); Anthropic `@anthropic-ai/sdk@0.112.3` `client.models.list(params?, options?)` (resources/models.d.ts:20). All authenticated, free, read-only. Clients are built with `maxRetries: 0` so a check is one request, bounded by a 6 s timeout. Gemini answers an invalid key with **400** "API key not valid", not 401, so rejection is decided by status 401/403 **or** Task 10's `isAiKeyRejectedError` on the message.

**Interfaces:**
- Consumes Task 10's `isAiKeyRejectedError`; `AI_PROVIDERS`, `DEFAULT_MODELS`, `AiProvider` from `src/lib/ai-providers.ts`.
- Produces in `src/lib/ai-key-check.ts`: `type KeyCheckVerdict = "accepted" | "rejected" | "unverified"`; `type KeyProbe = (apiKey: string, signal: AbortSignal) => Promise<void>`; `KEY_CHECK_TIMEOUT_MS = 6000`; `KEY_PROBES: Record<AiProvider, KeyProbe>`; `isKeyRejection(err: unknown): boolean`; `checkAiKey(provider, apiKey, opts?: { probes?: Record<AiProvider, KeyProbe>; timeoutMs?: number }): Promise<KeyCheckVerdict>`; `type KeyCheckOutcome = { save: true; note: string | null } | { save: false; error: string }`; `keyCheckOutcome(verdict, provider): KeyCheckOutcome`.
- Changes: `saveAiSettings` returns `{ ok: true; embeddingReset: boolean; keyNote: string | null } | { ok: false; error: string }` (no exported type — it lives in a `"use server"` file; callers infer it).

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-ai-key-check.ts`:

```ts
/**
 * Pins the save-time BYOK key check (audit A9): a refused key is refused with the
 * provider's name, a network failure or timeout still saves (a provider outage must not
 * stop someone saving a good key), and the check never waits longer than its budget.
 *
 * Pure: the provider calls are injected. Run: npx tsx scripts/smoke-ai-key-check.ts
 */
import {
  checkAiKey,
  isKeyRejection,
  keyCheckOutcome,
  KEY_PROBES,
  type KeyProbe,
} from "../src/lib/ai-key-check";
import type { AiProvider } from "../src/lib/ai-providers";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const withStatus = (message: string, status: number) => Object.assign(new Error(message), { status });
const all = (probe: KeyProbe): Record<AiProvider, KeyProbe> => ({ gemini: probe, openai: probe, anthropic: probe });

async function main() {
  console.log("Verdicts");
  let seen = "";
  check("a probe that resolves → accepted",
    (await checkAiKey("openai", "sk-good", { probes: all(async (key) => { seen = key; }) })) === "accepted");
  check("…and the probe received the key", seen === "sk-good");
  check("401 → rejected", (await checkAiKey("openai", "k", { probes: all(async () => { throw withStatus("401 Incorrect API key provided", 401); }) })) === "rejected");
  check("403 → rejected", (await checkAiKey("anthropic", "k", { probes: all(async () => { throw withStatus("403 permission_error", 403); }) })) === "rejected");
  check("Gemini's 400 'API key not valid' → rejected",
    (await checkAiKey("gemini", "k", { probes: all(async () => { throw withStatus("API key not valid. Please pass a valid API key.", 400); }) })) === "rejected");
  check("a 500 → unverified", (await checkAiKey("gemini", "k", { probes: all(async () => { throw withStatus("500 internal", 500); }) })) === "unverified");
  check("a network error → unverified", (await checkAiKey("openai", "k", { probes: all(async () => { throw new TypeError("fetch failed"); }) })) === "unverified");

  const started = Date.now();
  const hung = await checkAiKey("anthropic", "k", { timeoutMs: 50, probes: all(() => new Promise<void>(() => {})) });
  check("a probe that never answers → unverified", hung === "unverified");
  check("…within the budget, not the probe's pace", Date.now() - started < 1000, `${Date.now() - started}ms`);
  let aborted = false;
  await checkAiKey("gemini", "k", {
    timeoutMs: 50,
    probes: all((_key, signal) => new Promise<void>((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }))),
  });
  check("the timeout aborts the probe's request", aborted);

  console.log("\nisKeyRejection");
  check("a status-less refused body counts", isKeyRejection(new Error("invalid x-api-key")));
  check("a rate limit does not", !isKeyRejection(withStatus("429 rate limit", 429)));

  console.log("\nWhat the person reads");
  const rejected = keyCheckOutcome("rejected", "gemini");
  check("rejected → not saved, with the provider's name",
    rejected.save === false && rejected.error === "Google Gemini didn’t accept that key — check it and try again", JSON.stringify(rejected));
  const unverified = keyCheckOutcome("unverified", "openai");
  check("unverified → saved with a note", unverified.save === true && unverified.note === "Saved — OpenAI didn’t answer, so the key isn’t checked yet", JSON.stringify(unverified));
  const accepted = keyCheckOutcome("accepted", "anthropic");
  check("accepted → saved, no note", accepted.save === true && accepted.note === null);
  const copy = [rejected.save ? "" : rejected.error, unverified.save ? unverified.note ?? "" : ""];
  check("house voice: curly apostrophes, no trailing period",
    copy.every((m) => !m.includes("'") && !m.endsWith(".")));

  console.log("\nEvery provider has a real probe");
  check("gemini, openai and anthropic", ["gemini", "openai", "anthropic"].every((p) => typeof KEY_PROBES[p as AiProvider] === "function"));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll AI key check checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Register it** — pure block, after `"smoke-admin-yc-calculations": "pure",`, add `  "smoke-ai-key-check": "pure",`.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx scripts/smoke-ai-key-check.ts`
Expected: exits nonzero with a module-not-found error for `../src/lib/ai-key-check`.

- [ ] **Step 4: Implement the checker**

Create `src/lib/ai-key-check.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { AI_PROVIDERS, DEFAULT_MODELS, type AiProvider } from "@/lib/ai-providers";
import { isAiKeyRejectedError } from "@/lib/errors";

/**
 * One cheap, read-only provider call that answers "does this key work", made when a key is
 * saved. Saving `AIzaSy-INVALID-…` used to say "AI settings saved" and "Your key is saved",
 * and the first question then failed with copy telling the person to add a key (audit A9).
 *
 * Three verdicts, not two: a refusal (401/403, or a refused-key body) blocks the save; a
 * network error, timeout or 5xx saves anyway with a note, because a provider outage must
 * never stop someone saving a good key.
 *
 * Server-only: imported by `src/actions/settings.ts`. No `@/db`, no `next/server`.
 */
export type KeyCheckVerdict = "accepted" | "rejected" | "unverified";
export type KeyProbe = (apiKey: string, signal: AbortSignal) => Promise<void>;

export const KEY_CHECK_TIMEOUT_MS = 6_000;

export const KEY_PROBES: Record<AiProvider, KeyProbe> = {
  // Metadata for one model that exists: authenticated, free, a few hundred bytes.
  gemini: async (apiKey, signal) => {
    await new GoogleGenAI({ apiKey }).models.get({
      model: DEFAULT_MODELS.gemini,
      config: { abortSignal: signal },
    });
  },
  openai: async (apiKey, signal) => {
    await new OpenAI({ apiKey, maxRetries: 0 }).models.list({ signal });
  },
  anthropic: async (apiKey, signal) => {
    await new Anthropic({ apiKey, maxRetries: 0 }).models.list({ limit: 1 }, { signal });
  },
};

export function isKeyRejection(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return true;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return isAiKeyRejectedError(message);
}

export async function checkAiKey(
  provider: AiProvider,
  apiKey: string,
  opts: { probes?: Record<AiProvider, KeyProbe>; timeoutMs?: number } = {}
): Promise<KeyCheckVerdict> {
  const probe = (opts.probes ?? KEY_PROBES)[provider];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("key check timed out"));
    }, opts.timeoutMs ?? KEY_CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(apiKey, controller.signal), deadline]);
    return "accepted";
  } catch (err) {
    return isKeyRejection(err) ? "rejected" : "unverified";
  } finally {
    clearTimeout(timer);
  }
}

export type KeyCheckOutcome = { save: true; note: string | null } | { save: false; error: string };

export function keyCheckOutcome(verdict: KeyCheckVerdict, provider: AiProvider): KeyCheckOutcome {
  const label = AI_PROVIDERS.find((p) => p.id === provider)?.label ?? "Your AI provider";
  if (verdict === "rejected") {
    return { save: false, error: `${label} didn’t accept that key — check it and try again` };
  }
  if (verdict === "unverified") {
    return { save: true, note: `Saved — ${label} didn’t answer, so the key isn’t checked yet` };
  }
  return { save: true, note: null };
}
```

- [ ] **Step 5: The action checks before it saves**

In `src/actions/settings.ts`, add `import { checkAiKey, keyCheckOutcome } from "@/lib/ai-key-check";` after the `@/lib/ai` import. In `saveAiSettings`, replace

```ts
  const encrypted = input.apiKey?.trim()
    ? encrypt(input.apiKey.trim())
    : null;
```

with

```ts
  // Only a NEWLY entered key is checked; saving a model change with the key left blank
  // costs no provider call.
  const newKey = input.apiKey?.trim() || null;
  let keyNote: string | null = null;
  if (newKey) {
    const outcome = keyCheckOutcome(await checkAiKey(provider, newKey), provider);
    // Returned, not thrown: a thrown message is a digest in production.
    if (!outcome.save) return { ok: false as const, error: outcome.error };
    keyNote = outcome.note;
  }
  const encrypted = newKey ? encrypt(newKey) : null;
```

and replace the final `return { ok: true, embeddingReset: … };` with:

```ts
  return {
    ok: true as const,
    embeddingReset: Boolean(previousBackend && nextBackend && previousBackend !== nextBackend),
    keyNote,
  };
```

- [ ] **Step 6: Show the refusal inline**

In `src/components/settings/ai-settings.tsx`: after `const [apiKey, setApiKey] = useState("");` (:40) add `const [keyError, setKeyError] = useState<string | null>(null);`. In the provider `onValueChange` (:67-74) add `setKeyError(null);` after `setApiKey("");`. Replace the key `<Input … />` (:111-120) with:

```tsx
        <Input
          id="key"
          type="password"
          placeholder={
            activeProviderStatus?.hasPersonalKey
              ? "•••••••• (leave blank to keep current)"
              : providerMeta.keyPlaceholder
          }
          value={apiKey}
          aria-invalid={keyError ? true : undefined}
          aria-describedby={keyError ? "key-error" : undefined}
          onChange={(e) => {
            setApiKey(e.target.value);
            setKeyError(null);
          }}
        />
        {keyError && (
          <p id="key-error" role="alert" className="text-sm text-destructive">
            {keyError}
          </p>
        )}
```

Replace the save `try { … }` body (:185-198) with:

```tsx
              try {
                const res = await saveAiSettings({
                  provider,
                  model,
                  apiKey: apiKey.trim() || undefined,
                });
                if (!res.ok) {
                  setKeyError(res.error);
                  return;
                }
                setKeyError(null);
                setApiKey("");
                setSettings(await getSettings());
                toast.success(
                  res.keyNote ??
                    (res.embeddingReset
                      ? "Saved — search will re-index for the new provider"
                      : "AI settings saved")
                );
```

In `src/components/onboarding/wizard/wizard-ai-key.tsx`, replace the `try` body in `save()` (:40-43) with:

```tsx
      try {
        const res = await saveAiSettings({ provider, apiKey: key });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.keyNote ?? `${meta?.label ?? "AI"} key saved`);
        onSaved();
```

- [ ] **Step 7: Run it and watch it pass**

Run: `npx tsx scripts/smoke-ai-key-check.ts && npx tsx scripts/smoke-toast-copy.ts`
Expected: `All AI key check checks passed.`; toast copy green; exit 0.

- [ ] **Step 8: Typecheck, lint, manifest** — `npm run typecheck && npm run lint && npx tsx scripts/run-smoke.ts --check`. Expected: exit 0.

- [ ] **Step 9: Verify in the browser**

Start `orbit-web` from `.claude/launch.json`. Open `http://localhost:3001/settings?integration=ai`. Provider: Google Gemini. Click the key field and type (real keystrokes) `AIzaSyD-not-a-real-key-000000000000000`, then click **Save settings**. Expected within ~6 s: a red line under the field reading "Google Gemini didn’t accept that key — check it and try again", no success toast, and the Status line unchanged. Type one more character: the red line disappears. Then open `/chat` and ask a question: it still answers with the previously configured key (nothing was saved). Check at 375 px width that the error line wraps inside the card.

- [ ] **Step 10: Commit**

```bash
git add src/lib/ai-key-check.ts src/actions/settings.ts src/components/settings/ai-settings.tsx src/components/onboarding/wizard/wizard-ai-key.tsx scripts/smoke-ai-key-check.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Check a new AI key with one cheap provider call before saving it

An invalid key saved as "Your key is saved" and every later AI call failed
with missing-key copy. Saving now makes one read-only call (Gemini models.get,
OpenAI/Anthropic models.list, 6 s budget): a refusal is shown inline and
nothing is saved; an outage or timeout saves with a note.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: A valid Opus preset, and no `temperature` for models that reject it (B8 subset)

**Files:**
- Modify: `src/lib/ai-providers.ts:48` (preset), `:58-61` (`LEGACY_MODEL_MAP`), new `anthropicAcceptsTemperature`
- Modify: `src/lib/ai-pricing.ts:35-38` (Anthropic rows)
- Modify: `src/lib/ai.ts` — import (:36-42) and the three Anthropic calls: `completeJson` (:641-647), `completeMultimodalJsonInner` (:823-829), `streamText` (:1916-1922)
- Modify: `scripts/smoke-fast-model.ts` (no script covered `resolveAiModel` before; this is the pure script that already imports the model roster)

**Decision.** `claude-opus-4` is not a model id (the Opus 4.0 alias is `claude-opus-4-0`, now deprecated). The replacement is **`claude-opus-4-5`** — the audit's first suggestion and the same generation as the picker's `claude-sonnet-4-5` / `claude-haiku-4-5`, listed Active in the Claude API model table, $5 / $25 per 1M tokens, $0.50 cache read. Not `claude-opus-5`: on Opus 5 omitting `thinking` runs adaptive thinking, whose tokens count against the 4096-token `max_tokens` the house calls use, which would truncate JSON extraction; moving the picker to the 5-family belongs with the rest of B8 (Phase 3a). `LEGACY_MODEL_MAP` maps stored `claude-opus-4` to `claude-opus-4-5`, so saved settings migrate on read through `resolveAiModel`.

**Temperature.** Per the Claude API reference, sampling parameters (`temperature`/`top_p`/`top_k`) return a 400 on Opus 4.7, Opus 4.8, Opus 5, Sonnet 5 and the Fable family, and are allowed on Opus 4.6 and earlier, Sonnet 4.6/4.5 and Haiku 4.5. The house code relies on low temperatures (0.1–0.3) for extraction on the models that accept them, so it is not dropped everywhere: an **allowlist** of accepting families decides, and any unknown or custom id (always newer than the list) omits it — omitting is accepted by every model.

**Interfaces:** Produces `anthropicAcceptsTemperature(model: string): boolean` in `src/lib/ai-providers.ts` (client-importable, pure).

- [ ] **Step 1: Write the failing test**

Replace the body of `main()` in `scripts/smoke-fast-model.ts` with the existing loop plus the new checks, and extend its imports:

```ts
import { FAST_MODELS } from "../src/lib/ai";
import {
  AI_PROVIDERS,
  PROVIDER_MODELS,
  anthropicAcceptsTemperature,
  resolveAiModel,
} from "../src/lib/ai-providers";
import { priceFor } from "../src/lib/ai-pricing";
import { readFileSync } from "node:fs";
```

```ts
async function main() {
  for (const p of AI_PROVIDERS) {
    const fast = FAST_MODELS[p.id];
    check(`${p.id} has a fast model`, typeof fast === "string" && fast.length > 0);
    check(
      `${p.id} fast model is in the known roster`,
      PROVIDER_MODELS[p.id].some((m) => m.value === fast),
      fast
    );
  }

  // B8: `claude-opus-4` is not a model id, so every Anthropic user who picked it got
  // "That Anthropic model isn't available" on every feature.
  check("no preset is the invalid claude-opus-4", !PROVIDER_MODELS.anthropic.some((m) => m.value === "claude-opus-4"));
  check("the Opus preset is claude-opus-4-5", PROVIDER_MODELS.anthropic.some((m) => m.value === "claude-opus-4-5"));
  check("a stored claude-opus-4 migrates on read", resolveAiModel("anthropic", "claude-opus-4") === "claude-opus-4-5", resolveAiModel("anthropic", "claude-opus-4"));
  for (const p of AI_PROVIDERS) {
    for (const m of PROVIDER_MODELS[p.id]) {
      check(`${m.value} has a price row`, priceFor(m.value) !== null);
    }
  }
  const opus = priceFor("claude-opus-4-5");
  check("claude-opus-4-5 prices at $5 / $25, not the Opus 4.0 row", opus?.input === 5 && opus?.output === 25, JSON.stringify(opus));

  check("sonnet 4.5 accepts temperature", anthropicAcceptsTemperature("claude-sonnet-4-5"));
  check("a dated sonnet 4.5 snapshot accepts it", anthropicAcceptsTemperature("claude-sonnet-4-5-20250929"));
  check("haiku 4.5 accepts it", anthropicAcceptsTemperature("claude-haiku-4-5"));
  check("opus 4.5 accepts it", anthropicAcceptsTemperature("claude-opus-4-5"));
  check("opus 4.7 does not", !anthropicAcceptsTemperature("claude-opus-4-7"));
  check("opus 5 does not", !anthropicAcceptsTemperature("claude-opus-5"));
  check("sonnet 5 does not", !anthropicAcceptsTemperature("claude-sonnet-5"));
  check("an unknown future id does not (omitting is always safe)", !anthropicAcceptsTemperature("claude-something-6"));

  const aiSource = readFileSync("src/lib/ai.ts", "utf8");
  check(
    "all three Anthropic calls gate temperature",
    (aiSource.match(/anthropicAcceptsTemperature\(model\)/g)?.length ?? 0) === 3
  );
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-fast-model.ts`
Expected: `no preset is the invalid claude-opus-4 failed` thrown by the first new check (this script's `check` throws); exit 1.

- [ ] **Step 3: Implement**

In `src/lib/ai-providers.ts`, change line 48 to `    { value: "claude-opus-4-5", label: "Claude Opus 4.5" },`, and replace `LEGACY_MODEL_MAP` (:58-61) with:

```ts
const LEGACY_MODEL_MAP: Record<string, string> = {
  "gemini-2.5-flash": "gemini-3.5-flash",
  "gemini-2.5-flash-lite": "gemini-3.1-flash-lite",
  // Was offered as a preset but was never a valid Anthropic id (the 4.0 alias is
  // claude-opus-4-0). Stored settings migrate on read.
  "claude-opus-4": "claude-opus-4-5",
};

/**
 * Anthropic model families that still accept `temperature`.
 *
 * An ALLOWLIST on purpose: Opus 4.7 and later, Sonnet 5 and the Fable family reject
 * sampling parameters with a 400, and a custom id typed into Settings is newer than any
 * list. Omitting temperature is accepted by every model, so an unknown id falls safe.
 */
const ANTHROPIC_TEMPERATURE_FAMILIES = [
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-0",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-opus-4-0",
  "claude-3",
];

export function anthropicAcceptsTemperature(model: string): boolean {
  return ANTHROPIC_TEMPERATURE_FAMILIES.some(
    (family) => model === family || model.startsWith(`${family}-`)
  );
}
```

In `src/lib/ai-pricing.ts`, replace the Anthropic block (:35-38) with:

```ts
  // Anthropic
  "claude-sonnet-4-5": { input: 3, output: 15, cachedInput: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1 },
  "claude-opus-4-5": { input: 5, output: 25, cachedInput: 0.5 },
  // Opus 4.0 / 4.1, reachable only as a typed custom id. Longest-prefix matching keeps
  // claude-opus-4-5 on its own row above.
  "claude-opus-4": { input: 15, output: 75, cachedInput: 1.5 },
```

In `src/lib/ai.ts`, add `anthropicAcceptsTemperature,` to the `@/lib/ai-providers` import (:36-42). In each of the three Anthropic request objects replace the line `temperature,` with:

```ts
          // Opus 4.7+, Sonnet 5 and Fable reject sampling parameters with a 400.
          ...(anthropicAcceptsTemperature(model) ? { temperature } : {}),
```

— in `completeJson` inside `client.messages.create({ … })` (:644), in `completeMultimodalJsonInner` inside `client.messages.create({ … })` (:826), and in `streamText` inside `client.messages.stream({ … })` (:1920). Leave the Gemini and OpenAI `temperature` lines alone.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-fast-model.ts && npx tsx scripts/smoke-usage-events.ts`
Expected: every line `ok`, exit 0 for both.

- [ ] **Step 5: Typecheck, lint** — `npm run typecheck && npm run lint`. Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai-providers.ts src/lib/ai-pricing.ts src/lib/ai.ts scripts/smoke-fast-model.ts
git commit -m "$(cat <<'EOF'
Replace the invalid claude-opus-4 preset and stop sending temperature to models that reject it

claude-opus-4 was never a model id, so everyone who picked it got "model not
available" everywhere. The preset is now claude-opus-4-5 (stored settings
migrate on read, priced at $5/$25). Anthropic calls send temperature only to
families that accept it; unknown and newer ids omit it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Replies to outreach reach the sender, not Orbit (A11, reply-to)

**Files:**
- Create: `src/lib/outreach-email.ts`
- Modify: `src/lib/outreach-send.ts` — `getOutreachSendConfig` return (:29-43), the Resend call (:109-115)
- Create: `scripts/smoke-outreach-email.ts`; Modify: `scripts/run-smoke.ts` (pure section)
- Modify: `scripts/smoke-outreach-guards.ts` (one check before the final `await cleanup();`)

The sender's address is already on the row `getOutreachSendConfig` loads: `user_settings.email`, mirrored from Clerk by the `user.created`/`user.updated` webhook (`setUserEmail`). The contact follow-up email (`src/actions/contacts.ts:1381`) goes through the same `sendOutreachMessage`, so it gets the reply-to too. A verified BYOK `from` address needs a new column and is deferred (Phase 3a).

**Interfaces:** Produces `outreachEmailPayload(input: { from: string; to: string; subject: string | null | undefined; text: string; replyTo: string | null | undefined }): { from: string; to: string; subject: string; text: string; replyTo?: string }` in `src/lib/outreach-email.ts`. `getOutreachSendConfig(userId)` gains `replyTo: string | null`. Resend's option is `replyTo` (`node_modules/resend/dist/index.d.mts:559`, resend 6.17.2).

- [ ] **Step 1: Write the failing tests**

Create `scripts/smoke-outreach-email.ts`:

```ts
/**
 * Pins the Resend payload for outreach email (audit A11): hosted mail goes out from
 * Orbit's RESEND_FROM_EMAIL, so without `replyTo` a recruiter's reply landed in Orbit's
 * inbox instead of the user's.
 *
 * Pure. Run: npx tsx scripts/smoke-outreach-email.ts
 */
import { outreachEmailPayload } from "../src/lib/outreach-email";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const base = { from: "Orbit <outreach@orbit.example>", to: "jordan@acme.example.com", text: "Hi Jordan" };
const withReply = outreachEmailPayload({ ...base, subject: "Coffee?", replyTo: "  me@person.example.com " });
check("replies go to the sender", withReply.replyTo === "me@person.example.com", JSON.stringify(withReply));
check("…while the From stays Orbit's verified address", withReply.from === base.from);
const noReply = outreachEmailPayload({ ...base, subject: "Coffee?", replyTo: null });
check("no sender email → no replyTo key at all (never an empty string)", !("replyTo" in noReply), JSON.stringify(noReply));
check("a blank subject still gets one", outreachEmailPayload({ ...base, subject: "  ", replyTo: null }).subject === "Hello");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll outreach email checks passed.");
process.exit(0);
```

Register it in the pure block after `"smoke-meeting-upload-queue": "pure",`: `  "smoke-outreach-email": "pure",`.

In `scripts/smoke-outreach-guards.ts`, add `getOutreachSendConfig` to the `../src/lib/outreach-send` import and insert before the final `await cleanup();`:

```ts
  console.log("\nReplies go to the sender");
  await db.update(userSettings).set({ email: "demo.sender@orbit.example.com" }).where(eq(userSettings.userId, USER));
  const config = await getOutreachSendConfig(USER);
  check("the send config carries the sender's email as replyTo", config.replyTo === "demo.sender@orbit.example.com", String(config.replyTo));
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx scripts/smoke-outreach-email.ts; npx tsx scripts/smoke-outreach-guards.ts`
Expected: the first exits nonzero with a module-not-found error for `../src/lib/outreach-email`; the second prints `FAIL the send config carries the sender's email as replyTo` (`undefined`); both exit 1.

- [ ] **Step 3: Implement**

Create `src/lib/outreach-email.ts`:

```ts
/**
 * The Resend payload for one outreach email.
 *
 * Hosted sending goes out FROM Orbit's verified `RESEND_FROM_EMAIL` — the only address it
 * can send from — so `replyTo` is what routes a recipient's reply to the person who wrote
 * the message. Pure, so the routing is pinned without a network
 * (`scripts/smoke-outreach-email.ts`).
 */
export function outreachEmailPayload(input: {
  from: string;
  to: string;
  subject: string | null | undefined;
  text: string;
  replyTo: string | null | undefined;
}) {
  const replyTo = input.replyTo?.trim();
  return {
    from: input.from,
    to: input.to,
    subject: input.subject?.trim() || "Hello",
    text: input.text,
    ...(replyTo ? { replyTo } : {}),
  };
}
```

In `src/lib/outreach-send.ts`, add `import { outreachEmailPayload } from "@/lib/outreach-email";`. In `getOutreachSendConfig`'s returned object, after `fromEmail: …,` add:

```ts
    // The sender's own address (mirrored from Clerk), so replies reach them, not Orbit.
    replyTo: settings?.email?.trim() || null,
```

and replace the Resend call (:110-115) with:

```ts
    const result = await resend.emails.send(
      outreachEmailPayload({
        from: config.fromEmail,
        to: input.toEmail,
        subject: input.subject,
        text: body,
        replyTo: config.replyTo,
      })
    );
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx tsx scripts/smoke-outreach-email.ts && npx tsx scripts/smoke-outreach-guards.ts`
Expected: `All outreach email checks passed.` and `All outreach guard checks passed.`; exit 0.

- [ ] **Step 5: Typecheck, lint, manifest** — `npm run typecheck && npm run lint && npx tsx scripts/run-smoke.ts --check`. Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/outreach-email.ts src/lib/outreach-send.ts scripts/smoke-outreach-email.ts scripts/smoke-outreach-guards.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Send outreach replies to the person who wrote the message

Hosted outreach mail went out from RESEND_FROM_EMAIL with no replyTo, so a
recruiter's reply landed in Orbit's inbox. The payload now sets replyTo to
the sender's own address from user_settings.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: A Resend rejection is recorded and pages the ops channel (A11, alerting)

**Files:**
- Modify: `src/lib/error-events.ts` — `ERROR_SOURCES` (:30-83)
- Modify: `src/lib/interest-list-email.ts` — imports (:1-6), `deliver` error branches (:442-449)
- Modify: `src/lib/outreach-send.ts` — the `result.error` branch (:117-119)
- Modify: `src/lib/ops-alerts.ts` — `OpsSnapshot` (:45), `evaluateOpsConditions` (before :138)
- Modify: `src/lib/ops-sweep.ts:86` and `:115`
- Modify: `scripts/smoke-ops-alerts.ts` (`HEALTHY` :33-51, checks after :98), `scripts/smoke-ops-sweep.ts` (imports :15-19; a block after the last `await reset();`, :104)
- Modify: `docs/RUNBOOK.md` alert table (after the `stripe.checkout_error` row, :41)

**Closed-set rule check** (`src/lib/error-events.ts:5-27`): a Resend rejection is (a) invisible today — the interest list logs it to a console Vercel keeps for an hour (that is how every Sep 7–9 waitlist welcome vanished), outreach turns it into a per-message error only the sender sees; (b) recorded nowhere else; (c) bounded by signups and by `DAILY_SEND_LIMIT`. It qualifies. Because a misconfigured `RESEND_FROM_EMAIL` rejects every send at once, one row in the last hour opens the condition.

**Interfaces:** Produces `ERROR_SOURCES.resendRejected = "resend.rejected"`; `OpsSnapshot.resendRejectedLastHour: number`; condition id `"resend.rejected"` (severity `warning`). The only `OpsSnapshot` builders are `loadOpsSnapshot` and the smoke fixture (checked with `grep -rn OpsSnapshot src scripts`).

- [ ] **Step 1: Write the failing tests**

In `scripts/smoke-ops-alerts.ts`, add `  resendRejectedLastHour: 0,` after `stripeCheckoutErrorsLastHour: 0,` in `HEALTHY`, and after the `stripe.checkout_error` check (:97-98) add:

```ts
  check("a Resend rejection in the last hour → resend.rejected (warning)",
    find({ ...HEALTHY, resendRejectedLastHour: 1 }, "resend.rejected")?.severity === "warning");
  check("…whose detail names the usual cause",
    Boolean(find({ ...HEALTHY, resendRejectedLastHour: 3 }, "resend.rejected")?.detail.includes("RESEND_FROM_EMAIL")));
```

In `scripts/smoke-ops-sweep.ts`, change the schema import to `import { cronRuns, errorEvents, opsAlertState, webhookDeliveries } from "../src/db/schema";`, add `import { ERROR_SOURCES } from "../src/lib/error-events";`, change the sweep import to `import { loadOpsSnapshot, runOpsSweep, type OpsDelivery } from "../src/lib/ops-sweep";`, and insert after the last `await reset();` (:104):

```ts
  console.log("\nA Resend rejection reaches the snapshot...");
  const [rejection] = await db
    .insert(errorEvents)
    .values({ source: ERROR_SOURCES.resendRejected, kind: "interest.welcome", message: "The gmail.com domain is not verified" })
    .returning();
  const snapshot = await loadOpsSnapshot(new Date(), null);
  check("resendRejectedLastHour counts it", snapshot.resendRejectedLastHour >= 1, String(snapshot.resendRejectedLastHour));
  await db.delete(errorEvents).where(eq(errorEvents.id, rejection.id));
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx scripts/smoke-ops-alerts.ts; npx tsx scripts/smoke-ops-sweep.ts`
Expected: `FAIL a Resend rejection in the last hour → resend.rejected (warning)` and `FAIL …whose detail names the usual cause`; the sweep script aborts on a NOT NULL violation for `error_events.source` (`ERROR_SOURCES.resendRejected` is undefined); both exit 1.

- [ ] **Step 3: Implement the source and the recordings**

In `src/lib/error-events.ts`, add inside `ERROR_SOURCES` after `providerHealthCheck: "provider.health_check",`:

```ts
  /**
   * Resend refused an email Orbit tried to send: an interest-list welcome or follow-up, or
   * an outreach message. Invisible before — a console line Vercel keeps for an hour (every
   * waitlist welcome of Sep 7–9 2026 died this way) or a per-message error only the sender
   * saw. Bounded by signups and `DAILY_SEND_LIMIT`. A `RESEND_FROM_EMAIL` on an unverified
   * domain rejects every send at once, so the ops sweep opens `resend.rejected` on one row.
   */
  resendRejected: "resend.rejected",
```

In `src/lib/interest-list-email.ts`, add `import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";` after the `resend` import, and replace the two error branches in `deliver` (:442-449, from `if (error) {` through the `catch` block's `return false; }`) with:

```ts
    if (error) {
      console.error(`[interest-list] Resend rejected the ${kind} email`, error);
      await recordErrorEvent({
        source: ERROR_SOURCES.resendRejected,
        kind: `interest.${kind}`,
        message: error,
        context: { phase: "rejected", name: error.name },
      });
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[interest-list] Failed to send the ${kind} email`, err);
    await recordErrorEvent({
      source: ERROR_SOURCES.resendRejected,
      kind: `interest.${kind}`,
      message: err,
      context: { phase: "threw" },
    });
    return false;
  }
```

(`recordErrorEvent` never throws, so `deliver` keeps its "never throws" contract.)

In `src/lib/outreach-send.ts`, add `import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";` and replace

```ts
    if (result.error) {
      throw new Error(result.error.message);
    }
```

with

```ts
    if (result.error) {
      await recordErrorEvent({
        source: ERROR_SOURCES.resendRejected,
        kind: "outreach",
        userId: input.userId,
        message: result.error,
        context: { name: result.error.name },
      });
      throw new Error(result.error.message);
    }
```

- [ ] **Step 4: Implement the condition**

In `src/lib/ops-alerts.ts`, add after `stripeCheckoutErrorsLastHour: number;` (:45):

```ts
  /** `error_events` rows from `resend.rejected` in the last hour. */
  resendRejectedLastHour: number;
```

and directly before `if (s.wedgedImports > 0) {` (:138):

```ts
  if (s.resendRejectedLastHour > 0) {
    out.push({
      id: "resend.rejected",
      severity: "warning",
      title: "Resend is refusing Orbit's email",
      detail: `${s.resendRejectedLastHour} email(s) refused in the last hour — usually RESEND_FROM_EMAIL is on a domain Resend has not verified, which refuses every send.`,
      href: "/admin/health",
    });
  }
```

In `src/lib/ops-sweep.ts`, after `const stripeCheckout = …;` (:86) add `const resendRejected = bySource.get(ERROR_SOURCES.resendRejected) ?? 0;`, and after `stripeCheckoutErrorsLastHour: stripeCheckout,` (:115) add `    resendRejectedLastHour: resendRejected,`.

In `docs/RUNBOOK.md`, add after the `stripe.checkout_error` row (:41):

```markdown
| `resend.rejected` | `/admin/health` → error events → `resend.rejected` shows Resend's message. "domain is not verified" = `RESEND_FROM_EMAIL` must be on a domain verified under Resend → Domains; fix it in Vercel and redeploy. |
```

- [ ] **Step 5: Run them and watch them pass**

Run: `npx tsx scripts/smoke-ops-alerts.ts && npx tsx scripts/smoke-ops-sweep.ts && npx tsx scripts/smoke-interest-list-join.ts && npx tsx scripts/smoke-outreach-guards.ts`
Expected: all green, exit 0.

- [ ] **Step 6: Typecheck, lint** — `npm run typecheck && npm run lint`. Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/error-events.ts src/lib/interest-list-email.ts src/lib/outreach-send.ts src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-ops-alerts.ts scripts/smoke-ops-sweep.ts docs/RUNBOOK.md
git commit -m "$(cat <<'EOF'
Record Resend rejections and alert on them

Production rejected every waitlist welcome for days (RESEND_FROM_EMAIL was a
gmail.com address) and only a one-hour console log knew. Interest-list and
outreach rejections now write a resend.rejected error event, and the ops
sweep opens a warning on the first one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Signed-out API calls get a JSON 401, and chat says so (B1)

**Files:**
- Create: `src/lib/api-signed-out.ts`
- Modify: `src/proxy.ts` — imports (:1-11), the `clerkMiddleware` callback (:96-101)
- Modify: `src/lib/chat-stream-client.ts` — new exports, and the response check in `streamChat` (:45-55)
- Modify: `scripts/smoke-chat-stream.ts` (imports :13-19; new checks before the final `if (failures > 0)`)

**Why the 307 happened (read from `node_modules/@clerk/nextjs/dist/esm/server/protect.js`, v7.5.20).** `auth.protect()` redirects when `isPageRequest(req)` is true, answers 401 for server actions and 404 otherwise. `isPageRequest` includes `isPagePathAvailable()`, which is true whenever Next's patched fetch store carries a page — inferred to be the case inside `proxy.ts`, which is why curl without an `Accept: text/html` header still got a 307. So `/api/*` stops calling `protect()` and checks `auth().userId` itself, returning `NextResponse.json(…, { status: 401 })` — the pattern the Next 16 proxy guide shows under "Producing a response" (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md:557-600`).

**Server actions keep their current behaviour, deliberately.** They POST to page URLs with a `Next-Action` header, never to `/api/*`, so this change does not touch them. Signed out, they get the same redirect as before; the Next action client rejects the HTML response and the caller's `friendlyError` fallback toast shows — an error, not a silent hang, and every action body also re-checks with `requireUserId()`. Changing page-path handling in the proxy risks page navigations (which must redirect) for no user-visible gain; the silent hang was specific to the SSE chat stream.

**Interfaces:** Produces in `src/lib/api-signed-out.ts` (import-free, pure): `API_SIGNED_OUT_STATUS = 401`, `API_SIGNED_OUT_BODY = { error: "You’re signed out — sign in again", code: "signed_out" }`, `isApiPath(pathname: string): boolean`. Produces in `src/lib/chat-stream-client.ts`: `CHAT_SIGNED_OUT_MESSAGE`, `type ChatResponseKind = "stream" | "signed_out" | "error"`, `classifyChatResponse(res: { status: number; ok: boolean; contentType: string | null }): ChatResponseKind`. Other `/api/*` clients already handle a 401 (e.g. `src/lib/meeting-upload-queue.ts:274`, which today never sees one).

- [ ] **Step 1: Write the failing test**

In `scripts/smoke-chat-stream.ts`, add imports:

```ts
import { CHAT_SIGNED_OUT_MESSAGE, classifyChatResponse } from "../src/lib/chat-stream-client";
import { API_SIGNED_OUT_BODY, API_SIGNED_OUT_STATUS, isApiPath } from "../src/lib/api-signed-out";
```

and insert before the final `if (failures > 0) {`:

```ts
  console.log("\nA signed-out chat request is named, not parsed as SSE");
  check("the stream itself is a stream",
    classifyChatResponse({ status: 200, ok: true, contentType: "text/event-stream; charset=utf-8" }) === "stream");
  check("a 401 is signed out", classifyChatResponse({ status: 401, ok: false, contentType: "application/json" }) === "signed_out");
  check("a followed redirect to the sign-in page (200 text/html) is signed out",
    classifyChatResponse({ status: 200, ok: true, contentType: "text/html; charset=utf-8" }) === "signed_out");
  check("a 200 with no content type is signed out, not an empty stream",
    classifyChatResponse({ status: 200, ok: true, contentType: null }) === "signed_out");
  check("a paywall 403 keeps its own JSON error", classifyChatResponse({ status: 403, ok: false, contentType: "application/json" }) === "error");
  check("a rate limit 429 keeps its own JSON error", classifyChatResponse({ status: 429, ok: false, contentType: "application/json" }) === "error");
  check("the signed-out copy follows the house voice",
    CHAT_SIGNED_OUT_MESSAGE === "You’re signed out — sign in again to keep chatting");

  console.log("\nWhich paths the proxy answers with JSON");
  check("/api/chat is an API path", isApiPath("/api/chat"));
  check("/api itself is", isApiPath("/api"));
  check("/apiary is not", !isApiPath("/apiary"));
  check("/dashboard is not", !isApiPath("/dashboard"));
  check("the body is a 401 with a readable error and a machine code",
    API_SIGNED_OUT_STATUS === 401 && API_SIGNED_OUT_BODY.code === "signed_out" && !API_SIGNED_OUT_BODY.error.includes("'"));
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-chat-stream.ts`
Expected: exits nonzero with a module-not-found error for `../src/lib/api-signed-out`.

- [ ] **Step 3: Implement**

Create `src/lib/api-signed-out.ts`:

```ts
/**
 * What an unauthenticated call to a protected `/api/*` route gets from `src/proxy.ts`.
 *
 * It used to get Clerk's 307 to /sign-in. `fetch` follows redirects, so the caller received
 * the sign-in page as `text/html` with status 200 — and the chat stream client, having
 * checked only `res.ok`, parsed HTML as SSE and spun forever (audit B1). A JSON 401 is
 * something every client can recognise.
 *
 * Import-free on purpose: the proxy and the smoke scripts both import it.
 */
export const API_SIGNED_OUT_STATUS = 401;

export const API_SIGNED_OUT_BODY = {
  error: "You’re signed out — sign in again",
  code: "signed_out",
} as const;

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}
```

In `src/proxy.ts`, add `import { API_SIGNED_OUT_BODY, API_SIGNED_OUT_STATUS, isApiPath } from "@/lib/api-signed-out";` after the `@/lib/app-url` import, and replace the callback (:96-101) with:

```ts
      async (auth, req) => {
        if (!isPublicRoute(req)) {
          if (isApiPath(new URL(req.url).pathname)) {
            // API callers get JSON, never a redirect: a followed 307 hands them the sign-in
            // page as a 200 they cannot tell from success. `auth.protect()` is skipped here
            // because it treats every request inside the proxy as a page navigation.
            // Pending sessions read as signed out, as protect() would treat them.
            const { userId } = await auth();
            if (!userId) {
              return NextResponse.json(API_SIGNED_OUT_BODY, { status: API_SIGNED_OUT_STATUS });
            }
          } else {
            // Pages — and the server-action POSTs made to them — keep Clerk's behaviour.
            await auth.protect();
          }
        }
        return withPathname(req);
      },
```

In `src/lib/chat-stream-client.ts`, add after the `ChatStreamHandlers` type:

```ts
export const CHAT_SIGNED_OUT_MESSAGE = "You’re signed out — sign in again to keep chatting";

export type ChatResponseKind = "stream" | "signed_out" | "error";

/**
 * What came back from `/api/chat`, before a byte of it is parsed. A 200 that is not an
 * event stream is the sign-in page reached through a followed redirect — the one way a
 * signed-out request used to look like success.
 */
export function classifyChatResponse(res: {
  status: number;
  ok: boolean;
  contentType: string | null;
}): ChatResponseKind {
  if (res.status === 401) return "signed_out";
  if (!res.ok) return "error";
  return (res.contentType ?? "").toLowerCase().includes("text/event-stream")
    ? "stream"
    : "signed_out";
}
```

and replace the response check in `streamChat` (:45-55, `if (!res.ok || !res.body) { … }`) with:

```ts
  const kind = classifyChatResponse({
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get("content-type"),
  });
  if (kind === "signed_out") {
    handlers.onError(CHAT_SIGNED_OUT_MESSAGE);
    return;
  }
  if (kind === "error" || !res.body) {
    let message = `Chat failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // Not JSON; keep the status message.
    }
    handlers.onError(message);
    return;
  }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-chat-stream.ts && npx tsx scripts/smoke-public-routes.ts`
Expected: `All chat-stream checks passed.` and public routes green; exit 0.

- [ ] **Step 5: Typecheck, lint, voice** — `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts`. Expected: exit 0.

- [ ] **Step 6: Manual verification with Clerk test keys**

Demo mode has no Clerk, so the proxy branch only runs with keys. In the worktree, put the `pk_test_…`/`sk_test_…` test-instance keys in `.env.local` (no `DATABASE_URL`), start `orbit-web`, then:

```bash
curl -s -i -X POST http://localhost:3001/api/chat -H 'content-type: application/json' -d '{"question":"hi"}' | sed -n '1p;$p'
curl -s -o /dev/null -w '%{http_code}\n' -H 'accept: text/html' http://localhost:3001/dashboard
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/api/health
```

Expected: `HTTP/1.1 401 Unauthorized` and the body `{"error":"You’re signed out — sign in again","code":"signed_out"}`; `/dashboard` still `307`; `/api/health` (public) still `200`. Remove the keys from `.env.local` afterwards.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api-signed-out.ts src/proxy.ts src/lib/chat-stream-client.ts scripts/smoke-chat-stream.ts
git commit -m "$(cat <<'EOF'
Answer signed-out API calls with a JSON 401, and say so in chat

Protected /api routes got Clerk's 307 to /sign-in; fetch followed it and the
chat stream parsed the sign-in page as SSE, spinning forever. The proxy now
returns a JSON 401 for /api/* and the stream client names a 401 or a non-SSE
200 as signed out. Page navigations and server actions are unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: The admin can delete an account that has no email (B12 subset)

**Files:**
- Modify: `src/lib/admin-operations.ts` — `deleteAccount` doc and call (:465-495), `confirmAccountEmail` (:497-512), `hardDeleteAccount` call (:540)
- Modify: `src/components/admin/account-actions.tsx` — the two danger-zone dialogs (:140-149, :167-176)
- Modify: `scripts/smoke-admin-actions.ts` — ids (:33-36), a new block before `/* ---- the gate itself ---- */` (:518)

Production logs show the delete action throwing "This account has no email on file, so the confirmation cannot be checked. Delete it with scripts/ instead." (audit B12). The typed confirmation becomes the account's user id when it has no email — the dialog already compares case-insensitively (`src/components/admin/confirm-action-dialog.tsx:65-66`), so the server does too, and the button can never be enabled for a value the server then refuses. The input field keeps its name `confirmEmail` so no action signature changes.

**Interfaces:** `confirmAccountEmail(targetUserId, confirmEmail)` is renamed `confirmAccountIdentity(targetUserId, confirmation)` (module-private). `deleteAccount` / `hardDeleteAccount` signatures unchanged; `confirmEmail` now means "the account's email, or its user id when it has none".

- [ ] **Step 1: Write the failing test**

In `scripts/smoke-admin-actions.ts`, replace `const IDS = [ADMIN, TARGET, OTHER_OP];` (:36) with the lines below (the existing `for (const id of IDS) await ensureUserSettings(id)` then creates the new account's settings row with no email):

```ts
const NO_EMAIL = `${PREFIX}no-email`;
const IDS = [ADMIN, TARGET, OTHER_OP, NO_EMAIL];
```

Insert before `/* --------------------------------------------------------------- the gate itself */` (:518):

```ts
  /* ------------------------------------------------------- an account with no email */

  await db.insert(contacts).values({ userId: NO_EMAIL, fullName: "Emailless Contact" });
  await refuses(
    "an email-less account refuses a confirmation that is not its user id",
    () =>
      actions.deleteAccount(ADMIN, {
        targetUserId: NO_EMAIL,
        confirmEmail: "someone-else",
        reason: "testing the email-less confirmation",
      }),
    /does not match/i
  );
  await actions.deleteAccount(ADMIN, {
    targetUserId: NO_EMAIL,
    confirmEmail: NO_EMAIL.toUpperCase(), // case-insensitive, like the dialog
    reason: "an account with no email on file must still be deletable",
  });
  check(
    "an email-less account is deleted when the user id is typed",
    (await db.query.contacts.findMany({ where: eq(contacts.userId, NO_EMAIL) })).length === 0
  );
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-admin-actions.ts`
Expected: `an email-less account refuses a confirmation that is not its user id failed: rejected with "This account has no email on file…"`; exit 1.

- [ ] **Step 3: Implement**

In `src/lib/admin-operations.ts`, replace `confirmAccountEmail` and its comment (:497-512) with:

```ts
/**
 * Shared by `deleteAccount` and `hardDeleteAccount`: resolves the account and checks the
 * typed confirmation against it, so the operator cannot fire either action against the row
 * next to the one they meant.
 *
 * The confirmation is the account's email or, for an account with no email on file (its
 * `user.created` webhook never landed, or it signed up by phone), its user id. Both compare
 * case-insensitively, exactly like the dialog, so the dialog can never enable a button the
 * server then refuses.
 */
async function confirmAccountIdentity(targetUserId: string, confirmation: string) {
  const account = await requireAccount(targetUserId);
  const email = (account.email ?? "").trim().toLowerCase();
  const expected = email || targetUserId.trim().toLowerCase();
  if (confirmation.trim().toLowerCase() !== expected) {
    throw new Error(
      email
        ? "That email does not match this account."
        : "That user id does not match this account."
    );
  }
  return account;
}
```

Change both call sites — `const account = await confirmAccountEmail(input.targetUserId, input.confirmEmail);` in `deleteAccount` (:486) and `hardDeleteAccount` (:540) — to `const account = await confirmAccountIdentity(input.targetUserId, input.confirmEmail);`. In `deleteAccount`'s doc comment replace `` `confirmEmail` must match the account's own email verbatim. `` with `` `confirmEmail` must match the account's own email — or its user id when it has none (case-insensitive). ``

In `src/components/admin/account-actions.tsx`, in BOTH dialogs replace

```tsx
          typedConfirmation={email ?? undefined}
          typedConfirmationHint={`Type ${email ?? "the account email"} to confirm`}
```

with

```tsx
          typedConfirmation={email ?? targetUserId}
          typedConfirmationHint={`Type ${email ?? targetUserId} to confirm`}
```

and in both `onConfirm` bodies replace `confirmEmail: email ?? "",` with `confirmEmail: email ?? targetUserId,`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-admin-actions.ts && npx tsx scripts/smoke-admin-gate.ts`
Expected: every line `ok`, `Done.`, exit 0.

- [ ] **Step 5: Typecheck, lint** — `npm run typecheck && npm run lint`. Expected: exit 0. (`/admin` 404s in demo mode, so the dialog change is verified by type and by the smoke; after deploy, open an email-less account in `/admin/users/<id>` and confirm the hint reads "Type user_… to confirm".)

- [ ] **Step 6: Commit**

```bash
git add src/lib/admin-operations.ts src/components/admin/account-actions.tsx scripts/smoke-admin-actions.ts
git commit -m "$(cat <<'EOF'
Let the admin delete an account that has no email on file

The delete actions required the typed email to match and threw for accounts
without one, pointing at scripts/. The confirmation is now the user id when
there is no email, compared case-insensitively like the dialog.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Dev stops printing Server Function arguments, including saved keys (B11 subset)

**Files:**
- Modify: `next.config.ts` (insert after `outputFileTracingIncludes`, :33-38)
- Create: `scripts/smoke-dev-logging.ts`; Modify: `scripts/run-smoke.ts` (pure section)

This is the exact change of commit `4d3502a` ("Stop dev from printing Server Function arguments, which included saved API keys") on `origin/claude/outreach-redesign-campaigns-48b9fc`, which is unmerged. Re-apply it by hand rather than cherry-picking, so this branch does not pick up that branch's context. The option name is confirmed in `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/logging.md` ("Server Function invocations are logged by default during development. You can disable this by setting `logging.serverFunctions` to `false`") and typed as `serverFunctions?: boolean` in `node_modules/next/dist/server/config-shared.d.ts:267`. Development-only; production logging is unaffected.

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-dev-logging.ts`:

```ts
/**
 * Pins `logging.serverFunctions: false` in next.config.ts (audit B11).
 *
 * Next logs every Server Function call WITH ITS ARGUMENTS in development by default, so
 * saving an AI, Apollo, Resend or Twilio key in Settings printed the key verbatim into the
 * terminal — and into any log a dev session is captured to.
 *
 * Text-level on purpose: importing next.config.ts pulls in Sentry's build wrapper.
 * Pure. Run: npx tsx scripts/smoke-dev-logging.ts
 */
import { readFileSync } from "node:fs";

const src = readFileSync("next.config.ts", "utf8");
const ok = /logging:\s*\{\s*serverFunctions:\s*false\s*,?\s*\}/.test(src);
if (!ok) {
  console.error("  FAIL next.config.ts sets logging.serverFunctions to false");
  process.exit(1);
}
console.log("  ok   next.config.ts sets logging.serverFunctions to false");
process.exit(0);
```

Register it in the pure block after `"smoke-date-commitments": "pure",`: `  "smoke-dev-logging": "pure",`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-dev-logging.ts`
Expected: `FAIL next.config.ts sets logging.serverFunctions to false`; exit 1.

- [ ] **Step 3: Implement**

In `next.config.ts`, directly after the closing `},` of `outputFileTracingIncludes` (:38) and before `experimental: {`, add:

```ts
  // Dev logs every Server Function call with its arguments by default, which prints the
  // API keys a person saves in Settings (saveAiSettings, saveOutreachSettings) into the
  // terminal verbatim.
  logging: {
    serverFunctions: false,
  },
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-dev-logging.ts`
Expected: `ok   next.config.ts sets logging.serverFunctions to false`; exit 0.

- [ ] **Step 5: Typecheck, lint, and see it in dev**

Run: `npm run typecheck && npm run lint && npx tsx scripts/run-smoke.ts --check`. Then start `orbit-web`, save any AI settings in `/settings?integration=ai`, and read the dev server output (`preview_logs` for the orbit-web server): no `└─ ƒ saveAiSettings(` line appears.

- [ ] **Step 6: Commit**

```bash
git add next.config.ts scripts/smoke-dev-logging.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Stop dev from printing Server Function arguments, which included saved API keys

Next logs every Server Function call with its arguments in development by
default, so saving an AI or Apollo key in Settings printed the key into the
terminal verbatim. Same change as 4d3502a on the unmerged outreach branch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Whole-branch gate, then push**

```bash
npm run typecheck && npm run lint && npm test && npm run build
git fetch -q --all && for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do git show "${b}:src/db/index.ts" 2>/dev/null | grep -oE 'export const SCHEMA_VERSION = [0-9]+'; done | grep -oE '[0-9]+$' | sort -n | tail -1
git diff origin/main -- src/db/schema.ts | wc -l
git push -u origin claude/launch-p0
```

Expected: typecheck, lint, the whole smoke suite and the build pass; the scan prints whatever the other branches hold (this branch changes nothing there); the `schema.ts` diff is `0` lines. If `main` moved while you worked, merge `origin/main` before pushing and re-run the first line.

---

## Deferred to later phases

Each needs a column, a dashboard, or a larger design, so it is out of this no-schema phase.

| Item | Why not here | Where |
|---|---|---|
| Ops condition `backup.stale` (newest artifact older than 36 h) | The sweep would need the GitHub API and a token; Task 7's failure page covers the loud case | Phase 3b (B6) |
| Recruiter PII stored per link (a non-creator keeps the email they typed; orphaned details after a creator's purge become deletable) | Needs `user_recruiter_links` columns | Phase 2 ("A8 properly", with B3) |
| Re-grant after a refund when Stripe redelivers an old `checkout.session.completed` | Needs per-subscription/purchase event ordering | Phase 2 (B2) |
| Distinct meeting-recorder copy for a refused transcription key | `meeting-upload-queue.ts` maps every 422 to "no key"; Task 10 keeps it terminal with the right message | Phase 3a (B8 rest) |
| `pending_embeddings` / last `error_kind` as an account alert (rest of A9) | Not in this plan's assignment | Phase 3a (B8 rest) |
| A verified BYOK `from` address for Resend | Needs a settings column | Phase 3a |
| Moving the Anthropic presets to the 5-family | Default adaptive thinking on Opus 5 needs a `max_tokens`/thinking review of every call | Phase 3a (B8 rest) |

## Manual steps (not code)

**M1 — Backup secrets (A1).** GitHub → the repo → Settings → Secrets and variables → Actions → New repository secret:
1. `age-keygen -o backup-key.txt` locally; store `backup-key.txt` in the password manager, never in the repo.
2. `BACKUP_AGE_PUBLIC_KEY` = the `# public key: age1…` value from that file.
3. `DATABASE_URL` = the production Neon URL on the **direct** host (no `-pooler`; `pg_dump` needs a session connection).
4. `SLACK_OPS_CRITICAL_WEBHOOK_URL` = the same webhook `ops.yml` uses (optional, but without it a failed backup still pages nobody).
5. Actions → backup → Run workflow on `main`. Expected: green, and an `orbit-YYYY-MM-DD-HHMM` artifact. Then set one secret to a wrong value on a throwaway run to see the guard's `::error` line and the Slack page, and put it back.

**M2 — Restore drill (A1 gate).** Download the artifact; `age -d -i backup-key.txt orbit-….pgc.age > orbit.pgc`; Neon → Branches → New branch from `main` (named `restore-drill-YYYY-MM-DD`); `pg_restore --clean --if-exists --no-owner --no-privileges -d "$BRANCH_URL" orbit.pgc`, timing it; run the count query from the runbook against the branch and production; write a row in `docs/RUNBOOK.md` → "Restore drill log" (date, artifact, duration, counts, who); delete the branch. Phase 0's gate is this row existing.

**M3 — Sender domain (A11).** Resend → Domains → add the Orbit domain and create the DNS records it lists; wait for "Verified". Vercel → Project → Settings → Environment Variables → `RESEND_FROM_EMAIL` (Production) = an address on that domain → Redeploy. Join the waitlist on production with a test address and confirm the welcome arrives and `/admin/health` shows no `resend.rejected` rows.

**M4 — Enforce CSP (B12).** Check a week of reports first (the source is `csp.report`; the roadmap's M4 query says `'csp'` and would return nothing):

```sql
SELECT kind AS directive, context->>'blockedUri' AS blocked, count(*) AS n, max(created_at) AS last_seen
FROM error_events
WHERE source = 'csp.report' AND created_at > now() - interval '7 days'
GROUP BY 1, 2
ORDER BY n DESC;
```

If every remaining row is a browser extension or a known third party already allowed, Vercel → Environment Variables → `CSP_ENFORCE=1` (Production) → Redeploy (it is read at build time). Confirm `curl -sI https://orbit.jasonpereira.live | grep -i content-security-policy` shows `Content-Security-Policy:` without `-Report-Only`.

**M5 — Vercel Pro (A10).** Vercel → Team → Settings → Billing → Upgrade to Pro before the first paying stranger.

**M6 — Stripe refunds (A4).** Dashboard → Developers → Webhooks → the production endpoint: confirm `charge.refunded` and `charge.dispute.closed` are subscribed. In test mode: `stripe listen --forward-to localhost:3001/api/webhooks/stripe`, buy Lifetime with a test card, refund it in full from the dashboard, and confirm Settings shows the free plan and the delivery detail says `revoked: refund`.

**M7 — Clerk deletion (A2).** Clerk → Webhooks → the production endpoint: confirm `user.deleted` is enabled. Delete a test user in Clerk and confirm their `user_settings` row is gone.

**M8 — Rollback drill (A5, optional but cheap).** After this branch is live, in a quiet window promote the previous deployment, confirm `/api/health` answers 200 with `"status":"degraded"` and `"ahead":true` and that the next `ops` run still sweeps, then promote the latest again.

## Self-review

**Audit item → task.**

| Item | Task(s) |
|---|---|
| A1 backups (code half: guard, pipefail, failure page, drill log) | 7; secrets and drill in M1, M2 |
| A2 real deletion from the Clerk webhook | 1 (admin hard delete already correct; "delete data" deliberately keeps the row) |
| A4 refunds and lost disputes revoke | 2 (pure decision), 3 (driver, resolver, runbook) |
| A5 rollback-safe health and version | 6 |
| A7 no sends to invented prospects | 4 |
| A8a recruiter pool PII | 8 (rule, write guard, readers, Gmail scan), 9 (drafts and sends) |
| A8b outreach preview scope | 5 |
| A9 (a) key check on save, (d) inline UI | 12 |
| A9 (b) translate stream/transcribe/embed errors | 11 |
| A9 (c) refused ≠ missing key | 10 |
| A10 Vercel Pro | M5 |
| A11 reply-to | 14 |
| A11 Resend rejection → error event + ops | 15; sender domain in M3 |
| B1 JSON 401 and chat signed-out copy | 16 |
| B8 Opus id + temperature | 13 |
| B11 dev logging | 18 |
| B12 email-less admin delete | 17; CSP flip in M4 |

**Placeholder scan.** No "TBD", "similar to Task N" or "add error handling". Task 11 Step 4 specifies each wrap as an exact opening-line and closing-line replacement with the body untouched, which is the complete edit.

**Names used across tasks (checked for consistency).** `ChargePurpose`, `RevocationReason`, `revocationPaymentIntent`, `paymentIntentIdOf`, `isFullRefund` (Task 2) → `resolveChargePurpose`, `ChargePurposeLookups`, `stripeChargePurposeLookups`, `revokeLifetimePurchase` (Task 3). `isDemoProspect`, `isPlaceholderAddress`, `prospectSearchStatus`, `DEMO_PROSPECT_SEND_MESSAGE`, `PLACEHOLDER_ADDRESS_SEND_MESSAGE`, `sendOutreachMessageNow` (Task 4) → `campaignMessages` (Task 5). `CREATOR_LINK_WINDOW_SECONDS`, `isCreatorLink`, `piiPooledRecruiterIds`, `unlockedRecruiterIds` (Task 8) → Task 9. `AI_KEY_REJECTED_MESSAGE`, `isAiKeyRejectedError` (Task 10) → `asAiProviderError`, `translatingProviderErrors` (Task 11) → `checkAiKey`, `keyCheckOutcome`, `KEY_PROBES` (Task 12). `anthropicAcceptsTemperature` (Task 13). `outreachEmailPayload` (Task 14). `ERROR_SOURCES.resendRejected`, `resendRejectedLastHour` (Task 15). `API_SIGNED_OUT_BODY`, `isApiPath`, `classifyChatResponse`, `CHAT_SIGNED_OUT_MESSAGE` (Task 16). `confirmAccountIdentity` (Task 17).

**New smoke scripts and tiers.** pure: `smoke-stripe-revocation`, `smoke-backup-workflow`, `smoke-ai-key-check`, `smoke-outreach-email`, `smoke-dev-logging`; pglite: `smoke-account-deletion`, `smoke-outreach-guards`, `smoke-recruiter-pii`. Each task's Step 2 adds its entry to `MANIFEST`.

**No schema change.** No task edits `src/db/schema.ts`, the DDL, `alters`, `EXPECTED_TABLES` or `SCHEMA_VERSION`; Task 18 Step 7 asserts the `schema.ts` diff is empty. New facts ride in existing jsonb (`billing_events.detail.paymentIntentId`) or are derived (creator links from timestamps).
