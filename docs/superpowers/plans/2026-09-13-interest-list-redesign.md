# /interest Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/interest` as a waitlist-shaped page for a list with no queue: a live proof line, a boarding-pass reveal with the joiner's number, planet and referral moons, a share link with referral tracking, and a per-person ticket image for link previews.

**Architecture:** The page becomes fully dynamic and renders one of three card states from the URL (form, invited, ticket). The join action is split into a thin `"use server"` wrapper and a headers-free core the smoke tests drive directly. A server-only read module owns ordinals, moon counts and a 60-second proof memo. A `next/og` route renders the ticket image. Client components own the flip and the assembly choreography on the house motion tokens.

**Tech Stack:** Next.js 16.2 App Router (no Cache Components), React 19, Drizzle over Neon (prod) / PGlite (local + smoke), `motion` v12, Tailwind v4, `next/og`, zod, tsx smoke scripts under `scripts/run-smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-09-13-interest-list-redesign-design.md`

## Global Constraints

- Node modules: this worktree has none. Run `npm ci` **in the worktree** (Task 1); never symlink main's.
- `SCHEMA_VERSION` goes from 50 to **52** (51 is taken by `origin/claude/capture-page-redesign-525456`). Re-scan every remote branch before opening the PR; bump again if a higher number has landed.
- Every new column appears in THREE places in `src/db/index.ts` + `src/db/schema.ts`: the Drizzle table, the `CREATE TABLE IF NOT EXISTS` template, and the `alters` list. Indexes appear in the template AND the alters list AND the Drizzle table.
- Low-level modules under `src/lib/` that a client component may import must import nothing from `next/*`, `node:*`, `resend`, or `@/db`. `src/lib/interest-list.ts` and `src/lib/welcome-planets.ts` are client-safe; `src/lib/interest-list-ticket.ts`, `src/lib/interest-list-join.ts`, `src/lib/interest-list-email.ts` are server-only.
- A `"use server"` file may export only async functions.
- Every database-tier smoke script starts with `import "./smoke/_env";`, ends with an explicit `process.exit(0)`, and is registered in `MANIFEST` in `scripts/run-smoke.ts`.
- Toast/error copy is not touched: the form keeps its two existing error strings verbatim: `"That address doesn't look right."` and `"Something went wrong — please try again."`.
- Motion uses `EASE_HOUSE`, `DUR`, `SPRING_SOFT` from `src/lib/motion.ts`; every animation has a reduced-motion branch (`useReducedMotion` from `motion/react`, already honoured by the `MotionConfig` in `src/app/(site)/layout.tsx`).
- Count floor: `INTEREST_LIST_COUNT_FLOOR = 50`. Moons drawn: at most `12`. Rate limit: `interestJoin: { limit: 5, windowSec: 600 }`.
- Copy, verbatim (from the spec): headline `Stay in orbit.` / ticket headline `You're in orbit.`; sub-line `Occasional notes from the one person building Orbit. Join and you're handed a planet.`; proof `1,284 people have joined · next planet up: Mars` (count part omitted below the floor); invited strip `Someone on Mars invited you. Join and you'll orbit right behind them.`; ticket `Passenger 1,285, bound for Mars.`; moons `3 people joined through you. They're the moons.` / `No moons yet. Share your link and watch them arrive.`; `Save this link — it's your page.`; `Not one for waiting? Orbit is live — start free.`; share text `I'm passenger #1,285 on Orbit's interest list, bound for Mars. Get your planet:`.
- Never run `next build` while the worktree's dev server is up (it wedges `.next`); run the browser pass first, then stop the server, then build.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/welcome-planets.ts` (new, client-safe) | The eight planets, ordinal→planet, label, glow colour. Moved out of the email module so the browser can import it. |
| `src/lib/interest-list.ts` (modify, client-safe) | Zod schema (+ `ref`), `InterestTicket`, `InterestListResult`, floor/caps, URL and share-text builders. |
| `src/lib/interest-list-ticket.ts` (new, server) | `ticketForRow`, `getTicketByShareToken`, `getInviterPlanet`, `readInterestProof`, `getInterestProof` (memo), `invalidateInterestProof`. |
| `src/lib/interest-list-join.ts` (new, server) | `joinInterestListCore(input, ctx)`: honeypot, validation, timing, rate limit, ref resolution, read-then-write, welcome email, ticket. |
| `src/actions/interest-list.ts` (rewrite) | `"use server"` wrapper: reads headers/cookies, delegates to the core. |
| `src/lib/interest-list-email.ts` (modify) | Re-exports planets; welcome + follow-up get optional `links` (ticket URL, share URL). |
| `src/lib/rate-limit.ts` (modify) | `interestJoin` policy. |
| `src/db/schema.ts`, `src/db/index.ts` (modify) | `share_token`, `referred_by_id`, two indexes, `SCHEMA_VERSION` 52. |
| `src/app/api/interest-list/ticket-image/route.tsx` + `fonts/` (new) | `next/og` boarding-pass image; generic card for bad tokens. |
| `src/lib/public-routes.ts` (modify) | Adds the image route. |
| `next.config.ts` (modify) | `outputFileTracingIncludes` for the fonts and planet PNGs. |
| `src/components/interest/planet-art.tsx` (new) | `<picture>` planet with the hero's glow treatment. Server-safe. |
| `src/components/interest/proof-line.tsx` (new, client) | Planet-dot stack + count roll + next planet. |
| `src/components/interest/moons.tsx` (new, client) | Orbit ring, staggered moon drop, CSS drift. |
| `src/components/interest/share-row.tsx` (new, client) | Link field, Copy, X, LinkedIn, native Share. |
| `src/components/interest/boarding-pass.tsx` (new, client) | The ticket: stub + seam + details, assembly choreography. |
| `src/components/interest/interest-hero.tsx` (new, client) | Eyebrow, crossfading headline, sub-line, the card state machine (form / invited / turning / ticket), the flip, `replaceState`. Absorbs and deletes `interest-form.tsx`. |
| `src/app/(site)/interest/page.tsx` (rewrite) | Dynamic page, `generateMetadata`, sections. |
| `src/components/loading/page-skeletons.tsx` (modify) | `InterestPageSkeleton` matches the new hero; detour section removed. |
| `src/app/globals.css` (modify) | Flip perspective, seam, moon drift keyframes. |
| `scripts/smoke-interest-list-join.ts`, `scripts/smoke-interest-list-page.ts`, `scripts/smoke-interest-ticket-image.ts` (new) + `scripts/run-smoke.ts` (modify) | The three smokes from the spec. |

---

### Task 1: Merge main and install

**Files:**
- Modify: (merge) everything main changed; no hand edits.

**Interfaces:**
- Produces: a worktree at main's layout (`src/app/(site)/interest/page.tsx`, `MarketingFooter`, `SCHEMA_VERSION = 50`) with `node_modules` present.

- [ ] **Step 1: Merge origin/main**

Run:
```bash
cd /Users/jasonpereira/Projects/orbit/.claude/worktrees/new-session-0999e5 && git fetch -q origin && git merge --no-edit origin/main
```
Expected: a merge commit, no conflicts (this branch only adds `docs/superpowers/`). If a conflict appears, it is in a doc file; keep both sides.

- [ ] **Step 2: Install dependencies in the worktree**

Run:
```bash
cd /Users/jasonpereira/Projects/orbit/.claude/worktrees/new-session-0999e5 && npm ci 2>&1 | tail -3
```
Expected: `added N packages` with no `ERR!` lines.

- [ ] **Step 3: Confirm the page now lives under (site) and the baseline typechecks**

Run:
```bash
cd /Users/jasonpereira/Projects/orbit/.claude/worktrees/new-session-0999e5 && ls "src/app/(site)/interest" && grep -n "export const SCHEMA_VERSION" src/db/index.ts && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -3
```
Expected: `loading.tsx page.tsx`, `SCHEMA_VERSION = 50`, and tsc prints nothing (zero errors).

- [ ] **Step 4: Commit**

The merge commit from Step 1 is the commit. Nothing else to add.

---

### Task 2: Schema — share token and referrer

**Files:**
- Modify: `src/db/schema.ts` (the `interestListSignups` table; anchor: the line `followUpSentAt: timestamp("follow_up_sent_at", { withTimezone: true }),` and the index list ending with `index("interest_list_signups_created_idx").on(t.createdAt),`)
- Modify: `src/db/index.ts` (three places: the `CREATE TABLE IF NOT EXISTS interest_list_signups` template; the `alters` array next to `ALTER TABLE interest_list_signups ADD COLUMN IF NOT EXISTS follow_up_sent_at timestamptz`; the `export const SCHEMA_VERSION = 50;` line and its comment block)
- Test: `npm run db:check` (runs `scripts/smoke-schema-ddl.ts`), `npx tsx scripts/smoke-interest-list-admin.ts`

**Interfaces:**
- Produces: columns `interestListSignups.shareToken: text | null`, `interestListSignups.referredById: uuid | null`; indexes `interest_list_signups_share_token_uidx` (unique), `interest_list_signups_referred_by_idx`.

- [ ] **Step 1: Run the DDL parity check to see it pass on the baseline**

Run: `npm run db:check 2>&1 | tail -3`
Expected: the last line reports all checks passed. (This is the test that will catch a column added in one place but not the others.)

- [ ] **Step 2: Add the columns and indexes to the Drizzle table**

In `src/db/schema.ts`, directly after the `followUpSentAt` column inside `interestListSignups`:

```ts
    /**
     * Opaque token behind the public share link (`/interest?ref=…`) and the personal ticket
     * page (`/interest?me=…`). Separate from `unsubscribeToken` on purpose: this one is
     * designed to be pasted into public places, that one must never be. Nullable because
     * rows predate it; `joinInterestListCore` mints one the next time the address is
     * submitted.
     */
    shareToken: text("share_token"),
    /**
     * The row whose share link brought this signup in — the referrer's `id`. Written once,
     * on insert, never on a rejoin. No FK, like every other cross-row reference here.
     */
    referredById: uuid("referred_by_id"),
```

And extend the index list:

```ts
  (t) => [
    uniqueIndex("interest_list_signups_email_uidx").on(t.email),
    uniqueIndex("interest_list_signups_token_uidx").on(t.unsubscribeToken),
    index("interest_list_signups_created_idx").on(t.createdAt),
    uniqueIndex("interest_list_signups_share_token_uidx").on(t.shareToken),
    index("interest_list_signups_referred_by_idx").on(t.referredById),
  ]
```

(`uuid` is already imported in `schema.ts` — it is used for `id`.)

- [ ] **Step 3: Add the columns and indexes to the CREATE TABLE template**

In `src/db/index.ts`, change the template to:

```sql
CREATE TABLE IF NOT EXISTS interest_list_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  landing_path text,
  unsubscribe_token text NOT NULL,
  unsubscribed_at timestamptz,
  welcome_planet text,
  follow_up_sent_at timestamptz,
  share_token text,
  referred_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS interest_list_signups_email_uidx ON interest_list_signups(email);
CREATE UNIQUE INDEX IF NOT EXISTS interest_list_signups_token_uidx ON interest_list_signups(unsubscribe_token);
CREATE INDEX IF NOT EXISTS interest_list_signups_created_idx ON interest_list_signups(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS interest_list_signups_share_token_uidx ON interest_list_signups(share_token);
CREATE INDEX IF NOT EXISTS interest_list_signups_referred_by_idx ON interest_list_signups(referred_by_id);
```

- [ ] **Step 4: Add the alters**

In the `alters` array, directly after the line
`` `ALTER TABLE interest_list_signups ADD COLUMN IF NOT EXISTS follow_up_sent_at timestamptz`, ``:

```ts
  // v52: the share link and referral tracking behind the /interest boarding pass.
  `ALTER TABLE interest_list_signups ADD COLUMN IF NOT EXISTS share_token text`,
  `ALTER TABLE interest_list_signups ADD COLUMN IF NOT EXISTS referred_by_id uuid`,
  `CREATE UNIQUE INDEX IF NOT EXISTS interest_list_signups_share_token_uidx ON interest_list_signups(share_token)`,
  `CREATE INDEX IF NOT EXISTS interest_list_signups_referred_by_idx ON interest_list_signups(referred_by_id)`,
```

- [ ] **Step 5: Bump the version**

Replace `export const SCHEMA_VERSION = 50;` with:

```ts
// 51 is taken by the capture-page redesign branch, so this skips it.
//
// 52 = interest_list_signups.share_token + referred_by_id, the share link and referral
// moons behind the /interest boarding pass.
export const SCHEMA_VERSION = 52;
```

- [ ] **Step 6: Run the parity check and the existing admin smoke**

Run:
```bash
npm run db:check 2>&1 | tail -3 && npx tsx scripts/smoke-interest-list-admin.ts 2>&1 | tail -3
```
Expected: both end with their "all checks passed" line. If `db:check` names `share_token`, one of the three places was missed.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/index.ts
git commit -m "Schema v52: share_token and referred_by_id on interest_list_signups

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Client-safe planets, types, URL builders, rate-limit policy

**Files:**
- Create: `src/lib/welcome-planets.ts`
- Modify: `src/lib/interest-list-email.ts` (top of file: remove `WELCOME_PLANETS`, `WelcomePlanet`, `planetForSignupNumber`, `asWelcomePlanet`; re-export them)
- Modify: `src/lib/interest-list.ts`
- Modify: `src/lib/rate-limit.ts` (the `RATE_LIMITS` object)
- Test: `npx tsc --noEmit`, `npx tsx scripts/smoke-interest-list-admin.ts` (it imports `generateUnsubscribeToken` and the planet helpers through the email module)

**Interfaces:**
- Produces (`src/lib/welcome-planets.ts`): `WELCOME_PLANETS`, `type WelcomePlanet`, `planetForSignupNumber(n: number): WelcomePlanet`, `asWelcomePlanet(v: string | null | undefined): WelcomePlanet`, `planetLabel(p: WelcomePlanet): string`, `PLANET_GLOW: Record<WelcomePlanet, string>`.
- Produces (`src/lib/interest-list.ts`): `INTEREST_LIST_COUNT_FLOOR = 50`, `SHARE_TOKEN_MAX = 64`, `MOONS_DRAWN_MAX = 12`, `interestListSchema` (with optional `ref`), `type InterestTicket = { number: number; planet: WelcomePlanet; joinedAt: string; moons: number; shareToken: string }`, `type InterestListResult = { ok: true; ticket: InterestTicket } | { ok: false; message: string }`, `buildTicketUrl(appUrl, token)`, `buildShareUrl(appUrl, token)`, `buildTicketImageUrl(appUrl, token)`, `shareText(ticket)`, `passengerLine(ticket)`, `moonsLine(moons)`.
- Produces (`src/lib/rate-limit.ts`): `RATE_LIMITS.interestJoin`.

- [ ] **Step 1: Create the client-safe planet module**

`src/lib/welcome-planets.ts`:

```ts
/**
 * The eight planets, ordered by distance from the sun — the art lives in
 * `public/landing/planets/`.
 *
 * Client-safe on purpose: the boarding pass renders a planet in the browser, and the module
 * that used to own these (`interest-list-email.ts`) imports `resend` and `node:crypto`,
 * neither of which belongs in a client bundle.
 */
export const WELCOME_PLANETS = [
  "mercury",
  "venus",
  "earth",
  "mars",
  "jupiter",
  "saturn",
  "uranus",
  "neptune",
] as const;
export type WelcomePlanet = (typeof WELCOME_PLANETS)[number];

/**
 * Maps a 1-based signup number onto the planet that signup receives: the 1st gets Mercury,
 * the 8th Neptune, the 9th Mercury again.
 *
 * Defensive about its input because the caller derives it from a COUNT that could in
 * principle come back 0 or non-finite — a negative index would otherwise read off the end
 * of the array and hand `undefined` to the template.
 */
export function planetForSignupNumber(signupNumber: number): WelcomePlanet {
  const n = Number.isFinite(signupNumber) ? Math.floor(signupNumber) : 1;
  return WELCOME_PLANETS[Math.max(0, n - 1) % WELCOME_PLANETS.length];
}

/**
 * Narrows the stored `welcome_planet` text back to the union. Rows written before that
 * column existed hold null, so the fallback is not theoretical — and an unrecognised value
 * must not reach a template, where it would build a 404 image URL.
 */
export function asWelcomePlanet(value: string | null | undefined): WelcomePlanet {
  return (WELCOME_PLANETS as readonly string[]).includes(value ?? "")
    ? (value as WelcomePlanet)
    : WELCOME_PLANETS[0];
}

/** "mars" → "Mars". */
export function planetLabel(planet: WelcomePlanet): string {
  return planet.charAt(0).toUpperCase() + planet.slice(1);
}

/** Atmosphere glow per planet — the same values `hero-solar-system.tsx` uses. */
export const PLANET_GLOW: Record<WelcomePlanet, string> = {
  mercury: "rgba(170, 160, 150, 0.45)",
  venus: "rgba(220, 190, 120, 0.5)",
  earth: "rgba(80, 160, 220, 0.55)",
  mars: "rgba(200, 100, 70, 0.5)",
  jupiter: "rgba(200, 160, 100, 0.45)",
  saturn: "rgba(210, 190, 140, 0.45)",
  uranus: "rgba(140, 210, 210, 0.5)",
  neptune: "rgba(70, 120, 220, 0.55)",
};
```

- [ ] **Step 2: Re-export from the email module**

In `src/lib/interest-list-email.ts`, delete the `WELCOME_PLANETS` constant, the `WelcomePlanet` type, `planetForSignupNumber` and `asWelcomePlanet` (and their doc comments), and add near the top, after the existing imports:

```ts
import { planetLabel, type WelcomePlanet } from "@/lib/welcome-planets";

// Re-exported so existing importers keep working; the definitions moved to a client-safe
// module because the boarding pass needs them in the browser.
export {
  WELCOME_PLANETS,
  asWelcomePlanet,
  planetForSignupNumber,
  type WelcomePlanet,
} from "@/lib/welcome-planets";
```

Replace the local `titleCase` function's two call sites (`titleCase(input.planet)`) with `planetLabel(input.planet)` and delete `titleCase`.

- [ ] **Step 3: Extend the shared client-safe module**

Replace `src/lib/interest-list.ts` with:

```ts
/**
 * Shape of an Interest list submission and its result, shared by the form, the server
 * action and the smoke tests.
 *
 * Deliberately not inside `src/actions/interest-list.ts`: a "use server" module may only
 * export async functions, so constants and types the form needs have to live somewhere the
 * client can import them from. Client-safe: no `next/*`, no `node:*`, no `@/db`.
 */
import { z } from "zod";
import { planetLabel, type WelcomePlanet } from "@/lib/welcome-planets";

/** A bot fills a form faster than a person can read it. */
export const MIN_FILL_MS = 2500;

/** Below this many signups the proof line shows the next planet only, never the count. */
export const INTEREST_LIST_COUNT_FLOOR = 50;

/** Share and ticket tokens are base64url of 32 bytes = 43 chars; this leaves headroom. */
export const SHARE_TOKEN_MAX = 64;

/** Moons drawn around the planet; past this the count line carries the rest. */
export const MOONS_DRAWN_MAX = 12;

export const interestListSchema = z.object({
  email: z.email("That address doesn't look right.").max(160),
  /** Honeypot. Hidden from people, irresistible to form-filling bots. */
  website: z.string().max(0),
  /** Milliseconds between the form rendering and this submission. */
  elapsedMs: z.number().int().nonnegative(),
  /** The referrer's share token, from `/interest?ref=…`. */
  ref: z.string().max(SHARE_TOKEN_MAX).optional(),
});

export type InterestListInput = z.input<typeof interestListSchema>;

/** What a joiner gets back, and what `/interest?me=…` renders. */
export type InterestTicket = {
  /** 1-based ordinal by (created_at, id). */
  number: number;
  planet: WelcomePlanet;
  /** ISO string — this crosses the server-action boundary. */
  joinedAt: string;
  /** People who joined through this ticket's share link. */
  moons: number;
  shareToken: string;
};

export type InterestListResult =
  | { ok: true; ticket: InterestTicket }
  | { ok: false; message: string };

export function buildTicketUrl(appUrl: string, token: string) {
  return `${appUrl}/interest?me=${encodeURIComponent(token)}`;
}

export function buildShareUrl(appUrl: string, token: string) {
  return `${appUrl}/interest?ref=${encodeURIComponent(token)}`;
}

export function buildTicketImageUrl(appUrl: string, token: string) {
  return `${appUrl}/api/interest-list/ticket-image?token=${encodeURIComponent(token)}`;
}

export function formatTicketNumber(number: number) {
  return number.toLocaleString("en-US");
}

/** "Passenger 1,285, bound for Mars." */
export function passengerLine(ticket: Pick<InterestTicket, "number" | "planet">) {
  return `Passenger ${formatTicketNumber(ticket.number)}, bound for ${planetLabel(ticket.planet)}.`;
}

export function moonsLine(moons: number) {
  if (moons === 0) return "No moons yet. Share your link and watch them arrive.";
  if (moons === 1) return "1 person joined through you. That's the moon.";
  return `${formatTicketNumber(moons)} people joined through you. They're the moons.`;
}

/** The prewritten share text; the URL is appended by the share target. */
export function shareText(ticket: Pick<InterestTicket, "number" | "planet">) {
  return `I'm passenger #${formatTicketNumber(ticket.number)} on Orbit's interest list, bound for ${planetLabel(ticket.planet)}. Get your planet:`;
}
```

- [ ] **Step 4: Add the rate-limit policy**

In `src/lib/rate-limit.ts`, inside `RATE_LIMITS`, after the `feedback` entry:

```ts
  /**
   * `joinInterestList`: five submits per ten minutes per IP. Replaces the action's old
   * per-instance Map, which never held across instances. A person mistypes twice; a script
   * probing whether addresses are on the list is what this is for.
   */
  interestJoin: { limit: 5, windowSec: 600 },
```

- [ ] **Step 5: Typecheck and run the admin smoke**

Run:
```bash
npx tsc --noEmit 2>&1 | tail -5 && npx tsx scripts/smoke-interest-list-admin.ts 2>&1 | tail -2
```
Expected: tsc prints nothing; the smoke ends with `interest-list console: all checks passed`. (The action still compiles because `InterestListResult` is only consumed by the form, which checks `result.ok` — the form is rewritten in Task 8; until then it type-errors only if it touches `ticket`, which it does not.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/welcome-planets.ts src/lib/interest-list-email.ts src/lib/interest-list.ts src/lib/rate-limit.ts
git commit -m "Move the welcome planets to a client-safe module; ticket types and share URLs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Read module — tickets, inviter, proof memo

**Files:**
- Create: `src/lib/interest-list-ticket.ts`
- Create: `scripts/smoke-interest-list-join.ts` (read-module half; Task 5 extends it)
- Modify: `scripts/run-smoke.ts` (`MANIFEST`, pglite section, alphabetical: after `"smoke-interest-list-admin": "pglite",`)

**Interfaces:**
- Consumes: `interestListSignups` (Task 2), `InterestTicket`, `INTEREST_LIST_COUNT_FLOOR` (Task 3), `asWelcomePlanet`, `planetForSignupNumber` (Task 3).
- Produces:
  - `type InterestProof = { count: number; nextPlanet: WelcomePlanet; recent: WelcomePlanet[] }`
  - `type SignupRowForTicket = { id: string; createdAt: Date; welcomePlanet: string | null; shareToken: string }`
  - `ticketForRow(row: SignupRowForTicket): Promise<InterestTicket>`
  - `getTicketByShareToken(token: string): Promise<InterestTicket | null>`
  - `getInviterPlanet(token: string): Promise<WelcomePlanet | null>`
  - `readInterestProof(): Promise<InterestProof>` (uncached), `getInterestProof(): Promise<InterestProof>` (60 s memo), `invalidateInterestProof(): void`
  - `proofShowsCount(proof: InterestProof): boolean`

- [ ] **Step 1: Write the failing smoke (read-module half)**

`scripts/smoke-interest-list-join.ts`:

```ts
/**
 * The interest-list join path and its read model, end to end against a throwaway PGlite.
 *
 * WHY THIS EXISTS. The join action returns a *ticket* now (number, planet, share token,
 * moons) and the /interest page renders one from a token. Every rule that keeps that honest
 * — ordinals that never collide, referral credit written once and never to yourself, bots
 * and rate-limited callers getting a plausible ticket and no row — is a query-shape or
 * branch-order detail that tsc cannot see. This drives the headers-free core directly.
 *
 * Run: npx tsx scripts/smoke-interest-list-join.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { interestListSignups, rateLimitBuckets } from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";
import {
  getInterestProof,
  getInviterPlanet,
  getTicketByShareToken,
  invalidateInterestProof,
  proofShowsCount,
  readInterestProof,
} from "../src/lib/interest-list-ticket";
import { INTEREST_LIST_COUNT_FLOOR } from "../src/lib/interest-list";
import { planetForSignupNumber } from "../src/lib/welcome-planets";

const PREFIX = "smoke-join-";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "interest.join:smoke-%"));
  invalidateInterestProof();
}

async function seedReadModel() {
  const db = await getDb();
  const at = (iso: string) => new Date(iso);
  const mk = (n: number, extra: Record<string, unknown> = {}) => ({
    email: `${PREFIX}r${n}@example.test`,
    unsubscribeToken: generateUnsubscribeToken(),
    shareToken: `smoke-share-${n}`,
    ...extra,
  });
  const [first] = await db
    .insert(interestListSignups)
    .values(mk(1, { welcomePlanet: "mercury", createdAt: at("2026-09-01T09:00:00Z") }))
    .returning();
  await db.insert(interestListSignups).values([
    // Two rows at the same instant: the ordinal must still tell them apart.
    mk(2, { welcomePlanet: "venus", createdAt: at("2026-09-02T09:00:00Z"), referredById: first!.id }),
    mk(3, { welcomePlanet: "earth", createdAt: at("2026-09-02T09:00:00Z"), referredById: first!.id }),
    // A legacy row: no planet stored.
    mk(4, { welcomePlanet: null, createdAt: at("2026-09-03T09:00:00Z") }),
  ]);
}

async function readModel() {
  console.log("\nread model…");
  await seedReadModel();

  const t1 = await getTicketByShareToken("smoke-share-1");
  check("first row is #1 on Mercury", t1?.number === 1 && t1.planet === "mercury", JSON.stringify(t1));
  check("first row has two moons", t1?.moons === 2, String(t1?.moons));
  check("joinedAt is an ISO string", typeof t1?.joinedAt === "string" && t1.joinedAt.endsWith("Z"));

  const t2 = await getTicketByShareToken("smoke-share-2");
  const t3 = await getTicketByShareToken("smoke-share-3");
  check("simultaneous rows get distinct ordinals", t2 !== null && t3 !== null && t2.number !== t3.number, `${t2?.number} vs ${t3?.number}`);
  check("simultaneous rows take 2 and 3", new Set([t2!.number, t3!.number]).size === 2 && Math.min(t2!.number, t3!.number) === 2 && Math.max(t2!.number, t3!.number) === 3);
  check("a referred row has no moons of its own", t2?.moons === 0);

  const t4 = await getTicketByShareToken("smoke-share-4");
  check("legacy row without a planet reads as Mercury", t4?.planet === "mercury" && t4.number === 4);

  check("unknown token is null", (await getTicketByShareToken("nope")) === null);
  check("empty token is null", (await getTicketByShareToken("")) === null);

  check("inviter planet resolves", (await getInviterPlanet("smoke-share-3")) === "earth");
  check("inviter for an unknown token is null", (await getInviterPlanet("nope")) === null);

  const proof = await readInterestProof();
  check("proof counts every row", proof.count === 4, String(proof.count));
  check("next planet follows the count", proof.nextPlanet === planetForSignupNumber(5));
  check("recent planets are newest first, legacy as Mercury", proof.recent.join(",") === "mercury,earth,venus" || proof.recent.join(",") === "mercury,venus,earth", proof.recent.join(","));
  check("count is hidden below the floor", proof.count < INTEREST_LIST_COUNT_FLOOR && !proofShowsCount(proof));
  check("count shows at the floor", proofShowsCount({ ...proof, count: INTEREST_LIST_COUNT_FLOOR }));

  // The memo: a second read inside the window returns the cached value even after a write;
  // invalidation makes the next read fresh.
  const memo1 = await getInterestProof();
  const db = await getDb();
  await db.insert(interestListSignups).values({
    email: `${PREFIX}r5@example.test`,
    unsubscribeToken: generateUnsubscribeToken(),
    welcomePlanet: "jupiter",
  });
  const memo2 = await getInterestProof();
  check("proof is memoised inside the window", memo1.count === memo2.count && memo2.count === 4);
  invalidateInterestProof();
  const memo3 = await getInterestProof();
  check("invalidation refreshes the proof", memo3.count === 5, String(memo3.count));
  await db.delete(interestListSignups).where(eq(interestListSignups.email, `${PREFIX}r5@example.test`));
}

async function main() {
  await cleanup();
  await readModel();
  await cleanup();
  console.log("\ninterest-list join: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
```

Note on `recent`: rows 2 and 3 share a timestamp, so their order among themselves is not defined; the assertion accepts either.

- [ ] **Step 2: Register it and run it to see it fail**

In `scripts/run-smoke.ts`, in `MANIFEST`, after `"smoke-interest-list-admin": "pglite",` add:

```ts
  "smoke-interest-list-join": "pglite",
```

Run: `npx tsx scripts/smoke-interest-list-join.ts 2>&1 | tail -3`
Expected: FAIL with `Cannot find module '../src/lib/interest-list-ticket'`.

- [ ] **Step 3: Write the read module**

`src/lib/interest-list-ticket.ts`:

```ts
/**
 * The read model behind the /interest boarding pass: a row's ordinal, its planet, the
 * people it referred, and the page's proof line.
 *
 * Server-only. Imports `@/db` and nothing from `next/*`, so the join core and the smoke
 * scripts can call it outside a request. The proof memo is module-level rather than
 * `unstable_cache` for the same reason — that helper needs Next's request store, and its
 * companion `revalidateTag(tag)` is deprecated in Next 16 — and because per-instance is
 * the right scope: a second instance lagging a join by up to a minute changes nothing a
 * visitor can act on.
 */
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interestListSignups } from "@/db/schema";
import { INTEREST_LIST_COUNT_FLOOR, type InterestTicket } from "@/lib/interest-list";
import {
  asWelcomePlanet,
  planetForSignupNumber,
  type WelcomePlanet,
} from "@/lib/welcome-planets";

export type InterestProof = {
  /** Every row ever inserted — the population the ordinals are drawn from. */
  count: number;
  nextPlanet: WelcomePlanet;
  /** The last three planets handed out, newest first. */
  recent: WelcomePlanet[];
};

export type SignupRowForTicket = {
  id: string;
  createdAt: Date;
  welcomePlanet: string | null;
  shareToken: string;
};

const countInt = sql<number>`count(*)::int`;

/**
 * Ordinal by (created_at, id): rows inserted in the same instant still get distinct
 * numbers. `id` is a uuid, so `<=` orders it arbitrarily but stably — which is all a
 * tie-break needs.
 */
export async function ticketForRow(row: SignupRowForTicket): Promise<InterestTicket> {
  const db = await getDb();
  const [[ordinal], [moons]] = await Promise.all([
    db
      .select({ n: countInt })
      .from(interestListSignups)
      .where(
        or(
          lt(interestListSignups.createdAt, row.createdAt),
          and(
            eq(interestListSignups.createdAt, row.createdAt),
            sql`${interestListSignups.id} <= ${row.id}::uuid`
          )
        )
      ),
    db
      .select({ n: countInt })
      .from(interestListSignups)
      .where(eq(interestListSignups.referredById, row.id)),
  ]);
  return {
    number: Math.max(1, ordinal?.n ?? 1),
    planet: asWelcomePlanet(row.welcomePlanet),
    joinedAt: row.createdAt.toISOString(),
    moons: moons?.n ?? 0,
    shareToken: row.shareToken,
  };
}

export async function getTicketByShareToken(token: string): Promise<InterestTicket | null> {
  if (!token) return null;
  const db = await getDb();
  const [row] = await db
    .select({
      id: interestListSignups.id,
      createdAt: interestListSignups.createdAt,
      welcomePlanet: interestListSignups.welcomePlanet,
      shareToken: interestListSignups.shareToken,
    })
    .from(interestListSignups)
    .where(eq(interestListSignups.shareToken, token))
    .limit(1);
  if (!row?.shareToken) return null;
  return ticketForRow({ ...row, shareToken: row.shareToken });
}

/** The planet on the ticket a `?ref=` link points at, for the invited strip. */
export async function getInviterPlanet(token: string): Promise<WelcomePlanet | null> {
  if (!token) return null;
  const db = await getDb();
  const [row] = await db
    .select({ welcomePlanet: interestListSignups.welcomePlanet })
    .from(interestListSignups)
    .where(eq(interestListSignups.shareToken, token))
    .limit(1);
  return row ? asWelcomePlanet(row.welcomePlanet) : null;
}

/** Uncached. One count, one three-row read. */
export async function readInterestProof(): Promise<InterestProof> {
  const db = await getDb();
  const [[total], recentRows] = await Promise.all([
    db.select({ n: countInt }).from(interestListSignups),
    db
      .select({ planet: interestListSignups.welcomePlanet })
      .from(interestListSignups)
      .orderBy(desc(interestListSignups.createdAt), desc(interestListSignups.id))
      .limit(3),
  ]);
  const count = total?.n ?? 0;
  return {
    count,
    nextPlanet: planetForSignupNumber(count + 1),
    recent: recentRows.map((r) => asWelcomePlanet(r.planet)),
  };
}

const PROOF_TTL_MS = 60_000;
let proofMemo: { at: number; value: InterestProof } | null = null;

/** The proof line, at most a minute stale. */
export async function getInterestProof(): Promise<InterestProof> {
  if (proofMemo && Date.now() - proofMemo.at < PROOF_TTL_MS) return proofMemo.value;
  const value = await readInterestProof();
  proofMemo = { at: Date.now(), value };
  return value;
}

/** Called by the join core after an insert so the next visitor sees the new count. */
export function invalidateInterestProof() {
  proofMemo = null;
}

export function proofShowsCount(proof: Pick<InterestProof, "count">) {
  return proof.count >= INTEREST_LIST_COUNT_FLOOR;
}
```

- [ ] **Step 4: Run the smoke**

Run: `npx tsx scripts/smoke-interest-list-join.ts 2>&1 | tail -20`
Expected: every `ok` line prints and it ends with `interest-list join: all checks passed`. If the `::uuid` cast errors on PGlite, drop the cast (`sql\`${interestListSignups.id} <= ${row.id}\``) — Postgres infers the parameter type from the column.

- [ ] **Step 5: Commit**

```bash
git add src/lib/interest-list-ticket.ts scripts/smoke-interest-list-join.ts scripts/run-smoke.ts
git commit -m "Interest-list read model: tickets by token, inviter planet, proof memo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Join core, action wrapper, email links

**Files:**
- Create: `src/lib/interest-list-join.ts`
- Rewrite: `src/actions/interest-list.ts`
- Modify: `src/lib/interest-list-email.ts` (builder inputs, send signatures, templates)
- Modify: `src/lib/interest-list-follow-up.ts` (the `sendInterestListFollowUpEmail(...)` call)
- Modify: `src/app/api/admin/email-preview/route.ts` (the two builder calls)
- Modify: `scripts/smoke-interest-list-join.ts` (join half)

**Interfaces:**
- Consumes: Task 3 types and builders; Task 4 read module; `consumeBucket`, `RATE_LIMITS.interestJoin`; `parseAttribution`, `ATTRIBUTION_COOKIE`, `type Attribution` from `@/lib/attribution-parse`; `getAppBaseUrl` from `@/lib/app-url`.
- Produces:
  - `type EmailLinks = { ticketUrl: string; shareUrl: string }` (email module)
  - `sendInterestListWelcomeEmail(email, unsubscribeUrl, planet, links?: EmailLinks)`, `sendInterestListFollowUpEmail(email, unsubscribeUrl, planet, links?: EmailLinks): Promise<boolean>`
  - `buildInterestListWelcomeEmail({ unsubscribeUrl, planet, links? })`, `buildInterestListFollowUpEmail({ unsubscribeUrl, planet, links? })`
  - `type WelcomeSender = (email: string, unsubscribeUrl: string, planet: WelcomePlanet, links: EmailLinks) => Promise<unknown>`
  - `type JoinContext = { ip: string; attribution: Attribution | null; sendWelcome?: WelcomeSender }`
  - `joinInterestListCore(input: InterestListInput, ctx: JoinContext): Promise<InterestListResult>`
  - `joinInterestList(input: InterestListInput): Promise<InterestListResult>` (the action, unchanged name)

- [ ] **Step 1: Extend the smoke with the join half (failing)**

Add to `scripts/smoke-interest-list-join.ts`, after the imports:

```ts
import { joinInterestListCore, type JoinContext } from "../src/lib/interest-list-join";
import { MIN_FILL_MS } from "../src/lib/interest-list";
import type { EmailLinks } from "../src/lib/interest-list-email";
```

and this function before `main`:

```ts
async function joinPath() {
  console.log("\njoin path…");
  const db = await getDb();
  const sent: Array<{ email: string; links: EmailLinks }> = [];
  const ctx = (ip: string): JoinContext => ({
    ip: `smoke-${ip}`,
    attribution: { referrer: "reddit.com", utmSource: "reddit", utmMedium: null, utmCampaign: null, landingPath: "/interest" },
    sendWelcome: async (email, _unsub, _planet, links) => {
      sent.push({ email, links });
    },
  });
  const base = { website: "", elapsedMs: MIN_FILL_MS + 10 };
  const rowFor = async (email: string) =>
    (await db.select().from(interestListSignups).where(eq(interestListSignups.email, email)))[0];

  // --- new join
  const a = await joinInterestListCore({ ...base, email: `${PREFIX}A@Example.test` }, ctx("a"));
  check("new join is ok", a.ok);
  if (!a.ok) return;
  const rowA = await rowFor(`${PREFIX}a@example.test`);
  check("email is normalised on insert", Boolean(rowA));
  check("ticket carries the stored share token", rowA?.shareToken === a.ticket.shareToken);
  check("ticket planet matches the stored one", rowA?.welcomePlanet === a.ticket.planet);
  check("attribution is stored", rowA?.utmSource === "reddit" && rowA.landingPath === "/interest");
  check("welcome sent once with both links", sent.length === 1 && sent[0]!.links.ticketUrl.includes(`me=${a.ticket.shareToken}`) && sent[0]!.links.shareUrl.includes(`ref=${a.ticket.shareToken}`));

  // --- duplicate: same ticket, no second mail, still one row
  const a2 = await joinInterestListCore({ ...base, email: `${PREFIX}a@example.test` }, ctx("a"));
  check("duplicate is ok", a2.ok);
  check("duplicate returns the same ticket", a2.ok && a2.ticket.shareToken === a.ticket.shareToken && a2.ticket.number === a.ticket.number);
  check("duplicate sends nothing", sent.length === 1);
  check("duplicate creates no row", (await db.select().from(interestListSignups).where(like(interestListSignups.email, `${PREFIX}a@%`))).length === 1);

  // --- referral: B joins through A's link
  const b = await joinInterestListCore({ ...base, email: `${PREFIX}b@example.test`, ref: a.ticket.shareToken }, ctx("b"));
  check("referred join is ok", b.ok);
  const rowB = await rowFor(`${PREFIX}b@example.test`);
  check("referred row points at the referrer", rowB?.referredById === rowA?.id);
  const a3 = await joinInterestListCore({ ...base, email: `${PREFIX}a@example.test` }, ctx("a"));
  check("referrer now has one moon", a3.ok && a3.ticket.moons === 1, a3.ok ? String(a3.ticket.moons) : "not ok");
  check("referred ticket is the next number", b.ok && a.ok && b.ticket.number === a.ticket.number + 1);

  // --- self-referral and unknown ref
  const c = await joinInterestListCore({ ...base, email: `${PREFIX}c@example.test`, ref: "no-such-token" }, ctx("c"));
  check("unknown ref still joins", c.ok);
  check("unknown ref stores no referrer", (await rowFor(`${PREFIX}c@example.test`))?.referredById === null);
  // Rejoining with your own token must never credit yourself (the branch is unreachable
  // for an active row, but an unsubscribed one rejoins through the update path).
  await db.update(interestListSignups).set({ unsubscribedAt: new Date(), followUpSentAt: new Date() }).where(eq(interestListSignups.email, `${PREFIX}c@example.test`));
  const cTicket = c.ok ? c.ticket : null;
  const c2 = await joinInterestListCore({ ...base, email: `${PREFIX}c@example.test`, ref: cTicket!.shareToken }, ctx("c"));
  const rowC = await rowFor(`${PREFIX}c@example.test`);
  check("rejoin reactivates and re-arms the follow-up", c2.ok && rowC?.unsubscribedAt === null && rowC.followUpSentAt === null);
  check("rejoin keeps the planet and token", rowC?.welcomePlanet === cTicket!.planet && rowC?.shareToken === cTicket!.shareToken);
  check("rejoin never credits a referrer", rowC?.referredById === null);
  check("rejoin sends the welcome again", sent.filter((s) => s.email === `${PREFIX}c@example.test`).length === 2);

  // --- legacy row without a share token gets one on the next submit
  await db.insert(interestListSignups).values({ email: `${PREFIX}legacy@example.test`, unsubscribeToken: generateUnsubscribeToken(), welcomePlanet: "saturn" });
  const legacy = await joinInterestListCore({ ...base, email: `${PREFIX}legacy@example.test` }, ctx("legacy"));
  const rowL = await rowFor(`${PREFIX}legacy@example.test`);
  check("legacy row is minted a share token", legacy.ok && Boolean(rowL?.shareToken) && legacy.ticket.shareToken === rowL?.shareToken);
  check("legacy mint sends no mail", !sent.some((s) => s.email === `${PREFIX}legacy@example.test`));

  // --- honeypot, too fast: ok, plausible ticket, no row
  const before = (await db.select().from(interestListSignups)).length;
  const bot = await joinInterestListCore({ ...base, website: "http://spam", email: `${PREFIX}bot@example.test` }, ctx("bot"));
  const fast = await joinInterestListCore({ ...base, elapsedMs: 10, email: `${PREFIX}fast@example.test` }, ctx("fast"));
  check("honeypot answers ok with a ticket", bot.ok && bot.ticket.number > 0 && bot.ticket.shareToken.length > 10);
  check("too-fast answers ok with a ticket", fast.ok && fast.ticket.moons === 0);
  check("neither writes a row", (await db.select().from(interestListSignups)).length === before);
  check("fake tokens resolve to nothing", bot.ok && (await getTicketByShareToken(bot.ticket.shareToken)) === null);

  // --- invalid email is the one visible error
  const bad = await joinInterestListCore({ ...base, email: "not-an-email" }, ctx("bad"));
  check("a bad address is refused with the form's copy", !bad.ok && bad.message === "That address doesn't look right.");

  // --- rate limit: the sixth submit from one IP gets a fake ticket and no row
  for (let i = 1; i <= 5; i += 1) {
    const r = await joinInterestListCore({ ...base, email: `${PREFIX}rl${i}@example.test` }, ctx("rl"));
    check(`submit ${i} of 5 lands`, r.ok && Boolean(await rowFor(`${PREFIX}rl${i}@example.test`)));
  }
  const sixth = await joinInterestListCore({ ...base, email: `${PREFIX}rl6@example.test` }, ctx("rl"));
  check("sixth submit still answers ok", sixth.ok);
  check("sixth submit writes no row", (await rowFor(`${PREFIX}rl6@example.test`)) === undefined);

  // --- the proof memo was invalidated by the inserts
  const proof = await getInterestProof();
  check("proof reflects the joins", proof.count >= 8, String(proof.count));
}
```

And in `main()`, call `await joinPath();` after `await readModel();`.

Run: `npx tsx scripts/smoke-interest-list-join.ts 2>&1 | tail -3`
Expected: FAIL with `Cannot find module '../src/lib/interest-list-join'`.

- [ ] **Step 2: Add links to the email templates**

In `src/lib/interest-list-email.ts`:

Add the type after the re-export block:

```ts
/** The two personal links a signup gets once it has a share token. */
export type EmailLinks = { ticketUrl: string; shareUrl: string };
```

Change the welcome builder's input to `{ unsubscribeUrl: string; planet: WelcomePlanet; links?: EmailLinks }` and, in its `text` array, replace the PS line with:

```ts
    `PS — everyone on this list gets a different planet, in order out from the sun. You got ${planetLabel(input.planet)}.`,
    ...(input.links
      ? [
          "",
          `Your ticket, with your number and your planet: ${input.links.ticketUrl}`,
          `Know someone who'd like a planet? Send them your link: ${input.links.shareUrl}`,
        ]
      : []),
```

In its HTML, directly after the PS `<tr>…</tr>` (the one containing `You got <span`), add:

```ts
            ${
              input.links
                ? `<tr>
              <td style="font-size:14px;line-height:1.7;color:${MUTED};padding-bottom:26px;">
                <a href="${escapeHtml(input.links.ticketUrl)}" style="color:${ACCENT};text-decoration:underline;">Your ticket</a>, with your number and your planet.
                Know someone who'd like a planet?
                <a href="${escapeHtml(input.links.shareUrl)}" style="color:${ACCENT};text-decoration:underline;">Send them your link</a>.
              </td>
            </tr>`
                : ""
            }
```

Apply the same `links?: EmailLinks` input to the follow-up builder; in its `text` array add, before `"— Jason"`:

```ts
    ...(input.links ? [`Your ticket is still here: ${input.links.ticketUrl}`, ""] : []),
```

and in its HTML, before the row that holds the `— Jason` sign-off, the same conditional `<tr>` with only the ticket sentence:

```ts
            ${
              input.links
                ? `<tr>
              <td style="font-size:14px;line-height:1.7;color:${MUTED};padding-bottom:26px;">
                <a href="${escapeHtml(input.links.ticketUrl)}" style="color:${ACCENT};text-decoration:underline;">Your ticket</a> is still here.
              </td>
            </tr>`
                : ""
            }
```

Change the two send functions:

```ts
export async function sendInterestListWelcomeEmail(
  email: string,
  unsubscribeUrl: string,
  planet: WelcomePlanet,
  links?: EmailLinks
) {
  await deliver(
    "welcome",
    email,
    unsubscribeUrl,
    buildInterestListWelcomeEmail({ unsubscribeUrl, planet, links })
  );
}

/** Returns whether it sent, so the sweep can un-claim the row if it did not. */
export async function sendInterestListFollowUpEmail(
  email: string,
  unsubscribeUrl: string,
  planet: WelcomePlanet,
  links?: EmailLinks
): Promise<boolean> {
  return deliver(
    "follow-up",
    email,
    unsubscribeUrl,
    buildInterestListFollowUpEmail({ unsubscribeUrl, planet, links })
  );
}
```

- [ ] **Step 3: Pass links from the follow-up sweep and the admin preview**

In `src/lib/interest-list-follow-up.ts`, add the imports `import { buildShareUrl, buildTicketUrl } from "@/lib/interest-list";` and `import { getAppBaseUrl } from "@/lib/app-url";`, and change the send call to:

```ts
    const appUrl = getAppBaseUrl();
    const ok = await sendInterestListFollowUpEmail(
      row.email,
      buildUnsubscribeUrl(row.unsubscribeToken),
      asWelcomePlanet(row.welcomePlanet),
      row.shareToken
        ? { ticketUrl: buildTicketUrl(appUrl, row.shareToken), shareUrl: buildShareUrl(appUrl, row.shareToken) }
        : undefined
    );
```

The candidates query in that file projects only `id`, `email`, `unsubscribeToken` and `welcomePlanet`; add one line to its `.select({ … })`:

```ts
      shareToken: interestListSignups.shareToken,
```

In `src/app/api/admin/email-preview/route.ts`, add a constant next to `SAMPLE_UNSUBSCRIBE`:

```ts
const SAMPLE_LINKS = {
  ticketUrl: "https://orbit.example/interest?me=sample-token",
  shareUrl: "https://orbit.example/interest?ref=sample-token",
};
```

and pass `links: SAMPLE_LINKS` in both `buildInterestListFollowUpEmail({...})` and `buildInterestListWelcomeEmail({...})` calls.

- [ ] **Step 4: Write the join core**

`src/lib/interest-list-join.ts`:

```ts
/**
 * The interest-list join, minus the request. `src/actions/interest-list.ts` reads the
 * headers and the attribution cookie and hands them in here, so this can run from a smoke
 * script with a fake IP and a recording mail sender.
 *
 * WHAT A CALLER LEARNS. Every path that does not end in a visible validation error returns
 * `ok` with a ticket. A real join, a duplicate, an unsubscribed address rejoining, a bot
 * and a rate-limited caller all get the same shape, so which check a submit tripped is
 * not inferable from the response. What IS inferable, by design (see the spec's privacy
 * section): a duplicate gets its real ticket, whose number is below the current total —
 * membership of an address can be probed at five tries per ten minutes per IP. The
 * address itself is never returned.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interestListSignups } from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import type { Attribution } from "@/lib/attribution-parse";
import {
  MIN_FILL_MS,
  buildShareUrl,
  buildTicketUrl,
  interestListSchema,
  type InterestListInput,
  type InterestListResult,
  type InterestTicket,
} from "@/lib/interest-list";
import {
  buildUnsubscribeUrl,
  generateUnsubscribeToken,
  sendInterestListWelcomeEmail,
  type EmailLinks,
} from "@/lib/interest-list-email";
import {
  getInterestProof,
  invalidateInterestProof,
  ticketForRow,
} from "@/lib/interest-list-ticket";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import { planetForSignupNumber, type WelcomePlanet } from "@/lib/welcome-planets";

export type WelcomeSender = (
  email: string,
  unsubscribeUrl: string,
  planet: WelcomePlanet,
  links: EmailLinks
) => Promise<unknown>;

export type JoinContext = {
  /** Rate-limit key. The action derives it from x-forwarded-for. */
  ip: string;
  attribution: Attribution | null;
  /** Injected by the smoke test; defaults to the real Resend send. */
  sendWelcome?: WelcomeSender;
};

const FORMAT_ERROR = "That address doesn't look right.";

/** Same generator as the unsubscribe token; a separate value, never the same one. */
export function generateShareToken() {
  return generateUnsubscribeToken();
}

/**
 * What a bot, a too-fast fill or a rate-limited caller sees: the next number that would be
 * handed out, its planet, and a token that exists nowhere. Indistinguishable in shape from
 * a real ticket; resolves to nothing if followed.
 */
async function plausibleTicket(): Promise<InterestTicket> {
  const proof = await getInterestProof();
  const number = proof.count + 1;
  return {
    number,
    planet: planetForSignupNumber(number),
    joinedAt: new Date().toISOString(),
    moons: 0,
    shareToken: generateShareToken(),
  };
}

export async function joinInterestListCore(
  input: InterestListInput,
  ctx: JoinContext
): Promise<InterestListResult> {
  // 1. Honeypot, before parsing: a filled decoy field is a bot, and a bot gets a ticket.
  if (typeof input.website === "string" && input.website.length > 0) {
    return { ok: true, ticket: await plausibleTicket() };
  }

  // 2. Validation — the one path with a visible error.
  const parsed = interestListSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: FORMAT_ERROR };
  const { elapsedMs, ref } = parsed.data;
  const email = parsed.data.email.trim().toLowerCase();

  // 3. Faster than a person can read the form.
  if (elapsedMs < MIN_FILL_MS) return { ok: true, ticket: await plausibleTicket() };

  // 4. Rate limit. A limiter that cannot count must not fail open into the write, and must
  //    not break a real person's signup either — so any throw is the fake ticket.
  try {
    await consumeBucket("interest.join", ctx.ip, RATE_LIMITS.interestJoin);
  } catch {
    return { ok: true, ticket: await plausibleTicket() };
  }

  const db = await getDb();

  // 5. Who sent them, if anyone.
  const referrer = ref
    ? (
        await db
          .select({ id: interestListSignups.id, email: interestListSignups.email })
          .from(interestListSignups)
          .where(eq(interestListSignups.shareToken, ref))
          .limit(1)
      )[0] ?? null
    : null;

  // 6. Read, then write down one of three branches.
  const [existing] = await db
    .select()
    .from(interestListSignups)
    .where(eq(interestListSignups.email, email))
    .limit(1);

  let row = existing;
  let welcome = false;

  if (!existing) {
    // The planet this signup gets: one step further out than the last. Counted before the
    // insert so the number is this row's own ordinal.
    const [before] = await db.select({ n: sql<number>`count(*)::int` }).from(interestListSignups);
    const inserted = await db
      .insert(interestListSignups)
      .values({
        email,
        referrer: ctx.attribution?.referrer ?? null,
        utmSource: ctx.attribution?.utmSource ?? null,
        utmMedium: ctx.attribution?.utmMedium ?? null,
        utmCampaign: ctx.attribution?.utmCampaign ?? null,
        landingPath: ctx.attribution?.landingPath ?? null,
        unsubscribeToken: generateUnsubscribeToken(),
        shareToken: generateShareToken(),
        welcomePlanet: planetForSignupNumber((before?.n ?? 0) + 1),
        // Never yourself: a token whose row owns this address is not a referral.
        referredById: referrer && referrer.email !== email ? referrer.id : null,
      })
      .onConflictDoNothing({ target: interestListSignups.email })
      // Bare, not `.returning({...})`: an explicit selector defeats Drizzle's overload
      // resolution after an `onConflict*` call in this TS version.
      .returning();

    if (inserted[0]) {
      row = inserted[0];
      welcome = true;
      invalidateInterestProof();
    } else {
      // Lost a race with a concurrent submit of the same address: it exists now.
      [row] = await db
        .select()
        .from(interestListSignups)
        .where(eq(interestListSignups.email, email))
        .limit(1);
    }
  }

  if (row && !welcome) {
    if (row.unsubscribedAt) {
      // Rejoining restarts the sequence: clearing follow_up_sent_at re-arms the day-3 note.
      // The planet is theirs — rewriting it would contradict the mail they already have.
      // referred_by_id is untouched: credit is written once, on insert.
      [row] = await db
        .update(interestListSignups)
        .set({
          unsubscribedAt: null,
          followUpSentAt: null,
          shareToken: row.shareToken ?? generateShareToken(),
        })
        .where(eq(interestListSignups.id, row.id))
        .returning();
      welcome = true;
    } else if (!row.shareToken) {
      // A row from before share tokens existed: mint one, send nothing.
      [row] = await db
        .update(interestListSignups)
        .set({ shareToken: generateShareToken() })
        .where(eq(interestListSignups.id, row.id))
        .returning();
    }
  }

  if (!row?.shareToken) {
    // Unreachable: every branch above leaves a row with a token. Fail like a bot would.
    return { ok: true, ticket: await plausibleTicket() };
  }

  const ticket = await ticketForRow({
    id: row.id,
    createdAt: row.createdAt,
    welcomePlanet: row.welcomePlanet,
    shareToken: row.shareToken,
  });

  if (welcome) {
    const appUrl = getAppBaseUrl();
    const send = ctx.sendWelcome ?? sendInterestListWelcomeEmail;
    // Best-effort: the signup above already succeeded, so a Resend hiccup must not turn
    // this into a failed submission. The real sender only ever logs.
    await send(row.email, buildUnsubscribeUrl(row.unsubscribeToken), ticket.planet, {
      ticketUrl: buildTicketUrl(appUrl, row.shareToken),
      shareUrl: buildShareUrl(appUrl, row.shareToken),
    });
  }

  return { ok: true, ticket };
}
```

- [ ] **Step 5: Rewrite the action as a wrapper**

`src/actions/interest-list.ts`:

```ts
"use server";

import { cookies, headers } from "next/headers";
import { ATTRIBUTION_COOKIE, parseAttribution } from "@/lib/attribution-parse";
import type { InterestListInput, InterestListResult } from "@/lib/interest-list";
import { joinInterestListCore } from "@/lib/interest-list-join";

/**
 * The request-reading half of the join. Everything that decides what happens lives in
 * `lib/interest-list-join.ts`, which the smoke test drives without a request.
 */
export async function joinInterestList(
  input: InterestListInput
): Promise<InterestListResult> {
  const headerList = await headers();
  // First hop in x-forwarded-for is the client; the rest are proxies.
  const ip =
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headerList.get("x-real-ip")?.trim() ||
    "unknown";

  const cookieStore = await cookies();
  const attribution = parseAttribution(cookieStore.get(ATTRIBUTION_COOKIE)?.value ?? null);

  return joinInterestListCore(input, { ip, attribution });
}
```

- [ ] **Step 6: Run the smoke, tsc, and the admin smoke**

Run:
```bash
npx tsx scripts/smoke-interest-list-join.ts 2>&1 | tail -30 && npx tsc --noEmit 2>&1 | tail -5 && npx tsx scripts/smoke-interest-list-admin.ts 2>&1 | tail -1
```
Expected: every `ok` line, `interest-list join: all checks passed`, tsc silent, admin smoke passes. A failure on "rejoin never credits a referrer" means the update branch wrote `referredById`; on "sixth submit writes no row" means the bucket key or policy is wrong.

- [ ] **Step 7: Commit**

```bash
git add src/lib/interest-list-join.ts src/actions/interest-list.ts src/lib/interest-list-email.ts src/lib/interest-list-follow-up.ts src/app/api/admin/email-preview/route.ts scripts/smoke-interest-list-join.ts
git commit -m "Join returns a ticket: read-then-write core, referral credit, bucket rate limit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Ticket image route

**Files:**
- Create: `src/app/api/interest-list/ticket-image/route.tsx`
- Create: `src/app/api/interest-list/ticket-image/fonts/Fraunces-Regular.ttf`, `Fraunces-Italic.ttf`, `OFL.txt`
- Modify: `src/lib/public-routes.ts` (after `"/api/interest-list/unsubscribe",`)
- Modify: `next.config.ts` (top-level `outputFileTracingIncludes`)
- Create: `scripts/smoke-interest-ticket-image.ts`; Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `getTicketByShareToken` (Task 4), `SHARE_TOKEN_MAX`, `formatTicketNumber`, `passengerLine` (Task 3), `planetLabel`, `PLANET_GLOW` (Task 3).
- Produces: `GET /api/interest-list/ticket-image?token=…` → `image/png`, 1200×630, `Cache-Control: public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400`; 200 for any token.

- [ ] **Step 1: Vendor the fonts**

Run (the Google Fonts CSS endpoint serves static TTFs to a user agent without woff2 support):
```bash
cd /Users/jasonpereira/Projects/orbit/.claude/worktrees/new-session-0999e5 && mkdir -p src/app/api/interest-list/ticket-image/fonts && cd src/app/api/interest-list/ticket-image/fonts && \
UA="Mozilla/5.0 (Windows NT 6.1; WOW64; rv:1.0)" && \
R=$(curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=Fraunces:wght@400" | grep -o "https://[^)]*\.ttf" | head -1) && \
I=$(curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@1,400" | grep -o "https://[^)]*\.ttf" | head -1) && \
curl -s -o Fraunces-Regular.ttf "$R" && curl -s -o Fraunces-Italic.ttf "$I" && \
curl -s -o OFL.txt "https://raw.githubusercontent.com/google/fonts/main/ofl/fraunces/OFL.txt" && \
file Fraunces-Regular.ttf Fraunces-Italic.ttf && ls -la
```
Expected: `file` reports `TrueType Font data` for both; each is roughly 100–200 KB; `OFL.txt` begins with `Copyright`.

- [ ] **Step 2: Write the failing smoke**

`scripts/smoke-interest-ticket-image.ts`:

```ts
/**
 * The boarding-pass image behind every shared /interest link.
 *
 * WHY THIS EXISTS. A link preview that 500s is worse than none: X and LinkedIn cache the
 * failure. This calls the route handler for a real token and a bogus one and asserts both
 * come back as a cacheable PNG.
 *
 * Run: npx tsx scripts/smoke-interest-ticket-image.ts
 */
import "./smoke/_env";

import { like } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb } from "../src/db";
import { interestListSignups } from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";

const PREFIX = "smoke-img-";
const TOKEN = "smoke-img-token";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
}

async function main() {
  await cleanup();
  const db = await getDb();
  await db.insert(interestListSignups).values({
    email: `${PREFIX}a@example.test`,
    unsubscribeToken: generateUnsubscribeToken(),
    shareToken: TOKEN,
    welcomePlanet: "mars",
  });

  const { GET } = await import("../src/app/api/interest-list/ticket-image/route");
  const call = (qs: string) =>
    GET(new NextRequest(`http://localhost/api/interest-list/ticket-image${qs}`));

  const real = await call(`?token=${TOKEN}`);
  check("real token: 200", real.status === 200, String(real.status));
  check("real token: png", real.headers.get("content-type") === "image/png", real.headers.get("content-type") ?? "");
  check("real token: cacheable", (real.headers.get("cache-control") ?? "").includes("s-maxage=86400"));
  const bytes = new Uint8Array(await real.arrayBuffer());
  check("real token: is a PNG", bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47);
  check("real token: has a body", bytes.length > 10_000, String(bytes.length));

  const bogus = await call("?token=nope");
  check("bogus token: still 200", bogus.status === 200, String(bogus.status));
  check("bogus token: png", bogus.headers.get("content-type") === "image/png");
  check("bogus token: cacheable", (bogus.headers.get("cache-control") ?? "").includes("s-maxage=86400"));

  const missing = await call("");
  check("missing token: still 200", missing.status === 200);

  await cleanup();
  console.log("\nticket image: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
```

Register in `scripts/run-smoke.ts` `MANIFEST`, after `"smoke-interest-list-join": "pglite",`:

```ts
  "smoke-interest-ticket-image": "pglite",
```

Run: `npx tsx scripts/smoke-interest-ticket-image.ts 2>&1 | tail -3`
Expected: FAIL with `Cannot find module '../src/app/api/interest-list/ticket-image/route'`.

- [ ] **Step 3: Write the route**

`src/app/api/interest-list/ticket-image/route.tsx`:

```tsx
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";
import { SHARE_TOKEN_MAX, formatTicketNumber } from "@/lib/interest-list";
import { getTicketByShareToken } from "@/lib/interest-list-ticket";
import { PLANET_GLOW, planetLabel, type WelcomePlanet } from "@/lib/welcome-planets";

/**
 * The boarding pass as a 1200×630 link preview, one per share token.
 *
 * Public (see `PUBLIC_ROUTES`): social crawlers carry no session. Any token answers 200 —
 * a bogus one gets the generic "get your planet" card — because X and LinkedIn cache a
 * failed preview and never come back for it. No moons on the image: they would go stale
 * under the day-long CDN cache, and the number and planet are the part people share.
 *
 * Fonts are vendored TTFs (Satori reads TTF/OTF/WOFF, not woff2, and `next/font` exposes
 * no file). Read at request time, not imported: `next.config.ts` lists the directory in
 * `outputFileTracingIncludes` so the deploy bundle carries it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";
const FONT_DIR = path.join(process.cwd(), "src/app/api/interest-list/ticket-image/fonts");
const PLANET_DIR = path.join(process.cwd(), "public/landing/planets");

const BG = "#05070f";
const TEXT = "#e8f3f1";
const MUTED = "#9aada8";
const FAINT = "#6d807c";
const ACCENT = "#f2c14e";
const SEAM = "rgba(232, 243, 241, 0.22)";

/** `ImageResponse` wants a plain ArrayBuffer; `readFile` hands back a Buffer view. */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function loadAssets(planet: WelcomePlanet) {
  const [regular, italic, png] = await Promise.all([
    readFile(path.join(FONT_DIR, "Fraunces-Regular.ttf")),
    readFile(path.join(FONT_DIR, "Fraunces-Italic.ttf")),
    readFile(path.join(PLANET_DIR, `${planet}.png`)),
  ]);
  return {
    fonts: [
      { name: "Fraunces", data: toArrayBuffer(regular), weight: 400 as const, style: "normal" as const },
      { name: "Fraunces", data: toArrayBuffer(italic), weight: 400 as const, style: "italic" as const },
    ],
    planetSrc: `data:image/png;base64,${png.toString("base64")}`,
  };
}

function Card({
  planet,
  planetSrc,
  number,
}: {
  planet: WelcomePlanet;
  planetSrc: string;
  /** null renders the generic card. */
  number: number | null;
}) {
  const label = planetLabel(planet);
  return (
    <div
      style={{
        width: 1200,
        height: 630,
        display: "flex",
        background: BG,
        color: TEXT,
        fontFamily: "Fraunces",
        padding: 56,
      }}
    >
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          border: "1px solid rgba(232,243,241,0.10)",
          borderRadius: 32,
          background: "linear-gradient(180deg, rgba(232,243,241,0.05), rgba(232,243,241,0.015))",
        }}
      >
        {/* Stub */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            width: 380,
            borderRight: `2px dashed ${SEAM}`,
            padding: 40,
          }}
        >
          <div
            style={{
              display: "flex",
              width: 220,
              height: 220,
              borderRadius: 999,
              boxShadow: `0 0 90px ${PLANET_GLOW[planet]}`,
            }}
          >
            <img src={planetSrc} width={220} height={220} alt="" />
          </div>
          {number !== null ? (
            <div style={{ display: "flex", fontSize: 72, marginTop: 28, letterSpacing: -2 }}>
              #{formatTicketNumber(number)}
            </div>
          ) : null}
          <div style={{ display: "flex", fontSize: 26, color: MUTED, marginTop: number !== null ? 4 : 28 }}>
            {number !== null ? label : "Your planet awaits"}
          </div>
        </div>
        {/* Details */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            flex: 1,
            padding: "40px 56px",
          }}
        >
          <div style={{ display: "flex", fontSize: 20, letterSpacing: 4, color: ACCENT }}>
            ORBIT · INTEREST LIST
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", fontSize: 56, lineHeight: 1.1, marginTop: 20, letterSpacing: -1.5 }}>
            {number !== null ? (
              <span>
                Passenger {formatTicketNumber(number)}, bound for{" "}
                <span style={{ fontStyle: "italic", color: ACCENT }}>{label}</span>.
              </span>
            ) : (
              <span>
                Every person who joins is handed a{" "}
                <span style={{ fontStyle: "italic", color: ACCENT }}>planet</span>.
              </span>
            )}
          </div>
          <div style={{ display: "flex", fontSize: 26, color: MUTED, marginTop: 28, lineHeight: 1.4 }}>
            {number !== null
              ? "Occasional notes from the one person building Orbit. Get your own planet."
              : "Occasional notes from the one person building Orbit. Join and get yours."}
          </div>
          <div style={{ display: "flex", fontSize: 22, color: FAINT, marginTop: 40 }}>
            orbit — the personal networking CRM
          </div>
        </div>
      </div>
    </div>
  );
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("token")?.trim() ?? "";
  const token = raw.length > 0 && raw.length <= SHARE_TOKEN_MAX ? raw : "";
  const ticket = token ? await getTicketByShareToken(token) : null;

  const planet: WelcomePlanet = ticket?.planet ?? "earth";
  const { fonts, planetSrc } = await loadAssets(planet);

  return new ImageResponse(
    <Card planet={planet} planetSrc={planetSrc} number={ticket?.number ?? null} />,
    {
      width: 1200,
      height: 630,
      fonts,
      headers: { "Cache-Control": CACHE_CONTROL },
    }
  );
}
```

- [ ] **Step 4: Make the route public and trace its files**

In `src/lib/public-routes.ts`, after `"/api/interest-list/unsubscribe",`:

```ts
  // The boarding-pass link preview. Fetched by X, LinkedIn and iMessage, which carry no
  // session; authenticated by nothing, because it reveals only a number and a planet.
  "/api/interest-list/ticket-image",
```

In `next.config.ts`, add a top-level key next to `experimental` (not inside it):

```ts
  // The ticket-image route reads its fonts and the planet art from disk at request time;
  // without this the deploy bundle omits them and the route 500s only in production.
  outputFileTracingIncludes: {
    "/api/interest-list/ticket-image": [
      "./src/app/api/interest-list/ticket-image/fonts/*",
      "./public/landing/planets/*.png",
    ],
  },
```

- [ ] **Step 5: Run the smoke and tsc**

Run: `npx tsx scripts/smoke-interest-ticket-image.ts 2>&1 | tail -12 && npx tsc --noEmit 2>&1 | tail -3`
Expected: all `ok` lines and `ticket image: all checks passed`; tsc silent. If Satori throws about a `div` with multiple children lacking `display: flex`, the offending element is named in the message — add the style. If `next/og` cannot initialise its wasm under tsx, change the manifest entry to `"smoke-interest-ticket-image": "manual"`, note it in the commit message, and verify the route in the browser in Task 9 instead.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/interest-list/ticket-image src/lib/public-routes.ts next.config.ts scripts/smoke-interest-ticket-image.ts scripts/run-smoke.ts
git commit -m "Ticket image: the boarding pass as a cacheable link preview

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Ticket components — planet art, proof line, moons, share row, boarding pass

**Files:**
- Create: `src/components/interest/planet-art.tsx`
- Create: `src/components/interest/proof-line.tsx`
- Create: `src/components/interest/moons.tsx`
- Create: `src/components/interest/share-row.tsx`
- Create: `src/components/interest/boarding-pass.tsx`
- Modify: `src/app/globals.css` (after the `.interest-rings-spin-reverse` block)
- Test: `npx tsc --noEmit`, `npx eslint src/components/interest`

**Interfaces:**
- Consumes: Task 3 (`InterestTicket`, `MOONS_DRAWN_MAX`, `formatTicketNumber`, `passengerLine`, `moonsLine`, `shareText`, `buildShareUrl`, `buildTicketUrl`), `PLANET_GLOW`, `planetLabel`; Task 4's `InterestProof` type (import type only — it is a type, so the client bundle pulls nothing).
- Produces:
  - `PlanetArt({ planet: WelcomePlanet; size: number; className?: string })` — server-safe.
  - `ProofLine({ proof: InterestProof; showCount: boolean })` — client.
  - `Moons({ count: number; play: boolean; size: number })` — client; draws `min(count, MOONS_DRAWN_MAX)` moons on a ring of diameter `size`.
  - `ShareRow({ ticket: InterestTicket; appUrl: string; play: boolean })` — client.
  - `BoardingPass({ ticket: InterestTicket; appUrl: string; signUpHref: string; entrance: "flip" | "direct"; headingRef?: React.Ref<HTMLHeadingElement> })` — client.

There is no component test runner in this repo; these are verified by tsc + eslint here, by the page smoke in Task 8 (server tree), and in the browser in Task 9.

- [ ] **Step 1: CSS**

In `src/app/globals.css`, after the `.interest-rings-spin-reverse { … }` block:

```css
/* The /interest card's Y-axis flip (form → boarding pass). The wrapper supplies the
 * perspective; the face is what motion rotates. `transform-style` keeps the glass's
 * backdrop-filter composited during the turn. */
.interest-flip-stage {
  perspective: 1400px;
}
.interest-flip-face {
  transform-style: preserve-3d;
  backface-visibility: hidden;
}

/* Referral moons drift around the planet once they have dropped in. Slow enough to read
 * as an orbit, not a spinner. Paused, not removed, under reduced motion so the moons
 * still sit on their ring. */
@keyframes interest-moon-drift {
  to {
    transform: rotate(360deg);
  }
}
.interest-moons-drift {
  animation: interest-moon-drift 40s linear infinite;
  transform-origin: 50% 50%;
  will-change: transform;
}
@media (prefers-reduced-motion: reduce) {
  .interest-moons-drift {
    animation-play-state: paused;
  }
}
```

- [ ] **Step 2: Planet art**

`src/components/interest/planet-art.tsx`:

```tsx
import { PLANET_GLOW, type WelcomePlanet } from "@/lib/welcome-planets";
import { cn } from "@/lib/utils";

/**
 * One planet from `public/landing/planets/`, with the landing hero's glow treatment
 * (`hero-planet-atmosphere` in globals.css). Server-safe: no hooks, no motion.
 */
export function PlanetArt({
  planet,
  size,
  className,
}: {
  planet: WelcomePlanet;
  /** CSS px. */
  size: number;
  className?: string;
}) {
  return (
    <span
      className={cn("relative inline-block shrink-0", className)}
      style={{ width: size, height: size, ["--planet-glow" as string]: PLANET_GLOW[planet] }}
      aria-hidden="true"
    >
      <picture>
        <source type="image/avif" srcSet={`/landing/planets/${planet}.avif`} />
        <source type="image/webp" srcSet={`/landing/planets/${planet}.webp`} />
        <img
          className="hero-planet-art"
          src={`/landing/planets/${planet}.png`}
          alt=""
          width={size}
          height={size}
          draggable={false}
        />
      </picture>
      <span className="hero-planet-atmosphere" />
    </span>
  );
}
```

- [ ] **Step 3: Proof line**

`src/components/interest/proof-line.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { PlanetArt } from "@/components/interest/planet-art";
import { formatTicketNumber } from "@/lib/interest-list";
import type { InterestProof } from "@/lib/interest-list-ticket";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { planetLabel } from "@/lib/welcome-planets";

/**
 * "1,284 people have joined · next planet up: Mars", or just the planet below the floor.
 *
 * The server renders the final number; after hydration the digits roll up from a few
 * dozen below, once. The roll starts in an effect, never in render, so the HTML and the
 * first client render agree.
 */
export function ProofLine({ proof, showCount }: { proof: InterestProof; showCount: boolean }) {
  return (
    <p className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs leading-[1.6] text-[#9aada8]">
      <span className="flex items-center" aria-hidden="true">
        {proof.recent.map((planet, i) => (
          <PlanetArt
            key={`${planet}-${i}`}
            planet={planet}
            size={14}
            className={i > 0 ? "-ml-1" : undefined}
          />
        ))}
      </span>
      {showCount ? (
        <span>
          <RollingCount value={proof.count} /> people have joined
        </span>
      ) : null}
      {showCount ? <span aria-hidden="true">·</span> : null}
      <span>
        next planet up: <span className="text-landing-accent">{planetLabel(proof.nextPlanet)}</span>
      </span>
    </p>
  );
}

/** Rolls from `value − 40` to `value` after mount; instant under reduced motion. */
export function RollingCount({ value, delay = 0 }: { value: number; delay?: number }) {
  const reduced = useReducedMotion();
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => formatTicketNumber(Math.round(v)));
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (reduced) {
      mv.set(value);
      return;
    }
    mv.set(Math.max(1, value - 40));
    const controls = animate(mv, value, { duration: DUR.celestial, ease: EASE_HOUSE, delay });
    return () => controls.stop();
  }, [value, reduced, mv, delay]);

  // Before mount, the static number — identical to the server HTML.
  if (!mounted) return <span className="tabular-nums">{formatTicketNumber(value)}</span>;
  return <motion.span className="tabular-nums">{text}</motion.span>;
}
```

- [ ] **Step 4: Moons**

`src/components/interest/moons.tsx`:

```tsx
"use client";

import { motion, useReducedMotion } from "motion/react";
import { MOONS_DRAWN_MAX } from "@/lib/interest-list";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The people who joined through a ticket, drawn as moons on one ring around its planet.
 *
 * Up to `MOONS_DRAWN_MAX`; the count line carries the rest. When `play` is true each moon
 * drops in with a 90 ms stagger, then the whole ring drifts on a CSS rotation. The ring
 * is sized to sit just outside the planet: `size` is the ring's diameter.
 */
export function Moons({ count, play, size }: { count: number; play: boolean; size: number }) {
  const reduced = useReducedMotion();
  const n = Math.min(count, MOONS_DRAWN_MAX);
  if (n === 0) return null;
  const r = size / 2;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#7aa896]/30",
        !reduced && "interest-moons-drift"
      )}
      style={{ width: size, height: size }}
    >
      {Array.from({ length: n }, (_, i) => {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        const x = r + r * Math.cos(angle);
        const y = r + r * Math.sin(angle);
        return (
          <motion.span
            key={i}
            className="absolute size-[7px] rounded-full bg-[#e8f3f1] shadow-[0_0_8px_rgba(232,243,241,0.85)]"
            style={{ left: x - 3.5, top: y - 3.5 }}
            initial={play && !reduced ? { scale: 0, opacity: 0 } : false}
            animate={{ scale: 1, opacity: 1 }}
            transition={
              reduced
                ? { duration: 0 }
                : { duration: DUR.base, ease: EASE_HOUSE, delay: 0.9 + i * 0.09 }
            }
          />
        );
      })}
    </span>
  );
}
```

- [ ] **Step 5: Share row**

`src/components/interest/share-row.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { buildShareUrl, shareText, type InterestTicket } from "@/lib/interest-list";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { cn } from "@/lib/utils";

const PILL =
  "inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#e8f3f1]/[0.14] px-3 text-sm text-[#e8f3f1] transition-colors hover:border-[#e8f3f1]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f2c14e]/60";

/**
 * The ticket's share tools: the link in a read-only field, Copy, X, LinkedIn, and — only
 * after mount, only where the browser has one — the native share sheet.
 *
 * Share intents open in a new tab; the text is prewritten (`shareText`) and the URL is the
 * `?ref=` link, so whoever follows it lands on the invited state and the referral counts.
 */
export function ShareRow({ ticket, appUrl, play }: { ticket: InterestTicket; appUrl: string; play: boolean }) {
  const reduced = useReducedMotion();
  const url = buildShareUrl(appUrl, ticket.shareToken);
  const text = shareText(ticket);
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      inputRef.current?.select();
      document.execCommand("copy");
    }
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }

  async function nativeShare() {
    try {
      await navigator.share({ title: "Orbit interest list", text, url });
    } catch {
      // Dismissed. Nothing to do.
    }
  }

  const x = `https://twitter.com/intent/tweet?${new URLSearchParams({ text, url })}`;
  const linkedin = `https://www.linkedin.com/sharing/share-offsite/?${new URLSearchParams({ url })}`;

  const enter = (i: number) =>
    play && !reduced
      ? { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: DUR.base, ease: EASE_HOUSE, delay: 1.35 + i * 0.05 } }
      : { initial: false as const, animate: { opacity: 1, y: 0 } };

  return (
    <div className="mt-4">
      <motion.div {...enter(0)} className="flex gap-2">
        <label htmlFor="interest-share-link" className="sr-only">
          Your share link
        </label>
        <input
          id="interest-share-link"
          ref={inputRef}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            "h-10 min-w-0 flex-1 rounded-lg border bg-[#05070f]/50 px-3 font-mono text-xs text-[#9aada8] transition-colors focus:outline-none",
            copied ? "border-[#f2c14e]/70" : "border-[#e8f3f1]/[0.14]"
          )}
        />
        <button type="button" onClick={copy} className={cn(PILL, "bg-[#e8f3f1] text-[#0f3d3e] hover:border-transparent hover:bg-white")} aria-live="polite">
          {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </motion.div>
      <motion.div {...enter(1)} className="mt-2 flex flex-wrap gap-2">
        <a href={x} target="_blank" rel="noopener noreferrer" className={PILL}>
          Share on X
        </a>
        <a href={linkedin} target="_blank" rel="noopener noreferrer" className={PILL}>
          LinkedIn
        </a>
        {canShare ? (
          <button type="button" onClick={nativeShare} className={PILL}>
            <Share2 className="size-4" aria-hidden="true" />
            Share…
          </button>
        ) : null}
      </motion.div>
    </div>
  );
}
```

- [ ] **Step 6: Boarding pass**

`src/components/interest/boarding-pass.tsx`:

```tsx
"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { Moons } from "@/components/interest/moons";
import { PlanetArt } from "@/components/interest/planet-art";
import { RollingCount } from "@/components/interest/proof-line";
import { ShareRow } from "@/components/interest/share-row";
import { formatTicketNumber, moonsLine, passengerLine, type InterestTicket } from "@/lib/interest-list";
import { DUR, EASE_HOUSE, SPRING_SOFT } from "@/lib/motion";
import { planetLabel } from "@/lib/welcome-planets";

const PLANET_SIZE = 96;
const RING_SIZE = 148;

function joinedLabel(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

/**
 * The ticket. A stub (planet, moons, number) and a details pane (passenger line, moons
 * line, share tools) with a perforated seam between them; the seam runs vertically from
 * `sm` up and horizontally on phones, where the stub stacks above the details.
 *
 * `entrance: "flip"` is the in-place reveal after a join: everything assembles in order
 * (seam draws, number rolls, planet springs in, moons drop, lines rise). `"direct"` is a
 * `?me=` visit: the ticket is fully in the HTML and only the number roll and the moon
 * drop play, once. Reduced motion: everything is simply there.
 */
export function BoardingPass({
  ticket,
  appUrl,
  signUpHref,
  entrance,
  headingRef,
}: {
  ticket: InterestTicket;
  appUrl: string;
  signUpHref: string;
  entrance: "flip" | "direct";
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  const reduced = useReducedMotion();
  const full = entrance === "flip" && !reduced;

  const rise = (delay: number) =>
    full
      ? { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: DUR.base, ease: EASE_HOUSE, delay } }
      : { initial: false as const, animate: { opacity: 1, y: 0 } };

  return (
    <div className="grid sm:grid-cols-[168px_minmax(0,1fr)]">
      {/* Stub */}
      <div className="relative flex flex-col items-center px-4 pb-6 pt-5 text-center sm:pb-5">
        <motion.span
          className="relative flex items-center justify-center"
          style={{ width: RING_SIZE, height: RING_SIZE }}
          initial={full ? { scale: 0.6, opacity: 0 } : false}
          animate={{ scale: 1, opacity: 1 }}
          transition={full ? { ...SPRING_SOFT, delay: 0.55 } : { duration: 0 }}
        >
          <Moons count={ticket.moons} play={!reduced} size={RING_SIZE} />
          <PlanetArt planet={ticket.planet} size={PLANET_SIZE} />
        </motion.span>
        <p className="mt-3 font-[family-name:var(--font-display)] text-[28px] leading-none tracking-tight text-[#e8f3f1]">
          <span aria-hidden="true">#</span>
          <span className="sr-only">Number </span>
          <RollingCount value={ticket.number} delay={full ? 0.35 : 0.1} />
        </p>
        <p className="mt-1.5 text-xs uppercase tracking-[0.14em] text-[#9aada8]">{planetLabel(ticket.planet)}</p>
      </div>

      {/* Seam: an SVG line so it can draw itself. Horizontal on phones, vertical from sm. */}
      <svg aria-hidden="true" className="h-px w-full sm:hidden" viewBox="0 0 100 1" preserveAspectRatio="none">
        <motion.line x1="0" y1="0.5" x2="100" y2="0.5" stroke="rgba(232,243,241,0.22)" strokeWidth="1" strokeDasharray="3 4" initial={full ? { pathLength: 0 } : false} animate={{ pathLength: 1 }} transition={full ? { duration: DUR.slow, ease: EASE_HOUSE, delay: 0.1 } : { duration: 0 }} />
      </svg>

      {/* Details */}
      <div className="relative px-5 pb-5 pt-5 sm:pl-6">
        <svg aria-hidden="true" className="absolute left-0 top-4 hidden h-[calc(100%-2rem)] w-px sm:block" viewBox="0 0 1 100" preserveAspectRatio="none">
          <motion.line x1="0.5" y1="0" x2="0.5" y2="100" stroke="rgba(232,243,241,0.22)" strokeWidth="1" strokeDasharray="3 4" initial={full ? { pathLength: 0 } : false} animate={{ pathLength: 1 }} transition={full ? { duration: DUR.slow, ease: EASE_HOUSE, delay: 0.1 } : { duration: 0 }} />
        </svg>

        <motion.p {...rise(0.95)} className="text-xs uppercase tracking-[0.16em] text-[#9aada8]">
          Orbit · Interest list
        </motion.p>
        <motion.h3
          {...rise(1.0)}
          ref={headingRef}
          tabIndex={-1}
          className="mt-2 font-[family-name:var(--font-display)] text-[22px] leading-[1.15] tracking-tight text-[#e8f3f1] outline-none"
        >
          Passenger {formatTicketNumber(ticket.number)}, bound for{" "}
          <em className="italic text-landing-accent">{planetLabel(ticket.planet)}</em>.
          <span className="sr-only">{passengerLine(ticket)}</span>
        </motion.h3>
        <motion.p {...rise(1.05)} className="mt-2 text-sm text-[#9aada8]">
          Joined {joinedLabel(ticket.joinedAt)} · {moonsLine(ticket.moons)}
        </motion.p>

        <ShareRow ticket={ticket} appUrl={appUrl} play={full} />

        <motion.p {...rise(1.5)} className="mt-4 text-xs leading-[1.6] text-[#6d807c]">
          Save this link — it&apos;s your page. Not one for waiting?{" "}
          <Link
            href={signUpHref}
            className="text-landing-accent underline decoration-[#f2c14e]/35 underline-offset-4 transition-colors hover:decoration-[#f2c14e]/90"
          >
            Orbit is live — start free
          </Link>
          .
        </motion.p>
      </div>
    </div>
  );
}
```

Note the visible heading repeats `passengerLine`'s words with the planet italicised; the `sr-only` copy is the exact spec string for screen readers and for the page smoke.

- [ ] **Step 7: Typecheck and lint**

Run: `npx tsc --noEmit 2>&1 | tail -5 && npx eslint src/components/interest src/app/globals.css 2>&1 | tail -5`
Expected: tsc silent; eslint reports 0 errors (warnings are pre-existing elsewhere; any in these files, fix). A `react-hooks/exhaustive-deps` warning on `RollingCount` means a dependency was dropped from the effect array — the array above is complete.

- [ ] **Step 8: Commit**

```bash
git add src/components/interest/planet-art.tsx src/components/interest/proof-line.tsx src/components/interest/moons.tsx src/components/interest/share-row.tsx src/components/interest/boarding-pass.tsx src/app/globals.css
git commit -m "Boarding pass: planet, moons, rolling number, seam and share row

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The hero (form, invite, flip) and the page

**Files:**
- Create: `src/components/interest/interest-hero.tsx`
- Delete: `src/components/interest/interest-form.tsx`
- Rewrite: `src/app/(site)/interest/page.tsx`
- Modify: `src/components/loading/page-skeletons.tsx` (`InterestPageSkeleton`)
- Create: `scripts/smoke-interest-list-page.ts`; Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `joinInterestList` (Task 5), `BoardingPass`, `ProofLine`, `PlanetArt` (Task 7), `getInterestProof`, `getTicketByShareToken`, `getInviterPlanet`, `proofShowsCount`, `type InterestProof` (Task 4), `buildTicketImageUrl`, `SHARE_TOKEN_MAX` (Task 3), `pulseStarfield`, `getAppBaseUrl`, `isClerkConfigured`, `isDemoMode`, `FREE_CONTACT_LIMIT`.
- Produces:
  - `type HeroInitial = { kind: "form"; proof: InterestProof; invite: WelcomePlanet | null; ref: string | null } | { kind: "ticket"; proof: InterestProof; ticket: InterestTicket }`
  - `InterestHero({ initial: HeroInitial; appUrl: string; signUpHref: string })`
  - `page.tsx`: `export const dynamic = "force-dynamic"`, `generateMetadata({ searchParams })`, `default async function InterestPage({ searchParams })`.

- [ ] **Step 1: Write the failing page smoke**

`scripts/smoke-interest-list-page.ts`:

```ts
/**
 * Renders /interest's page function in its three states and checks what crosses the
 * client boundary.
 *
 * WHY THIS EXISTS. The page is dynamic and decides form / invited / ticket from the URL on
 * the server. The client hero only ever sees its `initial` prop, so that prop IS the
 * contract: the wrong `kind`, a missing inviter planet or a ticket for a bogus token would
 * render a page that looks fine and is wrong. Same walk as `smoke-interest-list-admin.ts`.
 *
 * Run: npx tsx scripts/smoke-interest-list-page.ts
 */
import "./smoke/_env";

import { like } from "drizzle-orm";
import { getDb } from "../src/db";
import { interestListSignups } from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";
import { invalidateInterestProof } from "../src/lib/interest-list-ticket";

const PREFIX = "smoke-page-";
const TOKEN = "smoke-page-token";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** Finds the first prop named `name` anywhere in a rendered element tree. */
function findProp(node: unknown, name: string): unknown {
  if (node == null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findProp(child, name);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  const el = node as { props?: Record<string, unknown> };
  if (!el.props) return undefined;
  if (name in el.props) return el.props[name];
  for (const value of Object.values(el.props)) {
    const hit = findProp(value, name);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Visible text of a tree, descending into children and the FAQ's q/a. */
function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  const el = node as { props?: Record<string, unknown> };
  if (el.props) {
    for (const [key, value] of Object.entries(el.props)) {
      if (key === "children" || key === "items" || key === "q" || key === "a") textOf(value, out);
    }
  }
  return out;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
  invalidateInterestProof();
}

async function main() {
  await cleanup();
  const db = await getDb();
  await db.insert(interestListSignups).values({
    email: `${PREFIX}a@example.test`,
    unsubscribeToken: generateUnsubscribeToken(),
    shareToken: TOKEN,
    welcomePlanet: "saturn",
  });

  const mod = await import("../src/app/(site)/interest/page");
  const Page = mod.default;
  const sp = (q: Record<string, string>) => ({ searchParams: Promise.resolve(q) });

  // --- form
  const form = await Page(sp({}));
  const formInitial = findProp(form, "initial") as { kind: string; invite: unknown; proof: { count: number } };
  check("no params renders the form", formInitial?.kind === "form", JSON.stringify(formInitial));
  check("no invite without a ref", formInitial.invite === null);
  check("proof is loaded", typeof formInitial.proof?.count === "number");
  // The headline and the card live inside the client hero, which this walk cannot enter —
  // it sees the hero's props (asserted above) and the server-rendered sections below it.
  const formText = textOf(form).join(" ");
  check("the waitlist FAQ answer is rewritten", formText.includes("no queue"));
  check("the detour section is gone", !formText.includes("There's nothing to"));

  // --- invited
  const invited = await Page(sp({ ref: TOKEN }));
  const invitedInitial = findProp(invited, "initial") as { kind: string; invite: unknown; ref: unknown };
  check("a ref keeps the form", invitedInitial?.kind === "form");
  check("a ref resolves the inviter's planet", invitedInitial.invite === "saturn", String(invitedInitial.invite));
  check("the ref token is handed to the form", invitedInitial.ref === TOKEN);
  const unknownRef = findProp(await Page(sp({ ref: "nope" })), "initial") as { invite: unknown };
  check("an unknown ref shows no invite", unknownRef.invite === null);

  // --- ticket
  const ticket = await Page(sp({ me: TOKEN }));
  const ticketInitial = findProp(ticket, "initial") as { kind: string; ticket: { number: number; planet: string; shareToken: string } };
  check("a me token renders the ticket", ticketInitial?.kind === "ticket", JSON.stringify(ticketInitial));
  check("the ticket is the row's", ticketInitial.ticket.planet === "saturn" && ticketInitial.ticket.shareToken === TOKEN);
  check("the ticket has a number", ticketInitial.ticket.number >= 1);
  const both = findProp(await Page(sp({ me: TOKEN, ref: "whatever" })), "initial") as { kind: string };
  check("me wins over ref", both.kind === "ticket");
  const bogus = findProp(await Page(sp({ me: "nope" })), "initial") as { kind: string };
  check("a bogus me token falls back to the form", bogus.kind === "form");
  const tooLong = findProp(await Page(sp({ me: "x".repeat(200) })), "initial") as { kind: string };
  check("an oversized token is ignored", tooLong.kind === "form");

  // --- metadata
  const meta = await mod.generateMetadata(sp({ me: TOKEN }));
  const og = meta.openGraph as { images?: unknown } | undefined;
  check("ticket metadata carries the image", JSON.stringify(og?.images ?? "").includes(`ticket-image?token=${TOKEN}`), JSON.stringify(og));
  check("ticket metadata titles the passenger", String(meta.title).startsWith("Passenger"));
  const refMeta = await mod.generateMetadata(sp({ ref: TOKEN }));
  check("ref metadata carries the image too", JSON.stringify(refMeta.openGraph ?? "").includes("ticket-image"));
  const plain = await mod.generateMetadata(sp({}));
  check("plain metadata is the default", String(plain.title).startsWith("Interest list"));

  await cleanup();
  console.log("\ninterest page: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
```

Register in `scripts/run-smoke.ts` `MANIFEST`, after `"smoke-interest-list-join": "pglite",`:

```ts
  "smoke-interest-list-page": "pglite",
```

Run: `npx tsx scripts/smoke-interest-list-page.ts 2>&1 | tail -3`
Expected: FAIL — `findProp(form, "initial")` is undefined (the current page has no `initial` prop), so "no params renders the form" fails.

- [ ] **Step 2: Write the hero**

`src/components/interest/interest-hero.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion, useAnimate, useReducedMotion } from "motion/react";
import { joinInterestList } from "@/actions/interest-list";
import { BoardingPass } from "@/components/interest/boarding-pass";
import { PlanetArt } from "@/components/interest/planet-art";
import { ProofLine } from "@/components/interest/proof-line";
import {
  INTEREST_LIST_COUNT_FLOOR,
  buildTicketUrl,
  interestListSchema,
  type InterestTicket,
} from "@/lib/interest-list";
import type { InterestProof } from "@/lib/interest-list-ticket";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { pulseStarfield } from "@/lib/starfield-events";
import { cn } from "@/lib/utils";
import { planetLabel, type WelcomePlanet } from "@/lib/welcome-planets";

export type HeroInitial =
  | { kind: "form"; proof: InterestProof; invite: WelcomePlanet | null; ref: string | null }
  | { kind: "ticket"; proof: InterestProof; ticket: InterestTicket };

const HEADING =
  "font-[family-name:var(--font-display)] font-normal leading-[1.12] tracking-[-0.025em] text-[#e8f3f1]";

const inputClass =
  "w-full rounded-xl border border-[#e8f3f1]/[0.14] bg-[#05070f]/50 px-4.5 py-4 text-base text-[#e8f3f1] transition-colors placeholder:text-[#6d807c] focus:border-[#f2c14e]/50 focus:outline-none";

const buttonClass =
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-landing-button-surface px-5 py-4 font-medium text-landing-button-label transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

const GENERIC_ERROR = "Something went wrong — please try again.";
const FORMAT_ERROR = "That address doesn't look right.";

type Phase = "form" | "turning" | "ticket";

/**
 * The hero: eyebrow, headline, sub-line and the card. The card is a three-state machine —
 * form (with an optional invited strip), turning (the flip's first half), ticket — and the
 * headline crossfades with it.
 *
 * The flip: the card face rotates to 90° with the form on it (`turning`), the content
 * swaps, and a fresh face keyed on the ticket enters from −90°. Height follows via
 * `layout`. Reduced motion skips straight to the ticket.
 *
 * `history.replaceState` runs only once the action has resolved and the ticket is in
 * state — a `replaceState` while a server action is queued drops the action (see the
 * memory of the same name).
 *
 * The success path never promises an email: `joinInterestList` answers `ok` with a ticket
 * for a duplicate, a rate-limited caller and a bot alike — by design — and the welcome
 * mail is best-effort on top of that.
 */
export function InterestHero({
  initial,
  appUrl,
  signUpHref,
}: {
  initial: HeroInitial;
  appUrl: string;
  signUpHref: string;
}) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>(initial.kind === "ticket" ? "ticket" : "form");
  const [ticket, setTicket] = useState<InterestTicket | null>(
    initial.kind === "ticket" ? initial.ticket : null
  );
  const [entrance, setEntrance] = useState<"flip" | "direct">("direct");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [rowScope, animateRow] = useAnimate();

  const invite = initial.kind === "form" ? initial.invite : null;
  const ref = initial.kind === "form" ? initial.ref : null;
  const showCount = initial.proof.count >= INTEREST_LIST_COUNT_FLOOR;

  // Set after mount, never during render: Date.now() on the server would not match the
  // client's and would trip hydration.
  const readyAt = useRef(0);
  useEffect(() => {
    readyAt.current = Date.now();
  }, []);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Once the ticket is up after a join: make the URL its page, and hand focus to its
  // heading after the assembly so the browser's focus scroll does not fight the motion.
  useEffect(() => {
    if (phase !== "ticket" || entrance !== "flip" || !ticket) return;
    window.history.replaceState(window.history.state, "", buildTicketUrl("", ticket.shareToken));
    const id = window.setTimeout(
      () => headingRef.current?.focus({ preventScroll: true }),
      reduced ? 0 : 1600
    );
    return () => window.clearTimeout(id);
  }, [phase, entrance, ticket, reduced]);

  function fail(message: string) {
    setError(message);
    if (!reduced) {
      animateRow(rowScope.current, { x: [0, -6, 5, -3, 0] }, { duration: 0.32 });
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const address = email.trim();

    // Same rule the server applies, checked here first so a typo does not cost a round
    // trip. The server re-validates regardless.
    if (!interestListSchema.shape.email.safeParse(address).success) {
      fail(FORMAT_ERROR);
      return;
    }
    setError(null);

    startTransition(async () => {
      try {
        const result = await joinInterestList({
          email: address,
          website: String(data.get("website") ?? ""),
          elapsedMs: readyAt.current ? Date.now() - readyAt.current : 0,
          ref: ref ?? undefined,
        });
        if (!result.ok) {
          fail(result.message);
          return;
        }
        // Measure while the button is still on screen: the state change below unmounts
        // it. The canvas is viewport-fixed, so these coordinates land where it was.
        const rect = buttonRef.current?.getBoundingClientRect();
        if (rect) pulseStarfield(rect.left + rect.width / 2, rect.top + rect.height / 2);
        setTicket(result.ticket);
        setEntrance("flip");
        setPhase(reduced ? "ticket" : "turning");
      } catch {
        fail(GENERIC_ERROR);
      }
    });
  }

  const showTicket = phase === "ticket" && ticket;
  const flipHalf = reduced ? { duration: 0 } : { duration: DUR.slow, ease: EASE_HOUSE };

  return (
    <>
      <section className="pt-10 text-center md:pt-16">
        <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">Interest list</p>
        <h1 className={cn(HEADING, "mt-4 grid text-[clamp(32px,5vw,56px)]")}>
          {/* Both headlines occupy the same grid cell so the crossfade does not reflow. */}
          <AnimatePresence initial={false}>
            <motion.span
              key={showTicket ? "in" : "stay"}
              className="col-start-1 row-start-1"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={flipHalf}
            >
              {/* Fraunces' true italic, declared in the root layout — the word that
                  carries the idea is the word that leans. */}
              {showTicket ? (
                <>You&apos;re in <em className="italic">orbit</em>.</>
              ) : (
                <>Stay in <em className="italic">orbit</em>.</>
              )}
            </motion.span>
          </AnimatePresence>
        </h1>
        <p className="mx-auto mt-5 max-w-[46ch] text-base leading-relaxed text-[#9aada8] sm:text-lg">
          Occasional notes from the one person building Orbit. Join and you&apos;re handed a
          planet.
        </p>
      </section>

      <section
        id="interest-join"
        aria-labelledby="interest-join-heading"
        className="relative mt-12 scroll-mt-24 md:mt-16"
      >
        <h2 id="interest-join-heading" className="sr-only">
          {showTicket ? "Your ticket" : "Join the interest list"}
        </h2>

        {/* Lives outside the swap so it exists before its text changes — a live region
            that mounts already populated is not announced. */}
        <p role="status" aria-live="polite" className="sr-only">
          {pending ? "Joining the list…" : showTicket ? "You're on the list." : ""}
        </p>

        <div className="interest-flip-stage mx-auto max-w-xl">
          <motion.div
            layout
            transition={reduced ? { duration: 0 } : { layout: { duration: DUR.slow, ease: EASE_HOUSE } }}
            className={cn(
              "landing-glass relative rounded-3xl transition-shadow duration-300",
              !showTicket && "focus-within:shadow-[0_0_0_1px_rgba(242,193,78,0.22)]"
            )}
          >
            {showTicket ? (
              <motion.div
                key="ticket"
                className="interest-flip-face"
                initial={entrance === "flip" && !reduced ? { rotateY: -90 } : false}
                animate={{ rotateY: 0 }}
                transition={flipHalf}
              >
                <BoardingPass
                  ticket={ticket}
                  appUrl={appUrl}
                  signUpHref={signUpHref}
                  entrance={entrance}
                  headingRef={headingRef}
                />
              </motion.div>
            ) : (
              <motion.form
                key="form"
                className="interest-flip-face p-6 sm:p-8"
                noValidate
                onSubmit={handleSubmit}
                animate={{ rotateY: phase === "turning" ? 90 : 0 }}
                transition={flipHalf}
                onAnimationComplete={() => {
                  if (phase === "turning") setPhase("ticket");
                }}
              >
                {invite ? (
                  <p className="mb-4 flex items-center gap-2.5 rounded-xl border border-[#f2c14e]/25 bg-[#f2c14e]/[0.06] px-3.5 py-2.5 text-sm text-[#e8f3f1]">
                    <PlanetArt planet={invite} size={22} />
                    <span>
                      Someone on {planetLabel(invite)} invited you. Join and you&apos;ll orbit right
                      behind them.
                    </span>
                  </p>
                ) : null}

                <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">
                  Join the list
                </p>
                <p className="mt-2 text-lg text-[#e8f3f1]">One address. Occasional news.</p>

                <div ref={rowScope} className="mt-5 flex flex-col gap-3 sm:flex-row">
                  <label htmlFor="interest-email" className="sr-only">
                    Email address
                  </label>
                  <input
                    id="interest-email"
                    type="email"
                    name="email"
                    autoComplete="email"
                    inputMode="email"
                    maxLength={160}
                    required
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? "interest-error" : undefined}
                    className={cn(inputClass, error && "border-[#e8a84e]/60")}
                  />
                  <button
                    ref={buttonRef}
                    type="submit"
                    disabled={pending || phase === "turning"}
                    aria-busy={pending}
                    className={buttonClass}
                  >
                    {pending ? (
                      <>
                        {/* An orbit, not a spinner: one dot circling a faint ring. */}
                        <span aria-hidden="true" className="relative inline-block size-4">
                          <span className="absolute inset-0 rounded-full border border-current/30" />
                          <span
                            className={cn(
                              "absolute inset-0",
                              !reduced && "animate-[interest-orbit_0.9s_linear_infinite]"
                            )}
                          >
                            <span className="absolute left-1/2 top-0 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" />
                          </span>
                        </span>
                        Joining…
                      </>
                    ) : (
                      "Join the list"
                    )}
                  </button>
                </div>

                {/* Honeypot. Off-screen rather than display:none — some bots skip hidden
                    fields but happily fill one that is merely positioned away. */}
                <div
                  aria-hidden="true"
                  className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden"
                >
                  <label htmlFor="interest-website">Website</label>
                  <input id="interest-website" name="website" tabIndex={-1} autoComplete="off" />
                </div>

                {error ? (
                  <p id="interest-error" role="alert" className="mt-3 text-sm text-[#e8a84e]">
                    {error}
                  </p>
                ) : (
                  <ProofLine proof={initial.proof} showCount={showCount} />
                )}
              </motion.form>
            )}
          </motion.div>
        </div>
      </section>
    </>
  );
}
```

Then delete the old form:

```bash
git rm -q src/components/interest/interest-form.tsx
```

- [ ] **Step 3: Rewrite the page**

`src/app/(site)/interest/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { MailOpen, Sparkles, Unplug } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import { Reveal } from "@/components/motion/reveal";
import { LandingStarfield } from "@/components/landing/landing-visuals";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { InterestHero, type HeroInitial } from "@/components/interest/interest-hero";
import { OrbitRingsBackdrop } from "@/components/interest/orbit-rings-backdrop";
import { FaqList, type FaqItem } from "@/components/marketing/faq-list";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { BackControl } from "@/components/pricing/back-control";
import { getAppBaseUrl } from "@/lib/app-url";
import { isClerkConfigured, isDemoMode } from "@/lib/auth";
import { SHARE_TOKEN_MAX, buildTicketImageUrl, passengerLine } from "@/lib/interest-list";
import {
  getInterestProof,
  getInviterPlanet,
  getTicketByShareToken,
} from "@/lib/interest-list-ticket";
import { FREE_CONTACT_LIMIT } from "@/lib/plan-limits";

// The proof line, the invited strip and the ticket all come from the URL and the database
// on every request. The proof memo (60 s) keeps the count query off the hot path.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

const DEFAULT_TITLE = "Interest list — Orbit";
const DEFAULT_DESCRIPTION = `Occasional notes from the person building Orbit, only when there's real news. Join and you're handed a planet. Orbit is already live and free for your first ${FREE_CONTACT_LIMIT} contacts.`;

/** One token from the query, or null: trimmed, single-valued, at most SHARE_TOKEN_MAX. */
function tokenParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const token = raw?.trim() ?? "";
  return token.length > 0 && token.length <= SHARE_TOKEN_MAX ? token : null;
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const params = await searchParams;
  const token = tokenParam(params.me) ?? tokenParam(params.ref);
  const ticket = token ? await getTicketByShareToken(token) : null;
  if (!ticket) {
    return { title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION };
  }
  const image = buildTicketImageUrl(getAppBaseUrl(), ticket.shareToken);
  const title = `${passengerLine(ticket)} — Orbit`;
  const description =
    "Every person who joins Orbit's interest list is handed a planet. Get yours.";
  return {
    title,
    description,
    openGraph: { title, description, images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

const HEADING =
  "font-[family-name:var(--font-display)] font-normal leading-[1.12] tracking-[-0.025em] text-[#e8f3f1]";

const EXPECT = [
  {
    icon: MailOpen,
    title: "Written by a person",
    body: "Every note comes from Jason, the one person who builds Orbit. There's no drip sequence and no marketing calendar behind it.",
  },
  {
    icon: Sparkles,
    title: "Only when it's real",
    body: "A launch, a big change, something worth your minute. Quiet months stay quiet.",
  },
  {
    icon: Unplug,
    title: "Leave in one click",
    body: "Every email carries a one-click unsubscribe. You're off the list immediately, no confirmation screen.",
  },
];

const FAQ: readonly FaqItem[] = [
  {
    q: "How often will you email me?",
    a: "Rarely. A short hello when you join, one tip a few days later if you haven't signed up, and after that only when there's real news. Quiet months are quiet.",
  },
  {
    q: "Is this a waitlist?",
    a: `Not really. There's no queue and nothing to wait for — Orbit is live and free for your first ${FREE_CONTACT_LIMIT} contacts. The number and the planet are yours to keep; the notes are the point.`,
  },
  {
    q: "What happens to my address?",
    a: (
      <>
        It gets the notes above and nothing else — never shared or sold. The details are in
        the <Link href="/privacy">privacy policy</Link>.
      </>
    ),
  },
  {
    q: "How do I leave?",
    a: "Every email has a one-click unsubscribe link. You're off immediately; there's no confirmation screen.",
  },
];

/**
 * Dynamic: the card's state comes from `?me=` (a ticket) or `?ref=` (an invitation), and
 * the proof line from the database. Who is signed in still resolves in the browser
 * (`LandingAuthControls`). The form talks to `joinInterestList` directly.
 *
 * Not a warp journey destination (see `lib/warp/journeys.ts`), so no arrival beacon.
 */
export default async function InterestPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const me = tokenParam(params.me);
  const ref = me ? null : tokenParam(params.ref);

  const [proof, ticket, invite] = await Promise.all([
    getInterestProof(),
    me ? getTicketByShareToken(me) : Promise.resolve(null),
    ref ? getInviterPlanet(ref) : Promise.resolve(null),
  ]);

  const initial: HeroInitial = ticket
    ? { kind: "ticket", proof, ticket }
    : { kind: "form", proof, invite, ref: invite ? ref : null };

  const clerkOn = isClerkConfigured();
  const demoMode = isDemoMode();
  const authProps = { clerkOn, demoMode };
  // Mirrors the destinations `LandingAuthControls` chooses for "Get Started".
  const signUpHref = clerkOn ? "/sign-up" : demoMode ? "/dashboard" : "/sign-in";

  return (
    // `landing-root` is load-bearing: globals.css paints the body deep-space while it is
    // mounted, which is what stops a light strip appearing on overscroll. The starfield
    // renders position:fixed, so this root must stay free of transform/filter.
    <div className="landing-root relative overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
      <LandingStarfield interactive />

      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-6 md:px-10">
        <div className="flex items-center gap-4">
          <BackControl />
          <Link
            href="/"
            className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
            aria-label="Orbit home"
          >
            <OrbitLogo size="sm" />
            {/* Below sm the wordmark is what pushes the auth controls into
                wrapping — the logo alone still identifies the link. */}
            <span className="hidden font-[family-name:var(--font-display)] text-[17px] tracking-tight text-[#e8f3f1] sm:inline">
              Orbit
            </span>
          </Link>
        </div>
        <LandingAuthControls {...authProps} variant="header" />
      </header>

      <main className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-24 md:px-10">
        <div className="relative">
          <OrbitRingsBackdrop />
          <InterestHero initial={initial} appUrl={getAppBaseUrl()} signUpHref={signUpHref} />
        </div>

        <Reveal className="reveal-celestial mt-20 block">
          <ul className="grid gap-6 sm:grid-cols-3">
            {EXPECT.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3.5">
                <Icon className="mt-0.5 size-[18px] shrink-0 text-[#f2c14e]" aria-hidden="true" />
                <div>
                  <h3 className="text-sm font-medium text-[#e8f3f1]">{title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-[#9aada8]">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </Reveal>

        <section className="mt-24 md:mt-32" aria-labelledby="interest-faq">
          <Reveal className="reveal-celestial">
            <h2 id="interest-faq" className={`${HEADING} text-center text-[clamp(26px,3.4vw,38px)]`}>
              Before you hand over an address.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial mt-10 block" delay={80}>
            <FaqList items={FAQ} />
          </Reveal>
        </section>

        <section className="relative mt-24 text-center md:mt-32">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[720px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ background: "radial-gradient(circle, rgba(242,193,78,0.13), transparent 62%)" }}
          />
          <Reveal className="reveal-celestial">
            <h2 className={`${HEADING} text-[clamp(28px,3.8vw,42px)]`}>
              One address. Occasional news.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={90}>
            <p className="mx-auto mt-4 max-w-[42ch] text-base leading-relaxed text-[#9aada8]">
              If you scrolled this far, the box is a click away.
            </p>
          </Reveal>
          <Reveal className="reveal-celestial mt-8 flex justify-center" delay={170}>
            {/* Back up to the form, not on to sign-up: one ask per page. */}
            <a
              href="#interest-join"
              className="inline-flex items-center justify-center rounded-full bg-[#e8f3f1] px-6 py-3 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white"
            >
              Join the list
            </a>
          </Reveal>
        </section>
      </main>

      <MarketingFooter className="max-w-6xl px-6 md:px-10" />
    </div>
  );
}
```

Note: `OrbitRingsBackdrop` is absolutely positioned at the centre of its parent; the parent is now the wrapper around the whole hero (headline + card) rather than the card section alone, so the rings centre a little higher than before. Verify in Task 9 that the mask still fades them out before the headline; if not, wrap only the `#interest-join` section — but that section lives inside the client hero, so the simplest fix is to pass `OrbitRingsBackdrop` into `InterestHero` as a `backdrop` prop rendered inside its second section.

- [ ] **Step 4: Update the skeleton**

In `src/components/loading/page-skeletons.tsx`, `InterestPageSkeleton`: delete the section that starts `<section className="mt-24 grid items-center gap-8 md:mt-32 lg:grid-cols-[minmax(0,1.1fr)_auto] lg:gap-14">` through its closing `</section>` (the sign-up detour), and in the card block replace
`<Skeleton className="mt-3 h-3 w-64 max-w-full bg-white/5" />` with:

```tsx
          <div className="mt-4 flex items-center justify-center gap-2">
            <Skeleton className="h-3.5 w-10 rounded-full bg-white/10" />
            <Skeleton className="h-3 w-56 max-w-full bg-white/5" />
          </div>
```

- [ ] **Step 5: Run the page smoke, the other two smokes, tsc and eslint**

Run:
```bash
npx tsx scripts/smoke-interest-list-page.ts 2>&1 | tail -25 && npx tsx scripts/smoke-interest-list-join.ts 2>&1 | tail -1 && npx tsx scripts/smoke-interest-list-admin.ts 2>&1 | tail -1 && npx tsc --noEmit 2>&1 | tail -5 && npx eslint "src/app/(site)/interest" src/components/interest src/components/loading 2>&1 | tail -5
```
Expected: all `ok` lines and `interest page: all checks passed`; the other two smokes pass; tsc silent; 0 eslint errors. If "the waitlist FAQ answer is rewritten" fails, `textOf` did not reach the FAQ — it descends `items`/`q`/`a`, which is how `FaqList` receives them.

- [ ] **Step 6: Run the manifest check**

Run: `npm run test:check 2>&1 | tail -3`
Expected: passes — every `scripts/smoke-*.ts` is in `MANIFEST` and every pglite script imports the preamble.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(site)/interest/page.tsx" src/components/interest/interest-hero.tsx src/components/loading/page-skeletons.tsx scripts/smoke-interest-list-page.ts scripts/run-smoke.ts
git commit -m "/interest: dynamic page with proof line, invited strip and the boarding-pass flip

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Browser verification, build, and the PR

**Files:**
- No source changes expected. Fixes found here are committed with a message naming what the browser showed.

**Interfaces:**
- Consumes: everything above, running on the `orbit-web` launch config (port 3001, demo mode on local PGlite — a fresh worktree has no `.env`, so this is automatic).

- [ ] **Step 1: Start the preview (fronted)**

Check nothing else is serving this worktree first:
```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN | head -3
```
Then `preview_start` with `{ name: "orbit-web" }` and keep the Browser pane **fronted** for the whole pass — a hidden pane starves rAF and animations never finish (occluded-tab memory).

- [ ] **Step 2: Form state**

Navigate to `http://localhost:3001/interest`. `read_console_messages` with `onlyErrors: true` — expect none. Screenshot. Confirm: headline "Stay in orbit.", the sub-line, the glass card, the proof line reading "next planet up: Mercury" (an empty PGlite has 0 signups, below the floor — so no count), rings turning behind.

- [ ] **Step 3: Join, watch the flip**

Type an address (`find` the email field; `computer` type; press Return). Wait 2.5 seconds first — `MIN_FILL_MS` — or the server hands back a fake ticket and no row. Expect: loader, starfield burst, the flip, then the ticket: `#1`, Mercury, "Passenger 1, bound for Mercury.", "No moons yet…", the share row. Screenshot at ~0.4 s (mid-flip) and at ~2 s (assembled). Confirm the URL now ends in `?me=<token>` (`javascript_tool`: `location.search`). Reload: the ticket is in the HTML immediately with the headline "You're in orbit."

- [ ] **Step 4: Copy and share**

Click Copy: label reads "Copied" and the field border turns gold for ~1.6 s. `read_page` the X and LinkedIn links: their `href`s contain `intent/tweet?text=I%27m+passenger` and `share-offsite`.

- [ ] **Step 5: Invite and referral**

Copy the `?ref=` URL from the field and navigate to it. Expect the invited strip: "Someone on Mercury invited you…". Join with a second address (wait 2.5 s). Expect `#2`, Venus. Navigate back to the first ticket's `?me=` URL: "1 person joined through you. That's the moon." with one moon on the ring, drifting.

- [ ] **Step 6: Bad tokens, image route**

`/interest?me=nope` → the plain form, no error. `/api/interest-list/ticket-image?token=<real>` → a PNG of the ticket (screenshot it); `?token=nope` → the generic card, still an image. `read_network_requests` for the image URL: `content-type: image/png`, `cache-control` contains `s-maxage=86400`.

- [ ] **Step 7: Mobile and reduced motion**

`resize_window` preset `mobile`, reload the `?me=` URL: the stub stacks above the details, the share buttons wrap, nothing scrolls horizontally (`javascript_tool`: `document.documentElement.scrollWidth <= window.innerWidth`). Screenshot. Then `resize_window` preset `desktop`. For reduced motion, in `javascript_tool` run `matchMedia("(prefers-reduced-motion: reduce)").matches` to confirm the current state, then emulate it by toggling the OS setting or, failing that, verify the code paths by reading `interest-hero.tsx`'s `reduced` branches — and say in the PR which of the two was done.

- [ ] **Step 8: Stop the server, then build and lint**

`preview_stop` the server. Then:
```bash
rm -rf .next && npm run build 2>&1 | tail -15 && npx eslint . 2>&1 | tail -3
```
Expected: the build lists `/interest` as `ƒ (Dynamic)` and `/api/interest-list/ticket-image` as a route; eslint 0 errors (the baseline is 0 errors / ~36 warnings — any error is new).

- [ ] **Step 9: Full smoke suite and schema-version re-scan**

```bash
npm test 2>&1 | tail -8
```
Expected: the suite passes. (If the machine is loaded, `smoke-admin-render` can time out; rerun it alone before suspecting code.) Then:
```bash
git fetch -q origin && for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin | grep -v HEAD); do v=$(git show "${b}:src/db/index.ts" 2>/dev/null | grep -o "SCHEMA_VERSION = [0-9]*" | grep -o "[0-9]*$"); [ -n "$v" ] && echo "$v $b"; done | sort -n | tail -3
```
Expected: nothing above 51 besides this branch. If something has landed at 52, bump to 53 in all three places' comments and commit.

- [ ] **Step 10: Save the screenshots and open the PR**

Write the screenshots from Steps 2, 3, 5, 6 and 7 to the scratchpad and attach them to the PR body. Merge `origin/main` once more if it moved, rerun `npx tsx scripts/smoke-interest-list-page.ts`, then:

```bash
git push -u origin claude/interest-list-redesign-232471
gh pr create --title "Redesign /interest as a waitlist-shaped page: proof line, boarding pass, referral moons" --body "$(cat <<'EOF'
## What

/interest is rebuilt around the mechanic it already had (every signup is handed a planet, in order out from the sun) and the things a YC-style waitlist page needs: a live proof line, a boarding pass with your number and planet, moons for the people who join through your link, and a per-person ticket image for link previews.

Spec: docs/superpowers/specs/2026-09-13-interest-list-redesign-design.md

## Behaviour

- `/interest` — form, with "N people have joined · next planet up: X" (count hidden below 50).
- `/interest?ref=TOKEN` — the same form with "Someone on Mars invited you"; joining credits the referrer.
- `/interest?me=TOKEN` — the boarding pass; the welcome email links here.
- After a join the card flips into the ticket and the URL becomes its page.
- `/api/interest-list/ticket-image?token=…` — the pass as a 1200×630 PNG, CDN-cached a day, generic card for bad tokens.

## Privacy trade (deliberate)

A submit now returns the address's real ticket, so whether an address was already on the list can be inferred from its number. Accepted: opt-in newsletter, the ticket is public by design, the email is never returned, duplicates send nothing, and the join is limited to 5 per 10 minutes per IP in the shared bucket table (replacing the per-instance Map).

## Schema

v52: `interest_list_signups.share_token` (unique) and `referred_by_id` (indexed). Nullable; old rows get a token the next time that email is submitted.

## Tests

- `smoke-interest-list-join` — new / duplicate / rejoin / referral / self-ref / unknown ref / honeypot / too-fast / rate limit / ordinal tie-break / proof floor + memo.
- `smoke-interest-list-page` — form, invited, ticket, bad token, me-over-ref, metadata.
- `smoke-interest-ticket-image` — real and bogus tokens both 200 image/png, cacheable.
- Existing `smoke-interest-list-admin`, `db:check`, build, eslint.

## Screenshots

(form · mid-flip · ticket · invited · one moon · image route · mobile)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then bind the PR with the `ccd_pr` tools and read CI.

---

## Self-review

**Spec coverage.** Page structure and the three states → Task 8. Boarding pass contents and the sm/phone stacking → Task 7 + 8. `replaceState` after the action → Task 8 (`InterestHero` effect). Data model, v52, three places, index parity → Task 2. Read module, ordinal tie-break, proof memo, floor → Task 4. Join action order (honeypot → validate → too-fast → bucket → ref → read-then-write → invalidate → ticket), plausible tickets, no email for duplicates, links in the welcome → Task 5. Email links in both templates, admin preview, follow-up sweep → Task 5. Page dynamic, `generateMetadata` for `me` and `ref`, skeleton → Task 8. Ticket image, vendored Fraunces + OFL, no moons, cache headers, generic card, public route, file tracing → Task 6. Motion: flip, seam, number roll, planet spring, moon stagger + drift, line stagger, headline crossfade, reduced-motion branches, direct-visit behaviour → Tasks 7–8. Share row: Copy feedback, X, LinkedIn, native Share after mount → Task 7. Edge cases: legacy tokens/planets, unsubscribed `?me=`, `me` over `ref`, oversized tokens → Tasks 4, 5, 8 (each has an assertion). Testing: three smokes registered, `db:check`, build, lint, browser at desktop/mobile/reduced-motion → Tasks 4–9. Out of scope items untouched.

**Placeholders.** None: every code step has its code; every run step has its command and expected output. The one conditional ("if Satori's wasm cannot start under tsx") names the exact fallback.

**Type consistency.** `InterestTicket` (Task 3) is what `ticketForRow` returns (Task 4), what `joinInterestListCore` returns inside `InterestListResult` (Task 5), what `BoardingPass`/`ShareRow` consume (Task 7) and what `HeroInitial.ticket` holds (Task 8). `InterestProof` (Task 4) → `ProofLine` and `HeroInitial.proof` (Tasks 7, 8). `EmailLinks` (Task 5) → `WelcomeSender` and the smoke. `SignupRowForTicket` matches the four fields the join core passes. `getInviterPlanet` returns `WelcomePlanet | null`, which is exactly `HeroInitial.invite`. `RollingCount` is exported from `proof-line.tsx` and imported by `boarding-pass.tsx`. `HERO`'s `buildTicketUrl("", token)` yields `/interest?me=…` — a relative path, which is what `replaceState` wants.
