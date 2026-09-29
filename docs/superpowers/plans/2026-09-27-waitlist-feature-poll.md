# Waitlist Feature Poll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An interactive "what should we build first?" poll on the waitlist page, between "How early access works" and "A few answers", that ranks the options by everyone's votes once the visitor has voted.

**Architecture:** One `waitlist_poll_votes` table, one row per voter (`voter_key` = `signup:<uuid>` when a resolving `?me=` pass is present, else `cookie:<id>` from an httpOnly `wp_voter` cookie). Pure ranking/option logic lives in a client-safe module; DB logic lives in a server-only module; a thin server action reads headers/cookies; a client component renders radio cards that turn into ranked bars after a vote.

**Tech Stack:** Next.js (App Router, server actions — this repo's Next has breaking changes, read `node_modules/next/dist/docs/` before touching cookies/server-action APIs), Drizzle on Neon/PGlite, `motion/react`, Tailwind 4, `tsx` smoke scripts.

**Spec:** `docs/superpowers/specs/2026-09-27-waitlist-feature-poll-design.md`

## Global Constraints

- **No product branding** in poll copy: the waitlist page is unbranded ("Project: Orbit" mark only). No "Orbit" in any option label or string a visitor sees.
- **Single choice, changeable** (upsert on `voter_key`). No admin UI, no seeded/fake votes, no live polling.
- **Floor:** below `POLL_RESULTS_FLOOR = 25` total votes, show ranked bars only — no percentages or counts — with the caption "Results sharpen as more votes come in."
- **Fixed authored option order** before voting (no shuffle).
- **Rate limit:** `RATE_LIMITS.pollVote = { limit: 20, windowSec: 600 }`, keyed on IP.
- **Client-bundle rule:** anything imported by `feature-poll.tsx` must not reach `@/db` (build fails with a `node:fs` chunk error). Hence the pure/DB module split.
- **`"use server"` files export only async functions** — no types, no constants.
- **Smoke scripts** start with `import "./smoke/_env";` (forces local PGlite; `.env.local` points at shared Neon) and end with `process.exit(0)`.
- **No FK** on `signup_id`, matching every other cross-row reference in the interest-list tables. A signup that is deleted leaves the vote counted.
- Commit after each task; end commit messages with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Baselines: `npx tsc --noEmit` clean; eslint 0 errors.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/lib/waitlist-poll.ts` (create) | **Pure, client-safe.** Option list, floor, `rankPoll`, `applyVote`, `isPollOptionId`, `isVoterId`, cookie name, copy strings. No `@/db`. |
| `src/lib/waitlist-poll-votes.ts` (create) | **Server-only.** Tally + memo, resolving `?me=`, `castVoteCore`, `readPollChoice`, `getPollInitial`. |
| `src/actions/waitlist-poll.ts` (create) | Request-reading half: headers/IP, cookie read + set. Exports only `castPollVote`. |
| `src/components/interest/feature-poll.tsx` (create) | Client component: radio cards, optimistic vote, ranked reveal. |
| `src/app/(site)/interest/page.tsx` (modify) | New section + server-side initial state. |
| `src/db/schema.ts`, `src/db/index.ts`, `scripts/setup-db.ts` (modify) | The table. |
| `src/lib/rate-limit.ts` (modify) | `pollVote` bucket. |
| `scripts/smoke-waitlist-poll.ts` (create), `scripts/run-smoke.ts` (modify) | Smoke + manifest entry. |

---

### Task 0: Worktree setup

**Files:** none

- [ ] **Step 1: Install dependencies in this worktree** (worktrees have no `node_modules`)

Run: `npm ci`
Expected: completes; `ls node_modules | wc -l` > 0.

- [ ] **Step 2: Confirm the baseline**

Run: `npx tsc --noEmit`
Expected: no output (clean).

---

### Task 1: The votes table

**Files:**
- Modify: `src/db/schema.ts` (after the `interestListSignups` block, ends ~line 3747)
- Modify: `src/db/index.ts` (DDL after line 1122; `SCHEMA_VERSION` at ~line 2130)
- Modify: `scripts/setup-db.ts` (`EXPECTED_TABLES`, after `"interest_list_signups"` ~line 49)

**Interfaces:**
- Produces: `waitlistPollVotes` Drizzle table exported from `@/db/schema` with columns `id: uuid`, `optionId: text`, `voterKey: text`, `signupId: uuid | null`, `createdAt`, `updatedAt`.

- [ ] **Step 1: Add the Drizzle table**

Insert after the closing `);` of `interestListSignups` in `src/db/schema.ts`:

```ts
/**
 * One row per voter in the waitlist page's feature poll. `voterKey` is the identity:
 * `signup:<interest_list_signups.id>` when the visitor came in on a resolving `?me=` pass,
 * otherwise `cookie:<id>` from the `wp_voter` cookie. It is unique, so a vote is an upsert
 * and changing your mind moves the row rather than adding one.
 *
 * `optionId` is validated against `POLL_OPTIONS` in `lib/waitlist-poll.ts` before insert, and
 * is deliberately not constrained here: the option list is code, and retiring an option
 * must not need a migration. Votes for an id no longer listed are ignored by the tally.
 * `signupId` has no FK, like every other cross-row reference in the interest-list tables.
 */
export const waitlistPollVotes = pgTable(
  "waitlist_poll_votes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    optionId: text("option_id").notNull(),
    voterKey: text("voter_key").notNull(),
    signupId: uuid("signup_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("waitlist_poll_votes_voter_uidx").on(t.voterKey),
    index("waitlist_poll_votes_option_idx").on(t.optionId),
  ]
);
```

- [ ] **Step 2: Add the DDL**

In `src/db/index.ts`, directly after the line `CREATE INDEX IF NOT EXISTS interest_list_signups_referred_by_idx ON interest_list_signups(referred_by_id);` inside the `DDL` template, add:

```sql
CREATE TABLE IF NOT EXISTS waitlist_poll_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  option_id text NOT NULL,
  voter_key text NOT NULL,
  signup_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_poll_votes_voter_uidx ON waitlist_poll_votes(voter_key);
CREATE INDEX IF NOT EXISTS waitlist_poll_votes_option_idx ON waitlist_poll_votes(option_id);
```

- [ ] **Step 3: Pick the next free schema version**

`getDb()` skips the sweep when the stored version matches, so DDL without a bump never reaches an existing database, and a version another branch already claimed silently skips that branch's DDL. Scan every ref and worktree:

```bash
git fetch --all --prune -q
for r in $(git for-each-ref --format='%(refname)' refs/heads refs/remotes); do
  git show "$r:src/db/index.ts" 2>/dev/null | grep -E '^export const SCHEMA_VERSION'
done | sort | uniq -c | sort -k5 -n | tail -5
for w in $(git worktree list --porcelain | awk '/^worktree /{print $2}'); do
  grep -E '^export const SCHEMA_VERSION' "$w/src/db/index.ts" 2>/dev/null
done | sort | uniq -c | tail -5
```

Take the highest number printed anywhere and add 1 — call it `N`. (This branch is at 120; main has moved past it.)

- [ ] **Step 4: Bump the version with a changelog comment**

Above `export const SCHEMA_VERSION = 120;` add (replace `N`):

```ts
// N = waitlist_poll_votes, the waitlist page's feature poll. Scanned every local and remote
// ref and every worktree's working src/db/index.ts on Sep 27 2026: N-1 is the highest
// claimed anywhere, so N is the next free integer.
```

Then change the constant to `export const SCHEMA_VERSION = N;`.

- [ ] **Step 5: Register the table in setup-db**

In `scripts/setup-db.ts`, add `"waitlist_poll_votes",` after `"interest_list_signups",` in `EXPECTED_TABLES`.

- [ ] **Step 6: Verify the DDL matches the schema**

Run: `npx tsx scripts/smoke-schema-ddl.ts`
Expected: it reports the fingerprint is stale (no failure about the table/index parity).

Run: `npx tsx scripts/smoke-schema-ddl.ts --update` then `npx tsx scripts/smoke-schema-ddl.ts`
Expected: PASS.

- [ ] **Step 7: Prove the DDL runs on a fresh PGlite**

Run: `npx tsx scripts/smoke-schema-bootstrap.ts`
Expected: PASS (it bootstraps the full DDL on a throwaway PGlite).

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/index.ts scripts/setup-db.ts scripts/
git commit -m "feat(waitlist): add waitlist_poll_votes table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Pure poll logic (options, ranking, optimistic update)

**Files:**
- Create: `src/lib/waitlist-poll.ts`
- Create: `scripts/smoke-waitlist-poll.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST, after `"smoke-waitlist-position": "pglite",`)

**Interfaces:**
- Produces (all from `@/lib/waitlist-poll`):
  - `POLL_OPTIONS` — `readonly [{ id, label }, …]` (`as const`)
  - `type PollOptionId`
  - `POLL_RESULTS_FLOOR = 25`, `POLL_VOTER_COOKIE = "wp_voter"`
  - `POLL_ERROR`, `POLL_RATE_LIMITED`, `POLL_RESULTS_CAPTION` (strings)
  - `type PollResults = { counts: Record<string, number> }`
  - `type RankedOption = { id: PollOptionId; label: string; count: number; rank: number; share: number | null; bar: number }`
  - `isPollOptionId(v: unknown): v is PollOptionId`
  - `isVoterId(v: unknown): v is string`
  - `rankPoll(results: PollResults): { options: RankedOption[]; total: number; showNumbers: boolean }`
  - `applyVote(results: PollResults, previous: PollOptionId | null, next: PollOptionId): PollResults`

- [ ] **Step 1: Write the failing smoke (pure half)**

Create `scripts/smoke-waitlist-poll.ts`:

```ts
/**
 * The waitlist page's feature poll: the option list, how a tally becomes a ranking, and (in
 * the second half of this file) how a vote is written and deduped.
 *
 * THE RULES (src/lib/waitlist-poll.ts, src/lib/waitlist-poll-votes.ts): one vote per voter,
 * changeable; a resolving `?me=` pass beats the cookie and absorbs the cookie's earlier
 * vote so nobody counts twice; below POLL_RESULTS_FLOOR total votes the ranking carries no
 * numbers.
 *
 * Run: npx tsx scripts/smoke-waitlist-poll.ts
 */
import "./smoke/_env";

import {
  POLL_OPTIONS,
  POLL_RESULTS_FLOOR,
  applyVote,
  isPollOptionId,
  isVoterId,
  rankPoll,
} from "../src/lib/waitlist-poll";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const [A, B, C] = POLL_OPTIONS.map((o) => o.id);

async function main() {
  console.log("options…");
  check("at least four options", POLL_OPTIONS.length >= 4);
  check("ids are unique", new Set(POLL_OPTIONS.map((o) => o.id)).size === POLL_OPTIONS.length);
  check(
    "no label names the product",
    POLL_OPTIONS.every((o) => !/orbit/i.test(o.label))
  );
  check("a listed id is valid", isPollOptionId(A));
  check("an unknown id is not", !isPollOptionId("nope"));
  check("prototype keys are not", !isPollOptionId("__proto__") && !isPollOptionId("constructor"));
  check("non-strings are not", !isPollOptionId(undefined) && !isPollOptionId(3));
  check("voter ids: uuid ok", isVoterId("3f1c2b4e-9a7d-4e0a-8b1c-2d3e4f5a6b7c"));
  check("voter ids: too short rejected", !isVoterId("short"));
  check("voter ids: odd characters rejected", !isVoterId("aaaaaaaaaaaaaaaa'; drop"));

  console.log("\nranking…");
  const empty = rankPoll({ counts: {} });
  check("no votes: authored order", empty.options.map((o) => o.id).join() === POLL_OPTIONS.map((o) => o.id).join());
  check("no votes: total 0, numbers hidden", empty.total === 0 && !empty.showNumbers);
  check("no votes: every bar empty", empty.options.every((o) => o.bar === 0 && o.share === null));

  const few = rankPoll({ counts: { [A]: 1, [B]: 3 } });
  check("ranks by count", few.options[0].id === B && few.options[1].id === A);
  check("rank numbers are 1-based positions", few.options[0].rank === 1 && few.options[1].rank === 2);
  check("below the floor: no shares", few.options.every((o) => o.share === null) && !few.showNumbers);
  check("leader's bar is full, others relative", few.options[0].bar === 1 && Math.abs(few.options[1].bar - 1 / 3) < 1e-9);

  const tie = rankPoll({ counts: { [B]: 2, [A]: 2 } });
  check("a tie keeps authored order", tie.options[0].id === A && tie.options[1].id === B);

  const full = rankPoll({ counts: { [A]: 15, [B]: 10 } });
  check("at the floor: shares appear", POLL_RESULTS_FLOOR === 25 && full.showNumbers);
  check("shares are rounded percentages of the total", full.options[0].share === 60 && full.options[1].share === 40);

  const orphan = rankPoll({ counts: { [A]: 1, "retired-option": 99 } });
  check("votes for a retired option are ignored", orphan.total === 1 && orphan.options.length === POLL_OPTIONS.length);

  console.log("\noptimistic update…");
  const base = { counts: { [A]: 1 } };
  check("first vote adds one", applyVote(base, null, B).counts[B] === 1 && applyVote(base, null, B).counts[A] === 1);
  const moved = applyVote({ counts: { [A]: 1, [B]: 2 } }, A, C);
  check("changing a vote moves it", moved.counts[A] === 0 && moved.counts[C] === 1 && moved.counts[B] === 2);
  check("never goes negative", applyVote({ counts: {} }, A, B).counts[A] === 0);
  check("does not mutate its input", base.counts[A] === 1 && !(B in base.counts));

  console.log("\nall waitlist-poll checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Register the smoke**

In `scripts/run-smoke.ts`, after `"smoke-waitlist-position": "pglite",` add:

```ts
  "smoke-waitlist-poll": "pglite",
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx tsx scripts/smoke-waitlist-poll.ts`
Expected: FAIL — cannot find module `../src/lib/waitlist-poll`.

- [ ] **Step 4: Implement the pure module**

Create `src/lib/waitlist-poll.ts`:

```ts
/**
 * The waitlist page's feature poll, minus the database: the options, the floor, and the two
 * pure functions the page needs — turn a tally into a ranking, and predict a vote's effect
 * before the server confirms it.
 *
 * CLIENT-SAFE ON PURPOSE. `components/interest/feature-poll.tsx` imports this; anything here
 * that reached `@/db` would fail the client build with a `node:fs` chunk error. The
 * database half is `waitlist-poll-votes.ts`.
 *
 * THE FLOOR. Below `POLL_RESULTS_FLOOR` total votes the ranking carries no numbers: three
 * votes read as "100% / 0% / 0%", which is noise dressed as a result. It is the same idea as
 * the proof line's count floor.
 *
 * COPY. The waitlist is unbranded — no option label may name the product.
 */

export const POLL_OPTIONS = [
  { id: "ask-network", label: "Ask your network anything" },
  { id: "reminders", label: "Reminders to reach out at the right moment" },
  { id: "auto-import", label: "Auto-import from your inbox and calendar" },
  { id: "network-map", label: "A visual map of your network" },
  { id: "drafted-outreach", label: "Drafted outreach messages" },
  { id: "find-people", label: "Finding new people worth knowing" },
] as const;

export type PollOptionId = (typeof POLL_OPTIONS)[number]["id"];

/** Total votes below which the ranking shows order only. */
export const POLL_RESULTS_FLOOR = 25;

/** The httpOnly cookie that identifies an anonymous voter. */
export const POLL_VOTER_COOKIE = "wp_voter";

export const POLL_ERROR = "Couldn't save your vote — please try again.";
export const POLL_RATE_LIMITED = "That's a lot of votes — give it a minute and try again.";
export const POLL_RESULTS_CAPTION = "Results sharpen as more votes come in.";

/** Votes per option id. Ids not in `POLL_OPTIONS` may appear (a retired option) and are ignored. */
export type PollResults = { counts: Record<string, number> };

export type RankedOption = {
  id: PollOptionId;
  label: string;
  count: number;
  /** 1-based position after ranking. */
  rank: number;
  /** Whole-number percent of the total, or null below the floor. */
  share: number | null;
  /** 0–1, relative to the leading option, for the bar. */
  bar: number;
};

const OPTION_IDS: ReadonlySet<string> = new Set(POLL_OPTIONS.map((o) => o.id));

export function isPollOptionId(value: unknown): value is PollOptionId {
  return typeof value === "string" && OPTION_IDS.has(value);
}

/** What a voter cookie looks like — a UUID, but any 16–64 url-safe characters pass. */
const VOTER_ID = /^[A-Za-z0-9_-]{16,64}$/;

export function isVoterId(value: unknown): value is string {
  return typeof value === "string" && VOTER_ID.test(value);
}

/**
 * Ranks the listed options by votes; ties keep authored order. The total counts only listed
 * options, so a retired option's votes cannot skew the percentages.
 */
export function rankPoll(results: PollResults): {
  options: RankedOption[];
  total: number;
  showNumbers: boolean;
} {
  const rows = POLL_OPTIONS.map((option, index) => ({
    option,
    index,
    count: Math.max(0, Math.floor(results.counts[option.id] ?? 0)),
  }));
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  const showNumbers = total >= POLL_RESULTS_FLOOR;
  const options = [...rows]
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map(({ option, count }, i) => ({
      id: option.id,
      label: option.label,
      count,
      rank: i + 1,
      share: showNumbers ? Math.round((count / total) * 100) : null,
      bar: max > 0 ? count / max : 0,
    }));
  return { options, total, showNumbers };
}

/**
 * The tally as it will read once the server confirms this vote: one off `previous`, one on
 * `next`. Used for the optimistic update; the server's answer replaces it.
 */
export function applyVote(
  results: PollResults,
  previous: PollOptionId | null,
  next: PollOptionId
): PollResults {
  const counts = { ...results.counts };
  if (previous) counts[previous] = Math.max(0, (counts[previous] ?? 0) - 1);
  counts[next] = (counts[next] ?? 0) + 1;
  return { counts };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx tsx scripts/smoke-waitlist-poll.ts`
Expected: every line `ok`, then `all waitlist-poll checks passed`.

Run: `npx tsx scripts/run-smoke.ts --check`
Expected: PASS (the script on disk is in the manifest).

- [ ] **Step 6: Commit**

```bash
git add src/lib/waitlist-poll.ts scripts/smoke-waitlist-poll.ts scripts/run-smoke.ts
git commit -m "feat(waitlist): poll options, ranking and optimistic-vote logic

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Votes on the server (tally, dedupe, rate limit)

**Files:**
- Create: `src/lib/waitlist-poll-votes.ts`
- Modify: `src/lib/rate-limit.ts` (after `interestJoin`, ~line 142)
- Modify: `scripts/smoke-waitlist-poll.ts` (add the DB half before the final `process.exit(0)`)

**Interfaces:**
- Consumes: `waitlistPollVotes`, `interestListSignups` (`@/db/schema`); `POLL_*`, `isPollOptionId`, `isVoterId` (`@/lib/waitlist-poll`); `consumeBucket`, `isRateLimitedError`, `RATE_LIMITS` (`@/lib/rate-limit`); `SHARE_TOKEN_MAX` (`@/lib/interest-list`).
- Produces (from `@/lib/waitlist-poll-votes`):
  - `type VoteInput = { optionId: string; me?: string | null; voterId?: string | null }`
  - `type VoteContext = { ip: string }`
  - `type VoteResult = { ok: true; choice: PollOptionId; results: PollResults; newVoterId: string | null } | { ok: false; message: string }`
  - `castVoteCore(input: VoteInput, ctx: VoteContext): Promise<VoteResult>` — `newVoterId` is non-null exactly when the caller must set the cookie.
  - `readPollResults(): Promise<PollResults>` (30 s memo)
  - `readPollChoice(who: { me?: string | null; voterId?: string | null }): Promise<PollOptionId | null>`
  - `getPollInitial(who): Promise<{ results: PollResults; choice: PollOptionId | null }>`
  - `invalidatePollResults(): void`

- [ ] **Step 1: Add the rate-limit bucket**

In `src/lib/rate-limit.ts`, after the `interestJoin` entry add:

```ts
  /**
   * `castPollVote`: the waitlist's feature poll. A vote is one upsert, so this is loose on
   * purpose — several friends behind one NAT voting is normal. What it stops is a loop
   * stuffing the tally from one address.
   */
  pollVote: { limit: 20, windowSec: 600 },
```

- [ ] **Step 2: Extend the smoke with the DB half (failing)**

In `scripts/smoke-waitlist-poll.ts`, add these imports at the top (below the existing ones):

```ts
import { eq, inArray, like, or } from "drizzle-orm";
import { getDb } from "../src/db";
import { interestListSignups, rateLimitBuckets, waitlistPollVotes } from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";
import { RATE_LIMITS } from "../src/lib/rate-limit";
import {
  castVoteCore,
  invalidatePollResults,
  readPollChoice,
  readPollResults,
} from "../src/lib/waitlist-poll-votes";
```

Add above `main()`:

```ts
const PREFIX = "smoke-poll-";
const minted: string[] = [];

async function cleanup() {
  const db = await getDb();
  const signups = await db
    .select({ id: interestListSignups.id })
    .from(interestListSignups)
    .where(like(interestListSignups.email, `${PREFIX}%`));
  const ids = signups.map((s) => s.id);
  const keys = minted.map((id) => `cookie:${id}`);
  await db
    .delete(waitlistPollVotes)
    .where(
      or(
        like(waitlistPollVotes.voterKey, `cookie:${PREFIX}%`),
        ids.length ? inArray(waitlistPollVotes.signupId, ids) : undefined,
        keys.length ? inArray(waitlistPollVotes.voterKey, keys) : undefined
      )
    );
  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, `poll.vote:${PREFIX}%`));
  invalidatePollResults();
}

async function seedSignup(n: number) {
  const db = await getDb();
  const [row] = await db
    .insert(interestListSignups)
    .values({
      email: `${PREFIX}s${n}@example.test`,
      unsubscribeToken: generateUnsubscribeToken(),
      shareToken: `${PREFIX}share-${n}`,
      welcomePlanet: "earth",
    })
    .returning({ id: interestListSignups.id });
  return { id: row.id, token: `${PREFIX}share-${n}` };
}

const ctx = (n: string) => ({ ip: `${PREFIX}ip-${n}` });
const V1 = `${PREFIX}voter-one-0000`;
const V2 = `${PREFIX}voter-two-0000`;
```

Replace the final two lines of `main()` (`console.log("\nall waitlist-poll checks passed"); process.exit(0);`) with the DB half followed by those same two lines:

```ts
  console.log("\ncasting votes…");
  await cleanup();
  const db = await getDb();
  const rowsFor = async (key: string) =>
    db.select().from(waitlistPollVotes).where(eq(waitlistPollVotes.voterKey, key));

  const first = await castVoteCore({ optionId: A, voterId: V1 }, ctx("a"));
  check("a first vote is recorded", first.ok && first.choice === A && first.results.counts[A] === 1);
  check("a known cookie is not re-minted", first.ok && first.newVoterId === null);
  check("one row under the cookie key", (await rowsFor(`cookie:${V1}`)).length === 1);

  const moved2 = await castVoteCore({ optionId: B, voterId: V1 }, ctx("a"));
  check(
    "changing a vote moves it, not adds it",
    moved2.ok && moved2.results.counts[A] === 0 && moved2.results.counts[B] === 1
  );
  check("still one row for that voter", (await rowsFor(`cookie:${V1}`)).length === 1);

  await castVoteCore({ optionId: B, voterId: V2 }, ctx("b"));
  check("two voters both count", (await readPollResults()).counts[B] === 2);

  const minted1 = await castVoteCore({ optionId: C }, ctx("c"));
  check("no cookie: the core mints one", minted1.ok && isVoterId(minted1.newVoterId));
  if (minted1.ok && minted1.newVoterId) minted.push(minted1.newVoterId);
  check(
    "the minted id reads back its vote",
    minted1.ok && (await readPollChoice({ voterId: minted1.newVoterId })) === C
  );

  const junk = await castVoteCore({ optionId: C, voterId: "short" }, ctx("c"));
  if (junk.ok && junk.newVoterId) minted.push(junk.newVoterId);
  check("a malformed cookie is treated as absent", junk.ok && isVoterId(junk.newVoterId));

  const bad = await castVoteCore({ optionId: "nope", voterId: V2 }, ctx("b"));
  check("an unknown option is refused", !bad.ok);
  check("…and did not touch the voter's row", (await readPollChoice({ voterId: V2 })) === B);

  console.log("\nsigned-up voters…");
  await cleanup();
  const s1 = await seedSignup(1);
  await castVoteCore({ optionId: A, voterId: V1 }, ctx("d"));
  check("setup: the browser voted anonymously first", (await readPollChoice({ voterId: V1 })) === A);

  const signed = await castVoteCore({ optionId: C, me: s1.token, voterId: V1 }, ctx("d"));
  check("a resolving pass records the vote", signed.ok && signed.choice === C);
  check("…under the signup key, with the signup id", (await rowsFor(`signup:${s1.id}`))[0]?.signupId === s1.id);
  check("…and absorbs the browser's earlier cookie vote", (await rowsFor(`cookie:${V1}`)).length === 0);
  check("…so the tally counts one, not two", signed.ok && signed.results.counts[A] === 0 && signed.results.counts[C] === 1);
  check("a signed-up voter reads back without the cookie", (await readPollChoice({ me: s1.token })) === C);
  check("…and with a stale cookie the pass wins", (await readPollChoice({ me: s1.token, voterId: V2 })) === C);
  check("signed-up voters are never handed a cookie", signed.ok && signed.newVoterId === null);

  const s2 = await seedSignup(2);
  await castVoteCore({ optionId: B, voterId: V2 }, ctx("e"));
  check(
    "a pass with no vote of its own falls back to the browser's",
    (await readPollChoice({ me: s2.token, voterId: V2 })) === B
  );
  const stray = await castVoteCore({ optionId: A, me: "not-a-real-token", voterId: V2 }, ctx("e"));
  check("an unknown pass falls back to the cookie path", stray.ok && stray.choice === A);
  check("…moving that browser's vote", (await readPollChoice({ voterId: V2 })) === A);

  console.log("\nrate limit…");
  await cleanup();
  const rl = ctx("rl");
  let lastOk = true;
  for (let i = 0; i < RATE_LIMITS.pollVote.limit; i++) {
    lastOk = (await castVoteCore({ optionId: A, voterId: V1 }, rl)).ok;
  }
  check("votes up to the limit go through", lastOk);
  const over = await castVoteCore({ optionId: B, voterId: V1 }, rl);
  check("the next is refused with a friendly message", !over.ok && over.message.length > 0);
  check("…and does not change the vote", (await readPollChoice({ voterId: V1 })) === A);

  await cleanup();
  console.log("\nall waitlist-poll checks passed");
  process.exit(0);
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx tsx scripts/smoke-waitlist-poll.ts`
Expected: pure half prints `ok`, then FAIL — cannot find module `../src/lib/waitlist-poll-votes`.

- [ ] **Step 4: Implement the server module**

Create `src/lib/waitlist-poll-votes.ts`:

```ts
/**
 * The waitlist feature poll's database half: the tally, who a `?me=` pass or a cookie is,
 * and the vote itself. The pure half (options, ranking) is `waitlist-poll.ts`.
 *
 * Server-only. Imports `@/db` and nothing from `next/*`, so the smoke can drive it outside a
 * request — the action in `actions/waitlist-poll.ts` supplies the IP and the cookie.
 *
 * IDENTITY. `voter_key` is `signup:<id>` when the visitor came in on a `?me=` pass that
 * resolves to a signup, else `cookie:<id>`. A pass beats the cookie, and casting a vote as a
 * signup deletes that browser's cookie-keyed vote in the same call, so voting before and
 * after joining cannot count twice. The two writes are not one transaction (neon-http has
 * none); the upsert lands first, so a failure between them leaves a double count, never a
 * lost vote.
 *
 * THE TALLY is a GROUP BY, memoised per instance for 30 s. A vote invalidates the memo on
 * the instance that took it, and returns a fresh read, so the voter always sees their own
 * vote; another instance lags by up to 30 s, which no visitor can act on.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interestListSignups, waitlistPollVotes } from "@/db/schema";
import { SHARE_TOKEN_MAX } from "@/lib/interest-list";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import {
  POLL_ERROR,
  POLL_RATE_LIMITED,
  isPollOptionId,
  isVoterId,
  type PollOptionId,
  type PollResults,
} from "@/lib/waitlist-poll";

const RESULTS_TTL_MS = 30_000;

let resultsMemo: { at: number; value: PollResults } | null = null;

export type VoteInput = { optionId: string; me?: string | null; voterId?: string | null };
export type VoteContext = { ip: string };
export type VoteResult =
  | { ok: true; choice: PollOptionId; results: PollResults; newVoterId: string | null }
  | { ok: false; message: string };

async function readResultsFresh(): Promise<PollResults> {
  const db = await getDb();
  const rows = await db
    .select({ optionId: waitlistPollVotes.optionId, n: sql<number>`count(*)::int` })
    .from(waitlistPollVotes)
    .groupBy(waitlistPollVotes.optionId);
  const counts: Record<string, number> = {};
  for (const row of rows) if (isPollOptionId(row.optionId)) counts[row.optionId] = row.n;
  return { counts };
}

export async function readPollResults(): Promise<PollResults> {
  if (resultsMemo && Date.now() - resultsMemo.at < RESULTS_TTL_MS) return resultsMemo.value;
  const value = await readResultsFresh();
  resultsMemo = { at: Date.now(), value };
  return value;
}

export function invalidatePollResults() {
  resultsMemo = null;
}

/** The signup a share token belongs to, or null for anything that is not a live token. */
async function signupIdForToken(token: string | null | undefined): Promise<string | null> {
  if (!token || token.length > SHARE_TOKEN_MAX) return null;
  const db = await getDb();
  const [row] = await db
    .select({ id: interestListSignups.id })
    .from(interestListSignups)
    .where(eq(interestListSignups.shareToken, token))
    .limit(1);
  return row?.id ?? null;
}

/**
 * What this visitor has already voted for, or null. A signup's own vote wins; failing that,
 * the browser's cookie vote (someone who voted, then joined, has not voted again yet).
 */
export async function readPollChoice(who: {
  me?: string | null;
  voterId?: string | null;
}): Promise<PollOptionId | null> {
  const signupId = await signupIdForToken(who.me);
  const signupKey = signupId ? `signup:${signupId}` : null;
  const cookieKey = isVoterId(who.voterId) ? `cookie:${who.voterId}` : null;
  const keys = [signupKey, cookieKey].filter((k): k is string => k !== null);
  if (keys.length === 0) return null;

  const db = await getDb();
  const rows = await db
    .select({ voterKey: waitlistPollVotes.voterKey, optionId: waitlistPollVotes.optionId })
    .from(waitlistPollVotes)
    .where(inArray(waitlistPollVotes.voterKey, keys));
  const mine = rows.find((r) => r.voterKey === signupKey) ?? rows.find((r) => r.voterKey === cookieKey);
  return mine && isPollOptionId(mine.optionId) ? mine.optionId : null;
}

/** What the page needs to render the poll: the tally and this visitor's choice. */
export async function getPollInitial(who: {
  me?: string | null;
  voterId?: string | null;
}): Promise<{ results: PollResults; choice: PollOptionId | null }> {
  const [results, choice] = await Promise.all([readPollResults(), readPollChoice(who)]);
  return { results, choice };
}

export async function castVoteCore(input: VoteInput, ctx: VoteContext): Promise<VoteResult> {
  const { optionId } = input;
  if (!isPollOptionId(optionId)) return { ok: false, message: POLL_ERROR };

  // A limiter that cannot count must not fail open into the write.
  try {
    await consumeBucket("poll.vote", ctx.ip, RATE_LIMITS.pollVote);
  } catch (err) {
    if (isRateLimitedError(err)) return { ok: false, message: POLL_RATE_LIMITED };
    console.error("[waitlist-poll] limiter failed", err);
    return { ok: false, message: POLL_ERROR };
  }

  try {
    const db = await getDb();
    const signupId = await signupIdForToken(input.me);
    const cookieId = isVoterId(input.voterId) ? input.voterId : null;

    let voterKey: string;
    let newVoterId: string | null = null;
    if (signupId) {
      voterKey = `signup:${signupId}`;
    } else {
      newVoterId = cookieId ? null : crypto.randomUUID();
      voterKey = `cookie:${cookieId ?? newVoterId}`;
    }

    await db
      .insert(waitlistPollVotes)
      .values({ optionId, voterKey, signupId })
      .onConflictDoUpdate({
        target: waitlistPollVotes.voterKey,
        set: { optionId, signupId, updatedAt: new Date() },
      });

    // A signed-up voter's earlier anonymous vote from this browser is theirs: absorb it.
    if (signupId && cookieId) {
      await db.delete(waitlistPollVotes).where(eq(waitlistPollVotes.voterKey, `cookie:${cookieId}`));
    }

    invalidatePollResults();
    return { ok: true, choice: optionId, results: await readPollResults(), newVoterId };
  } catch (err) {
    console.error("[waitlist-poll] vote failed", err);
    return { ok: false, message: POLL_ERROR };
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx tsx scripts/smoke-waitlist-poll.ts`
Expected: every line `ok`, then `all waitlist-poll checks passed`.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/waitlist-poll-votes.ts src/lib/rate-limit.ts scripts/smoke-waitlist-poll.ts
git commit -m "feat(waitlist): poll votes — tally, signup-tied dedupe, rate limit

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: The server action

**Files:**
- Create: `src/actions/waitlist-poll.ts`

**Interfaces:**
- Consumes: `castVoteCore`, `type VoteResult` (`@/lib/waitlist-poll-votes`); `POLL_VOTER_COOKIE` (`@/lib/waitlist-poll`); `clientIpFrom` (`@/lib/client-ip`).
- Produces: `castPollVote(input: { optionId: string; me?: string | null }): Promise<{ ok: true; choice: PollOptionId; results: PollResults } | { ok: false; message: string }>` — never returns `newVoterId`; it sets the cookie itself.

- [ ] **Step 1: Check the cookie API in this Next version**

Run: `grep -rn "cookies()" node_modules/next/dist/docs --include=*.md -l | head -5` and read the one covering server actions.
Expected: confirms `cookies()` is async and `.set(name, value, options)` is allowed inside a server action. If the signature differs, adapt Step 2 to match the docs.

- [ ] **Step 2: Write the action**

Create `src/actions/waitlist-poll.ts`:

```ts
"use server";

import { cookies, headers } from "next/headers";
import { clientIpFrom } from "@/lib/client-ip";
import { POLL_VOTER_COOKIE, type PollOptionId, type PollResults } from "@/lib/waitlist-poll";
import { castVoteCore } from "@/lib/waitlist-poll-votes";

/**
 * The request-reading half of a poll vote. Everything that decides what happens lives in
 * `lib/waitlist-poll-votes.ts`, which the smoke drives without a request.
 *
 * Reads the IP and the `wp_voter` cookie, and mints the cookie when the core says the voter
 * has none. The minted id never goes back to the client in the response — the cookie is
 * httpOnly, and the client has no use for it.
 *
 * A "use server" file may export only async functions, so the types the client needs are
 * spelled out in the return type rather than exported.
 */
export async function castPollVote(input: {
  optionId: string;
  me?: string | null;
}): Promise<
  | { ok: true; choice: PollOptionId; results: PollResults }
  | { ok: false; message: string }
> {
  const ip = clientIpFrom(await headers());
  const jar = await cookies();
  const voterId = jar.get(POLL_VOTER_COOKIE)?.value ?? null;

  const result = await castVoteCore({ optionId: input.optionId, me: input.me, voterId }, { ip });
  if (!result.ok) return result;

  if (result.newVoterId) {
    jar.set(POLL_VOTER_COOKIE, result.newVoterId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
    });
  }
  return { ok: true, choice: result.choice, results: result.results };
}
```

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/actions/waitlist-poll.ts src/lib/waitlist-poll.ts src/lib/waitlist-poll-votes.ts`
Expected: clean, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/actions/waitlist-poll.ts
git commit -m "feat(waitlist): castPollVote server action

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: The poll component

**Files:**
- Create: `src/components/interest/feature-poll.tsx`

**Interfaces:**
- Consumes: `castPollVote` (`@/actions/waitlist-poll`); `POLL_OPTIONS`, `POLL_ERROR`, `POLL_RESULTS_CAPTION`, `applyVote`, `rankPoll`, `type PollOptionId`, `type PollResults` (`@/lib/waitlist-poll`); `SPRING_SOFT`, `EASE_HOUSE` (`@/lib/motion`); `pulseStarfield` (`@/lib/starfield-events`).
- Produces: `FeaturePoll({ initial, me }: { initial: FeaturePollInitial; me: string | null })` and `type FeaturePollInitial = { results: PollResults; choice: PollOptionId | null }`.

- [ ] **Step 1: Write the component**

Create `src/components/interest/feature-poll.tsx`:

```tsx
"use client";

import { useRef, useState, useTransition } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Check } from "lucide-react";
import { castPollVote } from "@/actions/waitlist-poll";
import { EASE_HOUSE, SPRING_SOFT } from "@/lib/motion";
import { pulseStarfield } from "@/lib/starfield-events";
import { cn } from "@/lib/utils";
import {
  POLL_ERROR,
  POLL_OPTIONS,
  POLL_RESULTS_CAPTION,
  applyVote,
  rankPoll,
  type PollOptionId,
  type PollResults,
} from "@/lib/waitlist-poll";

export type FeaturePollInitial = { results: PollResults; choice: PollOptionId | null };

/**
 * The waitlist's feature poll. Before a vote: radio cards in authored order, no results.
 * One tap votes (no submit button); the bars then grow in and the cards glide into ranked
 * order, the pick highlighted. Tapping another card moves the vote.
 *
 * The cards are native radios inside labels, so keyboard and screen-reader behaviour is the
 * platform's. The vote is applied optimistically and replaced by the server's tally; a
 * failure rolls it back and says so.
 *
 * A visitor who already voted gets the ranked view from the server on first paint, and their
 * bars start at full length (`initial={false}`) rather than replaying the reveal.
 *
 * `me` is the visitor's `?me=` pass token, if any, so the server can tie the vote to their
 * signup. Reduced motion is read at render time from `useReducedMotion`, not from a
 * post-mount effect: a hook that flips after mount would let the first transition play.
 */
export function FeaturePoll({ initial, me }: { initial: FeaturePollInitial; me: string | null }) {
  const reduced = useReducedMotion();
  const [results, setResults] = useState(initial.results);
  const [choice, setChoice] = useState(initial.choice);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [, startTransition] = useTransition();
  const votedOnLoad = useRef(initial.choice !== null);
  const inFlight = useRef(false);

  const voted = choice !== null;
  const view = rankPoll(results);
  const byId = new Map(view.options.map((o) => [o.id, o]));
  const ordered = voted ? view.options : POLL_OPTIONS.map((o) => byId.get(o.id)!);

  function vote(id: PollOptionId, source: HTMLElement) {
    if (inFlight.current || id === choice) return;
    inFlight.current = true;
    const before = { results, choice };
    setError(null);
    setResults(applyVote(results, choice, id));
    setChoice(id);

    const rect = source.getBoundingClientRect();
    pulseStarfield(rect.left + rect.width / 2, rect.top + rect.height / 2);

    const rollback = (message: string) => {
      setResults(before.results);
      setChoice(before.choice);
      setError(message);
    };
    startTransition(async () => {
      try {
        const res = await castPollVote({ optionId: id, me });
        if (!res.ok) {
          rollback(res.message);
          return;
        }
        setResults(res.results);
        setChoice(res.choice);
        const label = POLL_OPTIONS.find((o) => o.id === res.choice)?.label ?? "";
        setAnnouncement(`Your vote for “${label}” is in.`);
      } catch (err) {
        console.error("[feature-poll] vote failed", err);
        rollback(POLL_ERROR);
      } finally {
        inFlight.current = false;
      }
    });
  }

  const glide = reduced ? { duration: 0 } : SPRING_SOFT;
  const grow = reduced ? { duration: 0 } : { duration: 0.7, ease: EASE_HOUSE };

  return (
    <div className="mx-auto w-full max-w-2xl">
      <fieldset>
        <legend className="sr-only">Which feature do you want most?</legend>
        <ul className="grid gap-3">
          {ordered.map((opt) => {
            const selected = choice === opt.id;
            return (
              <motion.li key={opt.id} layout="position" transition={glide}>
                <label
                  className={cn(
                    "landing-glass relative block cursor-pointer overflow-hidden rounded-2xl border border-transparent px-5 py-4 transition-colors",
                    "hover:border-[#e8f3f1]/20 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#f2c14e]/60",
                    selected && "border-[#f2c14e]/50"
                  )}
                >
                  <input
                    type="radio"
                    name="feature-poll"
                    className="sr-only"
                    checked={selected}
                    onChange={(e) => vote(opt.id, e.currentTarget.parentElement ?? e.currentTarget)}
                  />
                  {voted && (
                    <motion.span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 w-full origin-left bg-[#f2c14e]/[0.13]"
                      initial={votedOnLoad.current ? false : { scaleX: 0 }}
                      animate={{ scaleX: opt.count === 0 ? 0 : Math.max(opt.bar, 0.06) }}
                      transition={grow}
                    />
                  )}
                  <span className="relative flex items-center gap-3">
                    {voted && (
                      <span className="w-5 shrink-0 text-sm tabular-nums text-[#6d807c]">{opt.rank}</span>
                    )}
                    <span className="flex-1 text-sm font-medium text-[#e8f3f1] sm:text-base">{opt.label}</span>
                    {selected && <Check className="size-4 shrink-0 text-[#f2c14e]" aria-hidden="true" />}
                    {voted && view.showNumbers && (
                      <span className="w-11 shrink-0 text-right text-sm tabular-nums text-[#9aada8]">
                        {opt.share}%
                      </span>
                    )}
                  </span>
                </label>
              </motion.li>
            );
          })}
        </ul>
      </fieldset>

      <p className="mt-4 text-center text-sm text-[#9aada8]">
        {!voted
          ? "Pick the one you'd use most, then see how everyone voted."
          : view.showNumbers
            ? `${view.total.toLocaleString()} votes so far. Tap another to change yours.`
            : POLL_RESULTS_CAPTION}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-center text-sm text-[#f0a3a3]">
          {error}
        </p>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/components/interest/feature-poll.tsx`
Expected: clean. Eslint warnings are tolerated only if the count does not rise above the baseline; errors are not.

- [ ] **Step 3: Commit**

```bash
git add src/components/interest/feature-poll.tsx
git commit -m "feat(waitlist): interactive feature poll component

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire it into the page

**Files:**
- Modify: `src/app/(site)/interest/page.tsx` (imports ~lines 4–27; data load ~lines 171–185; new section before the FAQ `<section>` ~line 292; helper at the bottom)
- Modify: `scripts/smoke-interest-list-page.ts` (assert the poll's initial state crosses the client boundary)

**Interfaces:**
- Consumes: `FeaturePoll`, `type FeaturePollInitial`; `getPollInitial`; `POLL_VOTER_COOKIE`.

- [ ] **Step 1: Add the imports**

In `page.tsx`, change `import { headers } from "next/headers";` to `import { cookies, headers } from "next/headers";` and add:

```tsx
import { FeaturePoll, type FeaturePollInitial } from "@/components/interest/feature-poll";
import { getPollInitial } from "@/lib/waitlist-poll-votes";
import { POLL_VOTER_COOKIE } from "@/lib/waitlist-poll";
```

Below `EMPTY_PROOF` add:

```tsx
/** What the poll degrades to if the database read fails: nothing voted, nothing tallied. */
const EMPTY_POLL: FeaturePollInitial = { results: { counts: {} }, choice: null };
```

- [ ] **Step 2: Load the poll state alongside the rest**

Extend the existing `Promise.all` so it reads `[proof, ticket, showDemo, poll]`:

```tsx
  const voterId = await readVoterId();
  const [proof, ticket, showDemo, poll] = await Promise.all([
    /* …existing three entries unchanged… */
    getPollInitial({ me, voterId }).catch((err: unknown) => {
      console.error("[interest] poll read failed", err);
      return EMPTY_POLL;
    }),
  ]);
```

- [ ] **Step 3: Add the section**

Insert directly before `<section className="mt-24 md:mt-32" aria-labelledby="waitlist-faq">`:

```tsx
        <section className="mt-24 md:mt-32" aria-labelledby="waitlist-poll">
          <Reveal className="reveal-celestial">
            <h2 id="waitlist-poll" className={`${HEADING} text-center text-[clamp(26px,3.4vw,38px)]`}>
              What should we build first?
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={80}>
            <p className="mx-auto mt-3 max-w-[48ch] text-center text-base leading-relaxed text-[#9aada8]">
              Vote for the one you want most, and see what everyone else picked.
            </p>
          </Reveal>
          <Reveal className="reveal-celestial mt-10 block" delay={120}>
            <FeaturePoll initial={poll} me={me} />
          </Reveal>
        </section>
```

- [ ] **Step 4: Add the cookie helper**

At the bottom of the file, beside `servedOnWaitlistHost`:

```tsx
/**
 * The poll's voter cookie, or null. Outside a request — the page smoke renders this
 * function directly — there is no cookie store, which reads as "hasn't voted".
 */
async function readVoterId() {
  try {
    return (await cookies()).get(POLL_VOTER_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Extend the page smoke**

In `scripts/smoke-interest-list-page.ts`:

Add imports:

```ts
import { eq } from "drizzle-orm";
import { waitlistPollVotes } from "../src/db/schema";
import { POLL_OPTIONS } from "../src/lib/waitlist-poll";
```

(merge `eq` into the existing `drizzle-orm` import rather than adding a second one).

Change the seed insert in `main()` to return the id, and seed one vote for that signup:

```ts
  const [seeded] = await db
    .insert(interestListSignups)
    .values({
      email: `${PREFIX}a@example.test`,
      unsubscribeToken: generateUnsubscribeToken(),
      shareToken: TOKEN,
      welcomePlanet: "saturn",
    })
    .returning({ id: interestListSignups.id });
  const pollPick = POLL_OPTIONS[1].id;
  await db
    .insert(waitlistPollVotes)
    .values({ optionId: pollPick, voterKey: `signup:${seeded.id}`, signupId: seeded.id });
```

In `cleanup()`, before the signups delete, add (the seeded row may not exist yet on the first call, so key it off the signups):

```ts
  const stale = await db
    .select({ id: interestListSignups.id })
    .from(interestListSignups)
    .where(like(interestListSignups.email, `${PREFIX}%`));
  for (const { id } of stale) {
    await db.delete(waitlistPollVotes).where(eq(waitlistPollVotes.signupId, id));
  }
```

Directly after the `// --- form` assertions block (after the "the hero gets the waitlist page URL" check), add:

```ts
  // The poll lives in a client component this walk cannot enter; its props are the contract.
  check("the poll carries a tally", typeof (findProp(form, "results") as { counts?: unknown })?.counts === "object");
  check("a visitor with no pass or cookie has not voted", findProp(form, "choice") === null);
  check("…and hands the poll no pass token", findProp(form, "me") === null);

  const passed = await Page(sp({ me: TOKEN }));
  check("a pass that has voted opens on its pick", findProp(passed, "choice") === pollPick, String(findProp(passed, "choice")));
  check("…and hands the poll its pass token", findProp(passed, "me") === TOKEN);
```

The existing "nothing else names the product" and "nothing says it is live…" checks already cover the poll section's server-rendered heading and sub-line; the option labels are checked for the product name in `smoke-waitlist-poll.ts`.

- [ ] **Step 6: Run the checks**

Run: `npx tsx scripts/smoke-interest-list-page.ts`
Expected: PASS, including the new assertions.

Run: `npx tsc --noEmit && npx eslint "src/app/(site)/interest/page.tsx"`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(site)/interest/page.tsx" scripts/smoke-interest-list-page.ts
git commit -m "feat(waitlist): feature poll section above the FAQ

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Verify in a browser

**Files:** none (fix anything found in the relevant earlier task's files).

- [ ] **Step 1: Start the preview**

Use `preview_start` with `{name: "orbit-demo"}` (runs `.claude/preview-demo.sh` on 3001, local PGlite demo mode). A fresh worktree has no `.env`, so this is demo mode; do not run `next build` against the same `.next` while it is up. If port drift is suspected, resolve port → pid → cwd → branch before trusting what you see.

- [ ] **Step 2: Open the page and check the pre-vote state**

Navigate to `/interest`, scroll to "What should we build first?".
Expected: six cards in authored order, no numbers, the prompt line under them. `read_console_messages` shows no errors.

- [ ] **Step 3: Vote**

Click a card (use the label ref from `read_page`; type/click real events, not `form_input`, which bypasses React state).
Expected: the card gets a check and highlight, bars appear, cards reorder with rank numbers, the caption reads "Results sharpen as more votes come in.", the starfield pulses. `read_network_requests` shows one POST to the page path; the response sets `wp_voter`.

- [ ] **Step 4: Change the vote, then reload**

Click a different card: the tally moves, no second row. Reload.
Expected: the ranked view renders immediately with the same pick highlighted and bars already at full length (no replayed reveal).

- [ ] **Step 5: Floor behaviour**

In the PGlite dev DB (dev server stopped first — single writer), or via 25+ distinct cookie voters in a throwaway script, push the total to 25.
Expected: percentages appear and the caption becomes "N votes so far. Tap another to change yours."

- [ ] **Step 6: Signed-up voter**

Join the waitlist on the page to get a pass, open `/interest?me=<token>` in a fresh session, vote.
Expected: vote counts once; earlier anonymous vote from the first browser is not double-counted.

- [ ] **Step 7: Responsive and motion**

`resize_window` to mobile (375×812): no horizontal scroll, cards readable. Emulate `prefers-reduced-motion: reduce` (via `javascript_tool` is not sufficient — use the browser emulation if available): reveal and reorder snap. Reset the viewport to desktop afterwards.

- [ ] **Step 8: Take a screenshot** of the pre-vote and post-vote states for the PR.

---

### Task 8: Full verification and wrap-up

**Files:** none new.

- [ ] **Step 1: Whole-suite gates**

Run each and confirm the output, not just the exit code:

```bash
npx tsc --noEmit
npx eslint src scripts 2>&1 | tail -5
npx tsx scripts/run-smoke.ts --check
npx tsx scripts/run-smoke.ts --only smoke-waitlist-poll smoke-interest-list-page smoke-interest-list-join smoke-waitlist-position smoke-schema-ddl smoke-schema-bootstrap
```

Expected: tsc clean; eslint 0 errors (warnings ≤ baseline of 46); every named smoke passes. If `admin-render`/`instrumentation` smokes time out under machine load, rerun them alone.

- [ ] **Step 2: Leak scan on a production build**

Stop any dev server on this checkout first (a build and `next dev` on one `.next` wedges the dev server), then:

```bash
npm run build
npx next start -p 3011 &
node scripts/dev/scan-waitlist-leaks.mjs http://waitlist.localhost:3011 --connect 127.0.0.1
```

Expected: the scan reports nothing branded reaching the waitlist host. Stop the server afterwards.

- [ ] **Step 3: Rescan the schema version against main**

Re-run the Task 1 Step 3 scan. If another branch claimed `N` since, bump to the next free integer, update the changelog comment, rerun `smoke-schema-ddl.ts --update`, and commit.

- [ ] **Step 4: Correct the spec to match what was built**

In `docs/superpowers/specs/2026-09-27-waitlist-feature-poll-design.md`: table `id` is `uuid` (not serial); `signup_id` is `uuid`, **no FK / no `ON DELETE SET NULL`** (repo convention; a deleted signup leaves the vote counted); the files list gains the split `src/lib/waitlist-poll.ts` (pure, client-safe) and `src/lib/waitlist-poll-votes.ts` (server-only). Commit.

- [ ] **Step 5: Hand off**

Summarize what shipped, the screenshots, the final `SCHEMA_VERSION`, and that nothing has been pushed. Do not push or open a PR without being asked.
