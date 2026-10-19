# Launch Phase 1 — Say True Things Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every public promise about Orbit (privacy policy, terms, Google disclosures, deletion, AI spend) true in code, and make the code that backs them auditable.
**Architecture:** One schema bump adds the three `user_settings` columns this phase needs (terms consent, timeline opt-in). Pure, DB-free modules (`google-scopes.ts`, `legal.ts`, `timeline-cost.ts`, `usage-summary-types.ts`, `knowledge-base-types.ts`) hold every constant the policy quotes, so the policy pages, the UI and the smoke tests read the same source. The policy and terms rewrites come last, after the code they describe has landed.
**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle over Neon (neon-http) / PGlite, Clerk, Stripe, tsx smoke scripts
**Spec:** docs/production-readiness-audit-2026-09-15.md (items: A3, B5 (Google-verification subset), B9, A6, B8 (usage card), B4)
**Roadmap:** docs/superpowers/plans/2026-09-15-launch-readiness-roadmap.md

## Global Constraints

- Branch: create `claude/launch-p1` off `origin/main` in a fresh worktree; run `npm ci` in it (worktrees share no node_modules). Commit after every task; commit messages end with the line `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
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

- **Cut after Phase 0 merges.** This plan assumes Phase 0 landed: the Clerk `user.deleted` webhook calls `purgeUserData(userId, { keepSettings: false })`; `saveAiSettings` validates keys via `src/lib/ai-key-check.ts`; `/api/*` answers JSON 401 when signed out; refunds and lost disputes revoke access (A4); `toPublicRecruiter` unlocks recruiter PII only for rows pooled for the viewer (A8 short-term). Tasks 14 and 15 re-verify the last two before writing policy text that depends on them.
- **Line numbers** below were verified on `33a213c`. Phase 0 edited some of the same files (`src/app/api/webhooks/clerk/route.ts`, `src/lib/errors.ts`, `src/actions/settings.ts`, `src/lib/admin-operations.ts`), so re-read each file before editing and anchor every edit on the quoted code, not on the number.
- **One schema bump, in Task 1.** Every later task consumes the columns it adds; no later task changes DDL.
- **Stop the dev server** of this worktree before any tsx script that writes to `.data/pglite` (`npm run db:setup`): two writers corrupt it. Smoke scripts use their own throwaway PGlite dir and are safe.
- **Policy copy is not legal advice.** Tasks 14–15 produce the text; the Manual steps require a lawyer or privacy-review read before launch.
- **Task order is load-bearing:** the policy (Task 14) and terms (Task 15) describe behaviour Tasks 1–13 create. Do not reorder them earlier.

---

### Task 1: The three `user_settings` columns, one schema bump (B9, A6)

**Files:**
- Modify: `src/db/schema.ts:275-285` (after `recruiterSharing`, before the `suspendedAt` doc comment)
- Modify: `src/db/index.ts:70` (DDL `CREATE TABLE user_settings`), `:1977-1982` (PGlite `ensureColumn` for `recruiter_sharing`), `:2523` (`alters` entry for `recruiter_sharing`), `:1399-1406` (changelog + `SCHEMA_VERSION`)
- Modify: `src/lib/user-data.ts:437-475` (`PRESERVED_SETTINGS_COLUMNS`)
- Modify: `scripts/schema-ddl.lock.json` (regenerated), `scripts/run-smoke.ts` (MANIFEST)
- Create: `scripts/smoke-preserved-settings.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Drizzle columns on `userSettings`: `termsAcceptedAt: Date | null` (`terms_accepted_at timestamptz`), `termsVersion: string | null` (`terms_version text`), `timelineBackfillEnabled: number` (`timeline_backfill_enabled integer NOT NULL DEFAULT 0`). All three survive a Settings data wipe and are erased by `purgeUserData(userId, { keepSettings: false })`.

- [ ] **Step 1: Set up the branch**

```bash
cd /Users/jasonpereira/Projects/orbit
git fetch -q origin
git worktree add .claude/worktrees/launch-p1 -b claude/launch-p1 origin/main
cd .claude/worktrees/launch-p1
npm ci
```

- [ ] **Step 2: Write the failing test** — create `scripts/smoke-preserved-settings.ts`:

```ts
/**
 * Launch Phase 1 adds three user_settings columns that are account state, not content:
 * the recorded Terms acceptance (terms_accepted_at, terms_version) and the LinkedIn
 * timeline opt-in (timeline_backfill_enabled). A Settings data wipe (purgeUserData with
 * keepSettings left at its default) must keep them; deleting the account must not.
 *
 * Run: npx tsx scripts/smoke-preserved-settings.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-preserved-settings-user";
const FRESH = "smoke-preserved-settings-fresh";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function settingsFor(userId: string) {
  const db = await getDb();
  return db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
}

run(async () => {
  const db = await getDb();
  await db.delete(userSettings).where(inArray(userSettings.userId, [USER, FRESH]));

  await db.insert(userSettings).values({ userId: FRESH });
  const fresh = await settingsFor(FRESH);
  check("a fresh row is opted out of the timeline backfill", fresh?.timelineBackfillEnabled === 0, JSON.stringify(fresh?.timelineBackfillEnabled));
  check("a fresh row has accepted nothing", fresh?.termsAcceptedAt === null && fresh?.termsVersion === null);

  const acceptedAt = new Date("2026-09-15T12:00:00.000Z");
  await db.insert(userSettings).values({
    userId: USER,
    termsAcceptedAt: acceptedAt,
    termsVersion: "2026-09-15",
    timelineBackfillEnabled: 1,
  });

  await purgeUserData(USER);
  const wiped = await settingsFor(USER);
  check("a Settings data wipe keeps the recorded terms acceptance", wiped?.termsAcceptedAt?.toISOString() === acceptedAt.toISOString(), String(wiped?.termsAcceptedAt));
  check("…and the terms version", wiped?.termsVersion === "2026-09-15", String(wiped?.termsVersion));
  check("…and the timeline opt-in", wiped?.timelineBackfillEnabled === 1, String(wiped?.timelineBackfillEnabled));

  await purgeUserData(USER, { keepSettings: false });
  check("deleting the account removes the row and everything on it", (await settingsFor(USER)) === undefined);

  await db.delete(userSettings).where(inArray(userSettings.userId, [USER, FRESH]));
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll preserved-settings checks passed.");
});
```

Add to `MANIFEST` in `scripts/run-smoke.ts`, in the `// pglite` block (after `"smoke-purge-selective": "pglite",`):

```ts
  "smoke-preserved-settings": "pglite",
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx scripts/smoke-preserved-settings.ts`
Expected: `FAIL a fresh row is opted out of the timeline backfill — undefined` (and the other FAIL lines), then `Error: 5 check(s) failed`, exit code 1. Drizzle drops the unknown keys, so the values read back `undefined`.

- [ ] **Step 4: Add the columns to `src/db/schema.ts`** — insert directly after `recruiterSharing: integer("recruiter_sharing").default(0).notNull(),` (line 285):

```ts
  /**
   * When this account accepted the Terms of Service, and which version.
   *
   * Written once from Clerk's `user.created` webhook when Clerk's express-consent checkbox
   * recorded `legal_accepted_at`, otherwise by the guided-setup checkbox (`acceptTerms` in
   * src/actions/onboarding-wizard.ts). `termsVersion` is `TERMS_VERSION` from
   * src/lib/legal.ts at the moment of acceptance, so a later rewrite can tell who accepted
   * an older text.
   *
   * Preserved by every Settings data wipe (PRESERVED_SETTINGS_COLUMNS in user-data.ts):
   * deleting your contacts does not un-accept the terms you still use the product under.
   */
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  termsVersion: text("terms_version"),
  /**
   * Opt-in to deriving LinkedIn timeline events with the user's own AI key. Integer, not
   * boolean, per house convention. Defaults to 0: the backfill costs one model call per
   * qualifying conversation and used to run unasked (audit A6). The runner, the cron sweep
   * and the import card all read it — see src/lib/linkedin-timeline-backfill.ts.
   */
  timelineBackfillEnabled: integer("timeline_backfill_enabled").default(0).notNull(),
```

- [ ] **Step 5: Add the DDL in `src/db/index.ts`** (three places, all for existing and fresh databases)

In the `DDL` template, after `  recruiter_sharing integer NOT NULL DEFAULT 0,` (line 70), add:

```
  terms_accepted_at timestamptz,
  terms_version text,
  timeline_backfill_enabled integer NOT NULL DEFAULT 0,
```

In `migratePglite`, directly after the `ensureColumn(client, "user_settings", "recruiter_sharing", "integer NOT NULL DEFAULT 0")` call (lines 1977-1982), add:

```ts
  await ensureColumn(client, "user_settings", "terms_accepted_at", "timestamptz");
  await ensureColumn(client, "user_settings", "terms_version", "text");
  await ensureColumn(client, "user_settings", "timeline_backfill_enabled", "integer NOT NULL DEFAULT 0");
```

In the `alters` array, directly after `` `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS recruiter_sharing integer NOT NULL DEFAULT 0`, `` (line 2523), add:

```ts
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS terms_version text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS timeline_backfill_enabled integer NOT NULL DEFAULT 0`,
```

- [ ] **Step 6: Preserve them across a data wipe** — in `src/lib/user-data.ts`, inside `PRESERVED_SETTINGS_COLUMNS`, after `  lastActiveAt: true,` (line 474), add:

```ts
  termsAcceptedAt: true,
  termsVersion: true,
  timelineBackfillEnabled: true,
```

- [ ] **Step 7: Bump the schema version (computed, never guessed)**

```bash
HIGHEST=$(bash -c 'git fetch -q --all && for b in $(git for-each-ref --format="%(refname:short)" refs/remotes/origin); do git show "${b}:src/db/index.ts" 2>/dev/null | grep -oE "export const SCHEMA_VERSION = [0-9]+"; done | grep -oE "[0-9]+$" | sort -n | tail -1')
NEXT=$((HIGHEST + 1)); echo "Phase 1 schema version: $NEXT"
NEXT="$NEXT" perl -0pi -e 's#export const SCHEMA_VERSION = \d+;#//\n// $ENV{NEXT} = user_settings.terms_accepted_at, terms_version and timeline_backfill_enabled (launch\n// Phase 1: recorded Terms consent and the opt-in LinkedIn timeline backfill).\nexport const SCHEMA_VERSION = $ENV{NEXT};#' src/db/index.ts
grep -n "export const SCHEMA_VERSION" src/db/index.ts
```

Expected: the grep prints the new number, one higher than any remote branch's.

- [ ] **Step 8: Regenerate the DDL lock and set up the local database** (stop this worktree's dev server first)

```bash
npx tsx scripts/smoke-schema-ddl.ts --update
npx tsx scripts/smoke-schema-ddl.ts
npm run db:setup
```

Expected: `smoke-schema-ddl` exits 0 with no drift; `db:setup` prints the table list and the new version.

- [ ] **Step 9: Run the test and watch it pass**

Run: `npx tsx scripts/smoke-preserved-settings.ts && npx tsx scripts/smoke-purge.ts && npx tsx scripts/smoke-purge-selective.ts && npx tsx scripts/smoke-schema-upgrade.ts`
Expected: six `ok` lines then `All preserved-settings checks passed.`; the three existing suites still exit 0.

- [ ] **Step 10: Typecheck, lint, check the manifest**

Run: `npm run typecheck && npm run lint && npx tsx scripts/run-smoke.ts --check`
Expected: 0 type errors, 0 lint errors, manifest check clean.

- [ ] **Step 11: Commit**

```bash
git add src/db/schema.ts src/db/index.ts src/lib/user-data.ts scripts/schema-ddl.lock.json scripts/smoke-preserved-settings.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Add terms-consent and timeline opt-in columns to user_settings

One schema bump for launch Phase 1: terms_accepted_at, terms_version and
timeline_backfill_enabled (default 0). All three survive a Settings data
wipe and are erased with the account.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Widen the operator denylist and prove every encrypted column is on it (A3)

**Files:**
- Modify: `src/lib/admin-redaction.ts:13-39` (header comment + `NEVER_REVEALABLE`)
- Create: `scripts/smoke-admin-redaction.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST)

**Interfaces:**
- Consumes: nothing.
- Produces: `NEVER_REVEALABLE` additionally lists `user_settings.wispr_api_key_encrypted`, `event_provider_connections.{api_key,access_token,refresh_token}_encrypted`, `webhook_endpoints.secret_encrypted`, `note_batches.source_text`, `meeting_transcript_segments.text`, `capture_photos.inline_data`, `capture_photos.blob_url`. Task 14's operator-access copy ("never shows") quotes this list.

- [ ] **Step 1: Write the failing test** — create `scripts/smoke-admin-redaction.ts`:

```ts
/**
 * `NEVER_REVEALABLE` is the list of columns no operator-console query may select. The
 * privacy policy quotes it ("what the console never shows"), so it has to be complete:
 * every `*_encrypted` column in the schema, plus the private content with no support use.
 * A new encrypted column that nobody adds here would otherwise be one careless SELECT from
 * rendering a foreign user's credential.
 *
 * Pure: imports the Drizzle schema objects, touches no database.
 * Run: npx tsx scripts/smoke-admin-redaction.ts
 */
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema";
import {
  NEVER_REVEALABLE,
  RedactionViolationError,
  assertRevealable,
} from "../src/lib/admin-redaction";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const denied = new Set(NEVER_REVEALABLE);
const real = new Set<string>();
const encrypted: string[] = [];
for (const value of Object.values(schema)) {
  if (!is(value, PgTable)) continue;
  const table = getTableConfig(value);
  for (const column of table.columns) {
    const qualified = `${table.name}.${column.name}`;
    real.add(qualified);
    if (column.name.endsWith("_encrypted")) encrypted.push(qualified);
  }
}

console.log("Every encrypted column");
check("the schema has the encrypted columns this guard expects", encrypted.length >= 16, `${encrypted.length}`);
for (const qualified of encrypted) {
  check(`${qualified} is never revealable`, denied.has(qualified));
}

console.log("Private content with no support use");
for (const qualified of [
  "chat_messages.content",
  "note_batches.source_text",
  "meeting_transcript_segments.text",
  "capture_photos.inline_data",
  "capture_photos.blob_url",
  "user_settings.calendar_feed_token",
]) {
  check(`${qualified} is never revealable`, denied.has(qualified));
}

console.log("The list itself");
for (const qualified of NEVER_REVEALABLE) {
  check(`${qualified} names a real column`, real.has(qualified));
}

let threw = false;
try {
  assertRevealable(["contacts.notes", "note_batches.source_text"]);
} catch (err) {
  threw = err instanceof RedactionViolationError && /note_batches\.source_text/.test(err.message);
}
check("asking for a denied column throws and names it", threw);

let allowed = true;
try {
  assertRevealable(["contacts.notes", "interactions.raw_notes"]);
} catch {
  allowed = false;
}
check("ordinary contact and interaction columns are still allowed", allowed);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll redaction checks passed.");
process.exit(0);
```

Add to `MANIFEST` in `scripts/run-smoke.ts`, in the `// pure` block (after `"smoke-admin-gate": "pure",`):

```ts
  "smoke-admin-redaction": "pure",
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-admin-redaction.ts`
Expected: `FAIL user_settings.wispr_api_key_encrypted is never revealable`, the same for the three `event_provider_connections` columns, `webhook_endpoints.secret_encrypted`, `note_batches.source_text`, `meeting_transcript_segments.text` and both `capture_photos` columns; `9 check(s) failed.`; exit 1.

- [ ] **Step 3: Implement** — in `src/lib/admin-redaction.ts`, replace the two-class paragraph of the header comment (lines 13-23, from `Two classes live here` to `no support question is\n *   answered by reading it.`) with:

```ts
 * Three classes live here, for three different reasons:
 *
 *   Credentials. Encrypted API keys, OAuth tokens, webhook signing secrets and the calendar
 *   feed token are live bearer secrets. The admin console reads their *presence* as a
 *   boolean and nothing else; `decryptOrNull()` is never called from any admin module,
 *   including into a log line. `scripts/smoke-admin-redaction.ts` fails when a new
 *   `*_encrypted` column is added to the schema without being listed here.
 *
 *   Chat transcripts. `chat_messages.content` is the most private store in the app — an
 *   unstructured record of what the user asked about their own network, in their own
 *   words. Unlike a contact note it has no operational use: no support question is
 *   answered by reading it.
 *
 *   Raw capture material. The verbatim text of a capture (`note_batches.source_text`), a
 *   meeting's transcript, and the photos a capture was read from. The privacy policy tells
 *   users the console never shows them; the structured result (contacts, interactions) is
 *   what support reads.
```

and replace the `NEVER_REVEALABLE` array (lines 25-39) with:

```ts
export const NEVER_REVEALABLE: readonly string[] = [
  "chat_messages.content",
  "user_settings.gemini_api_key_encrypted",
  "user_settings.openai_api_key_encrypted",
  "user_settings.anthropic_api_key_encrypted",
  "user_settings.wispr_api_key_encrypted",
  "user_settings.apollo_api_key_encrypted",
  "user_settings.resend_api_key_encrypted",
  "user_settings.twilio_account_sid_encrypted",
  "user_settings.twilio_auth_token_encrypted",
  "user_settings.calendar_feed_token",
  "gmail_connections.access_token_encrypted",
  "gmail_connections.refresh_token_encrypted",
  "outlook_connections.access_token_encrypted",
  "outlook_connections.refresh_token_encrypted",
  "event_provider_connections.api_key_encrypted",
  "event_provider_connections.access_token_encrypted",
  "event_provider_connections.refresh_token_encrypted",
  "webhook_endpoints.secret_encrypted",
  "note_batches.source_text",
  "meeting_transcript_segments.text",
  "capture_photos.inline_data",
  "capture_photos.blob_url",
];
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-admin-redaction.ts && npx tsx scripts/smoke-admin-unmasked.ts`
Expected: `All redaction checks passed.`; the existing unmasked-inspector suite still exits 0 (no admin query selects the newly denied columns — verified: only `src/lib/admin-feedback.ts` mentions an `inline_data`, and that is the feedback-screenshot table, not `capture_photos`).

- [ ] **Step 5: Typecheck, lint** — `npm run typecheck && npm run lint` → 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/admin-redaction.ts scripts/smoke-admin-redaction.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Keep capture text, transcripts, photos and every encrypted column out of the admin console

NEVER_REVEALABLE gains the Wispr key, event-provider tokens, webhook secrets,
note_batches.source_text, meeting transcript text and capture photos. A pure
smoke fails when a new *_encrypted column is not listed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Log every admin contact view by id; require a reason for sign-in links (A3)

**Files:**
- Modify: `src/lib/admin-operations.ts:156-198` (add `recordContactView` after `recordAccountView`; `mintSignInLink` takes and records a reason)
- Modify: `src/actions/admin.ts:93-103` (`mintSignInLinkAction` input)
- Modify: `src/components/admin/sign-in-link-dialog.tsx:1-149` (reason field before minting)
- Modify: `src/app/(clerk)/(admin)/admin/users/[userId]/contacts/[contactId]/page.tsx:17,42-43`
- Modify: `src/db/schema.ts:2098-2111` (action-name list in the `adminAuditLog` doc comment)
- Test: `scripts/smoke-admin-unmasked.ts:30,220-235`, `scripts/smoke-admin-actions.ts` (after the account-view section)

**Interfaces:**
- Consumes: nothing.
- Produces: `recordContactView(adminUserId: string, targetUserId: string, contactId: string): Promise<void>` — one `admin_audit_log` row per call, `action: "contact.view"`, `resourceType: "contact"`, `resourceId: contactId`; never throws. `mintSignInLink(adminUserId, input: { targetUserId: string; reason: string })` — `requireReason(reason, 8)` first; its audit row (`action: "auth.sign_in_link"`, reason in the `reason` column) is written BEFORE the token is minted. `mintSignInLinkAction(input: { targetUserId: string; reason: string })`. The reason goes in `admin_audit_log.reason`, the column every other operator action uses and the audit page renders, not in `detail`.

- [ ] **Step 1: Write the failing tests**

In `scripts/smoke-admin-unmasked.ts`, change line 30 to:

```ts
import { recordAccountView, recordContactView } from "../src/lib/admin-operations";
```

and insert after `check("a view in a later session does", (await viewRows()).length === 2);` (line 232):

```ts
  /* ------------------------------------------------------------ the contact view row */

  // Not throttled, unlike account.view: the privacy policy says every contact record the
  // operator opens is recorded with its id, and the detail page has no mutations that
  // would re-render it on its own.
  await recordContactView(ADMIN, USER, contactId);
  await recordContactView(ADMIN, USER, contactId);
  const contactViews = (await viewRows()).filter((r) => r.action === "contact.view");
  check("every contact record opened is recorded", contactViews.length === 2, `${contactViews.length}`);
  check(
    "each row names the contact",
    contactViews.every((r) => r.resourceType === "contact" && r.resourceId === contactId)
  );
```

In `scripts/smoke-admin-actions.ts`, insert directly after the check `"a view outside the window writes a fresh row"` (end of the account-view section, before the `deletion` banner):

```ts
  /* ------------------------------------------------------------------ sign-in link */

  // The reason gate runs before any Clerk call, so this needs no Clerk test user.
  await refuses(
    "a sign-in link with no reason is refused",
    () => actions.mintSignInLink(ADMIN, { targetUserId: TARGET, reason: "" }),
    /at least 8 characters/
  );
  await refuses(
    "a sign-in link with a token reason is refused",
    () => actions.mintSignInLink(ADMIN, { targetUserId: TARGET, reason: "demo" }),
    /at least 8 characters/
  );
  check(
    "a refused sign-in link writes no audit row",
    (await auditRows("auth.sign_in_link")).length === 0
  );
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx scripts/smoke-admin-unmasked.ts; npx tsx scripts/smoke-admin-actions.ts`
Expected: the first throws `recordContactView is not a function`; the second fails `a sign-in link with no reason is refused failed: rejected with "…"` (it reaches Clerk instead of a reason gate). Both exit 1.

- [ ] **Step 3: Implement the lib** — in `src/lib/admin-operations.ts`, insert after the closing `}` of `recordAccountView` (line 156):

```ts
/**
 * Records that the operator opened one contact record, naming it.
 *
 * `account.view` says which accounts were looked at; this says which PEOPLE inside them.
 * The privacy policy promises that every contact record the operator opens is on the
 * record with its id, so unlike `recordAccountView` this is not throttled. It never throws,
 * for the same reason: the audit trail is not worth failing a render over.
 */
export async function recordContactView(
  adminUserId: string,
  targetUserId: string,
  contactId: string
): Promise<void> {
  try {
    await recordAdminAction({
      adminUserId,
      action: "contact.view",
      targetUserId,
      resourceType: "contact",
      resourceId: contactId,
    });
  } catch {
    // Never fail a render over the audit trail.
  }
}
```

Replace `mintSignInLink` (lines 177-198) with:

```ts
export async function mintSignInLink(
  adminUserId: string,
  input: { targetUserId: string; reason: string }
): Promise<{ url: string; expiresInSeconds: number }> {
  // A sign-in link is "act as this user". It needs a reason like every other operator
  // write, and the row is written BEFORE the token exists: a link with no log line must be
  // impossible, while a log line for a mint that then errored is merely noisy.
  const reason = requireReason(input.reason, 8);
  await requireAccount(input.targetUserId);

  await recordAdminAction({
    adminUserId,
    action: "auth.sign_in_link",
    targetUserId: input.targetUserId,
    detail: { expiresInSeconds: SIGN_IN_LINK_EXPIRES_SECONDS },
    reason,
  });

  const clerk = await clerkClient();
  const token = await clerk.signInTokens.createSignInToken({
    userId: input.targetUserId,
    expiresInSeconds: SIGN_IN_LINK_EXPIRES_SECONDS,
  });

  const url = `${getAppBaseUrl()}/sign-in?__clerk_ticket=${encodeURIComponent(token.token)}`;
  return { url, expiresInSeconds: SIGN_IN_LINK_EXPIRES_SECONDS };
}
```

- [ ] **Step 4: The action, the page, the doc comment**

`src/actions/admin.ts` lines 98-103 become:

```ts
export async function mintSignInLinkAction(input: {
  targetUserId: string;
  reason: string;
}): Promise<{ url: string; expiresInSeconds: number }> {
  const adminUserId = await requireAdminUserId();
  return ops.mintSignInLink(adminUserId, input);
}
```

In the contact page, line 17 becomes `import { recordAccountView, recordContactView } from "@/lib/admin-operations";` and lines 42-43 become:

```ts
  const detail = await getAdminContactDetail(decoded, contactId);
  if (!detail) notFound();
  // After notFound(), so a mistyped id is never logged as a view of a real person.
  await recordContactView(adminUserId, decoded, contactId);
```

In `src/db/schema.ts`, in the `adminAuditLog` doc comment's action list, add a line after ` *   export.download`:

```ts
 *   account.view · contact.view · auth.sign_in_link
```

- [ ] **Step 5: The dialog asks for a reason first** — in `src/components/admin/sign-in-link-dialog.tsx`, add `import { Textarea } from "@/components/ui/textarea";` after the `Input` import, and after the imports:

```ts
/** Mirrors `requireReason(input.reason, 8)` in `mintSignInLink`; the server enforces it regardless. */
const MIN_REASON = 8;
```

Replace the body of `SignInLinkButton` from `const [open, setOpen]` (line 41) through the end of the trigger `<Button>` (line 69) with:

```tsx
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState("");
  const [link, setLink] = useState<{ url: string; expiresInSeconds: number } | null>(null);
  const reasonOk = reason.trim().length >= MIN_REASON;

  const mint = () => {
    if (!reasonOk) return;
    setPending(true);
    setLink(null);
    mintSignInLinkAction({ targetUserId, reason: reason.trim() })
      .then((result) => setLink(result))
      .catch((err) => {
        toast.error(friendlyError(err, "Couldn’t create a sign-in link — try again?"));
      })
      .finally(() => setPending(false));
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setReason("");
          setLink(null);
          setOpen(true);
        }}
      >
        <KeyRound className="size-3.5" aria-hidden />
        Sign-in link
      </Button>
```

Replace the `<DialogDescription>` element, the `</DialogHeader>` after it, and the `{pending && …}` paragraph (lines 75-82) with:

```tsx
            <DialogDescription>
              {email ?? targetUserId} — no password, no emailed code. Minting one is recorded in
              the audit log with your reason.
            </DialogDescription>
          </DialogHeader>

          {!link && (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium">Reason</span>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                disabled={pending}
                placeholder="Which support request or demo is this for? Goes in the audit log."
                className="text-sm"
              />
            </label>
          )}

          {pending && <p className="text-sm text-muted-foreground">Minting a link…</p>}
```

Replace the `<DialogFooter>` block (lines 135-144) with:

```tsx
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            {link ? (
              <Button variant="outline" onClick={mint} disabled={pending}>
                New link
              </Button>
            ) : (
              <Button onClick={mint} disabled={pending || !reasonOk}>
                Create link
              </Button>
            )}
          </DialogFooter>
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx tsx scripts/smoke-admin-unmasked.ts && npx tsx scripts/smoke-admin-actions.ts && npx tsx scripts/smoke-admin-render.ts`
Expected: all exit 0, including the five new `ok` lines.

- [ ] **Step 7: Typecheck, lint, copy** — `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts` → clean. No browser check: a worktree with no Clerk keys runs demo mode, where `/admin` 404s by design; `smoke-admin-render` covers the page.

- [ ] **Step 8: Commit**

```bash
git add src/lib/admin-operations.ts src/actions/admin.ts src/components/admin/sign-in-link-dialog.tsx "src/app/(clerk)/(admin)/admin/users/[userId]/contacts/[contactId]/page.tsx" src/db/schema.ts scripts/smoke-admin-unmasked.ts scripts/smoke-admin-actions.ts
git commit -m "$(cat <<'EOF'
Record every admin contact view by id and require a reason for sign-in links

contact.view rows name the contact the operator opened; mintSignInLink now
takes a typed reason and writes its audit row before minting the token.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: One DB-free module for Google scopes per purpose, and the missing-scope copy (B5)

**Files:**
- Create: `src/lib/google-scopes.ts`, `scripts/smoke-google-scopes.ts`
- Modify: `src/lib/errors.ts` (`describeOAuthReason`, line ~323 at `33a213c`; add one import at the top)
- Modify: `scripts/smoke-friendly-error.ts:113-117` (OAuth reasons block), `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (all pure, client-safe): `GOOGLE_SCOPES` (`openid`, `email`, `contacts`, `gmailRead`, `gmailSend`, `calendar`); `type GooglePurpose = "contacts" | "recruiter_scan" | "send" | "calendar" | "event_mail"`; `GOOGLE_PURPOSES`; `isGooglePurpose(v: unknown): v is GooglePurpose`; `requiredScopeFor(p)`; `googleScopesFor(p): GoogleScope[]` (identity scopes + one); `parseScopes(s)`; `hasScope(s, scope)` (exact token match); `hasGmailReadScope(s)`; `grantCovers(p, s)`; `unionScopes(existing, granted): string` (`""` when both empty); `missingScopeMessage(p | null)`. `describeOAuthReason(reason, provider, purpose?)` maps `reason === "missing_scope"` to `missingScopeMessage`.

- [ ] **Step 1: Write the failing test** — create `scripts/smoke-google-scopes.ts`:

```ts
/**
 * Each Google entry point asks for its own scope (plus the two identity scopes), never all
 * six at once — the consent screen must not ask to "send email on your behalf" of someone
 * importing their address book (audit B5). Stored grants are read by exact token, and a
 * token response with no `scope` must never be recorded as every scope granted.
 *
 * Run: npx tsx scripts/smoke-google-scopes.ts
 */
import {
  GOOGLE_PURPOSES,
  GOOGLE_SCOPES,
  googleScopesFor,
  grantCovers,
  hasGmailReadScope,
  isGooglePurpose,
  missingScopeMessage,
  requiredScopeFor,
  unionScopes,
} from "../src/lib/google-scopes";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const identity = [GOOGLE_SCOPES.openid, GOOGLE_SCOPES.email];
const legacyAllSix = Object.values(GOOGLE_SCOPES).join(" ");

console.log("Scopes per purpose");
for (const purpose of GOOGLE_PURPOSES) {
  const scopes = googleScopesFor(purpose);
  check(`${purpose} asks for exactly identity + one scope`, scopes.length === 3 && identity.every((s) => scopes.includes(s)), scopes.join(" "));
  check(`${purpose}'s one scope is its required scope`, scopes[2] === requiredScopeFor(purpose));
}
check("contacts never asks to send or read mail", !googleScopesFor("contacts").some((s) => s === GOOGLE_SCOPES.gmailSend || s === GOOGLE_SCOPES.gmailRead));
check("send asks for gmail.send, not gmail.readonly", requiredScopeFor("send") === GOOGLE_SCOPES.gmailSend && !googleScopesFor("send").includes(GOOGLE_SCOPES.gmailRead));
check("the recruiter scan and confirmation emails both need gmail.readonly", requiredScopeFor("recruiter_scan") === GOOGLE_SCOPES.gmailRead && requiredScopeFor("event_mail") === GOOGLE_SCOPES.gmailRead);
check("calendar asks for calendar.readonly", requiredScopeFor("calendar") === GOOGLE_SCOPES.calendar);

console.log("Purposes from untrusted input");
check("a known purpose is accepted", isGooglePurpose("contacts"));
check("an unknown purpose is refused", !isGooglePurpose("everything") && !isGooglePurpose(undefined) && !isGooglePurpose(""));

console.log("Reading a stored grant");
check("gmail.readonly is found by exact token", hasGmailReadScope(`openid ${GOOGLE_SCOPES.gmailRead}`));
check("a longer look-alike is not a match", !hasGmailReadScope(`${GOOGLE_SCOPES.gmailRead}.extra`));
check("an empty or null grant covers nothing", !hasGmailReadScope("") && !hasGmailReadScope(null));
check("a legacy all-scopes grant still covers calendar", grantCovers("calendar", legacyAllSix));
check("a contacts-only grant does not cover the recruiter scan", !grantCovers("recruiter_scan", `openid ${GOOGLE_SCOPES.email} ${GOOGLE_SCOPES.contacts}`));

console.log("Merging grants");
check("no scope anywhere stores an empty grant", unionScopes(null, undefined) === "");
check("a new grant adds to the stored one, without duplicates", unionScopes("a b", "b c") === "a b c");
check("a refresh that omits scope keeps the stored grant", unionScopes("openid x", undefined) === "openid x");

console.log("Copy");
check("mail purposes say mail", missingScopeMessage("recruiter_scan") === "Google didn’t grant mail access — reconnect and allow it" && missingScopeMessage("event_mail") === missingScopeMessage("recruiter_scan"));
check("an unknown purpose falls back to the mail copy", missingScopeMessage(null) === missingScopeMessage("recruiter_scan"));
check("contacts says contacts", missingScopeMessage("contacts") === "Google didn’t grant contacts access — reconnect and allow it");
check("calendar says calendar", missingScopeMessage("calendar") === "Google didn’t grant calendar access — reconnect and allow it");
check("send says send", missingScopeMessage("send") === "Google didn’t grant permission to send — reconnect and allow it");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Google scope checks passed.");
process.exit(0);
```

In `scripts/smoke-friendly-error.ts`, after the line `check("no reason at all", …);` (line 117) add:

```ts
check("a missing Google scope is an error, not a cancel", describeOAuthReason("missing_scope", "Gmail", "recruiter_scan").cancelled === false);
check("…and names the access Google withheld", describeOAuthReason("missing_scope", "Google", "contacts").message === "Google didn’t grant contacts access — reconnect and allow it");
check("…with the mail copy when the purpose is unknown", describeOAuthReason("missing_scope", "Gmail", "bogus").message === "Google didn’t grant mail access — reconnect and allow it");
```

Add `"smoke-google-scopes": "pure",` to the `// pure` block of `MANIFEST`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx scripts/smoke-google-scopes.ts; npx tsx scripts/smoke-friendly-error.ts`
Expected: the first cannot resolve `../src/lib/google-scopes` (exit 1); the second prints `FAIL …names the access Google withheld` and the unknown-purpose line, exit 1.

- [ ] **Step 3: Implement** — create `src/lib/google-scopes.ts`:

```ts
/**
 * Which Google OAuth scopes each Orbit feature asks for, and how to read a stored grant.
 *
 * DB-free and client-safe on purpose: the OAuth start action, the callback, the panels that
 * choose between "Connect" and "Scan", the OAuth-error copy and the privacy policy's scope
 * table all read from here, so the policy cannot describe a scope the code does not request.
 *
 * Before this module the single Google grant asked for all six scopes whichever button was
 * pressed (audit B5). Each entry point now asks for its own scope plus the two identity
 * scopes, with `include_granted_scopes=true` so earlier grants carry forward.
 */
export const GOOGLE_SCOPES = {
  openid: "openid",
  email: "https://www.googleapis.com/auth/userinfo.email",
  contacts: "https://www.googleapis.com/auth/contacts.readonly",
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
} as const;

export type GoogleScope = (typeof GOOGLE_SCOPES)[keyof typeof GOOGLE_SCOPES];

export const GOOGLE_PURPOSES = ["contacts", "recruiter_scan", "send", "calendar", "event_mail"] as const;
export type GooglePurpose = (typeof GOOGLE_PURPOSES)[number];

const IDENTITY_SCOPES: readonly GoogleScope[] = [GOOGLE_SCOPES.openid, GOOGLE_SCOPES.email];

const PURPOSE_SCOPE: Record<GooglePurpose, GoogleScope> = {
  contacts: GOOGLE_SCOPES.contacts,
  recruiter_scan: GOOGLE_SCOPES.gmailRead,
  send: GOOGLE_SCOPES.gmailSend,
  calendar: GOOGLE_SCOPES.calendar,
  event_mail: GOOGLE_SCOPES.gmailRead,
};

export function isGooglePurpose(value: unknown): value is GooglePurpose {
  return typeof value === "string" && (GOOGLE_PURPOSES as readonly string[]).includes(value);
}

export function requiredScopeFor(purpose: GooglePurpose): GoogleScope {
  return PURPOSE_SCOPE[purpose];
}

export function googleScopesFor(purpose: GooglePurpose): GoogleScope[] {
  return [...IDENTITY_SCOPES, PURPOSE_SCOPE[purpose]];
}

/** Google returns granted scopes space-separated; so does `gmail_connections.scopes`. */
export function parseScopes(scopes: string | null | undefined): string[] {
  return (scopes ?? "").split(/\s+/).filter(Boolean);
}

/** Exact token match. The old `includes()` substring test would accept a look-alike. */
export function hasScope(scopes: string | null | undefined, scope: string): boolean {
  return parseScopes(scopes).includes(scope);
}

export function hasGmailReadScope(scopes: string | null | undefined): boolean {
  return hasScope(scopes, GOOGLE_SCOPES.gmailRead);
}

export function grantCovers(purpose: GooglePurpose, scopes: string | null | undefined): boolean {
  return hasScope(scopes, PURPOSE_SCOPE[purpose]);
}

/**
 * What to store after a token response: everything granted before plus everything Google
 * says it granted now. Never a hardcoded list — `""` when Google reported nothing, so an
 * absent `scope` can no longer be recorded as every scope granted.
 */
export function unionScopes(
  existing: string | null | undefined,
  granted: string | null | undefined
): string {
  return [...new Set([...parseScopes(existing), ...parseScopes(granted)])].join(" ");
}

/** Shown when Google's granular consent let the person untick the scope the feature needs. */
export function missingScopeMessage(purpose: GooglePurpose | null | undefined): string {
  switch (purpose) {
    case "contacts":
      return "Google didn’t grant contacts access — reconnect and allow it";
    case "calendar":
      return "Google didn’t grant calendar access — reconnect and allow it";
    case "send":
      return "Google didn’t grant permission to send — reconnect and allow it";
    default:
      return "Google didn’t grant mail access — reconnect and allow it";
  }
}
```

In `src/lib/errors.ts` add at the top of the file `import { isGooglePurpose, missingScopeMessage } from "@/lib/google-scopes";` and replace `describeOAuthReason` with:

```ts
export function describeOAuthReason(
  reason: string | null | undefined,
  provider: string,
  purpose?: string | null
): { cancelled: boolean; message: string } {
  if (reason === "access_denied") {
    return {
      cancelled: true,
      message: `${provider} connection cancelled — connect again whenever you’re ready`,
    };
  }
  if (reason === "missing_scope") {
    return {
      cancelled: false,
      message: missingScopeMessage(isGooglePurpose(purpose) ? purpose : null),
    };
  }
  return {
    cancelled: false,
    message: friendlyError(reason, `Couldn’t connect ${provider} — try again?`),
  };
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx tsx scripts/smoke-google-scopes.ts && npx tsx scripts/smoke-friendly-error.ts`
Expected: `All Google scope checks passed.` and `ALL PASS`.

- [ ] **Step 5: Typecheck, lint, copy** — `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/google-scopes.ts src/lib/errors.ts scripts/smoke-google-scopes.ts scripts/smoke-friendly-error.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Define Google scopes per purpose in one pure module

googleScopesFor(purpose) returns identity plus one scope; grants are read by
exact token; describeOAuthReason maps missing_scope to specific copy.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Request Google scopes per entry point with incremental consent (B5)

**Files:**
- Modify: `src/lib/gmail.ts:1-8` (imports), `:7` (delete `GOOGLE_CONTACTS_SCOPE`), `:61`, `:72`, `:74-105` (scope constants and helpers), `:176-191` (`buildGmailAuthUrl`), `:285`, `:307` (`upsertGmailConnection` scopes)
- Modify: `src/actions/gmail.ts:16-37` (imports, status type), `:58-65`, `:68-102` (`startGmailOAuth`), `:111-124` (`consumeGmailOAuthState`), `:170-172` (scan guard)
- Modify: `src/app/api/gmail/callback/route.ts:44-80`
- Modify: `src/components/recruiters/gmail-import-panel.tsx:111-120, 197-221`; `src/components/imports/google-contacts-import.tsx:67-92, 131-151`; `src/components/recruiters/compose-workspace.tsx:413, 437-443, 452`
- Create: `scripts/smoke-gmail-scope-storage.ts`; Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes (Task 4): `GOOGLE_SCOPES`, `GooglePurpose`, `googleScopesFor`, `hasScope`, `hasGmailReadScope`, `grantCovers`, `isGooglePurpose`, `unionScopes`.
- Produces: `buildGmailAuthUrl(state: string, purpose: GooglePurpose): string` (adds `include_granted_scopes=true`); `upsertGmailConnection` stores `unionScopes(existing?.scopes, tokens.scope)`; `export { hasGmailReadScope }` from `@/lib/gmail`; `startGmailOAuth(input: { purpose: GooglePurpose; returnTo?: string }): Promise<{ url: string }>`; `consumeGmailOAuthState(state) → { userId: string; returnTo: string | null; purpose: GooglePurpose | null }`; `GmailConnectionStatus` gains `canRead: boolean` and `canImportContacts: boolean`. The callback redirects with `reason=missing_scope&purpose=<p>` when the grant lacks the purpose's scope, and always sets `purpose=<p>` when known. Task 6 uses `startGmailOAuth` with `"calendar"` and `"event_mail"`.

- [ ] **Step 1: Read the Next guide** — `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` (the callback is a route handler).

- [ ] **Step 2: Write the failing test** — create `scripts/smoke-gmail-scope-storage.ts`:

```ts
/**
 * The OAuth URL each entry point builds, and what the connection row stores afterwards.
 * Before Phase 1 every URL asked for all six scopes, and a token response with no `scope`
 * was stored as all six — a grant the person never gave (audit B5).
 *
 * Run: npx tsx scripts/smoke-gmail-scope-storage.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

process.env.GOOGLE_CLIENT_ID ||= "smoke-client.apps.googleusercontent.com";
process.env.GOOGLE_REDIRECT_URI ||= "http://localhost:3001/api/gmail/callback";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { gmailConnections, userSettings } from "../src/db/schema";
import { buildGmailAuthUrl, hasGmailReadScope, upsertGmailConnection } from "../src/lib/gmail";
import { GOOGLE_SCOPES, hasScope } from "../src/lib/google-scopes";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-gmail-scope-user";
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function cleanup() {
  const db = await getDb();
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

const scopesOf = (url: string) => new URL(url).searchParams.get("scope")?.split(" ") ?? [];

run(async () => {
  console.log("Authorization URLs");
  const contactsUrl = buildGmailAuthUrl("state-contacts", "contacts");
  const contacts = scopesOf(contactsUrl);
  check("contacts asks for contacts.readonly", contacts.includes(GOOGLE_SCOPES.contacts));
  check("contacts never asks to read or send mail", !contacts.includes(GOOGLE_SCOPES.gmailRead) && !contacts.includes(GOOGLE_SCOPES.gmailSend), contacts.join(" "));
  check("incremental consent is on", new URL(contactsUrl).searchParams.get("include_granted_scopes") === "true");
  check("a refresh token is still requested", new URL(contactsUrl).searchParams.get("access_type") === "offline");
  const send = scopesOf(buildGmailAuthUrl("state-send", "send"));
  check("send asks for gmail.send without gmail.readonly", send.includes(GOOGLE_SCOPES.gmailSend) && !send.includes(GOOGLE_SCOPES.gmailRead));

  console.log("Stored grants");
  await cleanup();
  await ensureUserSettings(USER);
  const created = await upsertGmailConnection(USER, { access_token: "at1", refresh_token: "rt1", expires_in: 3600 }, "scope@example.test");
  check("a token response with no scope stores an empty grant", created?.scopes === "", JSON.stringify(created?.scopes));

  await upsertGmailConnection(USER, { access_token: "at2", scope: `openid ${GOOGLE_SCOPES.email} ${GOOGLE_SCOPES.contacts}`, expires_in: 3600 }, "scope@example.test");
  const widened = await upsertGmailConnection(USER, { access_token: "at3", scope: `openid ${GOOGLE_SCOPES.gmailRead}`, expires_in: 3600 }, "scope@example.test");
  check("a later grant adds to the stored scopes", hasScope(widened?.scopes, GOOGLE_SCOPES.contacts) && hasGmailReadScope(widened?.scopes), String(widened?.scopes));

  const refreshed = await upsertGmailConnection(USER, { access_token: "at4", expires_in: 3600 }, "scope@example.test");
  check("a refresh that omits scope keeps what was granted", refreshed?.scopes === widened?.scopes);

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Gmail scope-storage checks passed.");
});
```

Add `"smoke-gmail-scope-storage": "pglite",` to the `// pglite` block of `MANIFEST`.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx scripts/smoke-gmail-scope-storage.ts`
Expected: `FAIL contacts never asks to read or send mail`, `FAIL incremental consent is on`, `FAIL a token response with no scope stores an empty grant — "openid … gmail.readonly …"`; exit 1.

- [ ] **Step 4: `src/lib/gmail.ts`**

Add after line 5 (`import { ReauthRequiredError, … }`):

```ts
import {
  GOOGLE_SCOPES,
  googleScopesFor,
  hasScope,
  unionScopes,
  type GooglePurpose,
} from "@/lib/google-scopes";

export { hasGmailReadScope } from "@/lib/google-scopes";
```

Delete line 7 (`const GOOGLE_CONTACTS_SCOPE = …`). Line 61 becomes `const GMAIL_SEND_SCOPE = GOOGLE_SCOPES.gmailSend;` and line 72 becomes `const GOOGLE_CALENDAR_SCOPE = GOOGLE_SCOPES.calendar;` (keep both doc comments). Replace lines 74-105 (the `GMAIL_SCOPES` constant and the three `has…Scope` helpers) with:

```ts
// No module-wide scope list any more: each entry point asks for its own scope through
// `googleScopesFor(purpose)` in src/lib/google-scopes.ts (audit B5).

/** True once a connection has consented to the People API scope. */
export function hasContactsScope(scopes: string | null | undefined) {
  return hasScope(scopes, GOOGLE_SCOPES.contacts);
}

/** True once a connection has consented to sending. */
export function hasSendScope(scopes: string | null | undefined) {
  return hasScope(scopes, GMAIL_SEND_SCOPE);
}

/**
 * True once a connection has consented to calendar access. The scheduler must check this
 * before claiming a Google connection for calendar sync: a token without the scope works
 * for Gmail and Contacts but every Calendar API call returns 403.
 */
export function hasCalendarScope(scopes: string | null | undefined) {
  return hasScope(scopes, GOOGLE_CALENDAR_SCOPE);
}
```

Replace `buildGmailAuthUrl` (lines 176-191) with:

```ts
export function buildGmailAuthUrl(state: string, purpose: GooglePurpose) {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured");
  const redirectUri = getGoogleRedirectUri();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: googleScopesFor(purpose).join(" "),
    access_type: "offline",
    prompt: "consent",
    // Incremental authorization: the new token also covers what this person granted
    // earlier, so asking for calendar later does not drop contacts.
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
```

In `upsertGmailConnection`, line 285 becomes `        scopes: unionScopes(existing.scopes, tokens.scope),` and line 307 becomes `      scopes: unionScopes(null, tokens.scope),`.

- [ ] **Step 5: `src/actions/gmail.ts`**

Replace the `@/lib/gmail` import (lines 16-20) with:

```ts
import {
  buildGmailAuthUrl,
  getGmailOAuthConfigSummary,
  hasContactsScope,
  hasGmailReadScope,
  hasSendScope,
} from "@/lib/gmail";
import { isGooglePurpose, type GooglePurpose } from "@/lib/google-scopes";
```

In `GmailConnectionStatus`, after `canSend: boolean;` add:

```ts
  /** The grant covers gmail.readonly: the recruiter scan and confirmation emails can run. */
  canRead: boolean;
  /** The grant covers contacts.readonly. */
  canImportContacts: boolean;
```

In `getGmailConnectionStatus`, add `canRead: false, canImportContacts: false,` to the unconfigured return, and after the `canSend:` line of the configured return add:

```ts
    canRead: Boolean(conn && conn.status === "active" && hasGmailReadScope(conn.scopes)),
    canImportContacts: Boolean(conn && conn.status === "active" && hasContactsScope(conn.scopes)),
```

Replace `startGmailOAuth`'s signature and its last lines: the function becomes `export async function startGmailOAuth(input: { purpose: GooglePurpose; returnTo?: string }): Promise<{ url: string }> {`; as its first statement add `if (!isGooglePurpose(input.purpose)) throw new Error("Unknown Google connection purpose");`; replace `returnTo && returnTo.startsWith("/") ? returnTo : ""` with `input.returnTo && input.returnTo.startsWith("/") ? input.returnTo : ""`; replace the `state` line and the `return` with:

```ts
  // The purpose rides in the state so the callback can check that Google granted the one
  // scope this entry point asked for. encodeURIComponent keeps ':' out of returnTo.
  const state = `${userId}:${crypto.randomUUID()}:${encodeURIComponent(safeReturnTo)}:${input.purpose}`;
```

```ts
  return { url: buildGmailAuthUrl(state, input.purpose) };
```

Replace `consumeGmailOAuthState` (lines 111-124) with:

```ts
export async function consumeGmailOAuthState(
  state: string | null
): Promise<{ userId: string; returnTo: string | null; purpose: GooglePurpose | null }> {
  const jar = await cookies();
  const expected = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE);
  if (!state || !expected || state !== expected) {
    throw new Error("Invalid OAuth state");
  }
  const [userId, , encodedReturnTo, rawPurpose] = state.split(":");
  if (!userId) throw new Error("Invalid OAuth state");
  const returnTo = encodedReturnTo ? decodeURIComponent(encodedReturnTo) : "";
  return {
    userId,
    returnTo: returnTo.startsWith("/") ? returnTo : null,
    purpose: isGooglePurpose(rawPurpose) ? rawPurpose : null,
  };
}
```

In `startGmailRecruiterScan`, directly after the `if (!conn || conn.status !== "active") { … }` block add:

```ts
    if (!hasGmailReadScope(conn.scopes)) {
      throw new UserFacingError("Allow Orbit to read your mail first — reconnect Gmail and tick mail access");
    }
```

- [ ] **Step 6: The callback** — in `src/app/api/gmail/callback/route.ts` add `import { grantCovers } from "@/lib/google-scopes";`. In the `if (error)` branch, change `const { returnTo } = await consumeGmailOAuthState(state);` to `const { returnTo, purpose } = …` and add `if (purpose) redirectBase.searchParams.set("purpose", purpose);` after the `returnTo` line. In the `try`, replace from `const { userId: stateUserId, returnTo } = …` through `return NextResponse.redirect(redirectBase);` (the success return) with:

```ts
    const { userId: stateUserId, returnTo, purpose } = await consumeGmailOAuthState(state);
    if (returnTo) redirectBase = new URL(returnTo, url.origin);
    if (purpose) redirectBase.searchParams.set("purpose", purpose);

    let sessionUserId: string | null = null;
    if (isDemoMode()) {
      sessionUserId = "demo-user";
    } else {
      const session = await auth();
      sessionUserId = session.userId;
    }

    if (!sessionUserId || sessionUserId !== stateUserId) {
      throw new Error("Signed-in user does not match OAuth state");
    }

    const tokens = await exchangeCodeForTokens(code);
    const email = await fetchGoogleProfileEmail(tokens.access_token);
    const connection = await upsertGmailConnection(sessionUserId, tokens, email);

    // Google's granular consent lets a person untick a scope and still press Allow. The
    // connection is kept (whatever WAS granted still works), but the feature that asked
    // cannot run, so say so instead of "connected".
    if (purpose && !grantCovers(purpose, connection?.scopes)) {
      await recordErrorEvent({
        source: ERROR_SOURCES.oauthGmailCallback,
        kind: "missing_scope",
        message: purpose,
      });
      redirectBase.searchParams.set("gmail", "error");
      redirectBase.searchParams.set("google", "error");
      redirectBase.searchParams.set("reason", "missing_scope");
      return NextResponse.redirect(redirectBase);
    }

    redirectBase.searchParams.set("gmail", "connected");
    redirectBase.searchParams.set("google", "connected");
    return NextResponse.redirect(redirectBase);
```

- [ ] **Step 7: The three entry points**

`src/components/recruiters/gmail-import-panel.tsx`: line 111 becomes `const oauth = describeOAuthReason(params.get("reason"), "Gmail", params.get("purpose"));`; after `params.delete("reason");` (line 120) add `params.delete("purpose");`. Replace the description ternary (lines 198-200) with:

```tsx
            {connection.connected && connection.canRead
              ? `Connected as ${connection.emailAddress}. Orbit searches your whole mailbox for recruiter threads and writes a private summary of each one.`
              : connection.connected
                ? `Connected as ${connection.emailAddress}, without permission to read mail. Allow mail access to scan for recruiters.`
                : "Search your whole mailbox for recruiters, the companies they hired for, and a summary of every conversation."}
```

Change the condition `{!connection.connected ? (` (line 204) to `{!connection.connected || !connection.canRead ? (`, the call to `await startGmailOAuth({ purpose: "recruiter_scan", returnTo });`, and the label `Connect Gmail` to `{connection.connected ? "Allow mail access" : "Connect Gmail"}`.

`src/components/imports/google-contacts-import.tsx`: both `describeOAuthReason(params.get("reason"), "Google")` calls gain a third argument `params.get("purpose")`; after each `params.delete("reason");` add `params.delete("purpose");`. After `const busy = …` add:

```ts
  // The status knows the stored grant; the preview result can narrow it further.
  const contactsGranted = contactsScopeGranted && (status?.canImportContacts ?? true);
```

and replace `contactsScopeGranted` with `contactsGranted` on lines 132 and 137 (the two render uses). The start call (line 143) becomes `await startGmailOAuth({ purpose: "contacts", returnTo });`.

`src/components/recruiters/compose-workspace.tsx`: lines 413 and 452 become `const { url } = await startGmailOAuth({ purpose: "send", returnTo: "/recruiters/compose" });`. In `ReconnectBanner`, replace the two paragraphs (lines 437-443) with:

```tsx
          <p className="font-medium text-foreground">Allow Gmail to send</p>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            You can draft now. Sending from your own address needs Google’s permission to
            send as you, which Orbit asks for only when you want it.
          </p>
```

and its doc comment (line 429) becomes `/** Shown when the Gmail grant does not include gmail.send. */`.

- [ ] **Step 8: Run the tests and watch them pass**

Run: `npx tsx scripts/smoke-gmail-scope-storage.ts && npx tsx scripts/smoke-instrumentation.ts && npx tsx scripts/smoke-google-scopes.ts`
Expected: `All Gmail scope-storage checks passed.`; the other two exit 0.

- [ ] **Step 9: Typecheck, lint, copy** — `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts` → clean. `typecheck` catches any caller still passing a bare string to `startGmailOAuth`.

- [ ] **Step 10: Browser check** — start `orbit-web`. On `/recruiters` the Gmail card renders; on `/imports` the Google Contacts card renders. With no Google env the cards show the not-configured copy — that is the expected demo state. Then load `http://localhost:3001/imports?google=error&reason=missing_scope&purpose=contacts`: the toast reads "Google didn’t grant contacts access — reconnect and allow it" and the URL is cleaned.

- [ ] **Step 11: Commit**

```bash
git add src/lib/gmail.ts src/actions/gmail.ts src/app/api/gmail/callback/route.ts src/components/recruiters/gmail-import-panel.tsx src/components/imports/google-contacts-import.tsx src/components/recruiters/compose-workspace.tsx scripts/smoke-gmail-scope-storage.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Ask Google for one scope per entry point with incremental consent

startGmailOAuth takes a purpose; the callback stores the union of granted
scopes (never a hardcoded list) and reports missing_scope when Google's
granular consent withheld the one the feature needs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Calendar and confirmation-email entry points on the Events card (B5)

Before this task calendar sync had no entry point of its own: `calendar.readonly` rode along on the six-scope grant. With per-purpose scopes something must ask for it, and the confirmation-email scan must ask for `gmail.readonly` instead of assuming it.

**Files:**
- Modify: `src/lib/events/connections.ts:319-331` (`findGmailGrant` returns scopes)
- Modify: `src/actions/events.ts:72-78` (imports), `:699-715` (`getEventConnections`), `:811-841` (`setGmailEventScan`)
- Modify: `src/app/(clerk)/(app)/(main)/events/page.tsx:17-25` (`ConnectionsSection`)
- Modify: `src/components/events/event-connections-card.tsx:21-36, 68-105, 219-226, 266-296`
- Test: `scripts/smoke-gmail-scope-storage.ts` (new section)

**Interfaces:**
- Consumes (Task 4/5): `hasGmailReadScope`, `hasScope`, `GOOGLE_SCOPES`, `type GooglePurpose`, `startGmailOAuth({ purpose, returnTo })`, `describeOAuthReason(reason, provider, purpose)`.
- Produces: `findGmailGrant(userId): Promise<{ emailAddress: string | null; scopes: string | null } | null>`; `getEventConnections()` adds `googleMailGranted: boolean`, `googleCalendarGranted: boolean`; `setGmailEventScan(enabled)` returns `{ ok: boolean; error?: string; needsMailScope?: boolean }`; `EventConnectionsCard` props add `googleMailGranted`, `googleCalendarGranted`.

- [ ] **Step 1: Write the failing test** — in `scripts/smoke-gmail-scope-storage.ts` add `import { findGmailGrant } from "../src/lib/events/connections";` and insert before the final `await cleanup();`:

```ts
  console.log("Event connections read the grant");
  const grant = await findGmailGrant(USER);
  check("findGmailGrant returns the stored scopes", grant !== null && hasGmailReadScope(grant.scopes), JSON.stringify(grant));
```

- [ ] **Step 2: Run it and watch it fail** — `npx tsx scripts/smoke-gmail-scope-storage.ts` → `FAIL findGmailGrant returns the stored scopes — {"emailAddress":"scope@example.test"}`, exit 1.

- [ ] **Step 3: `findGmailGrant`** — replace it (lines 319-331) with:

```ts
export async function findGmailGrant(
  userId: string
): Promise<{ emailAddress: string | null; scopes: string | null } | null> {
  const db = await getDb();
  const rows = rowsOf<{ email_address: string | null; scopes: string | null }>(
    await db.execute(sql`
      SELECT email_address, scopes FROM gmail_connections
       WHERE user_id = ${userId} AND status = 'active'
       LIMIT 1
    `)
  );
  return rows[0] ? { emailAddress: rows[0].email_address, scopes: rows[0].scopes } : null;
}
```

- [ ] **Step 4: The actions** — in `src/actions/events.ts` add `import { GOOGLE_SCOPES, hasGmailReadScope, hasScope } from "@/lib/google-scopes";`. Replace `getEventConnections` (lines 699-715) with:

```ts
export async function getEventConnections(): Promise<{
  connections: EventConnectionSummary[];
  eventbriteConfigured: boolean;
  /** Any active Google connection exists. */
  googleConnected: boolean;
  /** That connection may read mail — the confirmation-email scan can run. */
  googleMailGranted: boolean;
  /** That connection may read the calendar — meetings sync. */
  googleCalendarGranted: boolean;
}> {
  const userId = await requireUserForSurface(SURFACE);
  const [connections, grant] = await Promise.all([
    listEventConnections(userId),
    findGmailGrant(userId),
  ]);
  return {
    connections,
    eventbriteConfigured: eventbriteOAuthConfig().configured,
    googleConnected: grant !== null,
    googleMailGranted: hasGmailReadScope(grant?.scopes),
    googleCalendarGranted: hasScope(grant?.scopes, GOOGLE_SCOPES.calendar),
  };
}
```

In `setGmailEventScan`, change the return type to `Promise<{ ok: boolean; error?: string; needsMailScope?: boolean }>` and replace the `if (!connection) { … }` block with:

```ts
  // This switch never widens a grant silently: without gmail.readonly it tells the card to
  // send the person through Google's consent screen for exactly that scope.
  if (!connection || !hasGmailReadScope(connection.scopes)) {
    return {
      ok: false,
      needsMailScope: true,
      error: "Allow mail access first — Orbit asks Google for it next",
    };
  }
```

- [ ] **Step 5: The page** — `ConnectionsSection` becomes:

```tsx
async function ConnectionsSection() {
  const { connections, eventbriteConfigured, googleConnected, googleMailGranted, googleCalendarGranted } =
    await getEventConnections();
  return (
    <EventConnectionsCard
      connections={connections}
      eventbriteConfigured={eventbriteConfigured}
      googleConnected={googleConnected}
      googleMailGranted={googleMailGranted}
      googleCalendarGranted={googleCalendarGranted}
    />
  );
}
```

- [ ] **Step 6: The card** — in `src/components/events/event-connections-card.tsx`: change line 21 to `import { useEffect, useState, useTransition } from "react";`; add `import { startGmailOAuth } from "@/actions/gmail";`, `import type { GooglePurpose } from "@/lib/google-scopes";`, `import { TOAST_COPY } from "@/lib/toast-copy";`, and change the errors import to `import { describeOAuthReason, friendlyError } from "@/lib/errors";`. Add the two props to the destructuring and the props type (`googleMailGranted: boolean; googleCalendarGranted: boolean;`). Replace `function setGmailScan` (lines 91-105) with:

```tsx
  function connectGoogle(purpose: GooglePurpose) {
    start(async () => {
      try {
        const { url } = await startGmailOAuth({ purpose, returnTo: "/events" });
        window.location.href = url;
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.connectFailed));
      }
    });
  }

  function setGmailScan(enabled: boolean) {
    if (enabled && !googleMailGranted) {
      connectGoogle("event_mail");
      return;
    }
    start(async () => {
      const result = await setGmailEventScan(enabled);
      if (!result.ok) {
        toast.error(result.error ?? "Couldn’t change that — try again?");
        return;
      }
      toast.success(
        enabled
          ? "Scanning confirmation emails — events will appear over the next few syncs"
          : "Stopped scanning your email"
      );
      router.refresh();
    });
  }

  // Google sends the person back here after consent. Toast once, then clean the URL. No
  // server action is fired from this effect, so the replaceState cannot drop one.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const google = params.get("google");
    if (!google) return;
    const purpose = params.get("purpose");
    if (google === "connected") {
      toast.success(
        purpose === "calendar"
          ? "Google Calendar connected — meetings appear after the next sync"
          : purpose === "event_mail"
            ? "Mail access allowed — press Turn on to scan confirmation emails"
            : "Google connected"
      );
    } else if (google === "error") {
      const oauth = describeOAuthReason(params.get("reason"), "Google", purpose);
      if (oauth.cancelled) toast.message(oauth.message);
      else toast.error(oauth.message);
    }
    for (const key of ["google", "gmail", "reason", "purpose"]) params.delete(key);
    const next = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${next ? `?${next}` : ""}${window.location.hash}`
    );
  }, []);
```

In the `summary` expression (lines 219-226) replace both `googleConnected` with `googleCalendarGranted`. Directly before `{feedRow("luma_ics")}` (line 265) add the calendar row:

```tsx
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">Google Calendar</p>
            <p className="text-xs text-muted-foreground">
              {googleCalendarGranted
                ? "Connected — meetings with people in your network land on their timelines."
                : "Read-only access to your calendar, so meetings with people in your network land on their timelines."}
            </p>
          </div>
          {googleCalendarGranted ? null : (
            <Button variant="outline" size="sm" onClick={() => connectGoogle("calendar")} disabled={pending}>
              <CalendarPlus className="size-4" aria-hidden />
              Connect
            </Button>
          )}
        </div>
```

In the confirmation-emails row replace the `googleConnected ? "Find events…" : "Connect Google first…"` branch (lines 277-279) with:

```tsx
                : googleMailGranted
                  ? "Find events from “you’re registered” emails. Orbit opens only mail from those platforms, stores no message content, and never sends any of it to AI."
                  : "Find events from “you’re registered” emails. Turning this on asks Google for permission to read your mail — Orbit opens only mail from those platforms and stores no message content."}
```

and on the Turn on button (line 292) change `disabled={pending || !googleConnected}` to `disabled={pending}`. If `googleConnected` is now unused in the card, remove it from the destructuring (keep it in the props type and the page so the prop contract is unchanged) — `npm run lint` will flag it otherwise.

- [ ] **Step 7: Run tests, typecheck, lint, copy**

Run: `npx tsx scripts/smoke-gmail-scope-storage.ts && npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts`
Expected: all clean.

- [ ] **Step 8: Browser check** — `orbit-web`, open `/events`, expand "Where your events come from": a "Google Calendar" row with Connect shows; pressing Connect with no Google env toasts "Couldn’t connect your account — try again?". Load `/events?google=connected&purpose=calendar`: the calendar toast shows and the URL is cleaned.

- [ ] **Step 9: Commit**

```bash
git add src/lib/events/connections.ts src/actions/events.ts "src/app/(clerk)/(app)/(main)/events/page.tsx" src/components/events/event-connections-card.tsx scripts/smoke-gmail-scope-storage.ts
git commit -m "$(cat <<'EOF'
Give calendar sync and confirmation emails their own Google consent

The Events card asks for calendar.readonly or gmail.readonly when the person
turns each on, instead of relying on a six-scope grant.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Record Terms acceptance — from Clerk's consent, or a guided-setup checkbox (B9a)

**Files:**
- Create: `src/lib/legal.ts`, `scripts/smoke-terms-acceptance.ts`
- Modify: `src/lib/user-settings.ts` (add `recordTermsAcceptance` after `setUserIdentity`, which ends at line ~179)
- Modify: `src/app/api/webhooks/clerk/route.ts:1-15` (imports), `:82-98` (`user.created`)
- Modify: `src/actions/onboarding-wizard.ts:1-9, 35-43` (+ `acceptTerms`)
- Modify: `src/app/(clerk)/(app)/onboarding/wizard/page.tsx:18-20`; `src/components/onboarding/wizard/setup-wizard-lazy.tsx`; `src/components/onboarding/wizard/setup-wizard.tsx:3-16, 72-86, 151-153, 229-246`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes (Task 1): `userSettings.termsAcceptedAt`, `userSettings.termsVersion`.
- Produces: `src/lib/legal.ts` (DB-free): `TERMS_VERSION = "2026-09-15"`, `LEGAL_LAST_UPDATED = "September 15, 2026"`, `termsAcceptanceFromClerk(legalAcceptedAt: number | null | undefined): { acceptedAt: Date; version: string } | null`, `needsTermsAcceptance(termsVersion: string | null | undefined): boolean`. `recordTermsAcceptance(userId, acceptance: { acceptedAt: Date; version: string }, opts?: { onlyIfUnset?: boolean }): Promise<boolean>` in `src/lib/user-settings.ts`. Server action `acceptTerms(): Promise<{ ok: true }>`; `getWizardStatus()` adds `termsAccepted: boolean`. Task 14/15 import `LEGAL_LAST_UPDATED` (and add Google constants to `legal.ts`). If the pages ship on a later day, set both date constants to that day in the same commit as Task 14.

- [ ] **Step 1: Write the failing test** — create `scripts/smoke-terms-acceptance.ts`:

```ts
/**
 * Terms acceptance is recorded once, with the version accepted. Clerk's express-consent
 * checkbox reports `legal_accepted_at` (unix ms, sometimes seconds elsewhere in Clerk's
 * API) on user.created; accounts without it accept in guided setup.
 *
 * Run: npx tsx scripts/smoke-terms-acceptance.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { TERMS_VERSION, needsTermsAcceptance, termsAcceptanceFromClerk } from "../src/lib/legal";
import { ensureUserSettings, recordTermsAcceptance } from "../src/lib/user-settings";

const USER = "smoke-terms-acceptance-user";
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

run(async () => {
  console.log("Reading Clerk's consent");
  const ms = Date.UTC(2026, 8, 15, 12, 0, 0);
  check("no consent recorded means nothing to store", termsAcceptanceFromClerk(null) === null && termsAcceptanceFromClerk(undefined) === null && termsAcceptanceFromClerk(0) === null);
  check("milliseconds are read as milliseconds", termsAcceptanceFromClerk(ms)?.acceptedAt.getTime() === ms);
  check("seconds are read as seconds", termsAcceptanceFromClerk(ms / 1000)?.acceptedAt.getTime() === ms);
  check("the current version is attached", termsAcceptanceFromClerk(ms)?.version === TERMS_VERSION);

  console.log("Which accounts must accept");
  check("never accepted", needsTermsAcceptance(null));
  check("accepted an older text", needsTermsAcceptance("2020-01-01"));
  check("accepted this text", !needsTermsAcceptance(TERMS_VERSION));

  console.log("Writing it");
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
  const first = new Date(ms);
  check("the first write-once record lands", await recordTermsAcceptance(USER, { acceptedAt: first, version: TERMS_VERSION }, { onlyIfUnset: true }));
  const later = new Date(ms + 86_400_000);
  check("a second write-once record is refused", !(await recordTermsAcceptance(USER, { acceptedAt: later, version: "later" }, { onlyIfUnset: true })));
  let row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("…and the first acceptance stands", row?.termsAcceptedAt?.getTime() === first.getTime() && row?.termsVersion === TERMS_VERSION);
  await recordTermsAcceptance(USER, { acceptedAt: later, version: "2027-01-01" });
  row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("an explicit acceptance of a new version overwrites", row?.termsVersion === "2027-01-01" && row?.termsAcceptedAt?.getTime() === later.getTime());

  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll terms-acceptance checks passed.");
});
```

Add `"smoke-terms-acceptance": "pglite",` to the `// pglite` block of `MANIFEST`.

- [ ] **Step 2: Run it and watch it fail** — `npx tsx scripts/smoke-terms-acceptance.ts` → cannot resolve `../src/lib/legal`; exit 1.

- [ ] **Step 3: Create `src/lib/legal.ts`**

```ts
/**
 * The legal pages' shared facts, DB-free so the marketing pages, onboarding and smoke tests
 * can all import them.
 *
 * TERMS_VERSION is what `user_settings.terms_version` records at acceptance. Change it (and
 * LEGAL_LAST_UPDATED) in the same commit as any material change to /terms or /privacy.
 */
export const TERMS_VERSION = "2026-09-15";
export const LEGAL_LAST_UPDATED = "September 15, 2026";

/**
 * Clerk's `legal_accepted_at` from a user.created payload, as an acceptance to record.
 * Clerk timestamps are unix epochs whose unit varies by field; anything below 1e12 is read
 * as seconds (the same rule as `epochToDate` in user-settings.ts).
 */
export function termsAcceptanceFromClerk(
  legalAcceptedAt: number | null | undefined
): { acceptedAt: Date; version: string } | null {
  if (typeof legalAcceptedAt !== "number" || !Number.isFinite(legalAcceptedAt) || legalAcceptedAt <= 0) {
    return null;
  }
  const ms = legalAcceptedAt < 1e12 ? legalAcceptedAt * 1000 : legalAcceptedAt;
  return { acceptedAt: new Date(ms), version: TERMS_VERSION };
}

/** True when this account has not accepted the current Terms. */
export function needsTermsAcceptance(termsVersion: string | null | undefined): boolean {
  return termsVersion !== TERMS_VERSION;
}
```

- [ ] **Step 4: `recordTermsAcceptance`** — add to `src/lib/user-settings.ts` after `setUserIdentity` (`and`, `eq`, `isNull` are already imported on line 2):

```ts
/**
 * Stores a Terms acceptance. `onlyIfUnset` is for the Clerk webhook: user.created can be
 * retried, and a retry must never re-stamp an old acceptance with a newer version. The
 * guided-setup checkbox writes unconditionally — it IS an acceptance of the current text.
 * Returns whether a row was written.
 */
export async function recordTermsAcceptance(
  userId: string,
  acceptance: { acceptedAt: Date; version: string },
  opts: { onlyIfUnset?: boolean } = {}
): Promise<boolean> {
  const db = await getDb();
  const where = opts.onlyIfUnset
    ? and(eq(userSettings.userId, userId), isNull(userSettings.termsAcceptedAt))
    : eq(userSettings.userId, userId);
  const rows = await db
    .update(userSettings)
    .set({
      termsAcceptedAt: acceptance.acceptedAt,
      termsVersion: acceptance.version,
      updatedAt: new Date(),
    })
    .where(where)
    .returning();
  return rows.length > 0;
}
```

- [ ] **Step 5: The Clerk webhook** — in `src/app/api/webhooks/clerk/route.ts` add `recordTermsAcceptance` to the `@/lib/user-settings` import and `import { termsAcceptanceFromClerk } from "@/lib/legal";`. Inside the `user.created || user.updated` branch, directly after the `await setUserIdentity(…);` call, add:

```ts
        // Clerk's "require express legal consent" checkbox stamps legal_accepted_at at
        // sign-up. Recorded from user.created only, write-once, so a later user.updated
        // can never attribute today's TERMS_VERSION to an old acceptance.
        if (evt.type === "user.created") {
          const acceptance = termsAcceptanceFromClerk(evt.data.legal_accepted_at);
          if (acceptance) {
            await recordTermsAcceptance(userId, acceptance, { onlyIfUnset: true });
          }
        }
```

- [ ] **Step 6: The guided-setup checkbox**

`src/actions/onboarding-wizard.ts`: add `import { needsTermsAcceptance, TERMS_VERSION } from "@/lib/legal";` and change the `@/lib/user-settings` import to `import { ensureUserSettings, recordTermsAcceptance } from "@/lib/user-settings";`. In `getWizardStatus`'s return add `termsAccepted: !needsTermsAcceptance(settings.termsVersion),`. Append:

```ts
/** The fallback consent for accounts Clerk did not record one for. */
export async function acceptTerms() {
  const userId = await requireUserId();
  await ensureUserSettings(userId);
  await recordTermsAcceptance(userId, { acceptedAt: new Date(), version: TERMS_VERSION });
  return { ok: true as const };
}
```

Wizard page: render `<SetupWizardLazy initialStepId={status.step} hasApiKey={settings.hasApiKey} termsAccepted={status.termsAccepted} />`. In `setup-wizard-lazy.tsx` add `termsAccepted = true` to the destructured props, `termsAccepted?: boolean;` to the type, and pass `termsAccepted={termsAccepted}` to `<SetupWizard>`.

`setup-wizard.tsx`: add `import Link from "next/link";`, `import { Checkbox } from "@/components/ui/checkbox";`, and `acceptTerms` to the `@/actions/onboarding-wizard` import. Add `termsAccepted = true,` / `termsAccepted?: boolean;` to `SetupWizard`'s props, and after the `apiKey` state: `const [termsOk, setTermsOk] = useState(termsAccepted);`. Replace the intro render (lines 151-153) with:

```tsx
              {step === "intro" && (
                <IntroStep
                  needsTerms={!termsOk}
                  onNext={async () => {
                    if (!termsOk) {
                      await acceptTerms();
                      setTermsOk(true);
                    }
                    goTo("add-people");
                  }}
                />
              )}
```

Replace `IntroStep` (lines 229-246) with:

```tsx
function IntroStep({
  needsTerms,
  onNext,
}: {
  needsTerms: boolean;
  onNext: () => Promise<void>;
}) {
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Two minutes, three ways to start — pick whichever fits what you
        already have on hand: a LinkedIn export, some raw notes, or just a
        name you want to remember.
      </p>
      {needsTerms ? (
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 p-3 text-sm text-muted-foreground">
          <Checkbox
            checked={agreed}
            onCheckedChange={(checked) => setAgreed(checked === true)}
            aria-label="I agree to the Terms of Service and Privacy Policy"
            className="mt-0.5"
          />
          <span>
            I agree to Orbit’s{" "}
            <Link href="/terms" target="_blank" className="text-primary underline-offset-4 hover:underline">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/privacy" target="_blank" className="text-primary underline-offset-4 hover:underline">
              Privacy Policy
            </Link>
            .
          </span>
        </label>
      ) : null}
      <Button
        type="button"
        className="bg-primary text-primary-foreground hover:bg-primary/90"
        disabled={(needsTerms && !agreed) || saving}
        onClick={() => {
          setSaving(true);
          onNext().finally(() => setSaving(false));
        }}
      >
        Let&apos;s go
      </Button>
    </div>
  );
}
```

- [ ] **Step 7: Run, typecheck, lint** — `npx tsx scripts/smoke-terms-acceptance.ts && npm run typecheck && npm run lint` → `All terms-acceptance checks passed.`, clean.

- [ ] **Step 8: Browser check** — `orbit-web`, open `/onboarding/wizard` (demo user has no acceptance): the checkbox shows and "Let’s go" is disabled; tick it (a real click), press Let’s go → the next step shows. Reload `/onboarding/wizard` after resetting the wizard from Settings: no checkbox.

- [ ] **Step 9: Commit**

```bash
git add src/lib/legal.ts src/lib/user-settings.ts src/app/api/webhooks/clerk/route.ts src/actions/onboarding-wizard.ts "src/app/(clerk)/(app)/onboarding/wizard/page.tsx" src/components/onboarding/wizard/setup-wizard-lazy.tsx src/components/onboarding/wizard/setup-wizard.tsx scripts/smoke-terms-acceptance.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Record when each account accepted the Terms and which version

user.created stores Clerk's legal_accepted_at write-once; accounts without
it tick a checkbox in guided setup.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: "Delete my account" in Settings → Data and privacy (B9b)

There is no self-serve subscription cancellation anywhere in the app (no Stripe portal), so deleting an account must cancel an active Stripe subscription itself, or the person keeps being billed with no account to cancel from.

**Files:**
- Create: `src/lib/account-deletion-shared.ts`, `src/lib/account-deletion.ts`, `src/actions/account.ts`, `src/components/settings/delete-account-dialog.tsx`, `scripts/smoke-delete-my-account.ts`
- Modify: `src/components/settings/data-settings.tsx:5,11,83` (new row after "Delete data"); `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `purgeUserData(userId, { keepSettings: false })` (`src/lib/user-data.ts:518`), `isAdminUser` (`src/lib/admin.ts:45`), `isClerkConfigured`/`isDemoMode` (`src/lib/demo-account.ts`), `getStripe` (`src/lib/stripe.ts:83`), `UserFacingError`/`asActionResult`/`ActionResult` (`src/lib/errors.ts`).
- Produces: `ACCOUNT_DELETE_CONFIRMATION = "delete my account"`; `type AccountDeletionDeps = { cancelSubscriptions(stripeCustomerId: string): Promise<void>; deleteLogin(userId: string): Promise<void> }`; `defaultAccountDeletionDeps`; `deleteOwnAccount(userId: string, deps?: AccountDeletionDeps): Promise<void>` (idempotent; the Clerk `user.deleted` webhook's later purge is a no-op); server action `deleteMyAccount(input: { confirmation: string }): Promise<ActionResult<{ redirectTo: "/" }>>`. Phase 2 builds its resumable purge on `deleteOwnAccount`.

- [ ] **Step 1: Write the failing test** — create `scripts/smoke-delete-my-account.ts`:

```ts
/**
 * Self-service account deletion: cancel billing, purge everything (settings row included),
 * then remove the sign-in. Order matters — if billing cannot be stopped, nothing is deleted;
 * if the sign-in cannot be removed, the data is still gone and the person is told. Running
 * it twice (or the Clerk webhook purging afterwards) must be harmless.
 *
 * Run: npx tsx scripts/smoke-delete-my-account.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-delete-my-account";
process.env.ADMIN_USER_IDS = "smoke-delete-my-account-operator";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, userSettings } from "../src/db/schema";
import { deleteOwnAccount, type AccountDeletionDeps } from "../src/lib/account-deletion";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-delete-my-account-user";
const PAYER = "smoke-delete-my-account-payer";
const OPERATOR = "smoke-delete-my-account-operator";
const IDS = [USER, PAYER, OPERATOR];

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function fakeDeps(opts: { cancelThrows?: boolean; loginThrows?: boolean } = {}) {
  const calls = { cancelled: [] as string[], deleted: [] as string[] };
  const deps: AccountDeletionDeps = {
    async cancelSubscriptions(customerId) {
      if (opts.cancelThrows) throw new Error("stripe down");
      calls.cancelled.push(customerId);
    },
    async deleteLogin(userId) {
      if (opts.loginThrows) throw new Error("clerk down");
      calls.deleted.push(userId);
    },
  };
  return { deps, calls };
}

async function seed(userId: string, stripeCustomerId: string | null) {
  const db = await getDb();
  await db.insert(userSettings).values({ userId, email: `${userId}@example.test`, stripeCustomerId });
  await db.insert(contacts).values({ userId, fullName: "Ada Lovelace" });
}

async function counts(userId: string) {
  const db = await getDb();
  return {
    settings: (await db.query.userSettings.findMany({ where: eq(userSettings.userId, userId) })).length,
    contacts: (await db.query.contacts.findMany({ where: eq(contacts.userId, userId) })).length,
  };
}

async function refusal(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
}

run(async () => {
  const db = await getDb();
  for (const id of IDS) {
    await db.delete(contacts).where(eq(contacts.userId, id));
  }
  await db.delete(userSettings).where(inArray(userSettings.userId, IDS));

  console.log("An account with no subscription");
  await seed(USER, null);
  const plain = fakeDeps();
  await deleteOwnAccount(USER, plain.deps);
  const after = await counts(USER);
  check("its settings row is gone", after.settings === 0);
  check("its contacts are gone", after.contacts === 0);
  check("its sign-in was removed", plain.calls.deleted.join() === USER);
  check("no billing call was made", plain.calls.cancelled.length === 0);

  console.log("Running it again, as the Clerk webhook will");
  await purgeUserData(USER, { keepSettings: false });
  const again = fakeDeps();
  check("a second deletion does not throw", (await refusal(() => deleteOwnAccount(USER, again.deps))) === null);

  console.log("A paying account whose billing cannot be stopped");
  await seed(PAYER, "cus_smoke_payer");
  const stuck = fakeDeps({ cancelThrows: true });
  const stuckErr = await refusal(() => deleteOwnAccount(PAYER, stuck.deps));
  check("it refuses with copy that says nothing was deleted", stuckErr?.name === "UserFacingError" && /nothing was deleted/.test(stuckErr.message), stuckErr?.message);
  check("and nothing was deleted", (await counts(PAYER)).contacts === 1);

  console.log("A paying account");
  const paid = fakeDeps();
  await deleteOwnAccount(PAYER, paid.deps);
  check("its subscription was cancelled first", paid.calls.cancelled.join() === "cus_smoke_payer");
  check("then everything was deleted", (await counts(PAYER)).settings === 0);

  console.log("When the sign-in cannot be removed");
  await seed(USER, null);
  const loginDown = fakeDeps({ loginThrows: true });
  const loginErr = await refusal(() => deleteOwnAccount(USER, loginDown.deps));
  check("the data is still deleted", (await counts(USER)).contacts === 0);
  check("and the person is told the sign-in remains", loginErr?.name === "UserFacingError" && /sign-in couldn’t be removed/.test(loginErr.message), loginErr?.message);

  console.log("An operator account");
  await seed(OPERATOR, null);
  const opErr = await refusal(() => deleteOwnAccount(OPERATOR, fakeDeps().deps));
  check("is refused", opErr?.name === "UserFacingError" && /Operator accounts/.test(opErr.message), opErr?.message);
  check("and keeps its data", (await counts(OPERATOR)).contacts === 1);

  for (const id of IDS) {
    await db.delete(contacts).where(eq(contacts.userId, id));
  }
  await db.delete(userSettings).where(inArray(userSettings.userId, IDS));
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll account-deletion checks passed.");
});
```

Add `"smoke-delete-my-account": "pglite",` to the `// pglite` block of `MANIFEST`.

- [ ] **Step 2: Run it and watch it fail** — `npx tsx scripts/smoke-delete-my-account.ts` → cannot resolve `../src/lib/account-deletion`; exit 1.

- [ ] **Step 3: The lib**

`src/lib/account-deletion-shared.ts`:

```ts
/** What a person types to confirm deleting their own account. DB-free: the dialog imports it. */
export const ACCOUNT_DELETE_CONFIRMATION = "delete my account";
```

`src/lib/account-deletion.ts`:

```ts
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { isAdminUser } from "@/lib/admin";
import { isClerkConfigured, isDemoMode } from "@/lib/demo-account";
import { UserFacingError } from "@/lib/errors";
import { purgeUserData } from "@/lib/user-data";

/**
 * Deleting your own account, from Settings.
 *
 * Three steps, in an order chosen for which half-finished state is safe to be stuck in:
 *   1. Cancel any live Stripe subscription. Orbit has no self-serve cancellation, so a
 *      deleted account that kept its subscription would be billed with no way back in.
 *      If this fails, nothing else happens.
 *   2. `purgeUserData(userId, { keepSettings: false })` — every table, the settings row,
 *      keys and tokens included. Idempotent.
 *   3. Delete the Clerk user. Clerk then fires `user.deleted`, whose purge finds nothing.
 *
 * The external calls are injected so `scripts/smoke-delete-my-account.ts` can exercise every
 * ordering without Stripe or Clerk.
 */
export type AccountDeletionDeps = {
  cancelSubscriptions: (stripeCustomerId: string) => Promise<void>;
  deleteLogin: (userId: string) => Promise<void>;
};

/** Stripe statuses that can still charge. */
const CHARGEABLE = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);

export const defaultAccountDeletionDeps: AccountDeletionDeps = {
  async cancelSubscriptions(stripeCustomerId) {
    if (!process.env.STRIPE_SECRET_KEY) return;
    const { getStripe } = await import("@/lib/stripe");
    const stripe = getStripe();
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 100,
    });
    for (const subscription of subscriptions.data) {
      if (CHARGEABLE.has(subscription.status)) {
        await stripe.subscriptions.cancel(subscription.id);
      }
    }
  },
  async deleteLogin(userId) {
    if (!isClerkConfigured() || isDemoMode()) return;
    const { clerkClient } = await import("@clerk/nextjs/server");
    const clerk = await clerkClient();
    try {
      await clerk.users.deleteUser(userId);
    } catch (err) {
      // Already gone (a retry after a timeout that did succeed) is success.
      if ((err as { status?: number }).status === 404) return;
      throw err;
    }
  },
};

export async function deleteOwnAccount(
  userId: string,
  deps: AccountDeletionDeps = defaultAccountDeletionDeps
): Promise<void> {
  if (isAdminUser(userId)) {
    throw new UserFacingError(
      "Operator accounts can’t be deleted from Settings — remove the id from ADMIN_USER_IDS first"
    );
  }

  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { stripeCustomerId: true },
  });

  if (settings?.stripeCustomerId) {
    try {
      await deps.cancelSubscriptions(settings.stripeCustomerId);
    } catch (err) {
      console.error("[account-deletion] cancelling the subscription threw", err);
      throw new UserFacingError(
        "Couldn’t cancel your Orbit Pro subscription, so nothing was deleted — try again, or contact us"
      );
    }
  }

  await purgeUserData(userId, { keepSettings: false });

  try {
    await deps.deleteLogin(userId);
  } catch (err) {
    console.error("[account-deletion] removing the sign-in threw", err);
    throw new UserFacingError(
      "Your data is deleted, but your sign-in couldn’t be removed — try again, or contact us"
    );
  }
}
```

- [ ] **Step 4: Run the test and watch it pass** — `npx tsx scripts/smoke-delete-my-account.ts` → `All account-deletion checks passed.`

- [ ] **Step 5: Read the Next guide** — `node_modules/next/dist/docs/01-app/02-guides/server-actions.md` and `01-app/03-api-reference/01-directives/use-server.md`.

- [ ] **Step 6: The action** — create `src/actions/account.ts`:

```ts
"use server";

import { requireUserId } from "@/lib/auth";
import { deleteOwnAccount } from "@/lib/account-deletion";
import { ACCOUNT_DELETE_CONFIRMATION } from "@/lib/account-deletion-shared";
import { asActionResult, UserFacingError, type ActionResult } from "@/lib/errors";

/**
 * Deletes the signed-in account. The typed confirmation is re-checked here because an
 * action is reachable by direct POST, not only through the dialog.
 */
export async function deleteMyAccount(input: {
  confirmation: string;
}): Promise<ActionResult<{ redirectTo: "/" }>> {
  return asActionResult(async () => {
    const userId = await requireUserId();
    if (input.confirmation.trim().toLowerCase() !== ACCOUNT_DELETE_CONFIRMATION) {
      throw new UserFacingError(`Type ${ACCOUNT_DELETE_CONFIRMATION} to confirm`);
    }
    await deleteOwnAccount(userId);
    return { redirectTo: "/" as const };
  });
}
```

- [ ] **Step 7: The dialog** — create `src/components/settings/delete-account-dialog.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { deleteMyAccount } from "@/actions/account";
import { ACCOUNT_DELETE_CONFIRMATION } from "@/lib/account-deletion-shared";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

/**
 * The irreversible one. Same shape as DeleteDataDialog: an unconditional typed
 * confirmation, because there is no undo and no export step in between.
 */
export function DeleteAccountDialog({ trigger }: { trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, start] = useTransition();
  const confirmed = typed.trim().toLowerCase() === ACCOUNT_DELETE_CONFIRMATION;

  const submit = () => {
    if (!confirmed || pending) return;
    start(async () => {
      try {
        const res = await deleteMyAccount({ confirmation: typed });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        // A full navigation, not router.push: the session this page was rendered for no
        // longer exists, and nothing cached for it should survive.
        window.location.assign(res.value.redirectTo);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t delete your account — try again?"));
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTyped("");
      }}
    >
      <span onClick={() => setOpen(true)}>{trigger}</span>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-destructive">Delete your account</DialogTitle>
          <DialogDescription>
            This erases every contact, note, import and setting, including saved API keys and
            connected accounts, cancels an active Orbit Pro subscription, and removes your
            sign-in. It can’t be undone — export first if you want a copy.
          </DialogDescription>
        </DialogHeader>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium">Type {ACCOUNT_DELETE_CONFIRMATION} to confirm</span>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={ACCOUNT_DELETE_CONFIRMATION}
            className="h-8 text-sm"
            autoComplete="off"
          />
        </label>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={submit} disabled={!confirmed || pending}>
            {pending ? "Deleting…" : "Delete my account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 8: The Settings row** — in `src/components/settings/data-settings.tsx`, change line 5 to `import { Download, Trash2, UserX } from "lucide-react";`, add after line 11 `import { DeleteAccountDialog } from "@/components/settings/delete-account-dialog";`, and after the "Delete data" `</SettingsRow>` (line 83) add:

```tsx
      <SettingsRow
        title="Delete account"
        description="Erase everything and remove your sign-in. Cancels an active Orbit Pro subscription."
      >
        <DeleteAccountDialog
          trigger={
            <Button
              variant="outline"
              size="sm"
              className="w-fit text-destructive hover:border-destructive/40 hover:bg-destructive/10"
            >
              <UserX className="size-3.5" />
              Delete account…
            </Button>
          }
        />
      </SettingsRow>
```

- [ ] **Step 9: Typecheck, lint, copy** — `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts` → clean.

- [ ] **Step 10: Browser check** — `orbit-web` (demo mode: `deleteLogin` is skipped, so this is safe). Settings → Data and privacy → "Delete account…": the button is disabled until you type `delete my account` with real keystrokes; confirm → the browser lands on `/`. Open `/dashboard` again: the demo workspace re-seeds (expected on localhost), proving the purge ran.

- [ ] **Step 11: Commit**

```bash
git add src/lib/account-deletion-shared.ts src/lib/account-deletion.ts src/actions/account.ts src/components/settings/delete-account-dialog.tsx src/components/settings/data-settings.tsx scripts/smoke-delete-my-account.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Let people delete their own account from Settings

Cancels a live Stripe subscription first, purges every table including the
settings row, then deletes the Clerk user. Idempotent with the user.deleted
webhook; refuses operator accounts.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Timeline cost model, and the extractor skips the model for one-message threads (A6)

**Files:**
- Create: `src/lib/timeline-cost.ts`, `scripts/smoke-timeline-cost.ts`
- Modify: `src/lib/linkedin-timeline-events.ts:1-8` (imports), `:92-120` (skip rule + fast tier)
- Test: `scripts/smoke-linkedin-timeline-backfill.ts:23` (value import), new section, `main()`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `estimateCostMicros`, `formatCostMicros` (`src/lib/ai-pricing.ts:68, 97`); `completeJson`'s `speed?: "fast"` (`src/lib/ai.ts:584`, routes to `FAST_MODELS[provider]`).
- Produces (DB-free): `TIMELINE_MIN_MESSAGES_FOR_AI = 2`, `TIMELINE_DAILY_CONTACT_CAP = 300`, `TIMELINE_EST_INPUT_TOKENS = 2_500`, `TIMELINE_EST_OUTPUT_TOKENS = 150`, `usableTimelineMessageCount(contents: readonly (string | null | undefined)[]): number`, `qualifiesForTimelineAi(usable: number): boolean`, `estimateTimelineCostMicros(conversations: number, model: string): number | null`, `timelineEstimateLabel(conversations: number, model: string): string`, `utcDayKey(now: Date): string`, `type TimelineBackfillStatus`. Tasks 10, 11 and 14 consume these.

- [ ] **Step 1: Write the failing tests**

Create `scripts/smoke-timeline-cost.ts`:

```ts
/**
 * The numbers the LinkedIn import card shows before anyone opts in to timeline events, and
 * the rule that keeps one-message threads away from the model (audit A6).
 * Run: npx tsx scripts/smoke-timeline-cost.ts
 */
import {
  TIMELINE_DAILY_CONTACT_CAP,
  estimateTimelineCostMicros,
  qualifiesForTimelineAi,
  timelineEstimateLabel,
  usableTimelineMessageCount,
  utcDayKey,
} from "../src/lib/timeline-cost";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

check("blank and missing messages do not count", usableTimelineMessageCount(["hi", "  ", "", null, undefined, "yo"]) === 2);
check("one message does not reach the model", !qualifiesForTimelineAi(1));
check("two messages do", qualifiesForTimelineAi(2));
check("the daily cap is 300 conversations", TIMELINE_DAILY_CONTACT_CAP === 300);

// 2,500 in + 150 out per conversation. flash-lite: 250 + 60 = 310 micro-dollars each.
check("10,000 conversations on Gemini flash-lite is $3.10", estimateTimelineCostMicros(10_000, "gemini-3.1-flash-lite") === 3_100_000, String(estimateTimelineCostMicros(10_000, "gemini-3.1-flash-lite")));
// gpt-4o-mini: 375 + 90 = 465 each.
check("10,000 on gpt-4o-mini is $4.65", estimateTimelineCostMicros(10_000, "gpt-4o-mini") === 4_650_000);
check("an unpriced model estimates nothing rather than guessing", estimateTimelineCostMicros(5, "mystery-model") === null);
check("no conversations cost nothing", estimateTimelineCostMicros(0, "gpt-4o-mini") === 0);

check("the label for a big export", timelineEstimateLabel(10_000, "gemini-3.1-flash-lite") === "Derive timeline events for 10,000 conversations — about $3.10 on your key", timelineEstimateLabel(10_000, "gemini-3.1-flash-lite"));
check("the label for a tiny one", timelineEstimateLabel(1, "gemini-3.1-flash-lite") === "Derive timeline events for 1 conversation — under a cent on your key");
check("the label for an unpriced model", timelineEstimateLabel(3, "mystery-model") === "Derive timeline events for 3 conversations — cost depends on your model");
check("the label with nothing waiting", timelineEstimateLabel(0, "gpt-4o-mini") === "Derive timeline events from your LinkedIn conversations");

check("the UTC day key ignores local time", utcDayKey(new Date("2026-09-15T23:59:59.000Z")) === "2026-09-15");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll timeline cost checks passed.");
process.exit(0);
```

Add `"smoke-timeline-cost": "pure",` to the `// pure` block of `MANIFEST`.

In `scripts/smoke-linkedin-timeline-backfill.ts`: change line 23 from `import type { extractLinkedInTimelineEvents } …` to `import { extractLinkedInTimelineEvents } from "../src/lib/linkedin-timeline-events";`; add `usageEvents` to the schema import; add `const SINGLE_USER = "smoke-li-timeline-single-user";` after `REAL_USER`; add `SINGLE_USER` to the `cleanup()` user list; add before `async function cleanup()`:

```ts
/**
 * Section 5: a one-message thread never reaches the model. It still gets its rule-based
 * reach-out (which is what keeps the pending predicate making progress), but no AI call —
 * most threads in a LinkedIn export are a single unanswered message.
 */
async function testSingleMessageSkipsModel() {
  await reset(SINGLE_USER);
  const events = await extractLinkedInTimelineEvents(SINGLE_USER, "single-scope", [
    { from: "them", content: "Want to grab coffee next Tuesday?", parsedDate: new Date(Date.UTC(2024, 5, 3)) },
  ]);
  check(
    "a one-message thread yields only the rule-based reach-out",
    events.length === 1 && events[0].interactionType === "reach_out",
    JSON.stringify(events.map((e) => e.interactionType))
  );
  const db = await getDb();
  const calls = await db.query.usageEvents.findMany({ where: eq(usageEvents.userId, SINGLE_USER) });
  check("and makes no AI call", calls.length === 0, `${calls.length} usage rows`);
}
```

and in `main()`, before `await cleanup();`:

```ts
  console.log("\n-- one-message threads skip the model --");
  await testSingleMessageSkipsModel();
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx scripts/smoke-timeline-cost.ts; npx tsx scripts/smoke-linkedin-timeline-backfill.ts`
Expected: the first cannot resolve `../src/lib/timeline-cost`; the second fails `a one-message thread yields only the rule-based reach-out — ["reach_out","in_person"]` (with no key the heuristic fallback turns "coffee" into an in-person event; with a local env key the model is called and the next check fails instead). Both exit 1.

- [ ] **Step 3: Create `src/lib/timeline-cost.ts`**

```ts
import { estimateCostMicros, formatCostMicros } from "@/lib/ai-pricing";

/**
 * What deriving LinkedIn timeline events costs, and the rules that bound it (audit A6).
 * DB-free: the import card, the server action, the runner and the privacy policy all read
 * these, so the number a person is shown is the number the code enforces.
 */

/** Threads with fewer usable messages get only the rule-based reach-out, never a model call. */
export const TIMELINE_MIN_MESSAGES_FOR_AI = 2;

/** Model-bound conversations processed per user per UTC day. */
export const TIMELINE_DAILY_CONTACT_CAP = 300;

/**
 * Per-conversation estimate for the fast tier: the extractor sends at most 14,000 characters
 * of transcript (about 3,500 tokens) plus a short system prompt, and most threads are far
 * shorter; it returns at most eight short events. Deliberately a round, slightly generous
 * figure — this is shown before consent, so it should not undersell.
 */
export const TIMELINE_EST_INPUT_TOKENS = 2_500;
export const TIMELINE_EST_OUTPUT_TOKENS = 150;

export type TimelineBackfillStatus = {
  enabled: boolean;
  /** Conversations still waiting that would each cost one model call. */
  pendingConversations: number;
  hasKey: boolean;
  /** The fast-tier model the runner will use for this user's provider. */
  model: string;
  label: string;
  dailyCap: number;
};

export function usableTimelineMessageCount(
  contents: readonly (string | null | undefined)[]
): number {
  return contents.filter((c) => (c ?? "").trim().length > 0).length;
}

export function qualifiesForTimelineAi(usable: number): boolean {
  return usable >= TIMELINE_MIN_MESSAGES_FOR_AI;
}

/** Micro-dollars, or null when the model is not in the price table (never a guess). */
export function estimateTimelineCostMicros(conversations: number, model: string): number | null {
  if (conversations <= 0) return 0;
  const perCall = estimateCostMicros({
    model,
    inputTokens: TIMELINE_EST_INPUT_TOKENS,
    outputTokens: TIMELINE_EST_OUTPUT_TOKENS,
  });
  return perCall === null ? null : perCall * conversations;
}

export function timelineEstimateLabel(conversations: number, model: string): string {
  if (conversations <= 0) return "Derive timeline events from your LinkedIn conversations";
  const count = conversations.toLocaleString("en-US");
  const noun = conversations === 1 ? "conversation" : "conversations";
  const micros = estimateTimelineCostMicros(conversations, model);
  if (micros === null) return `Derive timeline events for ${count} ${noun} — cost depends on your model`;
  if (micros < 10_000) return `Derive timeline events for ${count} ${noun} — under a cent on your key`;
  return `Derive timeline events for ${count} ${noun} — about ${formatCostMicros(micros)} on your key`;
}

/** The daily cap's bucket key: a UTC calendar day, so the cap resets at 00:00 UTC. */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: The extractor** — in `src/lib/linkedin-timeline-events.ts` add `import { qualifiesForTimelineAi } from "@/lib/timeline-cost";` after line 8. Directly after the reach-out `if (first) { … }` block (ends line 92) insert:

```ts
  // A single message is a reach-out and nothing else — there is no reply in which a
  // meeting could have been proposed. Skipping the model here is most threads in an
  // export, at no loss (audit A6).
  if (!qualifiesForTimelineAi(usable.length)) return events;
```

Replace the `completeJson` options' first two lines (lines 105-107, `operation` is mis-indented today) with:

```ts
    const content = await completeJson(userId, {
      operation: "import.linkedin.timeline",
      // The fast tier (FAST_MODELS in ai.ts), not the user's chat model: extraction of at
      // most eight short events does not need it, and this runs once per conversation.
      speed: "fast",
      temperature: 0.1,
```

- [ ] **Step 5: Run them and watch them pass** — `npx tsx scripts/smoke-timeline-cost.ts && npx tsx scripts/smoke-linkedin-timeline-backfill.ts` → `All timeline cost checks passed.` and `Timeline backfill checks passed.` (sections 1–4 are unaffected: sections 1 and 4 use two-message threads; section 2's one-message thread goes through the stub).

- [ ] **Step 6: Typecheck, lint** — `npm run typecheck && npm run lint` → clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/timeline-cost.ts src/lib/linkedin-timeline-events.ts scripts/smoke-timeline-cost.ts scripts/smoke-linkedin-timeline-backfill.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Route timeline extraction to the fast tier and skip one-message threads

Adds the pure cost model the import card will show (2,500 in / 150 out per
conversation) and the constants the daily cap will use.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The backfill runs only for opted-in accounts, capped per UTC day (A6)

**Files:**
- Modify: `src/lib/rate-limit.ts:1-3` (import), `:120-121` (new `RATE_LIMITS` entry)
- Modify: `src/lib/linkedin-timeline-backfill.ts:64-71` (imports), `:151-173` (counts and sweep), `:184-301` (runner)
- Test: `scripts/smoke-linkedin-timeline-backfill.ts` (`reset`, two new sections, `cleanup`, `main`)

**Interfaces:**
- Consumes (Task 1): `userSettings.timelineBackfillEnabled`. (Task 9): `TIMELINE_DAILY_CONTACT_CAP`, `TIMELINE_MIN_MESSAGES_FOR_AI`, `qualifiesForTimelineAi`, `usableTimelineMessageCount`, `utcDayKey`. `consumeBucket`, `isRateLimitedError` (`src/lib/rate-limit.ts:128, 29`).
- Produces: `RATE_LIMITS.timelineBackfillDaily = { limit: TIMELINE_DAILY_CONTACT_CAP, windowSec: 86_400 }`; `runLinkedInTimelineBackfill(userId, extract?, budgetMs?, opts?: { dailyCap?: number; now?: Date })` returns `{ contactsProcessed; eventsCreated; remaining; capped: boolean; enabled: boolean }`; `pendingTimelineAiContactCount(userId): Promise<number>` (pending contacts with ≥ 2 usable messages); `usersWithPendingTimelineEvents` lists opted-in users only. The route (`src/app/api/linkedin/timeline-events/backfill/route.ts`) is unchanged: it re-kicks only when `contactsProcessed > 0`, so a capped or disabled run ends the chain.

- [ ] **Step 1: Write the failing tests** — in `scripts/smoke-linkedin-timeline-backfill.ts`:

Add `rateLimitBuckets` to the schema import (the drizzle import already has `like`). Add `TIME_BUDGET_MS` and `pendingTimelineAiContactCount` to the `../src/lib/linkedin-timeline-backfill` import. Add constants `const OFF_USER = "smoke-li-timeline-off-user";` and `const CAP_USER = "smoke-li-timeline-cap-user";`, and add both to `cleanup()`'s user list; at the end of `cleanup()` add:

```ts
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "timelineBackfill:smoke-li-timeline-%"));
```

In `reset()`, after `await ensureUserSettings(userId);` add (every existing section tests an opted-in account):

```ts
  await db.update(userSettings).set({ timelineBackfillEnabled: 1 }).where(eq(userSettings.userId, userId));
```

Add these sections before `async function cleanup()`:

```ts
/** Section 6: nothing runs, and nothing is kicked, for an account that has not opted in. */
async function testOptIn() {
  await reset(OFF_USER);
  const db = await getDb();
  await db.update(userSettings).set({ timelineBackfillEnabled: 0 }).where(eq(userSettings.userId, OFF_USER));
  seen.length = 0;
  await seedThread(OFF_USER, "Opted Out", [
    { body: "Hi, loved the panel.", sentAt: new Date(Date.UTC(2024, 7, 1)) },
    { body: "Coffee next week?", sentAt: new Date(Date.UTC(2024, 7, 2)) },
  ]);

  const off = await runLinkedInTimelineBackfill(OFF_USER, stubExtract);
  check(
    "an account that has not opted in derives nothing",
    off.enabled === false && off.contactsProcessed === 0 && off.remaining === 1 && seen.length === 0,
    JSON.stringify(off)
  );
  check("the cron sweep does not kick it", !(await usersWithPendingTimelineEvents(50)).includes(OFF_USER));

  await db.update(userSettings).set({ timelineBackfillEnabled: 1 }).where(eq(userSettings.userId, OFF_USER));
  const on = await runLinkedInTimelineBackfill(OFF_USER, stubExtract);
  check("opting in lets the same work run", on.enabled && on.contactsProcessed === 1 && on.remaining === 0, JSON.stringify(on));
}

/**
 * Section 7: the daily cap. Only model-bound threads (two or more usable messages) count
 * against it; a one-message thread is free and never blocked by it.
 */
async function testDailyCap() {
  await reset(CAP_USER);
  seen.length = 0;
  const day = (n: number) => new Date(Date.UTC(2024, 8, n));
  const modelBound: string[] = [];
  for (const name of ["Cap One", "Cap Two", "Cap Three"]) {
    modelBound.push(
      await seedThread(CAP_USER, name, [
        { body: `Hi ${name}, great to meet you.`, sentAt: day(1) },
        { body: "Coffee next week?", sentAt: day(2) },
      ])
    );
  }
  const single = await seedThread(CAP_USER, "Cap Single", [{ body: "Thanks for connecting.", sentAt: day(3) }]);

  check("three threads would call the model", (await pendingTimelineAiContactCount(CAP_USER)) === 3);

  const derived = async () => new Set((await eventRows(CAP_USER)).map((r) => r.contactId));
  const monday = new Date(Date.UTC(2026, 8, 14, 9));

  const first = await runLinkedInTimelineBackfill(CAP_USER, stubExtract, TIME_BUDGET_MS, { dailyCap: 2, now: monday });
  const afterFirst = await derived();
  check(
    "the cap stops the pass after two model-bound threads",
    first.capped && modelBound.filter((id) => afterFirst.has(id)).length === 2,
    JSON.stringify(first)
  );
  check("one model-bound thread is left for tomorrow", (await pendingTimelineAiContactCount(CAP_USER)) === 1);

  const later = await runLinkedInTimelineBackfill(CAP_USER, stubExtract, TIME_BUDGET_MS, {
    dailyCap: 2,
    now: new Date(monday.getTime() + 3_600_000),
  });
  const afterLater = await derived();
  check(
    "a second pass the same UTC day adds no model-bound thread",
    later.capped && modelBound.filter((id) => afterLater.has(id)).length === 2,
    JSON.stringify(later)
  );

  const tuesday = new Date(Date.UTC(2026, 8, 15, 0, 5));
  const next = await runLinkedInTimelineBackfill(CAP_USER, stubExtract, TIME_BUDGET_MS, { dailyCap: 2, now: tuesday });
  check("the next UTC day picks up the rest", !next.capped && next.remaining === 0, JSON.stringify(next));
  check("the one-message thread was processed without counting against the cap", (await derived()).has(single));
}
```

In `main()`, before `await cleanup();`:

```ts
  console.log("\n-- opt-in --");
  await testOptIn();

  console.log("\n-- the daily cap --");
  await testDailyCap();
```

- [ ] **Step 2: Run it and watch it fail** — `npx tsx scripts/smoke-linkedin-timeline-backfill.ts` → `pendingTimelineAiContactCount is not a function` (or, once exported, `FAIL an account that has not opted in derives nothing`); exit 1.

- [ ] **Step 3: The bucket policy** — in `src/lib/rate-limit.ts` add `import { TIMELINE_DAILY_CONTACT_CAP } from "@/lib/timeline-cost";` after line 3, and inside `RATE_LIMITS` after the `eventWhy` entry:

```ts
  /**
   * Model-bound LinkedIn timeline conversations per user per day (audit A6). The runner
   * keys the bucket by UTC date as well as user, so the cap resets at midnight UTC rather
   * than 24 hours after the first call; the window only guarantees no reset mid-day.
   */
  timelineBackfillDaily: { limit: TIMELINE_DAILY_CONTACT_CAP, windowSec: 86_400 },
```

- [ ] **Step 4: The runner** — in `src/lib/linkedin-timeline-backfill.ts`, replace the imports (lines 64-71) with:

```ts
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { interactions, userSettings } from "@/db/schema";
import { internalFetch } from "@/lib/internal-auth";
import {
  extractLinkedInTimelineEvents,
  type LinkedInTimelineEvent,
} from "@/lib/linkedin-timeline-events";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import {
  TIMELINE_MIN_MESSAGES_FOR_AI,
  qualifiesForTimelineAi,
  usableTimelineMessageCount,
  utcDayKey,
} from "@/lib/timeline-cost";
```

After `pendingTimelineContactCount` (ends line 158) add:

```ts
/**
 * Pending contacts whose thread would cost a model call — what the import card's estimate
 * multiplies. Same predicate as the claim, plus the extractor's own skip rule.
 */
export async function pendingTimelineAiContactCount(userId: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT count(*)::int AS n ${PENDING_TIMELINE_CONTACTS}
      AND c.user_id = ${userId}
      AND (
        SELECT count(*) FROM interactions q
         WHERE q.user_id = c.user_id
           AND q.contact_id = c.id
           AND q.interaction_type = 'linkedin_message'
           AND btrim(coalesce(q.raw_notes, '')) <> ''
      ) >= ${TIMELINE_MIN_MESSAGES_FOR_AI}
  `);
  return Number(rowsOf<{ n: number }>(result)[0]?.n ?? 0);
}
```

In `usersWithPendingTimelineEvents`, replace its query with:

```ts
  const result = await db.execute(sql`
    SELECT DISTINCT c.user_id ${PENDING_TIMELINE_CONTACTS}
      AND EXISTS (
        SELECT 1 FROM user_settings us
         WHERE us.user_id = c.user_id AND us.timeline_backfill_enabled = 1
      )
    LIMIT ${limit}
  `);
```

Replace the runner's signature and opening (lines 184-192) with:

```ts
export async function runLinkedInTimelineBackfill(
  userId: string,
  extract: typeof extractLinkedInTimelineEvents = extractLinkedInTimelineEvents,
  budgetMs: number = TIME_BUDGET_MS,
  opts: { dailyCap?: number; now?: Date } = {}
): Promise<{
  contactsProcessed: number;
  eventsCreated: number;
  remaining: number;
  capped: boolean;
  enabled: boolean;
}> {
  const db = await getDb();
  const start = Date.now();
  let contactsProcessed = 0;
  let eventsCreated = 0;
  let capped = false;

  // Opt-in (audit A6): the work costs the user's own AI key, so it never starts unasked.
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { timelineBackfillEnabled: true },
  });
  if ((settings?.timelineBackfillEnabled ?? 0) !== 1) {
    return {
      contactsProcessed: 0,
      eventsCreated: 0,
      remaining: await pendingTimelineContactCount(userId),
      capped: false,
      enabled: false,
    };
  }
  const dailyCap = opts.dailyCap ?? RATE_LIMITS.timelineBackfillDaily.limit;
  const bucketKey = `${userId}:${utcDayKey(opts.now ?? new Date())}`;
```

Label the loop `claiming: while (Date.now() - start < budgetMs) {`, and directly after `if (msgs.length === 0) continue;` (line 232) add:

```ts
      // Only a thread that will reach the model spends from the daily allowance.
      if (qualifiesForTimelineAi(usableTimelineMessageCount(msgs.map((m) => m.rawNotes)))) {
        try {
          await consumeBucket("timelineBackfill", bucketKey, { limit: dailyCap, windowSec: 86_400 });
        } catch (err) {
          if (!isRateLimitedError(err)) throw err;
          capped = true;
          break claiming;
        }
      }
```

and replace the final `return { … }` (lines 296-300) with:

```ts
  return {
    contactsProcessed,
    eventsCreated,
    remaining: await pendingTimelineContactCount(userId),
    capped,
    enabled: true,
  };
```

- [ ] **Step 5: Run it and watch it pass** — `npx tsx scripts/smoke-linkedin-timeline-backfill.ts && npx tsx scripts/smoke-timeline-cost.ts` → both pass, including the new opt-in and cap sections.

- [ ] **Step 6: Typecheck, lint** — `npm run typecheck && npm run lint` → clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/rate-limit.ts src/lib/linkedin-timeline-backfill.ts scripts/smoke-linkedin-timeline-backfill.ts
git commit -m "$(cat <<'EOF'
Run the LinkedIn timeline backfill only when opted in, 300 conversations a day

The runner checks timeline_backfill_enabled, the cron sweep skips opted-out
accounts, and model-bound threads spend from a UTC-day bucket in
rate_limit_buckets.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: The opt-in toggle, with its estimate, on the LinkedIn messages card (A6)

**Files:**
- Create: `src/actions/timeline-backfill.ts`, `src/components/imports/timeline-backfill-toggle.tsx`
- Modify: `src/components/imports/linkedin-messages-import.tsx:9, 167` (render the toggle after the button row)

**Interfaces:**
- Consumes (Task 10): `pendingTimelineAiContactCount`, `kickLinkedInTimelineBackfill`; (Task 9): `TIMELINE_DAILY_CONTACT_CAP`, `timelineEstimateLabel`, `type TimelineBackfillStatus`; `FAST_MODELS`, `getAiCapability` (`src/lib/ai.ts:227, ~376`).
- Produces: server actions `getTimelineBackfillStatus(): Promise<TimelineBackfillStatus>` and `setTimelineBackfillEnabled(enabled: boolean): Promise<TimelineBackfillStatus>` (enabling kicks the backfill via `after()`); client component `TimelineBackfillToggle({ refreshKey?: unknown })`. The toggle appears on `/imports` and in Settings → Integrations → LinkedIn (both render `LinkedInMessagesImport`).

- [ ] **Step 1: Read the Next guides** — `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md` (using `after` inside a server action) and `01-app/02-guides/server-actions.md`.

- [ ] **Step 2: Test first** — the logic under this UI is covered by `smoke-timeline-cost` (label, estimate) and `smoke-linkedin-timeline-backfill` (gate, cap, `pendingTimelineAiContactCount`). This task adds no new logic, so its failing check is the type contract: write the component in Step 4 before the action exists and run `npm run typecheck` — expected: `Cannot find module '@/actions/timeline-backfill'`.

- [ ] **Step 3: The actions** — create `src/actions/timeline-backfill.ts`:

```ts
"use server";

import { eq } from "drizzle-orm";
import { after } from "next/server";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { FAST_MODELS, getAiCapability } from "@/lib/ai";
import {
  kickLinkedInTimelineBackfill,
  pendingTimelineAiContactCount,
} from "@/lib/linkedin-timeline-backfill";
import {
  TIMELINE_DAILY_CONTACT_CAP,
  timelineEstimateLabel,
  type TimelineBackfillStatus,
} from "@/lib/timeline-cost";

/** What the LinkedIn import card needs to offer the timeline backfill honestly. */
export async function getTimelineBackfillStatus(): Promise<TimelineBackfillStatus> {
  const userId = await requireUserId();
  const db = await getDb();
  const [settings, pending, capability] = await Promise.all([
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { timelineBackfillEnabled: true },
    }),
    pendingTimelineAiContactCount(userId),
    getAiCapability(userId),
  ]);
  const model = FAST_MODELS[capability.provider];
  return {
    enabled: (settings?.timelineBackfillEnabled ?? 0) === 1,
    pendingConversations: pending,
    hasKey: capability.hasKey,
    model,
    label: timelineEstimateLabel(pending, model),
    dailyCap: TIMELINE_DAILY_CONTACT_CAP,
  };
}

/** Turning it on starts the work now rather than at the next hourly sweep. */
export async function setTimelineBackfillEnabled(
  enabled: boolean
): Promise<TimelineBackfillStatus> {
  const userId = await requireUserId();
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ timelineBackfillEnabled: enabled ? 1 : 0, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
  if (enabled) after(() => kickLinkedInTimelineBackfill(userId));
  return getTimelineBackfillStatus();
}
```

- [ ] **Step 4: The toggle** — create `src/components/imports/timeline-backfill-toggle.tsx`:

```tsx
"use client";

import { useEffect, useState, useTransition } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  getTimelineBackfillStatus,
  setTimelineBackfillEnabled,
} from "@/actions/timeline-backfill";
import type { TimelineBackfillStatus } from "@/lib/timeline-cost";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

/**
 * The opt-in for deriving timeline events from imported LinkedIn conversations (audit A6).
 * Off by default; the label carries the estimate BEFORE the person turns it on. `refreshKey`
 * re-reads the count when an import finishes, since that is when conversations appear.
 */
export function TimelineBackfillToggle({ refreshKey }: { refreshKey?: unknown }) {
  const [status, setStatus] = useState<TimelineBackfillStatus | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    getTimelineBackfillStatus()
      .then((next) => {
        if (live) setStatus(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refreshKey]);

  if (!status) return null;

  const change = (checked: boolean) =>
    start(async () => {
      try {
        setStatus(await setTimelineBackfillEnabled(checked));
        toast.success(
          checked
            ? `Timeline events on — up to ${status.dailyCap} conversations a day`
            : "Timeline events off"
        );
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });

  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-muted/30 p-3">
      <Checkbox
        checked={status.enabled}
        disabled={pending}
        onCheckedChange={(checked) => change(checked === true)}
        aria-label="Derive timeline events from LinkedIn conversations"
        className="mt-0.5"
      />
      <span className="min-w-0 text-sm">
        <span className="block font-medium text-ink tabular-nums">{status.label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          Finds meetings and meetups in your threads and adds them to each person’s timeline.
          One call per conversation on {status.model}, up to {status.dailyCap} a day; threads
          with a single message get only a reach-out, with no AI call.
          {status.hasKey ? "" : " Without an AI key, Orbit falls back to simple keyword matching."}
        </span>
      </span>
    </label>
  );
}
```

- [ ] **Step 5: Render it** — in `src/components/imports/linkedin-messages-import.tsx` add `import { TimelineBackfillToggle } from "@/components/imports/timeline-backfill-toggle";` after line 9, and directly after the closing `</div>` of the button row (line 167) add:

```tsx
      <TimelineBackfillToggle refreshKey={job?.kind === "messages" ? job.status : null} />
```

- [ ] **Step 6: Typecheck, lint, copy** — `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts` → clean.

- [ ] **Step 7: Browser check** — `orbit-web`, open `/imports`. On the LinkedIn messages card the toggle shows unchecked with a label from `timelineEstimateLabel` (the demo workspace may already hold LinkedIn messages, in which case it shows a count and a dollar figure). Tick it with a real click: toast "Timeline events on — up to 300 conversations a day", box stays checked after a reload; untick: "Timeline events off". Check at 375 px width that the label wraps without overflow.

- [ ] **Step 8: Commit**

```bash
git add src/actions/timeline-backfill.ts src/components/imports/timeline-backfill-toggle.tsx src/components/imports/linkedin-messages-import.tsx
git commit -m "$(cat <<'EOF'
Offer LinkedIn timeline events as an opt-in with an up-front cost estimate

The messages import card shows how many conversations would be processed
and roughly what that costs on the user's key, off by default.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: An "AI usage" card in Settings → Integrations → AI provider (B8 subset)

**Files:**
- Create: `src/lib/usage-summary-types.ts`, `src/lib/usage-summary.ts`, `src/actions/usage.ts`, `src/components/settings/ai-usage-card.tsx`, `scripts/smoke-usage-summary.ts`
- Modify: `src/components/settings/integrations-dialog.tsx:26, 424-425`; `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `usageEvents` (`src/db/schema.ts:2056`, `estimated_cost_micros` is computed at write time by `estimateCostMicros` in `ai-pricing.ts`), `formatCostMicros` (`src/lib/ai-pricing.ts:97`).
- Produces: `type UsageSummaryRow = { operation; label; calls; failures; inputTokens; outputTokens; costMicros; unpricedCalls }`, `type UsageSummary = { since: string; days: number; rows: UsageSummaryRow[]; totalCalls: number; totalCostMicros: number; unpricedCalls: number }`, `usageOperationLabel(operation: string): string` (DB-free); `loadUsageSummary(userId, opts?: { now?: Date; days?: number }): Promise<UsageSummary>`; server action `getMyAiUsage(): Promise<UsageSummary>`; `AiUsageCard`. Task 14's policy points to this card.

- [ ] **Step 1: Write the failing test** — create `scripts/smoke-usage-summary.ts`:

```ts
/**
 * The 30-day AI usage card: this user's calls, grouped by feature, with the cost estimated
 * when each call was recorded. Other users' rows and rows older than the window never count.
 * Run: npx tsx scripts/smoke-usage-summary.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { usageEvents } from "../src/db/schema";
import { loadUsageSummary } from "../src/lib/usage-summary";

const USER = "smoke-usage-summary-user";
const OTHER = "smoke-usage-summary-other";
const NOW = new Date("2026-09-15T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const base = { provider: "gemini" as const, model: "gemini-3.5-flash", kind: "completion" as const, keyOwner: "user" as const };

run(async () => {
  const db = await getDb();
  await db.delete(usageEvents).where(inArray(usageEvents.userId, [USER, OTHER]));
  await db.insert(usageEvents).values([
    { ...base, userId: USER, operation: "capture.parse", inputTokens: 1000, outputTokens: 200, estimatedCostMicros: 800, createdAt: daysAgo(1) },
    { ...base, userId: USER, operation: "capture.parse", inputTokens: 1000, outputTokens: 200, estimatedCostMicros: 800, createdAt: daysAgo(3) },
    { ...base, userId: USER, operation: "chat.answer", inputTokens: 4000, outputTokens: 500, estimatedCostMicros: 5000, createdAt: daysAgo(2) },
    { ...base, userId: USER, operation: "chat.answer", success: 0, errorKind: "auth", createdAt: daysAgo(2) },
    { ...base, userId: USER, operation: "search.embed", kind: "embedding", createdAt: daysAgo(4) },
    { ...base, userId: USER, operation: "capture.parse", inputTokens: 9, outputTokens: 9, estimatedCostMicros: 999_999, createdAt: daysAgo(40) },
    { ...base, userId: OTHER, operation: "chat.answer", estimatedCostMicros: 123_456, createdAt: daysAgo(1) },
  ]);

  const summary = await loadUsageSummary(USER, { now: NOW });
  const byOp = new Map(summary.rows.map((r) => [r.operation, r]));
  check("rows are ordered by estimated cost", summary.rows.map((r) => r.operation).join() === "chat.answer,capture.parse,search.embed", summary.rows.map((r) => r.operation).join());
  check("calls and failures are counted per feature", byOp.get("chat.answer")?.calls === 2 && byOp.get("chat.answer")?.failures === 1);
  check("tokens and cost are summed", byOp.get("capture.parse")?.inputTokens === 2000 && byOp.get("capture.parse")?.costMicros === 1600);
  check("a successful call with no estimate is counted as unpriced", byOp.get("search.embed")?.unpricedCalls === 1);
  check("a failed call is not called unpriced", byOp.get("chat.answer")?.unpricedCalls === 0);
  check("the window excludes a 40-day-old row", summary.totalCalls === 5, `${summary.totalCalls}`);
  check("another user's rows never count", summary.totalCostMicros === 6600, `${summary.totalCostMicros}`);
  check("totals carry the unpriced count", summary.unpricedCalls === 1);
  check("known operations get a readable label", byOp.get("capture.parse")?.label === "Capture: reading notes");

  const empty = await loadUsageSummary("smoke-usage-summary-nobody", { now: NOW });
  check("an account with no calls gets an empty summary", empty.rows.length === 0 && empty.totalCalls === 0);

  await db.delete(usageEvents).where(inArray(usageEvents.userId, [USER, OTHER]));
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll usage-summary checks passed.");
});
```

Add `"smoke-usage-summary": "pglite",` to the `// pglite` block of `MANIFEST`.

- [ ] **Step 2: Run it and watch it fail** — `npx tsx scripts/smoke-usage-summary.ts` → cannot resolve `../src/lib/usage-summary`; exit 1.

- [ ] **Step 3: Implement**

`src/lib/usage-summary-types.ts`:

```ts
/** DB-free: the AI usage card imports these. */
export type UsageSummaryRow = {
  operation: string;
  label: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of the per-call estimates recorded at write time. */
  costMicros: number;
  /** Successful calls with no estimate (unpriced model, or no token counts reported). */
  unpricedCalls: number;
};

export type UsageSummary = {
  since: string;
  days: number;
  rows: UsageSummaryRow[];
  totalCalls: number;
  totalCostMicros: number;
  unpricedCalls: number;
};

/** The `operation` ids AI call sites record, in words a person would use. */
const LABELS: Record<string, string> = {
  "capture.parse": "Capture: reading notes",
  "capture.parse.identify": "Capture: finding people",
  "capture.parse.details": "Capture: details per person",
  "capture.dates": "Capture: dates and reminders",
  "capture.transcribe.page": "Capture: reading photos",
  "meeting.transcribe": "Meeting transcription",
  "chat.answer": "Chat answers",
  "chat.understand": "Chat: understanding the question",
  "chat.rerank": "Chat: ranking results",
  "search.embed": "Search indexing",
  "search.embed.batch": "Search indexing (bulk)",
  "recruiter.scan": "Recruiter scan",
  "recruiter.draft": "Recruiter drafts",
  "outreach.draft": "Outreach drafts",
  "outreach.apollo": "Outreach: prospect search",
  "import.linkedin.timeline": "LinkedIn timeline events",
  "import.enrich": "LinkedIn import summaries",
  "followup.draft": "Follow-up drafts",
  "events.why": "Events: why talk to them",
  "contact.brief": "Contact briefs",
};

export function usageOperationLabel(operation: string): string {
  return LABELS[operation] ?? operation;
}
```

`src/lib/usage-summary.ts`:

```ts
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { usageEvents } from "@/db/schema";
import { usageOperationLabel, type UsageSummary } from "@/lib/usage-summary-types";

export const USAGE_SUMMARY_DAYS = 30;

/**
 * One grouped statement over `usage_events_user_created_idx` (user_id, created_at). Costs
 * are the estimates stored per row at write time, so a price-table change never rewrites
 * what a past month cost. float8 sums: a bigint sum comes back as a string on neon-http.
 */
export async function loadUsageSummary(
  userId: string,
  opts: { now?: Date; days?: number } = {}
): Promise<UsageSummary> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? USAGE_SUMMARY_DAYS;
  const since = new Date(now.getTime() - days * 86_400_000);
  const db = await getDb();

  const cost = sql<number>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)::float8`;
  const rows = await db
    .select({
      operation: usageEvents.operation,
      calls: sql<number>`count(*)::int`,
      failures: sql<number>`(count(*) filter (where ${usageEvents.success} = 0))::int`,
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::float8`,
      costMicros: cost,
      unpricedCalls: sql<number>`(count(*) filter (where ${usageEvents.estimatedCostMicros} is null and ${usageEvents.success} = 1))::int`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), gte(usageEvents.createdAt, since), sql`${usageEvents.createdAt} <= ${now}`))
    .groupBy(usageEvents.operation)
    .orderBy(desc(cost));

  const mapped = rows.map((r) => ({
    operation: r.operation,
    label: usageOperationLabel(r.operation),
    calls: Number(r.calls),
    failures: Number(r.failures),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    costMicros: Number(r.costMicros),
    unpricedCalls: Number(r.unpricedCalls),
  }));

  return {
    since: since.toISOString(),
    days,
    rows: mapped,
    totalCalls: mapped.reduce((n, r) => n + r.calls, 0),
    totalCostMicros: mapped.reduce((n, r) => n + r.costMicros, 0),
    unpricedCalls: mapped.reduce((n, r) => n + r.unpricedCalls, 0),
  };
}
```

`src/actions/usage.ts`:

```ts
"use server";

import { requireUserId } from "@/lib/auth";
import { loadUsageSummary } from "@/lib/usage-summary";
import type { UsageSummary } from "@/lib/usage-summary-types";

/** The signed-in user's own last 30 days of AI calls. Never another account's. */
export async function getMyAiUsage(): Promise<UsageSummary> {
  const userId = await requireUserId();
  return loadUsageSummary(userId);
}
```

`src/components/settings/ai-usage-card.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { getMyAiUsage } from "@/actions/usage";
import { formatCostMicros } from "@/lib/ai-pricing";
import type { UsageSummary } from "@/lib/usage-summary-types";
import { SettingsSection } from "@/components/settings/settings-section";

/**
 * The last 30 days of AI calls made with this user's key, by feature, with estimated cost.
 * An estimate from list prices, labelled as one: the provider's bill is the real number.
 */
export function AiUsageCard() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    getMyAiUsage()
      .then((next) => {
        if (live) setSummary(next);
      })
      .catch(() => {
        if (live) setUnavailable(true);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <SettingsSection
      title="AI usage"
      description="Calls made with your key in the last 30 days, and roughly what they cost at list prices. Your provider’s bill is the real number."
    >
      {unavailable ? (
        <p className="text-sm text-muted-foreground">Usage isn’t available right now.</p>
      ) : !summary ? (
        <p className="text-sm text-muted-foreground">Loading usage…</p>
      ) : summary.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No AI calls in the last 30 days.</p>
      ) : (
        <div className="space-y-2">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-sm tabular-nums">
              <thead>
                <tr className="border-b border-border/60 text-xs text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-medium">Feature</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">Calls</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">Tokens</th>
                  <th scope="col" className="py-1.5 text-right font-medium">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((row) => (
                  <tr key={row.operation} className="border-b border-border/40 last:border-b-0">
                    <td className="py-1.5 pr-3 text-ink">{row.label}</td>
                    <td className="py-1.5 pr-3 text-right">
                      {row.calls.toLocaleString()}
                      {row.failures > 0 ? (
                        <span className="text-muted-foreground"> ({row.failures.toLocaleString()} didn’t complete)</span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-3 text-right">{(row.inputTokens + row.outputTokens).toLocaleString()}</td>
                    <td className="py-1.5 text-right">{formatCostMicros(row.costMicros) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border/60 font-medium">
                  <td className="py-1.5 pr-3">Total</td>
                  <td className="py-1.5 pr-3 text-right">{summary.totalCalls.toLocaleString()}</td>
                  <td className="py-1.5 pr-3" />
                  <td className="py-1.5 text-right">{formatCostMicros(summary.totalCostMicros) ?? "—"}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {summary.unpricedCalls > 0 ? (
            <p className="text-xs text-muted-foreground">
              {summary.unpricedCalls.toLocaleString()} {summary.unpricedCalls === 1 ? "call has" : "calls have"} no
              estimate — the provider reported no token counts or the model isn’t in Orbit’s price
              list — so {summary.unpricedCalls === 1 ? "it isn’t" : "they aren’t"} in the total.
            </p>
          ) : null}
        </div>
      )}
    </SettingsSection>
  );
}
```

In `src/components/settings/integrations-dialog.tsx` add `import { AiUsageCard } from "@/components/settings/ai-usage-card";` after line 26, and change the `"ai"` case (line 424-425) to:

```tsx
    case "ai":
      return (
        <div className="space-y-5">
          <AiSettings initialSettings={initialSettings} />
          <AiUsageCard />
        </div>
      );
```

- [ ] **Step 4: Run it and watch it pass** — `npx tsx scripts/smoke-usage-summary.ts && npx tsx scripts/smoke-usage-events.ts` → `All usage-summary checks passed.`; the existing suite exits 0.

- [ ] **Step 5: Typecheck, lint, copy** — `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts` → clean.

- [ ] **Step 6: Browser check** — `orbit-web`, Settings → Integrations → AI provider: the "AI usage" section shows below the key settings with "No AI calls in the last 30 days." on a fresh demo workspace. Ask one chat question (demo mode uses the server env key, which still records `usage_events`), reopen the tab: a "Chat answers" row with a call count and cost. At 375 px the table scrolls inside its container; the page does not.

- [ ] **Step 7: Commit**

```bash
git add src/lib/usage-summary-types.ts src/lib/usage-summary.ts src/actions/usage.ts src/components/settings/ai-usage-card.tsx src/components/settings/integrations-dialog.tsx scripts/smoke-usage-summary.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Show each user their last 30 days of AI usage and estimated cost

A card under Settings → Integrations → AI provider, from usage_events,
grouped by feature, with unpriced calls called out rather than hidden.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: `/knowledge` reads a bounded, projected slice (B4)

`getKnowledgeBase` (`src/actions/knowledge.ts:51-189`) runs `db.query.contacts.findMany({ where: userId })` with no projection and no limit — `notes` and base64 `profile_image_url` for the whole account — then slices to 400 in JavaScript. The entries it returns are exactly reproducible from the 400 most recently updated contacts that have a summary, notes or key facts, because every contact-derived entry is dated with the contact's `updated_at`.

**Files:**
- Create: `src/lib/knowledge-base-types.ts`, `src/lib/knowledge-base.ts`
- Modify: `src/actions/knowledge.ts` (whole file becomes a thin wrapper), `src/components/knowledge/knowledge-base-view.tsx:15-19` (type import)
- Test: `scripts/smoke-page-budgets.ts:34-47` (import), new section before "Payload scaling" (line ~518), one check inside it

**Interfaces:**
- Consumes: `normalizeInteractionType` (`src/lib/interaction-types.ts:177`), `rowsOf` (`src/db/index.ts:2224`), index `contacts_user_recent_idx (user_id, updated_at desc, id desc)`.
- Produces: types `KnowledgeKind`, `KnowledgeEntry`, `KnowledgeStats`, `KnowledgeBasePayload` (moved verbatim, DB-free); `KNOWLEDGE_ENTRY_LIMIT = 400`; `loadKnowledgeBase(userId: string): Promise<KnowledgeBasePayload>` (at most 4 statements; no bare `notes`/`raw_notes`/`profile_image_url`); `getKnowledgeBase()` unchanged in shape.

- [ ] **Step 1: Write the failing test** — in `scripts/smoke-page-budgets.ts` add `import { loadKnowledgeBase } from "../src/lib/knowledge-base";` after line 39, and insert before the `// ---- Payload scaling ----` banner:

```ts
  // ---- Knowledge -----------------------------------------------------------------------
  console.log("\nKnowledge base (loadKnowledgeBase)…");
  startQueryCount();
  const knowledge = await loadKnowledgeBase(USER);
  const knowledgeCount = stopQueryCount();
  const knowledgeStatements = capturedQueries();
  const knowledgeScans = contactScans(knowledgeStatements);
  console.log(`  statements: ${knowledgeCount}`);
  check("knowledge issues ≤ 4 statements", knowledgeCount <= 4, `got ${knowledgeCount}`);
  check(
    "every knowledge contacts scan is bounded by LIMIT",
    knowledgeScans.length >= 1 && knowledgeScans.every((s) => /\blimit\b/i.test(s)),
    knowledgeScans.find((s) => !/\blimit\b/i.test(s))?.slice(0, 200)
  );
  check(
    "knowledge never pulls notes as a bare column",
    knowledgeScans.every((s) => !selectsBare(s, "notes")),
    knowledgeScans.find((s) => selectsBare(s, "notes"))?.slice(0, 200)
  );
  check(
    "knowledge never selects profile_image_url",
    knowledgeStatements.every((s) => !s.includes('"profile_image_url"'))
  );
  check("knowledge returns at most 400 entries", knowledge.entries.length <= 400, `${knowledge.entries.length}`);
  check("knowledge still counts every contact", knowledge.stats.people === N + SPECIAL_ROWS, `${knowledge.stats.people}`);
  const knowledgeBytes = JSON.stringify(knowledge).length;
  const renderedContacts = new Set(knowledge.entries.map((e) => e.contactId)).size || 1;
  console.log(`  ${(knowledgeBytes / 1024).toFixed(0)} KB, ${(knowledgeBytes / renderedContacts).toFixed(0)} bytes a rendered contact`);
  // Up to four entries a contact (summary, notes, two key facts), each snippet capped at 420
  // characters. A regression that ships whole notes or an avatar per entry blows through this.
  check(
    "knowledge moves under 2,500 bytes per contact it renders",
    knowledgeBytes / renderedContacts < 2500,
    `${(knowledgeBytes / renderedContacts).toFixed(0)} bytes a contact`
  );
```

and inside the "Payload scaling" section, directly after `const smallPanel = …` (the third small-account loader), add:

```ts
  const smallKnowledge = await loadKnowledgeBase(SCALE_USER);
  check(
    "knowledge payload does not grow with the account",
    JSON.stringify(knowledge).length / Math.max(1, JSON.stringify(smallKnowledge).length) < 1.5,
    `${JSON.stringify(smallKnowledge).length} → ${JSON.stringify(knowledge).length} bytes`
  );
```

- [ ] **Step 2: Run it and watch it fail** — `npx tsx scripts/smoke-page-budgets.ts` → cannot resolve `../src/lib/knowledge-base`; exit 1.

- [ ] **Step 3: Move the types** — create `src/lib/knowledge-base-types.ts` containing `KnowledgeKind`, `KnowledgeEntry`, `KnowledgeStats` and `KnowledgeBasePayload` exactly as they are in `src/actions/knowledge.ts:13-45`, each with `export`. In `knowledge-base-view.tsx` change the type import (lines 15-19) to `from "@/lib/knowledge-base-types"`.

- [ ] **Step 4: The loader** — create `src/lib/knowledge-base.ts`:

```ts
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, interactions } from "@/db/schema";
import { normalizeInteractionType } from "@/lib/interaction-types";
import type {
  KnowledgeBasePayload,
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeStats,
} from "@/lib/knowledge-base-types";

/**
 * The /knowledge page's data, bounded (audit B4).
 *
 * The page renders at most 400 entries, newest first, and every contact-derived entry is
 * dated with the contact's `updated_at` — so the 400 most recently updated contacts that
 * HAVE a summary, notes or key facts produce exactly the entries the old whole-account read
 * did. Text columns are truncated in SQL (`left(...)`) so a multi-KB note never crosses the
 * wire to be sliced in JavaScript; `profile_image_url` is never selected. Stats come from one
 * aggregate instead of from the whole account in memory.
 */
export const KNOWLEDGE_ENTRY_LIMIT = 400;
const INTERACTION_LIMIT = 500;
const INTERACTION_ENTRY_LIMIT = 300;
const SNIPPET_CHARS = 420;

type ContactName = {
  id: string;
  fullName: string;
  preferredName: string | null;
  company: string | null;
  title: string | null;
};

function iso(d: Date | null | undefined) {
  return d ? new Date(d).toISOString() : null;
}

/** Legacy values (`meeting_note`, `outreach`, `coffee`) bucket with their modern equivalents. */
function kindOf(type: string | null, hasRawNotes: boolean): KnowledgeKind {
  if (!type && hasRawNotes) return "note";
  const canonical = normalizeInteractionType(type);
  if (canonical === "linkedin_message" || canonical === "message") return "message";
  if (canonical === "meeting" || canonical === "in_person" || canonical === "event") return "meeting";
  return "note";
}

function snippet(text: string | null | undefined) {
  return (text ?? "").trim().slice(0, SNIPPET_CHARS);
}

export async function loadKnowledgeBase(userId: string): Promise<KnowledgeBasePayload> {
  const db = await getDb();

  const [statsResult, contactRows, interactionRows] = await Promise.all([
    db.execute(sql`
      SELECT count(*)::int AS people,
             (count(*) FILTER (WHERE btrim(coalesce(ai_summary, '')) <> ''))::int AS with_summary,
             (count(*) FILTER (WHERE jsonb_array_length(coalesce(key_facts, '[]'::jsonb)) > 0))::int AS with_key_facts,
             (count(*) FILTER (WHERE btrim(coalesce(notes, '')) <> ''))::int AS with_notes,
             (SELECT count(*)::int FROM contact_embeddings WHERE user_id = ${userId}) AS embeddings
        FROM contacts
       WHERE user_id = ${userId}
    `),
    db
      .select({
        id: contacts.id,
        fullName: contacts.fullName,
        preferredName: contacts.preferredName,
        company: contacts.company,
        title: contacts.title,
        source: contacts.source,
        updatedAt: contacts.updatedAt,
        keyFacts: contacts.keyFacts,
        // 480 not 420: the old code trimmed before slicing, so leave room for leading space.
        aiSummary: sql<string | null>`left(${contacts.aiSummary}::text, 480)`,
        notes: sql<string | null>`left(${contacts.notes}::text, 480)`,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          // No coalesce(col, ...) here: NULL just drops out of the OR, and a bare "notes",
          // would trip the page-budget check that scans every statement for a bare notes column.
          sql`(btrim(${contacts.aiSummary}) <> '' OR btrim(${contacts.notes}) <> '' OR jsonb_array_length(${contacts.keyFacts}) > 0)`
        )
      )
      .orderBy(desc(contacts.updatedAt), desc(contacts.id))
      .limit(KNOWLEDGE_ENTRY_LIMIT),
    db
      .select({
        id: interactions.id,
        contactId: interactions.contactId,
        interactionType: interactions.interactionType,
        source: interactions.source,
        interactionDate: interactions.interactionDate,
        aiSummary: sql<string | null>`left(${interactions.aiSummary}::text, 480)`,
        rawNotes: sql<string | null>`left(${interactions.rawNotes}::text, 480)`,
      })
      .from(interactions)
      .where(eq(interactions.userId, userId))
      .orderBy(desc(interactions.interactionDate))
      .limit(INTERACTION_LIMIT),
  ]);

  const s = rowsOf<{
    people: number;
    with_summary: number;
    with_key_facts: number;
    with_notes: number;
    embeddings: number;
  }>(statsResult)[0];

  // Names for the interactions that become entries. Most are already in `contactRows`; the
  // rest come from one by-id read, bounded by the same 300 the entries are.
  const names = new Map<string, ContactName>(contactRows.map((c) => [c.id, c]));
  const entryInteractions = interactionRows.slice(0, INTERACTION_ENTRY_LIMIT);
  const missing = [...new Set(entryInteractions.map((i) => i.contactId))].filter((id) => !names.has(id));
  if (missing.length > 0) {
    const extra = await db
      .select({
        id: contacts.id,
        fullName: contacts.fullName,
        preferredName: contacts.preferredName,
        company: contacts.company,
        title: contacts.title,
      })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), inArray(contacts.id, missing)))
      .limit(INTERACTION_ENTRY_LIMIT);
    for (const c of extra) names.set(c.id, c);
  }

  const kinds = interactionRows.map((i) => kindOf(i.interactionType, Boolean(i.rawNotes)));
  const stats: KnowledgeStats = {
    people: Number(s?.people ?? 0),
    messages: kinds.filter((k) => k === "message").length,
    notes: kinds.filter((k) => k === "note").length + Number(s?.with_notes ?? 0),
    meetings: kinds.filter((k) => k === "meeting").length,
    withSummary: Number(s?.with_summary ?? 0),
    withKeyFacts: Number(s?.with_key_facts ?? 0),
    embeddings: Number(s?.embeddings ?? 0),
  };

  const entries: KnowledgeEntry[] = [];
  entryInteractions.forEach((i, index) => {
    const contact = names.get(i.contactId);
    if (!contact) return;
    const text = snippet(i.aiSummary || i.rawNotes);
    if (!text) return;
    entries.push({
      id: `interaction:${i.id}`,
      kind: kinds[index],
      contactId: contact.id,
      contactName: contact.preferredName || contact.fullName,
      company: contact.company,
      title: contact.title,
      snippet: text,
      date: iso(i.interactionDate),
      source: i.source,
    });
  });

  for (const c of contactRows) {
    const base = {
      contactId: c.id,
      contactName: c.preferredName || c.fullName,
      company: c.company,
      title: c.title,
      date: iso(c.updatedAt),
    };
    if (snippet(c.aiSummary)) {
      entries.push({ ...base, id: `summary:${c.id}`, kind: "summary", snippet: snippet(c.aiSummary), source: c.source });
    }
    if (snippet(c.notes)) {
      entries.push({ ...base, id: `notes:${c.id}`, kind: "note", snippet: snippet(c.notes), source: "profile_notes" });
    }
    for (const fact of c.keyFacts || []) {
      if (!fact.trim()) continue;
      entries.push({ ...base, id: `fact:${c.id}:${fact.slice(0, 40)}`, kind: "key_fact", snippet: snippet(fact), source: "key_facts" });
    }
  }

  entries.sort((a, b) => (b.date ? Date.parse(b.date) : 0) - (a.date ? Date.parse(a.date) : 0));
  return { stats, entries: entries.slice(0, KNOWLEDGE_ENTRY_LIMIT) };
}
```

- [ ] **Step 5: The action becomes a wrapper** — replace the whole of `src/actions/knowledge.ts` with:

```ts
"use server";

import { requireUserForSurface } from "@/lib/plan-guards";
import { loadKnowledgeBase } from "@/lib/knowledge-base";
import type { KnowledgeBasePayload } from "@/lib/knowledge-base-types";

export async function getKnowledgeBase(): Promise<KnowledgeBasePayload> {
  const userId = await requireUserForSurface("page.knowledge");
  return loadKnowledgeBase(userId);
}
```

- [ ] **Step 6: Run it and watch it pass** — `npx tsx scripts/smoke-page-budgets.ts` (up to five minutes) → all checks pass, including the eight knowledge ones; record the printed bytes-per-contact figure in the commit message.

- [ ] **Step 7: Typecheck, lint** — `npm run typecheck && npm run lint` → clean.

- [ ] **Step 8: Browser check** — `orbit-web`, open `/knowledge`: the stats row and the entries render as before (same counts as on `main` for the demo workspace; compare by opening `/knowledge` on a `main` worktree if one is running).

- [ ] **Step 9: Commit**

```bash
git add src/lib/knowledge-base-types.ts src/lib/knowledge-base.ts src/actions/knowledge.ts src/components/knowledge/knowledge-base-view.tsx scripts/smoke-page-budgets.ts
git commit -m "$(cat <<'EOF'
Bound /knowledge to a projected, limited read and put it under the page budget

Stats come from one aggregate; entries from the 400 most recently updated
contacts with content, text truncated in SQL, no avatar column.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Rewrite the privacy policy to match the code (A3)

**Files:**
- Modify: `src/lib/legal.ts` (Google disclosure constants)
- Modify: `src/app/(site)/(docs)/privacy/page.tsx` (whole file, 514 lines at `33a213c`, replaced by the copy in Steps 5–6)
- Create: `scripts/smoke-legal-pages.ts`; Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `LEGAL_LAST_UPDATED` (Task 7); `GOOGLE_SCOPES` (Task 4); `TIMELINE_DAILY_CONTACT_CAP` (Task 9); every behaviour Tasks 2–13 created, which the copy describes.
- Produces: `GOOGLE_USER_DATA_POLICY_URL`, `GOOGLE_LIMITED_USE` (`{ before, linkText, after, href }`), `GOOGLE_LIMITED_USE_SENTENCE`, `GOOGLE_SCOPE_DISCLOSURES: readonly { scope; permission; use; askedWhen }[]` in `src/lib/legal.ts`. The disclosure table is also the per-scope justification for Google's verification form (Manual steps).

- [ ] **Step 1: Confirm the Phase 0 behaviour this copy depends on** — if either check fails, STOP and raise it: the policy would be false.

```bash
grep -n "keepSettings: false" src/app/api/webhooks/clerk/route.ts   # A2: must print a line (Clerk-side deletion is full)
sed -n "/export function toPublicRecruiter/,/^}/p" src/lib/recruiters.ts   # A8: read it
```

In the printed `toPublicRecruiter`, contact details (email, phone, LinkedIn) must be unlocked only when the row is pooled for a sharing viewer, never by `Boolean(link)` alone. At `33a213c` it read `const unlocked = Boolean(link) || pooledForViewer;` — if it still does, Phase 0's A8 fix has not landed and the "shared directory" paragraph below is false.

- [ ] **Step 2: Write the failing test** — create `scripts/smoke-legal-pages.ts`:

```ts
/**
 * The legal pages must say what the code does. This reads their source and pins the
 * statements Google verification and the audit (A3) require, the corrections that must not
 * regress, and the link between the Google scope table and the scopes the code requests.
 * Pure. Run: npx tsx scripts/smoke-legal-pages.ts
 */
import { readFileSync } from "node:fs";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { GOOGLE_LIMITED_USE, GOOGLE_LIMITED_USE_SENTENCE, GOOGLE_SCOPE_DISCLOSURES } from "../src/lib/legal";

const privacy = readFileSync("src/app/(site)/(docs)/privacy/page.tsx", "utf8");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("Google Limited Use");
check(
  "the sentence is Google's required wording, verbatim",
  GOOGLE_LIMITED_USE_SENTENCE ===
    "Orbit's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements."
);
check("the rendered pieces join into that sentence", GOOGLE_LIMITED_USE.before + GOOGLE_LIMITED_USE.linkText + GOOGLE_LIMITED_USE.after === GOOGLE_LIMITED_USE_SENTENCE);
check("it links the User Data Policy", GOOGLE_LIMITED_USE.href === "https://developers.google.com/terms/api-services-user-data-policy");
check("the privacy page renders all four parts", ["GOOGLE_LIMITED_USE.before", "GOOGLE_LIMITED_USE.linkText", "GOOGLE_LIMITED_USE.after", "GOOGLE_LIMITED_USE.href"].every((p) => privacy.includes(p)));

console.log("The scope table matches the code");
for (const scope of Object.values(GOOGLE_SCOPES)) {
  check(`${scope} is disclosed exactly once`, GOOGLE_SCOPE_DISCLOSURES.filter((d) => d.scope === scope).length === 1);
}
check("the table discloses nothing the code does not request", GOOGLE_SCOPE_DISCLOSURES.every((d) => (Object.values(GOOGLE_SCOPES) as string[]).includes(d.scope)));
check("the privacy page renders the table", privacy.includes("GOOGLE_SCOPE_DISCLOSURES.map"));

console.log("Processors");
for (const name of ["Clerk", "Vercel", "Neon", "Stripe", "Resend", "Twilio", "Apollo", "Microsoft", "Eventbrite", "Luma", "Partiful", "Google Gemini, OpenAI, Anthropic", "Wispr Flow", "Sentry", "Slack", "Better Stack", "unavatar.io", "Microlink", "Gravatar"]) {
  check(`${name} is listed`, privacy.includes(`name: "${name}`));
}

console.log("Corrections that must not regress");
check("photos are no longer said to be discarded", !privacy.includes("then discarded"));
check("the console is no longer said to show only metadata", !privacy.includes("not the people in your"));
check("no reveal gate is claimed", !privacy.includes("reveal-everything"));
check("the recruiter scan is described", privacy.includes('id="recruiters"'));
check("the shared directory is described", privacy.includes("shared directory"));
check("self-service account deletion is described", privacy.includes("Delete your account"));
check("the usage view is pointed to", privacy.includes("Integrations → AI provider"));
check("the timeline cap is quoted from code", privacy.includes("TIMELINE_DAILY_CONTACT_CAP"));
check("the date comes from legal.ts", privacy.includes("LEGAL_LAST_UPDATED"));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll legal-page checks passed.");
process.exit(0);
```

Add `"smoke-legal-pages": "pure",` to the `// pure` block of `MANIFEST`.

- [ ] **Step 3: Run it and watch it fail** — `npx tsx scripts/smoke-legal-pages.ts` → `GOOGLE_LIMITED_USE` is not exported from `../src/lib/legal` (crashes, exit 1).

- [ ] **Step 4: The Google constants** — append to `src/lib/legal.ts` (add `import { GOOGLE_SCOPES } from "@/lib/google-scopes";` at the top):

```ts
export const GOOGLE_USER_DATA_POLICY_URL =
  "https://developers.google.com/terms/api-services-user-data-policy";

/**
 * Google requires this sentence, verbatim, on the privacy policy of any app using its
 * restricted or sensitive scopes. Split so the page can link the policy name;
 * `scripts/smoke-legal-pages.ts` proves the pieces still join into the exact sentence.
 */
export const GOOGLE_LIMITED_USE_SENTENCE =
  "Orbit's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.";

export const GOOGLE_LIMITED_USE = {
  before: "Orbit's use and transfer to any other app of information received from Google APIs will adhere to the ",
  linkText: "Google API Services User Data Policy",
  after: ", including the Limited Use requirements.",
  href: GOOGLE_USER_DATA_POLICY_URL,
} as const;

/**
 * One row per scope the code can request (src/lib/google-scopes.ts). The privacy page renders
 * this table and Google's verification form reuses it as the per-scope justification.
 */
export const GOOGLE_SCOPE_DISCLOSURES: readonly {
  scope: string;
  permission: string;
  use: string;
  askedWhen: string;
}[] = [
  {
    scope: GOOGLE_SCOPES.openid,
    permission: "Sign-in identity (openid)",
    use: "Confirms which Google account you connected.",
    askedWhen: "Every Google connection",
  },
  {
    scope: GOOGLE_SCOPES.email,
    permission: "Your email address (userinfo.email)",
    use: "Shown on the connection so you can tell which account is connected, and the address mail is sent from when you send from Gmail.",
    askedWhen: "Every Google connection",
  },
  {
    scope: GOOGLE_SCOPES.contacts,
    permission: "See your contacts (contacts.readonly)",
    use: "Lists your Google Contacts so you can pick who to import. Only the people you select are saved: name, company, title, email, phone and photo.",
    askedWhen: "Connect Google on Imports → Google Contacts",
  },
  {
    scope: GOOGLE_SCOPES.gmailRead,
    permission: "Read your email (gmail.readonly)",
    use: "Recruiter scan: finds recruiting conversations and summarizes each with your own AI key. Confirmation emails: reads mail from Luma, Partiful, Eventbrite, Meetup and Posh to find events you registered for. Message bodies are never stored.",
    askedWhen: "Connect Gmail on Recruiters, or turn on Confirmation emails on Events",
  },
  {
    scope: GOOGLE_SCOPES.gmailSend,
    permission: "Send email as you (gmail.send)",
    use: "Sends the recruiter messages you write and press Send on, from your own address, so replies reach your inbox. Orbit never sends a message you did not send.",
    askedWhen: "Allow Gmail to send, in the recruiter composer",
  },
  {
    scope: GOOGLE_SCOPES.calendar,
    permission: "See your calendar events (calendar.readonly)",
    use: "Reads recent and upcoming events on your primary calendar and adds meetings with people in your network to their timelines.",
    askedWhen: "Connect Google Calendar on Events",
  },
];
```

- [ ] **Step 5: Replace `src/app/(site)/(docs)/privacy/page.tsx`** with block A below followed immediately by block B in Step 6 (one file; the split is only for length). Sections 9 (cookies) keeps the current copy verbatim; everything else is rewritten.

Block A:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { Download, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import {
  DocBody,
  DocCallout,
  DocCard,
  DocCardGrid,
  DocFooterCta,
  DocHero,
  DocHighlights,
  DocSection,
  type Highlight,
} from "@/components/marketing/marketing-doc";
import type { TocItem } from "@/components/marketing/doc-toc";
import { GOOGLE_LIMITED_USE, GOOGLE_SCOPE_DISCLOSURES, LEGAL_LAST_UPDATED } from "@/lib/legal";
import { TIMELINE_DAILY_CONTACT_CAP } from "@/lib/timeline-cost";

export const metadata: Metadata = {
  title: "Privacy Policy — Orbit",
  description:
    "What Orbit collects, who it shares data with, what it does with Google data, and how to export or delete everything in your account.",
};

const LAST_UPDATED = LEGAL_LAST_UPDATED;

const HIGHLIGHTS: readonly Highlight[] = [
  { icon: ShieldCheck, title: "Your network isn't a product", body: "Orbit doesn't sell personal information or run ad pixels, and its traffic analytics set no cookies." },
  { icon: Sparkles, title: "AI runs on your key", body: "AI features are opt-in, you choose the provider, every call bills to a key you supply, and Settings shows what the last 30 days cost." },
  { icon: Download, title: "Export on demand", body: "One control in Settings produces a JSON download of your core Orbit data, on every plan including Free." },
  { icon: Trash2, title: "Deletion is real deletion", body: "Delete some or all of your data from Settings, or delete your account — which erases your data, keys and sign-in and cancels any subscription." },
];

const TOC: readonly TocItem[] = [
  { id: "scope", label: "Who this covers" },
  { id: "collect", label: "What we collect" },
  { id: "use", label: "How it's used" },
  { id: "google", label: "Google user data" },
  { id: "recruiters", label: "Recruiter scan & directory" },
  { id: "third-parties", label: "Who else sees it" },
  { id: "ai", label: "AI processing" },
  { id: "payments", label: "Payments" },
  { id: "cookies", label: "Cookies, storage & analytics" },
  { id: "controls", label: "Your controls" },
  { id: "retention", label: "Retention" },
  { id: "security", label: "Security" },
  { id: "operator-access", label: "Operator access" },
  { id: "transfers", label: "Where it's processed" },
  { id: "children", label: "Children" },
  { id: "changes", label: "Changes" },
  { id: "contact", label: "Questions" },
];

/** Every service that receives personal data, verified against the code on 2026-09-15. */
const PROCESSORS = [
  { name: "Clerk", badge: "Required", body: "Sign-in, sessions and account lifecycle. Holds your sign-in identity and records when you accepted these terms." },
  { name: "Vercel", badge: "Required", body: "Hosting, and file storage for contact photos, capture photos and feedback screenshots. Also runs Web Analytics and Speed Insights, which receive page addresses with ids and tokens removed." },
  { name: "Neon", badge: "Required", body: "The Postgres database that holds your Orbit data." },
  { name: "Sentry", badge: "Required", body: "Error reports: the error, where in the code it happened, the page and browser. Configured not to attach IP addresses or cookies, and with session replay off." },
  { name: "Slack", badge: "Required", body: "Operational alerts to the operator: job status, route names and error messages. An error message can occasionally include a value it was processing." },
  { name: "Better Stack", badge: "Required", body: "Uptime heartbeat. Receives a ping, no personal data." },
  { name: "unavatar.io", badge: "Automatic", body: "Looks up a public profile photo for contacts with a LinkedIn URL. Receives the LinkedIn username only." },
  { name: "Microlink", badge: "Automatic", body: "When unavatar.io has no photo, fetches the public preview image of the contact's LinkedIn profile URL." },
  { name: "Gravatar", badge: "Automatic", body: "Checks for a public avatar for a contact's email. Receives a one-way hash of the address, not the address." },
  { name: "Stripe", badge: "Optional", body: "Orbit Pro and Orbit Lifetime payments. Card details go to Stripe directly; Orbit stores a customer reference." },
  { name: "Google Gemini, OpenAI, Anthropic", badge: "Optional", body: "AI features, on the provider and key you choose in Settings: notes, chat, drafts, search indexing, transcription and reading pages you scan." },
  { name: "Wispr Flow", badge: "Optional", body: "Meeting transcription, only if you add a Wispr key." },
  { name: "Google", badge: "Optional", body: "Gmail, Contacts and Calendar, one permission per feature you turn on. See Google user data." },
  { name: "Microsoft", badge: "Optional", body: "Outlook contacts import, read-only. Orbit does not read Outlook mail." },
  { name: "Eventbrite", badge: "Optional", body: "Guest lists of events you host, through Eventbrite sign-in." },
  { name: "Luma", badge: "Optional", body: "Guest lists of events you host (with your Luma API key), and your personal Luma calendar link if you paste it." },
  { name: "Partiful", badge: "Optional", body: "Your personal Partiful calendar link, if you paste it, to list events you are going to." },
  { name: "Apollo", badge: "Optional", body: "People search and contact enrichment, with your Apollo key, or Orbit's on Pro." },
  { name: "Resend", badge: "Optional", body: "Email Orbit sends: the waitlist confirmation, messages you send through the contact page, and outreach you send from Orbit." },
  { name: "Twilio", badge: "Optional", body: "SMS outreach you send, through the Twilio account you connect." },
] as const;

export default function PrivacyPage() {
  return (
    <>
      <DocHero
        eyebrow="Privacy"
        title="What Orbit knows, and what it does with it."
        lede="Orbit holds the working memory of your professional network — who you met, what you said, and who you still owe a reply. This page is the plain description of how that information is handled."
        meta={[
          { label: "Last updated", value: LAST_UPDATED },
          { label: "Applies to", value: "The Orbit web app and browser extension" },
          { label: "Read time", value: "About 12 minutes" },
        ]}
      />

      <DocHighlights kicker="The short version" items={HIGHLIGHTS} />

      <DocBody toc={TOC}>
        <DocSection id="scope" index={1} title="Who this covers">
          <p>
            Orbit is a personal networking tracker: it captures contacts, keeps a history of your
            relationships, imports data you already have, and uses AI to organise follow-ups. This
            policy covers the Orbit web app, its browser extension and the services run alongside
            them, and describes how the product behaves today rather than how it might later.
          </p>
          <p>
            Orbit is built and run by one person, Jason Pereira. Where this policy says{" "}
            <strong>we</strong>, that is who it means.
          </p>
        </DocSection>

        <DocSection id="collect" index={2} title="What Orbit collects">
          <p>Almost everything in Orbit is there because you put it there. Depending on the features you use:</p>
          <ul>
            <li>
              <strong>Account information</strong> — from our sign-in provider, Clerk: your user id,
              name, email address and profile image; your plan; and when you accepted the Terms and
              which version.
            </li>
            <li>
              <strong>Network and CRM content</strong> — contacts and their details (name, company,
              title, location, school, email, phone, LinkedIn URL, website, notes, tags, closeness,
              follow-up dates), interactions, goals, reminders, chat threads, events, outreach
              campaigns and messages, recruiter records, and import history. When you capture notes,
              Orbit keeps the text and any photos you attach so you can look back at the original.
              Photos are resized and stripped of their metadata (including location) before they are
              stored; photos from a capture you never save are deleted after 24 hours.
            </li>
            <li>
              <strong>Voice and meetings</strong> — audio you record is sent to be transcribed and is
              not kept. The transcript is: a voice note becomes the text of your note, and a meeting
              keeps its transcript until you delete the meeting.
            </li>
            <li>
              <strong>Connected accounts</strong> — if you connect Google, Orbit reads only what the
              feature you turned on needs (see <a href="#google">Google user data</a>). Microsoft is
              used only to import Outlook contacts.
            </li>
            <li>
              <strong>The browser extension</strong> — when you open its panel on a LinkedIn profile,
              it sends that page&rsquo;s text to Orbit, which fills in a contact using your AI key. A
              contact is created only when you save it.
            </li>
            <li>
              <strong>Secrets you provide</strong> — API keys for AI, enrichment, email, SMS and
              transcription providers, and the tokens for accounts you connect. Encrypted at rest.
            </li>
            <li>
              <strong>Derived data</strong> — AI summaries, suggestions, embeddings (search indexes)
              and timeline events computed from what you store.
            </li>
            <li>
              <strong>Usage records</strong> — for each AI call: the feature, provider, model, token
              counts, an estimated cost, duration and whether it succeeded. Never the prompt or the
              reply. You can see your last 30 days in Settings under Integrations → AI provider.
            </li>
            <li>
              <strong>Page views</strong> — which pages are opened, when and for how long; device type;
              the referring site and campaign tags; and approximate location looked up from the IP
              address. Linked to your account while you are signed in. See{" "}
              <a href="#cookies">cookies, storage, and analytics</a>.
            </li>
          </ul>
          <DocCallout title="Worth knowing">
            <p>
              Contact records are usually about other people. When you add or import someone, you
              decide what Orbit stores about them, and you remain responsible for having a lawful
              basis to keep it. Recording a meeting captures everyone on the call, and many places
              require their consent first.
            </p>
          </DocCallout>
        </DocSection>

        <DocSection id="use" index={3} title="How that data is used">
          <p>Orbit uses the information above to:</p>
          <ul>
            <li>Authenticate you and keep every query scoped to your account</li>
            <li>Run the CRM itself — search, reminders, the relationship graph and the dashboard</li>
            <li>Power the AI features you use, on your key</li>
            <li>Run the imports, syncs, enrichment and outbound email or SMS you set up</li>
            <li>Look up public profile photos for your contacts</li>
            <li>Apply plan limits and process payments if you upgrade</li>
            <li>Understand which pages are read, where visitors arrive from, and which features get used</li>
            <li>Honour export, deletion and account requests</li>
          </ul>
          <p>
            Orbit does not use your content to train AI models, its own or anyone else&rsquo;s, and
            does not build advertising profiles from it.
          </p>
        </DocSection>
```

- [ ] **Step 6: Continue the same file** with block B, then block C (Step 7).

Block B:

```tsx
        <DocSection id="google" index={4} title="Google user data">
          <p>
            Orbit can connect to a Google account you choose. Each feature asks Google only for the
            permission it needs, at the moment you turn it on, and Google&rsquo;s own screen shows
            exactly what is being granted. You can allow one feature and decline another.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-[#e8f3f1]/[0.1] text-xs uppercase tracking-[0.12em] text-[#6d807c]">
                  <th scope="col" className="py-2 pr-4 font-normal">Permission</th>
                  <th scope="col" className="py-2 pr-4 font-normal">What Orbit does with it</th>
                  <th scope="col" className="py-2 font-normal">Asked for when</th>
                </tr>
              </thead>
              <tbody>
                {GOOGLE_SCOPE_DISCLOSURES.map((row) => (
                  <tr key={row.scope} className="border-b border-[#e8f3f1]/[0.06] align-top">
                    <td className="py-3 pr-4 text-[#e8f3f1]">{row.permission}</td>
                    <td className="py-3 pr-4 text-[#9aada8]">{row.use}</td>
                    <td className="py-3 text-[#9aada8]">{row.askedWhen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            {GOOGLE_LIMITED_USE.before}
            <a href={GOOGLE_LIMITED_USE.href}>{GOOGLE_LIMITED_USE.linkText}</a>
            {GOOGLE_LIMITED_USE.after}
          </p>
          <p>
            In practice: Orbit uses Google data only to provide the features in the table, shown to
            you inside Orbit. It does not sell it, does not use it for advertising, and does not use
            it to develop or train AI models. Where a feature uses AI (the recruiter scan), the text
            involved goes to the AI provider you chose, on your own key, only to produce the result
            you asked for. A person at Orbit reads Google data only with your permission for a
            support request you raise, to investigate abuse or a security problem, or where the law
            requires it.
          </p>
          <p>
            Disconnecting Google in Orbit deletes the tokens Orbit holds. To also revoke the grant
            on Google&rsquo;s side, remove Orbit from your Google Account&rsquo;s third-party access
            page.
          </p>
          <DocCallout title="Confirmation emails">
            <p>
              If you turn on event discovery from confirmation emails, Orbit searches your Gmail for
              mail from event platforms only — Luma, Partiful, Eventbrite, Meetup and Posh — and
              opens a message only when Google&rsquo;s signature check confirms it came from one of
              them. It keeps the event link, the subject line, the sender&rsquo;s domain and the
              date; it stores no message bodies, reads no other mail, and never sends this mail to
              an AI provider. Turning it off stops the scanning and removes what it recorded about
              where each event was found.
            </p>
          </DocCallout>
        </DocSection>

        <DocSection id="recruiters" index={5} title="The recruiter scan and the shared directory">
          <p>
            <strong>The scan.</strong> When you connect Gmail on the Recruiters page and press Scan,
            Orbit uses Gmail search to find messages that look like recruiting — terms such as
            &ldquo;recruiter&rdquo;, &ldquo;talent acquisition&rdquo; and &ldquo;open role&rdquo;,
            excluding newsletters and mailing lists. For each likely recruiter, up to 400 a scan, it
            sends the subject and text of up to five of their most recent messages, with their name
            and address, to the AI provider you chose, on your key. The model decides whether the
            sender is a recruiter and writes a short summary of the conversation.
          </p>
          <p>
            <strong>What is kept.</strong> For each recruiter found: their name, firm and email
            address; the companies and roles discussed; how many emails you exchanged and when; the
            latest thread id, so a reply can continue it; and the summary, which only you can see.
            Message bodies are not stored. The scan&rsquo;s work list — the name, address and Gmail
            message ids of every sender it considered — stays with the scan in your import history
            until you delete it.
          </p>
          <p>
            <strong>The shared directory.</strong> A recruiter&rsquo;s record has a shared core —
            name, firm, specialty, and work email, phone and LinkedIn when known — so two people
            who work with the same recruiter point at one record. Your notes, summaries and email
            threads stay yours. Sharing is off by default. If you turn it on in Recruiters, the
            recruiters you add (except any you exclude) join a pool: other people who also share can
            see those recruiters&rsquo; shared core and an average rating that includes yours, and
            you see theirs. Contact details on a shared record are shown to someone else only when
            that recruiter is in the pool and they share too. Turning sharing off takes your
            recruiters out of the pool.
          </p>
        </DocSection>

        <DocSection id="third-parties" index={6} title="Who else touches your data">
          <p>
            Orbit relies on the processors and integrations below. &ldquo;Required&rdquo; ones handle
            every account; &ldquo;Automatic&rdquo; ones run without a setting (photo lookups for
            contacts); &ldquo;Optional&rdquo; ones stay dormant until you use the feature.
          </p>
          <DocCardGrid columns={2}>
            {PROCESSORS.map((processor) => (
              <DocCard key={processor.name} title={processor.name} badge={processor.badge}>
                {processor.body}
              </DocCard>
            ))}
          </DocCardGrid>
          <p>
            We do not sell your personal information. Using AI, enrichment, sync or outreach shares
            the relevant content with those providers, where it is governed by their own terms and
            privacy policies.
          </p>
        </DocSection>

        <DocSection id="ai" index={7} title="AI processing">
          <p>
            When you use an AI feature, the content it needs — notes, contact context, chat prompts,
            meeting audio, photos of pages you scan, recruiter emails when you run the scan — is sent
            to the provider you configured. In production every call runs on an API key you supply,
            so the request lands on your own account with that vendor, under the retention terms you
            agreed with them.
          </p>
          <p>
            Some AI work runs in the background. Search indexing runs when contacts change, so search
            understands meaning. Importing LinkedIn messages writes a short summary for up to 40 of
            the people you talked with most. Deriving timeline events from imported LinkedIn
            conversations is off until you turn it on, shows an estimated cost first, skips threads
            with a single message, and processes at most {TIMELINE_DAILY_CONTACT_CAP} conversations
            a day. Settings → Integrations → AI provider shows every call from the last 30 days and
            its estimated cost.
          </p>
          <p>
            <strong>
              Don&rsquo;t store anything in Orbit you would be unwilling to send to your chosen AI
              provider
            </strong>
            . AI output can be wrong or invented — review anything before you act on it or send it
            to a real person.
          </p>
        </DocSection>

        <DocSection id="payments" index={8} title="Payments">
          <p>
            The Free Plan needs no payment details. Orbit Pro and Orbit Lifetime are sold through
            Stripe.
          </p>
          <p>
            <strong>Orbit never sees your card.</strong> Orbit stores a Stripe customer reference, your
            plan and subscription status, and a record of each charge, refund and dispute for its
            accounts. When you delete your account, that accounting record is kept with your account
            id removed. Pricing is on the <Link href="/pricing">pricing page</Link>.
          </p>
        </DocSection>
```

- [ ] **Step 7: Finish the file** with block C. Section 9 is the current `cookies` section (old lines 325-381) unchanged except its `index`, 7 → 9.

Block C:

```tsx
        <DocSection id="cookies" index={9} title="Cookies, local storage, and analytics">
          <p>
            Orbit uses Clerk session cookies to keep you signed in. On your very
            first visit it also sets one first-party cookie,{" "}
            <code>orbit_attr</code>, recording where you arrived from — the
            referring site and any campaign tags in the link — so we can tell
            which channels bring people here. It holds no personal information,
            is never shared, and expires after 90 days. The app also stores
            preferences on your device in <code>localStorage</code> —
            theme flash helpers, saved graph layout positions, and per-device
            notification opt-in. Delivered notification history and account
            preferences live with your account instead.
          </p>
          <p>
            Orbit counts its own traffic, and does it{" "}
            <strong>without cookies</strong>. Each page view records which page
            was opened, when, and for how long; whether it was on a desktop,
            phone, or tablet; the site that linked there and any campaign tags;
            and an approximate location — city, region, and country — looked up
            from the IP address. The IP address itself is not kept: Orbit&apos;s
            analytics reduces it, together with your browser type, to a one-way
            hash mixed with a value that changes every day, and stores only the
            hash. That hash cannot connect one day&apos;s visit to the next, and
            it cannot be turned back into an address from the data alone. To
            group the pages of a single visit, your browser holds a random
            session id in <code>sessionStorage</code>; it is discarded when you
            close the tab, and replaced after 30 minutes without a page view.
          </p>
          <p>
            For a signed-out visitor, that is all it is: a count of how many
            people read which pages on a given day, with no way to tell who they
            were.{" "}
            <strong>
              While you are signed in, your page views are also recorded against
              your account
            </strong>{" "}
            — which pages you open, when, and for how long. Only Orbit&apos;s
            operator can see them, in the internal console described under{" "}
            <a href="#operator-access">operator access</a>. They are used to
            understand which features get used and where people get stuck, and
            they are never sold, shared, or used for advertising.
          </p>
          <p>
            Orbit also runs two of its host&apos;s tools:{" "}
            <strong>Vercel Web Analytics</strong>, which counts page views and
            visitors in aggregate, and <strong>Vercel Speed Insights</strong>,
            which measures how quickly pages load. Along with each page, Vercel
            receives the site that linked to it, the browser and device type, and
            an approximate location. Neither tool uses cookies; Vercel tells
            visitors apart with a hash of the request that it discards after 24
            hours. Before anything is sent to Vercel, ids and one-time
            tokens in the page address are replaced with placeholders, every
            query parameter except campaign tags is removed, and views of the
            operator console are not sent at all. There are no advertising
            pixels and no cross-site tracking.
          </p>
        </DocSection>

        <DocSection id="controls" index={10} title="Your controls">
          <p>
            In Settings, under <Link href="/settings">Data and privacy</Link>, on every plan
            including Free:
          </p>
          <ul>
            <li>
              <strong>Export</strong> a JSON download of your contacts, interactions, reminders,
              tags, imports and AI suggestions. It does not yet include capture text and photos,
              meeting transcripts, chat history, events, companies, goals, outreach or recruiter
              records — ask through the <Link href="/contact">contact page</Link> for a copy of those.
            </li>
            <li>
              <strong>Delete data</strong>, choosing by category. Your account, plan and API keys
              stay.
            </li>
            <li>
              <strong>Delete your account.</strong> This erases all of your Orbit data and settings,
              including saved API keys and connected accounts, cancels an active Orbit Pro
              subscription, and removes your sign-in. It cannot be undone.
            </li>
          </ul>
          <p>
            Deleting your account from Clerk&rsquo;s own account page does the same deletion through
            our account webhook. Settings → Integrations → AI provider shows your AI usage, and you
            can disconnect any connected account from the Integrations dialog.
          </p>
        </DocSection>

        <DocSection id="retention" index={11} title="How long data is kept">
          <p>
            Your Orbit data is kept while your account is active, until you delete it with the
            controls above. Downgrading never deletes anything: contacts added while you were
            subscribed stay visible and exportable on the Free Plan.
          </p>
          <p>
            Capture photos stay with the capture they belong to until you delete it; photos from a
            capture you never save are deleted after 24 hours. Audio is never kept. Page views are
            deleted after 180 days; deleting your data or your account unlinks the ones made while
            you were signed in, keeping only the anonymous count.
          </p>
          <p>
            When you delete your account, every table holding your data is cleared, including your
            settings, keys and tokens. What remains: Stripe&rsquo;s own records of your payments,
            held by Stripe; Orbit&rsquo;s accounting record of charges and refunds, with your
            account id removed; the operator&rsquo;s audit log of actions taken on your account,
            which refers to an account id that no longer exists; and a few operational counters
            keyed by that same id. Encrypted database backups are kept for 90 days, so deleted data
            leaves the last backup within 90 days.
          </p>
        </DocSection>

        <DocSection id="security" index={12} title="Security">
          <p>
            Traffic runs over HTTPS, every database query is scoped to your account, and API keys and
            account tokens are encrypted at rest (AES-256-GCM). Sign-in is handled by Clerk, and card
            data never touches Orbit&rsquo;s servers.
          </p>
          <p>
            No system is perfectly secure, and Orbit is an early-stage product built by one person.
            Use a strong, unique password, and treat the API keys you paste into Settings with the
            same care you would anywhere else.
          </p>
        </DocSection>

        <DocSection id="operator-access" index={13} title="Operator access">
          <p>
            Running Orbit means occasionally looking at how it is doing, and at one account when
            something goes wrong for it. There is an internal operator console for that. This is what
            it can see and do.
          </p>
          <ul>
            <li>
              <strong>For every account:</strong> name, email and profile picture; plan and billing
              status; sign-up and last-active times; which integrations are connected and whether
              each has a key saved (never the key); AI usage totals and estimated cost; recent
              imports and errors; a timeline of recent activity that names contacts and chat thread
              titles; and the pages you opened while signed in.
            </li>
            <li>
              <strong>When the operator opens an account:</strong> its contact list — names, email
              addresses, companies and titles. Opening one contact shows that record in full: phone,
              location, notes, AI summary, key facts, and the notes on its recent interactions.
            </li>
            <li>
              <strong>Never:</strong> API keys, account tokens, webhook secrets or the calendar feed
              link; chat messages; the original text of your captures; meeting transcripts; capture
              photos. These are blocked in the code that reads the database, so the console cannot
              display them even by mistake.
            </li>
            <li>
              <strong>Feedback you send</strong> through the in-app feedback button, including any
              screenshot you attach, is read by the operator.
            </li>
          </ul>
          <p>
            The operator can comp or revoke a plan, suspend or delete an account, retry or cancel an
            import, reset onboarding, disconnect an integration, turn a calendar feed on or off, and
            create a one-time link that signs in as your account (for support, and for the demo
            account). Each of these requires a written reason, recorded in an audit log. Opening your
            account is recorded, and so is every individual contact record opened, by its id.
          </p>
          <p>
            The operator looks only to answer a support request from you, to investigate abuse, a
            security problem or a failure affecting your account, or where the law requires it.
          </p>
        </DocSection>

        <DocSection id="transfers" index={14} title="Where data is processed">
          <p>
            Orbit&rsquo;s hosting, database, payment and AI providers operate globally, so your data
            may be processed outside the country you live in — most often the United States. Where
            you supply your own API keys, the processing location follows what you configured with
            that vendor.
          </p>
        </DocSection>

        <DocSection id="children" index={15} title="Children">
          <p>
            Orbit is not directed at children under 13, and we do not knowingly collect personal
            information from them. If you believe a child has provided information to Orbit, get in
            touch and it will be removed.
          </p>
        </DocSection>

        <DocSection id="changes" index={16} title="Changes to this policy">
          <p>
            This policy will change as the product does. The <strong>Last updated</strong> date at
            the top is revised whenever it happens, and material changes are called out in the app.
            Continuing to use Orbit after a change means you accept the updated policy.
          </p>
        </DocSection>

        <DocSection id="contact" index={17} title="Questions">
          <p>
            Questions about this policy, or about what Orbit holds on you, can go to the operator
            through the <Link href="/contact">contact page</Link>. For routine export or deletion,
            the Settings controls are faster than an email.
          </p>
        </DocSection>
      </DocBody>

      <DocFooterCta
        title="Prefer to check for yourself?"
        body="Export your data, delete some of it, or delete your account from the Data and privacy panel in Settings — no request required."
        primary={{ href: "/settings", label: "Open Settings" }}
        secondary={{ href: "/terms", label: "Read the terms" }}
      />
    </>
  );
}
```

- [ ] **Step 8: Run the tests and watch them pass** — `npx tsx scripts/smoke-legal-pages.ts && npx tsx scripts/smoke-public-routes.ts` → `All legal-page checks passed.`; public routes still pass (no route changed).

- [ ] **Step 9: Typecheck, lint** — `npm run typecheck && npm run lint` → clean (the page uses `&rsquo;`/`&ldquo;` in JSX text, so `react/no-unescaped-entities` stays quiet).

- [ ] **Step 10: Browser check** — `orbit-web`, open `/privacy`: 17 sections in the table of contents, the Google table renders, the Limited Use sentence links to Google's policy, processors grid shows 20 cards. At 375 px, the table scrolls sideways inside its own container and the page does not.

- [ ] **Step 11: Commit**

```bash
git add src/lib/legal.ts "src/app/(site)/(docs)/privacy/page.tsx" scripts/smoke-legal-pages.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Rewrite the privacy policy to match what Orbit does

Adds the Google Limited Use statement and a per-scope table read from code,
describes the recruiter scan and shared directory, lists every processor,
fixes photo retention, and states plainly what the operator console shows,
does and logs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Terms — billing via Stripe, refunds end access, deletion from Settings (A3, B9)

**Files:**
- Modify: `src/app/(site)/(docs)/terms/page.tsx:14-19, 27, 135-146, 222-228, 241-259, 291-302, 331-337`
- Test: `scripts/smoke-legal-pages.ts` (terms checks)

**Interfaces:**
- Consumes: `LEGAL_LAST_UPDATED` (Task 7), `TIMELINE_DAILY_CONTACT_CAP` (Task 9); self-service deletion (Task 8); Phase 0's A4 revocation.
- Produces: nothing new in code.

- [ ] **Step 1: Confirm Phase 0's refund behaviour** — `sed -n "/charge.refunded/,/charge.dispute.closed/p" src/lib/billing-stripe.ts | head -80`. A full refund of a Lifetime charge must end Lifetime, and a refunded subscription invoice or a lost dispute must end Pro now. If either still returns `mirror: null` with no revocation, STOP: the refunds bullet below would be false. If Phase 0 revokes only on full refunds, keep the wording "refunded in full" as written.

- [ ] **Step 2: Write the failing test** — in `scripts/smoke-legal-pages.ts` add after the `privacy` read: `const terms = readFileSync("src/app/(site)/(docs)/terms/page.tsx", "utf8");`, and before the failure summary:

```ts
console.log("Terms");
check("subscriptions are no longer said to run through Clerk", !terms.includes("Clerk&apos;s billing") && !terms.includes("Clerk's billing"));
check("billing is said to run through Stripe", terms.includes("Payments are handled by Stripe"));
check("refunds and chargebacks end access", terms.includes("Refunds and chargebacks end what they paid for"));
check("account deletion from Settings is described", terms.includes("delete your account yourself"));
check("the Terms date comes from legal.ts", terms.includes("LEGAL_LAST_UPDATED"));
check("the timeline cap is quoted from code", terms.includes("TIMELINE_DAILY_CONTACT_CAP"));
```

- [ ] **Step 3: Run it and watch it fail** — `npx tsx scripts/smoke-legal-pages.ts` → six `FAIL` lines under "Terms", exit 1.

- [ ] **Step 4: Edit the page**

Imports: after the `@/lib/plan-limits` import (line 19) add:

```ts
import { LEGAL_LAST_UPDATED } from "@/lib/legal";
import { TIMELINE_DAILY_CONTACT_CAP } from "@/lib/timeline-cost";
```

Line 27 becomes `const LAST_UPDATED = LEGAL_LAST_UPDATED;`.

The `account` section (lines 135-146) becomes:

```tsx
        <DocSection id="account" index={4} title="Your account">
          <p>
            Accounts are handled by our authentication provider, Clerk. You are
            responsible for keeping your credentials secure and for everything
            that happens under your account. Tell us promptly if you believe it
            has been accessed by someone else.
          </p>
          <p>
            Provide accurate account information, and keep it current. One
            person, one account — don&apos;t share logins or resell access.
            Orbit records when you accepted these Terms and which version.
          </p>
          <p>
            You can delete your account yourself, at any time, in Settings under
            Data and privacy. Deleting it erases your Orbit data, cancels an
            active Orbit Pro subscription, and removes your sign-in.
          </p>
        </DocSection>
```

The first paragraph of the `keys` section (lines 222-228) becomes:

```tsx
          <p>
            Orbit integrates with services including Clerk, Vercel, Neon, Stripe,
            AI providers (Google Gemini, OpenAI, Anthropic), Wispr Flow, Apollo,
            Resend, Twilio, Google (Gmail, Contacts and Calendar), Microsoft
            (Outlook contacts), Eventbrite, Luma and Partiful. The{" "}
            <Link href="/privacy">Privacy Policy</Link> lists every service that
            receives data and why. Each has its own terms and privacy policy, and
            your use of them through Orbit is also subject to those.
          </p>
```

In the `ai` section, after its first `<p>…billed to your own key.</p>` (ends line 247) add:

```tsx
          <p>
            Some AI work runs in the background: search indexing, and — only if
            you turn it on — deriving timeline events from imported LinkedIn
            conversations, which shows an estimated cost before you do and is
            capped at {TIMELINE_DAILY_CONTACT_CAP} conversations a day. Settings
            shows the last 30 days of AI usage and its estimated cost; the bill
            itself comes from your provider.
          </p>
```

In the `plans` list, replace the "Cancel whenever you like" and "Payments are handled by our providers" items (lines 291-302) with:

```tsx
            <li>
              <strong>Cancel whenever you like.</strong> Write to us through the{" "}
              <Link href="/contact">contact page</Link> and Orbit Pro ends at the
              close of the period you have already paid for; deleting your account
              in Settings cancels it immediately. Cancelling part-way through a
              period does not trigger a pro-rated refund.
            </li>
            <li>
              <strong>Payments are handled by Stripe.</strong> Both Orbit Pro and
              Orbit Lifetime are sold through Stripe, whose terms govern the
              transaction itself, and taxes are added where the law requires.
              Orbit never sees your card.
            </li>
            <li>
              <strong>Refunds and chargebacks end what they paid for.</strong> If
              a payment is refunded in full, or reversed after a lost dispute, the
              plan it paid for ends when Orbit records it and your account returns
              to the Free Plan. Nothing in your account is deleted.
            </li>
```

The first paragraph of `termination` (lines 331-337) becomes:

```tsx
          <p>
            You can stop using Orbit at any time, and delete some or all of your
            data, or your whole account, from Settings. We may suspend or
            terminate access if you materially breach these Terms, if your use
            puts the service or other people at risk, or if we discontinue the
            product — and we will give notice where it is reasonable to do so.
          </p>
```

- [ ] **Step 5: Run the tests and watch them pass** — `npx tsx scripts/smoke-legal-pages.ts && npx tsx scripts/smoke-public-routes.ts` → both pass.

- [ ] **Step 6: Typecheck, lint** — `npm run typecheck && npm run lint` → clean.

- [ ] **Step 7: Browser check** — `orbit-web`, open `/terms`: "Last updated" shows `LEGAL_LAST_UPDATED`; the plans section lists the three new bullets; the account section mentions self-service deletion.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(site)/(docs)/terms/page.tsx" scripts/smoke-legal-pages.ts
git commit -m "$(cat <<'EOF'
Update the Terms: Stripe billing, refunds end access, deletion in Settings

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Existing accounts accept the current Terms once, from anywhere in the app (B9a, gap)

Task 7 records acceptance from Clerk's consent checkbox (new sign-ups) and from guided setup. An account that signed up before Clerk's consent setting was on and never reopens guided setup would stay unrecorded forever, and a later `TERMS_VERSION` bump would never be re-accepted by anyone. This task shows a notice at the top of every app page until the current version is accepted.

**Files:**
- Modify: `src/lib/legal.ts` (add `shouldShowTermsNotice` and `TERMS_NOTICE_COPY`)
- Create: `src/components/legal/terms-update-notice.tsx`
- Modify: `src/app/(clerk)/(app)/layout.tsx` — imports, and the `<AppShell>` children (currently `{children}` after `<SectionFlash />`)
- Modify: `scripts/smoke-terms-acceptance.ts` (pure checks appended)

**Interfaces:**
- Consumes (Task 7): `needsTermsAcceptance(termsVersion)`, `TERMS_VERSION`, the `acceptTerms(): Promise<{ ok: true }>` server action in `src/actions/onboarding-wizard.ts`; (Task 1) `settings.termsVersion` on the row `bootstrapAuthenticatedUser` already returns in the layout.
- Produces: `shouldShowTermsNotice(input: { clerkOn: boolean; demoMode: boolean; termsVersion: string | null | undefined }): boolean`; `TERMS_NOTICE_COPY = { title, body, accept, retry }`; client component `TermsUpdateNotice`.

- [ ] **Step 1: Write the failing test**

Append to the end of `scripts/smoke-terms-acceptance.ts`'s `run(async () => { … })` body, before its final pass/fail line:

```ts
  console.log("\nThe in-app notice for accounts that never accepted the current Terms");
  const { shouldShowTermsNotice, TERMS_NOTICE_COPY } = await import("../src/lib/legal");
  check("an account with no recorded acceptance sees it",
    shouldShowTermsNotice({ clerkOn: true, demoMode: false, termsVersion: null }));
  check("an account on an older version sees it",
    shouldShowTermsNotice({ clerkOn: true, demoMode: false, termsVersion: "2020-01-01" }));
  check("an account on the current version does not",
    !shouldShowTermsNotice({ clerkOn: true, demoMode: false, termsVersion: TERMS_VERSION }));
  check("demo mode never shows it (demo-user is not a person)",
    !shouldShowTermsNotice({ clerkOn: false, demoMode: true, termsVersion: null }));
  check("without Clerk nobody is signed in to accept",
    !shouldShowTermsNotice({ clerkOn: false, demoMode: false, termsVersion: null }));
  check("the copy follows the house voice",
    !/failed|Could not|\.$/.test(Object.values(TERMS_NOTICE_COPY).join(" ")) &&
      TERMS_NOTICE_COPY.title.includes("’"));
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-terms-acceptance.ts`
Expected: exits 1 — `shouldShowTermsNotice` is not a function (the import resolves, the export does not exist yet).

- [ ] **Step 3: Implement the decision and the copy**

Append to `src/lib/legal.ts` (it stays DB-free):

```ts
/**
 * Whether the app shell should ask this account to accept the current Terms.
 *
 * Only for a real signed-in account (Clerk on, not the shared local demo user), and only
 * while the recorded version is not the current one — which covers both "never recorded"
 * (accounts that predate Clerk's consent checkbox) and "accepted an older version".
 */
export function shouldShowTermsNotice(input: {
  clerkOn: boolean;
  demoMode: boolean;
  termsVersion: string | null | undefined;
}): boolean {
  if (!input.clerkOn || input.demoMode) return false;
  return needsTermsAcceptance(input.termsVersion);
}

export const TERMS_NOTICE_COPY = {
  title: "We’ve updated our Terms and Privacy Policy",
  body: "Please read them. Accepting records that you agree to the version dated " + LEGAL_LAST_UPDATED,
  accept: "Accept",
  retry: "Couldn’t record that — try again",
} as const;
```

(`LEGAL_LAST_UPDATED` is defined earlier in the same file by Task 7; if the constant sits below this block, move the block after it.)

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-terms-acceptance.ts`
Expected: all checks pass, exit 0.

- [ ] **Step 5: The notice and its place in the shell**

Create `src/components/legal/terms-update-notice.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { acceptTerms } from "@/actions/onboarding-wizard";
import { buttonVariants } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { TERMS_NOTICE_COPY } from "@/lib/legal";
import { cn } from "@/lib/utils";

/**
 * Sits at the top of every app page until the current Terms are accepted. Not a modal: it
 * never blocks someone from reaching their own data, and it cannot be dismissed without
 * accepting, so the record it produces is an explicit click on a named version.
 */
export function TermsUpdateNotice() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <section
      aria-labelledby="terms-update-title"
      className="mb-6 flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="space-y-1">
        <h2 id="terms-update-title" className="text-sm font-medium text-ink">
          {TERMS_NOTICE_COPY.title}
        </h2>
        <p className="text-sm text-muted-foreground">
          {TERMS_NOTICE_COPY.body}:{" "}
          <Link href="/terms" className="underline underline-offset-2">Terms</Link>
          {" · "}
          <Link href="/privacy" className="underline underline-offset-2">Privacy Policy</Link>
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={pending}
        className={cn(buttonVariants({ size: "sm" }), "shrink-0")}
        onClick={() => {
          setError(null);
          start(async () => {
            try {
              await acceptTerms();
              router.refresh();
            } catch (err) {
              setError(friendlyError(err, TERMS_NOTICE_COPY.retry));
            }
          });
        }}
      >
        {TERMS_NOTICE_COPY.accept}
      </button>
    </section>
  );
}
```

In `src/app/(clerk)/(app)/layout.tsx`, import `TermsUpdateNotice` from `@/components/legal/terms-update-notice` and `shouldShowTermsNotice` from `@/lib/legal`, compute after the suspension redirect:

```ts
  const showTermsNotice = shouldShowTermsNotice({
    clerkOn,
    demoMode,
    termsVersion: settings.termsVersion,
  });
```

and render it directly above `{children}` inside `<AppShell>`:

```tsx
      {showTermsNotice && <TermsUpdateNotice />}
      {children}
```

`AppShell` early-returns a bare shell for `/onboarding`; that is fine — guided setup has its own Task 7 checkbox, and the notice appears on the first page after it if acceptance still is not recorded.

- [ ] **Step 6: Typecheck, lint, voice, browser**

Run: `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts`
Expected: exit 0.

Browser, with the Clerk test keys in `.env.local` (no `DATABASE_URL`) and a test user whose `terms_version` is null: the notice shows on `/dashboard`, `/contacts` and `/settings`; the Terms and Privacy links open; **Accept** hides it after the refresh and the row now carries `TERMS_VERSION` and a timestamp. In demo mode (no Clerk keys) it never shows. At 375px the notice stacks: text above, button below, no horizontal scroll.

- [ ] **Step 7: Commit**

```bash
git add src/lib/legal.ts src/components/legal/terms-update-notice.tsx "src/app/(clerk)/(app)/layout.tsx" scripts/smoke-terms-acceptance.ts
git commit -m "$(cat <<'EOF'
Ask existing accounts to accept the current Terms from the app shell

Acceptance was recorded only by Clerk's sign-up consent and guided setup, so
older accounts and future Terms versions went unrecorded. Every app page now
shows a notice until the current TERMS_VERSION is accepted with one click.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Phase verification and the pull request

**Files:** none changed unless a check fails.

- [ ] **Step 1: The whole suite** — stop this worktree's dev server, then `npm test`. Expected: every script passes, including the nine new ones (`smoke-preserved-settings`, `smoke-admin-redaction`, `smoke-google-scopes`, `smoke-gmail-scope-storage`, `smoke-terms-acceptance`, `smoke-delete-my-account`, `smoke-timeline-cost`, `smoke-usage-summary`, `smoke-legal-pages`) and the extended `smoke-linkedin-timeline-backfill`, `smoke-admin-unmasked`, `smoke-admin-actions`, `smoke-friendly-error` and `smoke-page-budgets`. If `smoke-admin-render` or an instrumentation script times out, rerun it alone before suspecting code (machine load).

- [ ] **Step 2: Build** — `npm run build` → succeeds. (A build wedges a running dev server in the same worktree; restart `orbit-web` afterwards if you need it.)

- [ ] **Step 3: Re-scan the schema version** — run the scan from the Global Constraints. If any remote branch now claims a number ≥ this branch's `SCHEMA_VERSION`, repeat Task 1 Step 7 (a new, higher number and changelog line), then `npx tsx scripts/smoke-schema-ddl.ts --update`, rerun `smoke-schema-ddl`, and commit.

- [ ] **Step 4: Check for rival work on main** — `git fetch -q origin && git log --oneline HEAD..origin/main`. If `origin/main` moved, merge it, and if the merge brought DDL, bump the version again (Step 3). Search for overlaps: `git grep -n "include_granted_scopes\|deleteOwnAccount\|timeline_backfill_enabled" origin/main -- src` should print nothing.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin claude/launch-p1
gh pr create --base main --head claude/launch-p1 --title "Launch Phase 1: say true things" --body "$(cat <<'EOF'
Implements launch Phase 1 of docs/superpowers/plans/2026-09-15-launch-readiness-roadmap.md (audit A3, A6, B4, B5 scopes, B8 usage card, B9).

- Privacy policy and Terms rewritten to match the code: Google Limited Use statement and per-scope table, recruiter scan and shared directory, full processor list, photo retention, operator access as it really is.
- Operator console: every contact view logged by id; sign-in links need a typed reason; NEVER_REVEALABLE covers every encrypted column plus capture text, transcripts and photos.
- Google: one scope per entry point with incremental consent; missing-scope detection; calendar and confirmation-email entry points.
- Terms acceptance recorded (Clerk legal_accepted_at or a guided-setup checkbox); self-service account deletion that cancels Stripe and removes the Clerk user.
- LinkedIn timeline backfill: opt-in, fast tier, one-message threads skip the model, 300 conversations a day, estimate shown first.
- AI usage card (30 days, estimated cost). /knowledge bounded and under the page budget.

One schema bump (user_settings.terms_accepted_at, terms_version, timeline_backfill_enabled).

Manual steps before merge: see the plan's "Manual steps (not code)" — Clerk consent setting, Google verification submission, legal review.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Manual steps (not code)

1. **Clerk — express legal consent (M9).** Clerk Dashboard → the production application → Configure → Legal (in some dashboard layouts: User & authentication → Legal compliance) → turn on **Require express consent to legal documents**. Terms of Service URL `https://orbit.jasonpereira.live/terms`, Privacy Policy URL `https://orbit.jasonpereira.live/privacy`. Save. Then Configure → Webhooks → the production endpoint → confirm `user.created`, `user.updated` and `user.deleted` are subscribed (Task 7 reads `legal_accepted_at` from `user.created`). Repeat on the development instance so sign-ups in previews show the checkbox. Verify by signing up a throwaway account on a preview: the checkbox appears, and `SELECT terms_accepted_at, terms_version FROM user_settings WHERE user_id = '<id>'` is filled.
2. **Clerk — self-deletion.** User & authentication → Account → "Allow users to delete their accounts" can stay on: Clerk's own deletion fires `user.deleted`, which Phase 0 made a full purge. Orbit's own Settings button (Task 8) also cancels Stripe, which Clerk's does not — prefer pointing people to Orbit's.
3. **Google Cloud — consent screen and verification (M10), after this phase is on production.**
   - Google Cloud Console → Google Auth Platform → **Branding**: application home page `https://orbit.jasonpereira.live`, privacy policy `https://orbit.jasonpereira.live/privacy`, terms `https://orbit.jasonpereira.live/terms`; authorized domain `jasonpereira.live`.
   - **Data Access**: the scope list must be exactly `openid`, `userinfo.email`, `contacts.readonly`, `gmail.readonly`, `gmail.send`, `calendar.readonly`. For each, paste the "What Orbit does with it" and "Asked for when" text from `GOOGLE_SCOPE_DISCLOSURES` in `src/lib/legal.ts` as the justification.
   - Record the demo video Google requires: sign in, open Imports → Google Contacts → Connect (consent screen shows contacts only); Recruiters → Connect Gmail → Scan; the composer → Allow Gmail to send → send one message; Events → Google Calendar → Connect; Events → Confirmation emails → Turn on. Upload unlisted to YouTube and link it in the form.
   - **Verification Center → Submit for verification.** `gmail.readonly` and `gmail.send` are restricted scopes: expect a security assessment (CASA) request and weeks of review. Until it passes, only listed test users can connect Gmail — keep the beta list on the test-user list.
4. **Legal review (D4).** Send `/privacy` and `/terms` (rendered, from the preview) to a lawyer or a privacy-policy review service before launch, with three questions flagged: the operator-access paragraph (a process commitment — views are logged, not gated); the cancellation wording (there is no self-serve cancel button, see Self-review); and whether the Limited Use section is sufficient for the restricted Gmail scopes.
5. **Vercel Pro (A10, roadmap D1)** is not in this plan; it is the roadmap's decision D1 and gates the first paying stranger.

## Self-review

**Audit item → task**

| Audit item | Task(s) |
|---|---|
| A3 — operator-access copy made true and auditable (contact view logged by id, typed reason for `mintSignInLink`) | 3, 14 |
| A3 — `NEVER_REVEALABLE` for source text, transcripts, capture photos, event-provider secrets, Wispr key; smoke that every `*_encrypted` column is listed | 2 |
| A3 — Google Limited Use paragraph + per-scope table | 4 (scopes), 14 (constants, copy, smoke) |
| A3 — photo retention, recruiter scan, shared directory, complete processor list, last-updated dates | 14 |
| A3 — Terms: Stripe billing, refunds revoke access | 15 |
| B5 subset — scopes per entry point, `include_granted_scopes`, union of granted scopes (no `|| GMAIL_SCOPES`), `hasGmailReadScope`, `missing_scope` redirect and copy | 4, 5, 6 |
| B9a — `terms_accepted_at` / `terms_version`, Clerk `legal_accepted_at`, onboarding-wizard checkbox, `TERMS_VERSION` | 1, 7 |
| B9b — "Delete my account" with typed confirmation, `purgeUserData(…, { keepSettings: false })`, Clerk `deleteUser`, idempotent with the webhook | 8 |
| A6 — fast tier, skip < 2 messages, 300/UTC day via `rate_limit_buckets`, opt-in `timeline_backfill_enabled` (default off), estimate on the import card | 1, 9, 10, 11 |
| B8 subset — 30-day AI usage card from `usage_events` with estimated cost | 12 |
| B4 — `/knowledge` projected and bounded, in `smoke-page-budgets` with a bytes-per-contact check | 13 |

**Columns added (Task 1):** `user_settings.terms_accepted_at timestamptz`, `user_settings.terms_version text`, `user_settings.timeline_backfill_enabled integer NOT NULL DEFAULT 0`. All three are in `PRESERVED_SETTINGS_COLUMNS`.

**Deviations from the brief, on purpose**
- The sign-in-link reason is stored in `admin_audit_log.reason`, not `detail`: `reason` is the column every other operator action uses and the audit page renders.
- Contact views are not throttled (account views stay throttled at one an hour), so "every contact record opened is recorded" is literally true.
- Self-service deletion also cancels live Stripe subscriptions first, because Orbit has no self-serve cancellation; without it a deleted account keeps being billed.
- Calendar sync had no entry point of its own; Task 6 adds a "Google Calendar → Connect" row on the Events card so `calendar.readonly` is asked for by the feature that uses it.
- The terms-consent fallback lives on guided setup's first step, as specified. Accounts that signed up before Clerk's consent setting is on AND never open guided setup stay unrecorded; a follow-up could show the same checkbox as a one-time banner in the app shell.

**Gaps found, not fixed here (out of scope)**
- No self-serve subscription cancellation exists (no Stripe Customer Portal). The Terms now say "write to us, or delete your account". Several US state auto-renewal laws expect online cancellation; recommend a Stripe Customer Portal button in Phase 2.
- `scripts/demo-signin-link.ts` mints sign-in tokens with the Clerk secret key and writes no audit row. The policy's "each requires a written reason, recorded" is true of the console only; either make the script call `mintSignInLink` or restrict the key.
- `rate_limit_buckets` rows keyed by user id are never cleaned up (true before this phase too); the policy mentions "operational counters keyed by that id".

**Could not verify in code:** Clerk's exact dashboard menu names; Google's current console labels; whether production's Clerk instance already has express consent on; the exact semantics Phase 0 gave refunds (Task 15 Step 1 checks before the copy ships); calendar sync's forward window (the table says "recent and upcoming").

**Placeholder and name check:** no TBDs; every function named in an Interfaces block is defined in the task that produces it (`recordContactView`, `googleScopesFor`, `hasGmailReadScope`, `unionScopes`, `grantCovers`, `missingScopeMessage`, `termsAcceptanceFromClerk`, `needsTermsAcceptance`, `recordTermsAcceptance`, `acceptTerms`, `deleteOwnAccount`, `deleteMyAccount`, `usableTimelineMessageCount`, `qualifiesForTimelineAi`, `estimateTimelineCostMicros`, `timelineEstimateLabel`, `utcDayKey`, `pendingTimelineAiContactCount`, `getTimelineBackfillStatus`, `setTimelineBackfillEnabled`, `loadUsageSummary`, `getMyAiUsage`, `loadKnowledgeBase`). The schema version is computed in Task 1 Step 7 and re-checked in Task 16 Step 3.
