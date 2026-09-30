# Email Intelligence Foundation (P0 + P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the consent gate, storage, and a durable polling sweep that reads career-relevant Gmail threads, triages them, and records deterministic hiring-stage events, with no AI and no Radar change yet.

**Architecture:** A new opt-in setting (`user_settings.email_intel_enabled`) arms a 15-minute sweep on its own `ops.yml` schedule. The sweep lease-claims accounts, lists new Gmail messages after a watermark, fetches thread metadata in batches, runs the already-committed recruiter triage helpers, and writes `email_threads` (every thread it judged) plus rule-derived `email_events` (ATS stage changes). Human threads that pass triage are stored as `pending_ai` for the P2 plan.

**Tech Stack:** Next.js (App Router, read `node_modules/next/dist/docs/` before touching route or server-action conventions), Drizzle on Neon-http / PGlite, zod, `tsx` smoke scripts.

**Spec:** `docs/superpowers/specs/2026-09-30-email-intelligence-design.md` (sections 1, 2, 3, and the ATS-rule half of 4). Later phases (P2 AI extraction, P3 people and ranking, P4 Radar signals, P5 search) each get their own plan after this one lands, because they consume the interfaces this plan defines.

## Global Constraints

- Schema version must be **above 142**. At plan time the highest version claimed on any ref or worktree is **144** (another worktree), so this plan uses **145**. Re-scan before committing (Task 2 gives the command); if 145 is taken, use the next free integer everywhere this plan says 145.
- `user_settings.email_intel_enabled` defaults to **0** (opt-in). Consent must never survive a data wipe, so do not add it to `PRESERVED_SETTINGS_COLUMNS`.
- Plan gating matches the recruiter scan: `getEntitlements(userId).canUseRecruiters === true` (Pro and Lifetime). Background code must not call `requireEntitlement` (it records gate hits and throws).
- **No AI in this plan.** No message body is fetched: Gmail thread metadata (`format=metadata`) only. Stored text is limited to subject, participants, and one short evidence snippet (Gmail's own preview, at most 200 characters). Privacy copy must say exactly that.
- Backfill on first enable: **14 days**. Watermark overlap: **2 days** (Gmail `after:` is date-granular). Sweep cadence: every **15 minutes** on its own cron line, never a rider on another schedule.
- Daily cap: `RATE_LIMITS.emailIntelDaily = { limit: 300, windowSec: 86_400 }` threads fetched per account per UTC day.
- Routes use `isInternalRequest` (`src/lib/internal-auth.ts`), export `maxDuration = 300`, and are listed in `src/lib/public-routes.ts`.
- `neon-http` has no transactions: every claim is one conditional `UPDATE ... RETURNING`.
- Every smoke: pure ones import nothing DB-related; PGlite ones start with `import "./smoke/_env";` (the guard in `scripts/run-smoke.ts` enforces it). Register each new smoke in `MANIFEST` in `scripts/run-smoke.ts`; `npx tsx scripts/run-smoke.ts --check` must pass.
- PGlite is single-writer: stop any running `next dev` before running PGlite smokes or builds.
- In zsh, `git show "$ref:path"` fires modifiers; wrap such commands in `bash -c '...'`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/email-intel/types.ts` (create) | Shared types: `ThreadDecision`, `RuleEvent`, `ThreadResult`, `EmailThreadStatus`, `EmailEventKind`, `statusFor` |
| `src/lib/email-intel/triage.ts` (create) | Pure: `assessThread`, `companyFromSender`. Wraps `triageThread` / `deriveAtsStage`. No DB, no network |
| `src/lib/email-intel/store.ts` (create) | DB: `upsertThreadResult`, `knownThreadVersions`, `deleteEmailIntelData` |
| `src/lib/email-intel/sweep.ts` (create) | `runEmailIntelSweep(deps)`: claim, list, fetch, assess, store, settle |
| `src/app/api/email-intel/sweep/route.ts` (create) | Internal POST entry point |
| `src/actions/email-intel.ts` (create) | `setEmailIntel(enabled)` server action |
| `src/components/settings/email-intel-setting.tsx` (create) | Settings switch, starts the Gmail grant when mail access is missing |
| `src/db/schema.ts`, `src/db/index.ts` (modify) | Columns on `user_settings`, tables `email_threads` and `email_events`, DDL, version 145 |
| `src/lib/google-scopes.ts`, `src/lib/legal.ts`, privacy page (modify) | Purpose `email_intel`, scope disclosure, copy, terms bump |
| `src/lib/user-data.ts`, `src/actions/gmail.ts` (modify) | Purge, export, and disconnect cascade |
| `src/lib/cron-runs.ts`, `src/lib/public-routes.ts`, `.github/workflows/ops.yml`, `src/lib/ops-alerts.ts`, `src/lib/ops-sweep.ts`, `docs/RUNBOOK.md` (modify) | Scheduling and alerting |
| `scripts/smoke-email-intel-*.ts` (create) | Smokes, one per unit |

---

### Task 1: Consent gate (purpose, disclosure, copy, terms bump)

**Files:**
- Modify: `src/lib/google-scopes.ts` (purposes, `PURPOSE_SCOPE`)
- Modify: `src/lib/legal.ts` (`TERMS_VERSION`, `LEGAL_LAST_UPDATED`, the `gmailRead` disclosure row)
- Modify: `src/app/(site)/(docs)/privacy/page.tsx` (new callout after the "Confirmation emails" callout, around line 241-253)
- Modify: `scripts/legal-pages.lock.json` (via `--update`)
- Create: `scripts/smoke-email-intel-consent.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST)

**Interfaces:**
- Produces: `GooglePurpose` gains `"email_intel"`, mapped to `GOOGLE_SCOPES.gmailRead`. `GOOGLE_CONNECT_PURPOSES` must NOT contain it (everyday Connect never asks for mail).

- [ ] **Step 1: Write the failing smoke**

```ts
/**
 * The email-intelligence consent surface: the purpose exists, asks for the mail scope only
 * when a feature button asks, and the legal copy says what the code does.
 *
 * Pure. Run: npx tsx scripts/smoke-email-intel-consent.ts
 */
import { readFileSync } from "node:fs";
import {
  GOOGLE_CONNECT_PURPOSES,
  GOOGLE_SCOPES,
  googleScopesFor,
  isGooglePurpose,
  requiredScopeFor,
} from "../src/lib/google-scopes";
import { GOOGLE_SCOPE_DISCLOSURES, TERMS_VERSION } from "../src/lib/legal";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

check("email_intel is a Google purpose", isGooglePurpose("email_intel"));
check("it needs the Gmail read scope", requiredScopeFor("email_intel") === GOOGLE_SCOPES.gmailRead);
check(
  "asking for it requests gmail.readonly",
  googleScopesFor(["email_intel"]).includes(GOOGLE_SCOPES.gmailRead)
);
check("everyday Connect never asks for mail", !GOOGLE_CONNECT_PURPOSES.includes("email_intel"));

const gmailRow = GOOGLE_SCOPE_DISCLOSURES.find((r) => r.scope === GOOGLE_SCOPES.gmailRead);
check("the Gmail scope disclosure names the feature", /email insights/i.test(gmailRow?.use ?? ""));
check("and still promises no stored bodies", /never stored/i.test(gmailRow?.use ?? ""));
check("the terms version moved off 2026-09-29", TERMS_VERSION !== "2026-09-29", TERMS_VERSION);

const privacy = readFileSync("src/app/(site)/(docs)/privacy/page.tsx", "utf8");
check("the privacy page has an Email insights callout", /title="Email insights"/.test(privacy));
check(
  "it says no message body is stored and no AI reads it yet",
  /no message bod(y|ies)/i.test(privacy) && /does not send (this )?mail to an AI/i.test(privacy)
);
console.log("\nAll email-intel consent checks passed.");
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-email-intel-consent.ts`
Expected: FAIL at "email_intel is a Google purpose".

- [ ] **Step 3: Add the purpose**

In `src/lib/google-scopes.ts`:

```ts
export const GOOGLE_PURPOSES = ["contacts", "recruiter_scan", "send", "calendar", "event_mail", "drive", "email_intel"] as const;
```

and in `PURPOSE_SCOPE` add `email_intel: GOOGLE_SCOPES.gmailRead,`. Leave `missingScopeMessage` alone: its `default` branch already reads "Google didn’t grant mail access — reconnect and allow it", which is right for this purpose. Run `npx tsc --noEmit`; any exhaustive `Record<GooglePurpose, ...>` elsewhere (grep `GooglePurpose` in `src/components/events/event-connections-card.tsx` and `src/components/settings/use-provider-connection.ts`) gets the same one-line entry.

- [ ] **Step 4: Update the disclosure and terms constants**

In `src/lib/legal.ts` set (use the real date you make the change, shown here for 2026-09-30):

```ts
export const TERMS_VERSION = "2026-09-30";
export const LEGAL_LAST_UPDATED = "September 30, 2026";
```

Replace the `gmailRead` row's `use` and `askedWhen`:

```ts
use: "Recruiter scan: finds recruiting conversations and summarizes each with your own AI key. Confirmation emails: reads mail from Luma, Partiful, Eventbrite, Meetup and Posh to find events you registered for. Email insights: reads the sender, subject and Gmail’s short preview of new job and hiring-process threads to note where each application stands. Message bodies are never stored.",
askedWhen: "Connect Gmail on Recruiters, turn on Confirmation emails on Events, or turn on Email insights in Settings",
```

- [ ] **Step 5: Add the privacy callout**

In `src/app/(site)/(docs)/privacy/page.tsx`, immediately after the closing `</DocCallout>` of "Confirmation emails", add:

```tsx
          <DocCallout title="Email insights">
            <p>
              If you turn on Email insights in Settings, Orbit checks your Gmail every fifteen
              minutes for new threads that look like a job application or a recruiter
              conversation, excluding newsletters and mailing lists. For each thread it reads
              only the sender, the subject, who is on it, and the short preview Gmail supplies —
              never the body. It keeps the thread id, the subject, the participants, a note of
              where an application stands (applied, interviewing, offer, or rejected) and that
              one preview line as evidence. It stores no message bodies and does not send this
              mail to an AI provider. Turning it off stops the checking; disconnecting Gmail, or
              deleting your insights in Settings, removes what it recorded.
            </p>
          </DocCallout>
```

The phrases the smoke asserts ("no message bodies", "does not send this mail to an AI") are in this text. When a later plan starts sending mail text to a model, that plan must rewrite this callout and bump the terms again.

- [ ] **Step 6: Refresh the lock, register, run**

```bash
npx tsx scripts/smoke-legal-pages.ts --update
npx tsx scripts/smoke-legal-pages.ts
npx tsx scripts/smoke-email-intel-consent.ts
npx tsx scripts/smoke-google-scopes.ts
```

Add `"smoke-email-intel-consent": "pure",` to the pure block of `MANIFEST` in `scripts/run-smoke.ts`. Expected: all four pass, `git diff scripts/legal-pages.lock.json` shows only the new date, version, and fingerprint.

- [ ] **Step 7: Commit**

```bash
git add src/lib/google-scopes.ts src/lib/legal.ts "src/app/(site)/(docs)/privacy/page.tsx" scripts/legal-pages.lock.json scripts/smoke-email-intel-consent.ts scripts/run-smoke.ts
git commit -m "feat(email-intel): consent purpose, scope disclosure, privacy copy, terms bump

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Schema v145 (settings columns and two tables)

**Files:**
- Create: `src/lib/email-intel/types.ts`
- Modify: `src/db/schema.ts` (three `user_settings` columns near `workHistoryAutoEnabled`, two new tables at the end)
- Modify: `src/db/index.ts` (the `user_settings` CREATE TABLE near line 93, the `DDL` string for the new tables, the alters list near line 4297, the `ensureColumn` calls near line 3471, changelog comment, `SCHEMA_VERSION`)
- Modify: `scripts/setup-db.ts` (`EXPECTED_TABLES`)
- Modify: `src/lib/rate-limit.ts` (`RATE_LIMITS.emailIntelDaily`)
- Modify: `scripts/schema-ddl.lock.json` (via `--update`)

**Interfaces:**
- Produces (used by every later task):
  - `userSettings.emailIntelEnabled` (integer, default 0), `emailIntelCursorAt` (timestamptz null), `emailIntelNextAt` (timestamptz null)
  - `emailThreads`, `emailEvents` Drizzle tables (shapes below)
  - types from `src/lib/email-intel/types.ts`

- [ ] **Step 1: Re-scan for the schema version**

```bash
bash -c 'git for-each-ref --format="%(refname)" | while read -r r; do v=$(git show "${r}:src/db/index.ts" 2>/dev/null | grep -m1 -E "^export const SCHEMA_VERSION"); [ -n "$v" ] && echo "$v"; done | sort | uniq -c | sort -t= -k2 -n | tail -4'
bash -c 'for w in $(git worktree list --porcelain | grep "^worktree " | cut -d" " -f2); do grep -m1 -E "^export const SCHEMA_VERSION" "$w/src/db/index.ts" 2>/dev/null; done | sort | uniq -c | sort -t= -k2 -n | tail -3'
```

Expected at plan time: highest is 144. Use `highest + 1` as V for the rest of this task (145 below). Never write a number another branch claimed: both sides writing the same `SCHEMA_VERSION` merges silently and skips one side's DDL.

- [ ] **Step 2: Create the shared types**

`src/lib/email-intel/types.ts`:

```ts
import type { RecruiterStage } from "@/lib/recruiter-stages";

/** What triage decided about a thread. `skipped` threads are remembered so they are never re-fetched. */
export type ThreadDecision = "ats_rule" | "classify" | "skipped";

/** `pending_ai` waits for the P2 extractor; `claimed` and `failed` are its lifecycle. */
export type EmailThreadStatus = "done" | "pending_ai" | "skipped" | "claimed" | "failed";

export type EmailEventKind = "job_posting" | "process_update" | "news" | "event" | "other";

export type EmailEventPerson = {
  name: string | null;
  email: string | null;
  title: string | null;
  contactId?: string | null;
};

/** A hiring-stage event read from an automated template by rule, never by a model. */
export type RuleEvent = {
  kind: "process_update";
  stage: RecruiterStage;
  company: string | null;
  summary: string;
  /** Gmail's own preview line, at most 200 characters. Never a body. */
  evidenceQuote: string;
  occurredAt: Date;
  confidence: number;
};

export type ThreadResult = {
  threadId: string;
  lastMessageId: string;
  /** Empty for skipped threads: nothing about a judged-irrelevant thread is kept beyond its id. */
  subject: string;
  participants: string[];
  lastDirection: "in" | "out";
  decision: ThreadDecision;
  triageScore: number;
  event: RuleEvent | null;
};

export function statusFor(decision: ThreadDecision): EmailThreadStatus {
  if (decision === "classify") return "pending_ai";
  if (decision === "skipped") return "skipped";
  return "done";
}
```

- [ ] **Step 3: Drizzle columns and tables**

In `src/db/schema.ts`, directly after `workHistoryAutoEnabled`:

```ts
  /**
   * Email insights (docs/superpowers/specs/2026-09-30-email-intelligence-design.md). Opt-in,
   * so it defaults to 0 and is deliberately NOT in `PRESERVED_SETTINGS_COLUMNS`: consent must
   * not survive a data wipe. The cursor is the watermark (start of the last complete sweep);
   * next_at is both the schedule and the lease, the same pattern as `work_history_due_at`.
   */
  emailIntelEnabled: integer("email_intel_enabled").default(0).notNull(),
  emailIntelCursorAt: timestamp("email_intel_cursor_at", { withTimezone: true }),
  emailIntelNextAt: timestamp("email_intel_next_at", { withTimezone: true }),
```

At the end of the file (add the type import next to the existing radar type imports at the top: `import type { EmailEventKind, EmailEventPerson, EmailThreadStatus, ThreadDecision } from "@/lib/email-intel/types";`):

```ts
/** One row per Gmail thread the email-insights sweep has judged. Metadata only, never a body. */
export const emailThreads = pgTable(
  "email_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider").$type<"gmail">().default("gmail").notNull(),
    threadId: text("thread_id").notNull(),
    lastMessageId: text("last_message_id").notNull(),
    subject: text("subject").default("").notNull(),
    participants: jsonb("participants").$type<string[]>().default([]).notNull(),
    lastDirection: text("last_direction").$type<"in" | "out">().default("in").notNull(),
    decision: text("decision").$type<ThreadDecision>().notNull(),
    triageScore: integer("triage_score").default(0).notNull(),
    status: text("status").$type<EmailThreadStatus>().notNull(),
    /** The P2 extractor's claim lifecycle (same shape as capture_jobs). Unused until then. */
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    stallResumes: integer("stall_resumes").default(0).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("email_threads_thread_uidx").on(t.userId, t.provider, t.threadId),
    index("email_threads_pending_idx").on(t.userId, t.status).where(sql`status = 'pending_ai'`),
  ]
);

/** What an email meant: a hiring-stage change now, jobs/news/events once the extractor lands. */
export const emailEvents = pgTable(
  "email_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    threadRowId: uuid("thread_row_id")
      .notNull()
      .references(() => emailThreads.id, { onDelete: "cascade" }),
    source: text("source").$type<"rule" | "ai">().default("rule").notNull(),
    kind: text("kind").$type<EmailEventKind>().notNull(),
    company: text("company"),
    role: text("role"),
    stage: text("stage"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    summary: text("summary").notNull(),
    evidenceQuote: text("evidence_quote").default("").notNull(),
    confidence: real("confidence").default(0).notNull(),
    people: jsonb("people").$type<EmailEventPerson[]>().default([]).notNull(),
    asks: jsonb("asks").$type<string[]>().default([]).notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One rule-derived event per kind per thread; AI events (P2) replace by source instead.
    uniqueIndex("email_events_rule_uidx").on(t.threadRowId, t.kind).where(sql`source = 'rule'`),
    index("email_events_user_idx").on(t.userId, t.occurredAt),
  ]
);
```

- [ ] **Step 4: DDL in four places in `src/db/index.ts`**

1. In the `user_settings` `CREATE TABLE` (the block containing `work_history_auto_enabled integer NOT NULL DEFAULT 1,` near line 93) add before `created_at`:

```sql
  email_intel_enabled integer NOT NULL DEFAULT 0,
  email_intel_cursor_at timestamptz,
  email_intel_next_at timestamptz,
```

2. In the alters list next to `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS work_history_auto_enabled ...` (near line 4297):

```ts
  // Schema v145: email insights — opt-in switch, watermark, and schedule/lease per account.
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS email_intel_enabled integer NOT NULL DEFAULT 0`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS email_intel_cursor_at timestamptz`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS email_intel_next_at timestamptz`,
```

3. Next to `await ensureColumn(client, "user_settings", "work_history_auto_enabled", ...)` (near line 3471):

```ts
  await ensureColumn(client, "user_settings", "email_intel_enabled", "integer NOT NULL DEFAULT 0");
  await ensureColumn(client, "user_settings", "email_intel_cursor_at", "timestamptz");
  await ensureColumn(client, "user_settings", "email_intel_next_at", "timestamptz");
```

4. In the `DDL` string, beside the `capture_jobs` table (copy its uuid default expression if it differs from `gen_random_uuid()`):

```sql
CREATE TABLE IF NOT EXISTS email_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  provider text NOT NULL DEFAULT 'gmail',
  thread_id text NOT NULL,
  last_message_id text NOT NULL,
  subject text NOT NULL DEFAULT '',
  participants jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_direction text NOT NULL DEFAULT 'in',
  decision text NOT NULL,
  triage_score integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  claim_token uuid,
  claimed_at timestamptz,
  stall_resumes integer NOT NULL DEFAULT 0,
  processed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_threads_thread_uidx ON email_threads(user_id, provider, thread_id);
CREATE INDEX IF NOT EXISTS email_threads_pending_idx ON email_threads(user_id, status) WHERE status = 'pending_ai';
CREATE TABLE IF NOT EXISTS email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  thread_row_id uuid NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'rule',
  kind text NOT NULL,
  company text,
  role text,
  stage text,
  occurred_at timestamptz NOT NULL,
  due_at timestamptz,
  summary text NOT NULL,
  evidence_quote text NOT NULL DEFAULT '',
  confidence real NOT NULL DEFAULT 0,
  people jsonb NOT NULL DEFAULT '[]'::jsonb,
  asks jsonb NOT NULL DEFAULT '[]'::jsonb,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_events_rule_uidx ON email_events(thread_row_id, kind) WHERE source = 'rule';
CREATE INDEX IF NOT EXISTS email_events_user_idx ON email_events(user_id, occurred_at);
```

Above the constant, add the changelog comment in the existing format, then bump:

```ts
// 145 = email insights (Email Intelligence P0/P1): user_settings.email_intel_enabled /
// email_intel_cursor_at / email_intel_next_at plus the email_threads and email_events tables.
// Scanned every local and remote ref and every worktree: 144 is the highest claimed.
export const SCHEMA_VERSION = 145;
```

- [ ] **Step 5: Table list, rate limit, lock**

In `scripts/setup-db.ts` add `"email_threads"` and `"email_events"` to `EXPECTED_TABLES`. In `src/lib/rate-limit.ts`, inside `RATE_LIMITS`, after `workHistoryBackground`:

```ts
  /**
   * Gmail threads the email-insights sweep may fetch per account per UTC day (metadata only).
   * Keyed per UTC day by the sweep, like `workHistoryBackground`.
   */
  emailIntelDaily: { limit: 300, windowSec: 86_400 },
```

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit
npx tsx scripts/smoke-schema-ddl.ts --update
npx tsx scripts/smoke-schema-ddl.ts
npx tsx scripts/smoke-schema-bootstrap.ts
npx tsx scripts/smoke-consume-bucket-args.ts
```

Expected: no type errors; `git diff scripts/schema-ddl.lock.json` shows version 145 and a new fingerprint only; the rest pass. `smoke-purge` is expected to FAIL now (new user-scoped tables); Task 5 fixes it.

- [ ] **Step 7: Commit**

```bash
git add src/lib/email-intel/types.ts src/db/schema.ts src/db/index.ts scripts/setup-db.ts src/lib/rate-limit.ts scripts/schema-ddl.lock.json
git commit -m "feat(email-intel): schema v145 — settings columns, email_threads, email_events

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Thread assessment (pure)

**Files:**
- Create: `src/lib/email-intel/triage.ts`
- Create: `scripts/smoke-email-intel-triage.ts`
- Modify: `scripts/run-smoke.ts` (pure block)

**Interfaces:**
- Consumes: `triageThread`, `deriveAtsStage` (`src/lib/recruiter-triage.ts`), `STAGE_LABELS` (`src/lib/recruiter-stages.ts`), `ATS_SENDER_DOMAINS` and the types `GmailThreadSummary` / `GmailHeaderSummary` (`src/lib/gmail.ts`), `ThreadResult` (Task 2).
- Produces:
  - `assessThread(thread: GmailThreadSummary, userEmail: string): ThreadResult`
  - `companyFromSender(from: string): string | null`

`assessThread` always returns a result. Threads that triage rejects or defers come back with `decision: "skipped"`, empty `subject` and `participants`, and no event, so the store can remember them without keeping anything about them.

- [ ] **Step 1: Write the failing smoke**

```ts
/**
 * Thread assessment: what the email-insights sweep keeps of a Gmail thread.
 * Pure. Run: npx tsx scripts/smoke-email-intel-triage.ts
 */
import type { GmailHeaderSummary, GmailThreadSummary } from "../src/lib/gmail";
import { assessThread, companyFromSender } from "../src/lib/email-intel/triage";

const ME = "me@example.com";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function msg(over: Partial<GmailHeaderSummary>): GmailHeaderSummary {
  return {
    id: "m1",
    threadId: "t1",
    from: "",
    to: `Me <${ME}>`,
    subject: "",
    snippet: "",
    internalDate: Date.UTC(2026, 8, 29, 12),
    listUnsubscribe: "",
    listId: "",
    precedence: "",
    ...over,
  };
}
const thread = (...messages: GmailHeaderSummary[]): GmailThreadSummary => ({ id: "t1", messages });

console.log("\nBulk and noise");
const newsletter = assessThread(
  thread(msg({ from: "News <news@substack.com>", subject: "This week in tech", listUnsubscribe: "<mailto:x>" })),
  ME
);
check("a newsletter is skipped", newsletter.decision === "skipped");
check("a skipped thread keeps no subject", newsletter.subject === "");
check("a skipped thread keeps no participants", newsletter.participants.length === 0);
check("a skipped thread has no event", newsletter.event === null);
check(
  "a friend with no career signal is skipped",
  assessThread(thread(msg({ from: "Sam <sam@friend.com>", subject: "lunch?", snippet: "free thursday?" })), ME)
    .decision === "skipped"
);

console.log("\nAutomated hiring mail");
const applied = assessThread(
  thread(
    msg({
      id: "m2",
      from: "Stripe Recruiting <no-reply@stripe.com>",
      subject: "Thank you for applying to Stripe",
      snippet: "We have received your application for Software Engineer.",
    })
  ),
  ME
);
check("ATS mail is read by rule", applied.decision === "ats_rule");
check("it carries the stage", applied.event?.stage === "applied", String(applied.event?.stage));
check("the kind is process_update", applied.event?.kind === "process_update");
check("the company comes from the sender domain", applied.event?.company === "Stripe");
check("the evidence is the preview line", applied.event?.evidenceQuote.startsWith("We have received"));
check("the last message id is recorded", applied.lastMessageId === "m2");
check("the thread is inbound", applied.lastDirection === "in");
check("the user's own address is not a participant", !applied.participants.includes(ME));

const rejected = assessThread(
  thread(
    msg({
      from: "Recruiting <no-reply@stripe.com>",
      subject: "Update on your application",
      snippet: "Unfortunately we will not be moving forward with your candidacy.",
    })
  ),
  ME
);
check("a rejection is caught before an invitation", rejected.event?.stage === "rejected");

const greenhouse = assessThread(
  thread(
    msg({
      from: "Acme <no-reply@us.greenhouse.io>",
      subject: "Thanks for applying",
      snippet: "Thank you for applying. We have received your application.",
    })
  ),
  ME
);
check("an ATS platform is not named as the company", greenhouse.event?.company === null);

const unmatched = assessThread(
  thread(msg({ from: "Careers <no-reply@stripe.com>", subject: "Hello", snippet: "Welcome to our newsletter." })),
  ME
);
check("automated mail with no stage rule has no event", unmatched.decision === "ats_rule" && unmatched.event === null);

console.log("\nHuman threads");
const recruiter = assessThread(
  thread(
    msg({
      id: "m3",
      from: "Dana Kim <dana@acme.com>",
      subject: "Software Engineer role at Acme",
      snippet: "I’m a technical recruiter at Acme and would love to schedule a call. Are you free Thursday?",
    })
  ),
  ME
);
check("a recruiter thread goes to the classifier", recruiter.decision === "classify");
check("it has no rule event", recruiter.event === null);
check("its subject is kept", recruiter.subject === "Software Engineer role at Acme");
check("its participants are lowercase emails", recruiter.participants.join() === "dana@acme.com");

const replied = assessThread(
  thread(
    msg({ id: "m4", from: "Pat <pat@corp.com>", subject: "Following up", snippet: "Chat?" }),
    msg({ id: "m5", from: `Me <${ME}>`, to: "Pat <pat@corp.com>", subject: "Re: Following up", snippet: "Sure" })
  ),
  ME
);
check("a thread you replied to goes to the classifier", replied.decision === "classify");
check("its last message is yours", replied.lastDirection === "out" && replied.lastMessageId === "m5");

console.log("\nCompany from sender");
check("subdomains are stripped", companyFromSender("Careers <careers@talent.example.com>") === "Example");
check("two-part TLDs are handled", companyFromSender("x@example.co.uk") === "Example");
check("an ATS platform yields no company", companyFromSender("x@greenhouse.io") === null);
check("no address yields no company", companyFromSender("nobody") === null);

console.log("\nAll email-intel triage checks passed.");
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-email-intel-triage.ts`
Expected: FAIL, cannot find module `../src/lib/email-intel/triage`.

- [ ] **Step 3: Implement**

`src/lib/email-intel/triage.ts`:

```ts
/**
 * Decides what the email-insights sweep keeps of one Gmail thread. Pure: no database, no
 * network, no model. It wraps the recruiter triage that was committed as v2 groundwork
 * (`triageThread`, `deriveAtsStage`) and turns its verdict into a storable result.
 *
 * Only headers and Gmail's short preview are read, never a body. A thread judged irrelevant
 * comes back `skipped` with nothing about it kept, so it is remembered by id alone and never
 * fetched again, without becoming a record of the person's private mail.
 */
import type { GmailHeaderSummary, GmailThreadSummary } from "@/lib/gmail";
import { ATS_SENDER_DOMAINS } from "@/lib/gmail";
import { deriveAtsStage, triageThread } from "@/lib/recruiter-triage";
import { STAGE_LABELS } from "@/lib/recruiter-stages";
import type { RuleEvent, ThreadResult } from "./types";

const EVIDENCE_MAX = 200;
/** Second-level suffixes where the company label is one further left. */
const TWO_PART_TLDS = new Set(["co.uk", "com.au", "co.nz", "co.jp", "co.in", "com.br"]);
const EMAIL_RE = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;

function domainOf(from: string): string {
  return from.match(/@([^\s>]+)/)?.[1]?.toLowerCase() ?? "";
}

/**
 * The company a sender belongs to, or null when the sender is an applicant-tracking platform
 * (greenhouse.io is not the employer) or has no usable domain.
 */
export function companyFromSender(from: string): string | null {
  const domain = domainOf(from);
  if (!domain) return null;
  if (ATS_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return null;
  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  const label = TWO_PART_TLDS.has(lastTwo) ? labels[labels.length - 3] : labels[labels.length - 2];
  if (!label) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function participantsOf(headers: GmailHeaderSummary[], userEmail: string): string[] {
  const me = userEmail.trim().toLowerCase();
  const seen = new Set<string>();
  for (const h of headers) {
    for (const found of `${h.from} ${h.to}`.match(EMAIL_RE) ?? []) {
      const email = found.toLowerCase();
      if (email !== me) seen.add(email);
    }
  }
  return [...seen];
}

function ruleEvent(headers: GmailHeaderSummary[], userEmail: string): RuleEvent | null {
  const me = userEmail.trim().toLowerCase();
  const inbound = headers.filter((h) => !(me && h.from.toLowerCase().includes(me)));
  const latest = inbound[inbound.length - 1];
  if (!latest) return null;
  const stage = deriveAtsStage(`${latest.subject} ${latest.snippet}`);
  if (!stage) return null;
  const company = companyFromSender(latest.from);
  const label = STAGE_LABELS[stage];
  const preview = (latest.snippet.trim() || latest.subject.trim()).slice(0, EVIDENCE_MAX);
  return {
    kind: "process_update",
    stage,
    company,
    summary: company ? `${label} — ${company}` : label,
    evidenceQuote: preview,
    occurredAt: new Date(latest.internalDate ?? Date.now()),
    confidence: 0.9,
  };
}

export function assessThread(thread: GmailThreadSummary, userEmail: string): ThreadResult {
  const headers = thread.messages;
  const last = headers[headers.length - 1];
  const base = {
    threadId: thread.id,
    lastMessageId: last?.id ?? "",
    lastDirection: "in" as "in" | "out",
  };
  if (!last) {
    return { ...base, subject: "", participants: [], decision: "skipped", triageScore: 0, event: null };
  }

  const me = userEmail.trim().toLowerCase();
  base.lastDirection = me && last.from.toLowerCase().includes(me) ? "out" : "in";

  const outcome = triageThread({ headers, userEmail });
  if (outcome.decision !== "ats_rule" && outcome.decision !== "classify") {
    return { ...base, subject: "", participants: [], decision: "skipped", triageScore: outcome.score, event: null };
  }
  return {
    ...base,
    subject: (headers[0]?.subject ?? "").trim(),
    participants: participantsOf(headers, userEmail),
    decision: outcome.decision,
    triageScore: outcome.score,
    event: outcome.decision === "ats_rule" ? ruleEvent(headers, userEmail) : null,
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-email-intel-triage.ts`
Expected: every line `ok`, ending "All email-intel triage checks passed." If "a friend with no career signal is skipped" fails, print `triageThread` output for that input and check the score against `TRIAGE_REJECT`/`TRIAGE_ACCEPT` in `src/lib/recruiter-triage.ts`; do not loosen the assertion, adjust the fixture text.

- [ ] **Step 5: Register and commit**

Add `"smoke-email-intel-triage": "pure",` to `MANIFEST`. Then:

```bash
npx tsc --noEmit
git add src/lib/email-intel/triage.ts scripts/smoke-email-intel-triage.ts scripts/run-smoke.ts
git commit -m "feat(email-intel): pure thread assessment over the recruiter triage helpers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Store (idempotent upsert, known-version lookup, delete)

**Files:**
- Create: `src/lib/email-intel/store.ts`
- Create: `scripts/smoke-email-intel-store.ts`
- Modify: `scripts/run-smoke.ts` (pglite block)

**Interfaces:**
- Consumes: `emailThreads`, `emailEvents` (Task 2), `ThreadResult`, `statusFor` (Task 2).
- Produces:
  - `upsertThreadResult(userId: string, result: ThreadResult): Promise<{ changed: boolean }>`; `changed` is false when the stored `last_message_id` already equals the result's.
  - `knownThreadVersions(userId: string, threadIds: string[]): Promise<Map<string, string>>` mapping thread id to stored last message id.
  - `deleteEmailIntelData(userId: string): Promise<void>` deleting the account's events and threads and turning the feature off.

- [ ] **Step 1: Write the failing smoke**

```ts
/**
 * The email-insights store: idempotent upserts, rule events that follow the thread, and a
 * delete that touches only one account. PGlite, no network.
 * Run: npx tsx scripts/smoke-email-intel-store.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { emailEvents, emailThreads, userSettings } from "../src/db/schema";
import {
  deleteEmailIntelData,
  knownThreadVersions,
  upsertThreadResult,
} from "../src/lib/email-intel/store";
import type { ThreadResult } from "../src/lib/email-intel/types";
import { ensureUserSettings } from "../src/lib/user-settings";

const A = "smoke-eis-a";
const B = "smoke-eis-b";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const base = (over: Partial<ThreadResult>): ThreadResult => ({
  threadId: "t1",
  lastMessageId: "m1",
  subject: "Thank you for applying",
  participants: ["no-reply@stripe.com"],
  lastDirection: "in",
  decision: "ats_rule",
  triageScore: 0,
  event: {
    kind: "process_update",
    stage: "applied",
    company: "Stripe",
    summary: "Applied — Stripe",
    evidenceQuote: "We have received your application.",
    occurredAt: new Date("2026-09-29T12:00:00Z"),
    confidence: 0.9,
  },
  ...over,
});

async function rows(userId: string) {
  const db = await getDb();
  return {
    threads: await db.select().from(emailThreads).where(eq(emailThreads.userId, userId)),
    events: await db.select().from(emailEvents).where(eq(emailEvents.userId, userId)),
  };
}

async function main() {
  const db = await getDb();
  await db.delete(emailThreads).where(inArray(emailThreads.userId, [A, B]));
  for (const u of [A, B]) await ensureUserSettings(u);

  console.log("\nUpsert");
  const first = await upsertThreadResult(A, base({}));
  check("a new thread is a change", first.changed);
  let r = await rows(A);
  check("one thread row", r.threads.length === 1);
  check("an ATS thread is done", r.threads[0]!.status === "done");
  check("one rule event", r.events.length === 1 && r.events[0]!.stage === "applied");

  const again = await upsertThreadResult(A, base({}));
  check("the same last message is not a change", !again.changed);
  r = await rows(A);
  check("still one thread and one event", r.threads.length === 1 && r.events.length === 1);

  const moved = await upsertThreadResult(
    A,
    base({
      lastMessageId: "m2",
      event: { ...base({}).event!, stage: "interviewing", summary: "Interviewing — Stripe" },
    })
  );
  check("a new message is a change", moved.changed);
  r = await rows(A);
  check("the stage followed the thread", r.events.length === 1 && r.events[0]!.stage === "interviewing");
  check("the last message id advanced", r.threads[0]!.lastMessageId === "m2");

  console.log("\nStatuses");
  await upsertThreadResult(A, base({ threadId: "t2", decision: "classify", event: null }));
  await upsertThreadResult(A, base({ threadId: "t3", decision: "skipped", subject: "", participants: [], event: null }));
  r = await rows(A);
  const status = (id: string) => r.threads.find((t) => t.threadId === id)?.status;
  check("a human thread waits for the extractor", status("t2") === "pending_ai");
  check("a skipped thread is remembered", status("t3") === "skipped");
  check("neither made an event", r.events.length === 1);

  await upsertThreadResult(A, base({ lastMessageId: "m3", decision: "skipped", subject: "", participants: [], event: null }));
  r = await rows(A);
  check("a thread that turns irrelevant loses its event", r.events.length === 0);

  console.log("\nKnown versions");
  const known = await knownThreadVersions(A, ["t1", "t2", "nope"]);
  check("returns the stored last message ids", known.get("t1") === "m3" && known.get("t2") === "m1");
  check("omits unknown threads", !known.has("nope"));
  check("an empty request is an empty map", (await knownThreadVersions(A, [])).size === 0);

  console.log("\nIsolation and delete");
  await upsertThreadResult(B, base({}));
  check("another account keeps its own row for the same thread id", (await rows(B)).threads.length === 1);
  await db.update(userSettings).set({ emailIntelEnabled: 1 }).where(eq(userSettings.userId, A));
  await deleteEmailIntelData(A);
  check("delete clears the account's threads", (await rows(A)).threads.length === 0);
  check("and its events", (await rows(A)).events.length === 0);
  check("but not another account's", (await rows(B)).threads.length === 1);
  const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, A));
  check("and switches the feature off", settings!.emailIntelEnabled === 0);

  await db.delete(emailThreads).where(inArray(emailThreads.userId, [A, B]));
  console.log("\nAll email-intel store checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-email-intel-store.ts`
Expected: FAIL, cannot find module `../src/lib/email-intel/store`.

- [ ] **Step 3: Implement**

`src/lib/email-intel/store.ts`:

```ts
/**
 * Writes for the email-insights sweep. Idempotent by construction: the thread row is keyed
 * on (user, provider, thread) and only rewritten when its last message id changed, and the
 * rule event is keyed on (thread, kind) so a stage that moves updates one row in place.
 * neon-http has no transactions, so each statement stands alone and is safe to repeat.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { emailEvents, emailThreads, userSettings } from "@/db/schema";
import { statusFor, type ThreadResult } from "./types";

export async function upsertThreadResult(userId: string, result: ThreadResult): Promise<{ changed: boolean }> {
  const db = await getDb();
  const now = new Date();
  const [row] = await db
    .insert(emailThreads)
    .values({
      userId,
      provider: "gmail",
      threadId: result.threadId,
      lastMessageId: result.lastMessageId,
      subject: result.subject,
      participants: result.participants,
      lastDirection: result.lastDirection,
      decision: result.decision,
      triageScore: result.triageScore,
      status: statusFor(result.decision),
      processedAt: now,
    })
    .onConflictDoUpdate({
      target: [emailThreads.userId, emailThreads.provider, emailThreads.threadId],
      set: {
        lastMessageId: result.lastMessageId,
        subject: result.subject,
        participants: result.participants,
        lastDirection: result.lastDirection,
        decision: result.decision,
        triageScore: result.triageScore,
        status: statusFor(result.decision),
        claimToken: null,
        claimedAt: null,
        processedAt: now,
        updatedAt: now,
      },
      // Untouched when nothing new arrived: the row (and its event) stay exactly as they were.
      setWhere: sql`${emailThreads.lastMessageId} <> excluded.last_message_id`,
    })
    .returning({ id: emailThreads.id });
  if (!row) return { changed: false };

  if (result.event) {
    const e = result.event;
    await db
      .insert(emailEvents)
      .values({
        userId,
        threadRowId: row.id,
        source: "rule",
        kind: e.kind,
        company: e.company,
        stage: e.stage,
        occurredAt: e.occurredAt,
        summary: e.summary,
        evidenceQuote: e.evidenceQuote,
        confidence: e.confidence,
      })
      .onConflictDoUpdate({
        target: [emailEvents.threadRowId, emailEvents.kind],
        targetWhere: sql`source = 'rule'`,
        set: {
          company: e.company,
          stage: e.stage,
          occurredAt: e.occurredAt,
          summary: e.summary,
          evidenceQuote: e.evidenceQuote,
          confidence: e.confidence,
          updatedAt: now,
        },
      });
  } else {
    // The thread no longer reads as an event (it went quiet, or became irrelevant).
    await db.delete(emailEvents).where(and(eq(emailEvents.threadRowId, row.id), eq(emailEvents.source, "rule")));
  }
  return { changed: true };
}

export async function knownThreadVersions(userId: string, threadIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (threadIds.length === 0) return out;
  const db = await getDb();
  const rows = await db
    .select({ threadId: emailThreads.threadId, lastMessageId: emailThreads.lastMessageId })
    .from(emailThreads)
    .where(and(eq(emailThreads.userId, userId), inArray(emailThreads.threadId, threadIds)));
  for (const r of rows) out.set(r.threadId, r.lastMessageId);
  return out;
}

/** Everything the feature recorded for one account, and the switch itself. */
export async function deleteEmailIntelData(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(emailEvents).where(eq(emailEvents.userId, userId));
  await db.delete(emailThreads).where(eq(emailThreads.userId, userId));
  await db
    .update(userSettings)
    .set({ emailIntelEnabled: 0, emailIntelCursorAt: null, emailIntelNextAt: null, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}
```

- [ ] **Step 4: Run it and watch it pass**

Stop any running `next dev`, then `npx tsx scripts/smoke-email-intel-store.ts`. Expected: all `ok`. If the `setWhere` clause is rejected by your drizzle version, replace it with a preliminary `SELECT last_message_id` compare and an early `return { changed: false }`; the test contract is unchanged.

- [ ] **Step 5: Register and commit**

Add `"smoke-email-intel-store": "pglite",` to `MANIFEST`. Then:

```bash
npx tsc --noEmit
git add src/lib/email-intel/store.ts scripts/smoke-email-intel-store.ts scripts/run-smoke.ts
git commit -m "feat(email-intel): idempotent thread and rule-event store

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Purge and export coverage

**Files:**
- Modify: `src/lib/user-data.ts` (imports, `insights` step `exports`, `counts`, `run`)
- Modify: `scripts/smoke-purge.ts` (seed rows for the two tables)

**Interfaces:**
- Consumes: `emailThreads`, `emailEvents`, `userSettings.emailIntel*` (Task 2).
- Produces: nothing new; `purgeUserData` and the export now cover the feature's tables.

`scripts/smoke-purge.ts` derives the list of user-scoped tables from `schema.ts`, so it has been failing since Task 2. This task makes it pass without weakening it.

- [ ] **Step 1: Confirm the failure**

Run: `npx tsx scripts/smoke-purge.ts`
Expected: FAIL naming `email_events` and/or `email_threads` (rows survive, or no seed row).

- [ ] **Step 2: Seed rows in the smoke**

In `scripts/smoke-purge.ts`, in `seed()` after the `closenessCohorts` insert, add:

```ts
  // Email insights: a thread and the event read from it. Derived from the user's mail, so
  // both must leave with an insights delete.
  const [emailThread] = await db
    .insert(schema.emailThreads)
    .values({
      userId: USER,
      threadId: "smoke-purge-thread",
      lastMessageId: "smoke-purge-message",
      subject: "Thank you for applying",
      participants: ["no-reply@example.com"],
      decision: "ats_rule",
      status: "done",
    })
    .returning();
  await db.insert(schema.emailEvents).values({
    userId: USER,
    threadRowId: emailThread.id,
    kind: "process_update",
    stage: "applied",
    occurredAt: now,
    summary: "Applied",
    evidenceQuote: "We have received your application.",
  });
```

- [ ] **Step 3: Register in the purge and export**

In `src/lib/user-data.ts`, add `emailEvents` and `emailThreads` to the schema import list, then in `STEPS.insights`:

- `exports`: append `own(emailThreads), own(emailEvents)`.
- `counts`: append `emailThreads, emailEvents`.
- `run`: before the `memoryChunks` delete add

```ts
      // Email insights: derived from the person's mail. Events cascade from threads, but an
      // insights-only delete says so explicitly.
      await db.delete(emailEvents).where(eq(emailEvents.userId, userId));
      await db.delete(emailThreads).where(eq(emailThreads.userId, userId));
```

- and extend the existing `db.update(userSettings).set({ radarLastRunAt: null, ... })` in that step with `emailIntelCursorAt: null, emailIntelNextAt: null,` so a later re-enable backfills from scratch. Do NOT reset `emailIntelEnabled` there: turning the feature off is `deleteEmailIntelData`'s and the switch's job, and a full purge already re-inserts settings at default 0.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
npx tsx scripts/smoke-purge.ts
npx tsx scripts/smoke-purge-selective.ts
npx tsx scripts/smoke-purge-resume.ts
```

Expected: all pass. If `smoke-purge-selective` complains about category coverage, the two tables belong to `insights` only; check that no other category lists them.

- [ ] **Step 5: Commit**

```bash
git add src/lib/user-data.ts scripts/smoke-purge.ts
git commit -m "feat(email-intel): purge and export cover threads and events

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 6: The sweep

**Files:**
- Create: `src/lib/email-intel/sweep.ts`
- Create: `scripts/smoke-email-intel-sweep.ts`
- Modify: `scripts/run-smoke.ts` (pglite block)

**Interfaces:**
- Consumes: `assessThread` (Task 3), `upsertThreadResult` / `knownThreadVersions` (Task 4), `RATE_LIMITS.emailIntelDaily` (Task 2), Gmail helpers `buildRecruiterQuery`, `listGmailMessagePage`, `fetchGmailThreadsBatched`, `getValidAccessToken` (`src/lib/gmail.ts`), `getEntitlements` (`src/lib/entitlements.ts`), `ReauthRequiredError` (`src/lib/errors.ts`).
- Produces:
  - `runEmailIntelSweep(deps?: EmailIntelDeps): Promise<EmailIntelSweepStats>`
  - the exported constants `SWEEP_USERS_PER_RUN`, `INTERVAL_MS`, `DEFER_MS`, `BACKFILL_DAYS`, `OVERLAP_DAYS`, `MAX_LISTED`, `THREAD_BATCH`
  - the injectable types `EmailIntelGmail`, `EmailIntelConnection`, `EmailIntelDeps`

Design notes the code below encodes:
- `user_settings.email_intel_next_at` is both the schedule and the lease. A claim pushes it 10 minutes out in one `UPDATE ... WHERE user_id IN (SELECT ...) RETURNING`, so a killed invocation's accounts come due again on their own.
- The watermark (`email_intel_cursor_at`) advances to the sweep's START time, and only when the whole window was processed. A budget or time cut-off leaves it alone; the next run re-lists the same window, and every thread already stored is skipped without a fetch or a charge because its newest listed message id equals the stored one. That is what guarantees progress.
- Threads are listed newest first; up to `MAX_LISTED` messages per run. A burst larger than that in one window loses its oldest tail. Career-filtered mail at a 15-minute cadence does not approach it; a first-run backfill is the only realistic case, and it is bounded on purpose.
- A thread whose real latest message is the user's own reply (not a matching message) has a stored last id different from the newest listed id, so it is refetched on each run inside the 2-day overlap. Bounded by the overlap and the daily cap; accepted.

- [ ] **Step 1: Write the failing smoke**

```ts
/**
 * The email-insights sweep: who it claims, what it stores, and every way it stops.
 * PGlite plus a fake Gmail and fake gates. No key, no network.
 * Run: npx tsx scripts/smoke-email-intel-sweep.ts
 */
import "./smoke/_env";

import { eq, inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { emailEvents, emailThreads, rateLimitBuckets, userSettings } from "../src/db/schema";
import {
  BACKFILL_DAYS,
  DEFER_MS,
  INTERVAL_MS,
  runEmailIntelSweep,
  type EmailIntelDeps,
  type EmailIntelGmail,
} from "../src/lib/email-intel/sweep";
import type { GmailHeaderSummary, GmailThreadSummary } from "../src/lib/gmail";
import { ReauthRequiredError } from "../src/lib/errors";
import { consumeBucket, RATE_LIMITS } from "../src/lib/rate-limit";
import { utcDayKey } from "../src/lib/timeline-cost";
import { ensureUserSettings } from "../src/lib/user-settings";

const ON = "smoke-eis-on";
const OFF = "smoke-eis-off";
const NOREAD = "smoke-eis-noread";
const NOELIG = "smoke-eis-noelig";
const REAUTH = "smoke-eis-reauth";
const CAPPED = "smoke-eis-capped";
const LATE = "smoke-eis-late";
const USERS = [ON, OFF, NOREAD, NOELIG, REAUTH, CAPPED, LATE];
const ME = "me@example.com";
const MIN = 60_000;
const T0 = new Date("2026-09-30T12:00:00Z");

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function msg(over: Partial<GmailHeaderSummary>): GmailHeaderSummary {
  return {
    id: "m",
    threadId: "t",
    from: "",
    to: `Me <${ME}>`,
    subject: "",
    snippet: "",
    internalDate: T0.getTime() - 60 * MIN,
    listUnsubscribe: "",
    listId: "",
    precedence: "",
    ...over,
  };
}

const threads: Record<string, GmailThreadSummary> = {
  "t-ats": {
    id: "t-ats",
    messages: [
      msg({ id: "a1", threadId: "t-ats", from: "Stripe <no-reply@stripe.com>", subject: "Thank you for applying to Stripe", snippet: "We have received your application." }),
    ],
  },
  "t-human": {
    id: "t-human",
    messages: [
      msg({ id: "h1", threadId: "t-human", from: "Dana Kim <dana@acme.com>", subject: "Software Engineer role at Acme", snippet: "I’m a technical recruiter at Acme, are you free Thursday to schedule a call?" }),
    ],
  },
  "t-news": {
    id: "t-news",
    messages: [msg({ id: "n1", threadId: "t-news", from: "News <news@substack.com>", subject: "This week", listUnsubscribe: "<mailto:x>" })],
  },
};

type Calls = { list: number; fetch: number[]; tokens: string[] };
function fakeGmail(calls: Calls): EmailIntelGmail {
  return {
    accessToken: async (userId) => {
      calls.tokens.push(userId);
      if (userId === REAUTH) throw new ReauthRequiredError("expired");
      return "tok";
    },
    listPage: async () => {
      calls.list += 1;
      const messages = Object.values(threads).map((t) => ({ id: t.messages.at(-1)!.id, threadId: t.id }));
      return { messages, nextPageToken: null };
    },
    fetchThreads: async (_token, ids) => {
      calls.fetch.push(ids.length);
      return ids.map((id) => threads[id]).filter((t): t is GmailThreadSummary => Boolean(t));
    },
  };
}

function deps(calls: Calls, now: Date, extra: Partial<EmailIntelDeps> = {}): EmailIntelDeps {
  return {
    now,
    gmail: fakeGmail(calls),
    connection: async (userId) => (userId === NOREAD ? { email: ME, canRead: false } : { email: ME, canRead: true }),
    eligible: async (userId) => userId !== NOELIG,
    ...extra,
  };
}

const freshCalls = (): Calls => ({ list: 0, fetch: [], tokens: [] });

/** Arms exactly `armed`, clears their schedule, and leaves everyone else switched off. */
async function arm(armed: string[]) {
  const db = await getDb();
  await db.update(userSettings).set({ emailIntelEnabled: 0 }).where(inArray(userSettings.userId, USERS));
  await db
    .update(userSettings)
    .set({ emailIntelEnabled: 1, emailIntelNextAt: null, emailIntelCursorAt: null })
    .where(inArray(userSettings.userId, armed));
}

async function settingsOf(userId: string) {
  const db = await getDb();
  const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  return row!;
}

async function threadRows(userId: string) {
  const db = await getDb();
  return db.select().from(emailThreads).where(eq(emailThreads.userId, userId));
}

async function main() {
  const db = await getDb();
  await db.delete(emailThreads).where(inArray(emailThreads.userId, USERS));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "%smoke-eis-%"));
  for (const u of USERS) await ensureUserSettings(u);

  console.log("\nWho is claimed, and what they leave behind");
  await arm([ON, NOREAD, NOELIG, REAUTH]);
  let calls = freshCalls();
  let stats = await runEmailIntelSweep(deps(calls, T0));
  check("four armed accounts were claimed", stats.accounts === 4, JSON.stringify(stats));
  const off = await settingsOf(OFF);
  check("a switched-off account is never touched", off.emailIntelNextAt === null);

  const rows = await threadRows(ON);
  const byId = (id: string) => rows.find((r) => r.threadId === id);
  check("all three threads were judged", rows.length === 3);
  check("the ATS thread is done", byId("t-ats")?.status === "done");
  check("the recruiter thread waits for the extractor", byId("t-human")?.status === "pending_ai");
  check("the newsletter is remembered as skipped", byId("t-news")?.status === "skipped");
  check("the skipped thread kept no subject", byId("t-news")?.subject === "");
  const events = await db.select().from(emailEvents).where(eq(emailEvents.userId, ON));
  check("one rule event: the application stage", events.length === 1 && events[0]!.stage === "applied");

  const on = await settingsOf(ON);
  check("the watermark advanced to the sweep start", on.emailIntelCursorAt?.getTime() === T0.getTime());
  check("the next run is fifteen minutes out", on.emailIntelNextAt?.getTime() === T0.getTime() + INTERVAL_MS);
  check("a first run looks back the backfill window", BACKFILL_DAYS === 14);

  check("no mail access: deferred a day", (await settingsOf(NOREAD)).emailIntelNextAt?.getTime() === T0.getTime() + DEFER_MS);
  check("no mail access: nothing stored", (await threadRows(NOREAD)).length === 0);
  check("plan-ineligible: deferred a day", (await settingsOf(NOELIG)).emailIntelNextAt?.getTime() === T0.getTime() + DEFER_MS);
  check("a dead grant defers that account only", (await settingsOf(REAUTH)).emailIntelNextAt?.getTime() === T0.getTime() + DEFER_MS);
  check("and did not stop the others", (await threadRows(ON)).length === 3);
  check("ineligible accounts never get a token", !calls.tokens.includes(NOELIG) && !calls.tokens.includes(NOREAD));

  console.log("\nSchedule and idempotency");
  calls = freshCalls();
  stats = await runEmailIntelSweep(deps(calls, new Date(T0.getTime() + 5 * MIN)));
  check("nothing is due five minutes later", stats.accounts === 0);

  calls = freshCalls();
  stats = await runEmailIntelSweep(deps(calls, new Date(T0.getTime() + 16 * MIN)));
  check("the armed account is due after fifteen", stats.accounts >= 1);
  check("known threads are not fetched again", calls.fetch.length === 0, JSON.stringify(calls.fetch));
  check("and are counted as unchanged", stats.unchanged >= 3, JSON.stringify(stats));

  console.log("\nA new reply");
  threads["t-human"]!.messages.push(
    msg({ id: "h2", threadId: "t-human", from: "Dana Kim <dana@acme.com>", subject: "Re: role", snippet: "Following up, are you free Thursday to schedule a call?" })
  );
  calls = freshCalls();
  await runEmailIntelSweep(deps(calls, new Date(T0.getTime() + 32 * MIN)));
  check("only the changed thread is fetched", calls.fetch.join() === "1", JSON.stringify(calls.fetch));
  check("its last message id advanced", (await threadRows(ON)).find((r) => r.threadId === "t-human")?.lastMessageId === "h2");

  console.log("\nThe daily cap");
  await arm([CAPPED]);
  const capNow = new Date(T0.getTime() + 60 * MIN);
  await consumeBucket("email-intel-daily", `${CAPPED}:${utcDayKey(capNow)}`, RATE_LIMITS.emailIntelDaily, RATE_LIMITS.emailIntelDaily.limit - 1);
  calls = freshCalls();
  stats = await runEmailIntelSweep(deps(calls, capNow));
  check("the cap stops the account", stats.exhausted === 1, JSON.stringify(stats));
  check("nothing was fetched past it", calls.fetch.length === 0);
  const capped = await settingsOf(CAPPED);
  check("the watermark did not advance", capped.emailIntelCursorAt === null);
  check("it is due again at the next UTC midnight", capped.emailIntelNextAt?.toISOString() === "2026-10-01T00:00:00.000Z", String(capped.emailIntelNextAt));

  console.log("\nThe time budget");
  await arm([LATE]);
  calls = freshCalls();
  stats = await runEmailIntelSweep(deps(calls, T0, { deadline: Date.now() - 1 }));
  const late = await settingsOf(LATE);
  check("an account that never started is handed back", stats.accounts === 1 && calls.tokens.length === 0);
  check("and is due immediately", late.emailIntelNextAt !== null && late.emailIntelNextAt.getTime() <= T0.getTime());

  await db.delete(emailThreads).where(inArray(emailThreads.userId, USERS));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "%smoke-eis-%"));
  console.log("\nAll email-intel sweep checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

Stop any `next dev`, then `npx tsx scripts/smoke-email-intel-sweep.ts`.
Expected: FAIL, cannot find module `../src/lib/email-intel/sweep`.

- [ ] **Step 3: Implement**

`src/lib/email-intel/sweep.ts`:

```ts
/**
 * The email-insights sweep: every fifteen minutes, read the new career-relevant Gmail threads
 * of each opted-in account, judge them by rule, and record what they say.
 *
 * ## Claiming
 * `user_settings.email_intel_next_at` is both the schedule and the lease (the pattern of
 * `work_history_due_at`): a claim pushes it ten minutes out in one UPDATE ... RETURNING, which
 * needs no transaction, and a killed invocation's accounts come due again on their own.
 *
 * ## Progress
 * The watermark (`email_intel_cursor_at`) moves to the sweep's START, and only when the whole
 * window was processed. Cut short by the daily cap or the time budget, it stays put and the
 * next run re-lists the same window: threads already stored are skipped free (their newest
 * listed message id equals the stored one), so each run goes further than the last.
 *
 * ## Cost
 * Metadata only, no body, no model. The daily cap charges threads fetched, not threads listed.
 *
 * Auth-free and free of `next/server`: the route wraps it and the smoke drives it on PGlite.
 */
import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { gmailConnections } from "@/db/schema";
import { getEntitlements } from "@/lib/entitlements";
import { ReauthRequiredError } from "@/lib/errors";
import {
  buildRecruiterQuery,
  fetchGmailThreadsBatched,
  getValidAccessToken,
  listGmailMessagePage,
  type GmailMessageRef,
  type GmailThreadSummary,
} from "@/lib/gmail";
import { hasGmailReadScope } from "@/lib/google-scopes";
import { consumeBucket, isRateLimitedError, RATE_LIMITS } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { utcDayKey } from "@/lib/timeline-cost";
import { knownThreadVersions, upsertThreadResult } from "./store";
import { assessThread } from "./triage";

const DAY_MS = 86_400_000;
/** Accounts one run looks at. */
export const SWEEP_USERS_PER_RUN = 6;
/** A claim holds an account this long before it comes due again on its own. */
const LEASE_MS = 10 * 60_000;
/** Cadence between complete sweeps of one account. */
export const INTERVAL_MS = 15 * 60_000;
/** An account with no mail access, no plan, or a dead grant is looked at again after a day. */
export const DEFER_MS = DAY_MS;
/** After an unexpected error: try again in an hour. */
const ERROR_BACKOFF_MS = 60 * 60_000;
/** First run: how far back to look. */
export const BACKFILL_DAYS = 14;
/** Gmail's `after:` is date-granular, so re-read a little before the watermark. */
export const OVERLAP_DAYS = 2;
/** Messages listed per account per run (newest first). */
export const MAX_LISTED = 1000;
const LIST_PAGE = 100;
/** Threads fetched per Gmail batch call (Google recommends 50). */
export const THREAD_BATCH = 50;

export type EmailIntelGmail = {
  accessToken(userId: string): Promise<string>;
  listPage(
    token: string,
    opts: { query: string; pageToken: string | null; maxResults: number }
  ): Promise<{ messages: GmailMessageRef[]; nextPageToken: string | null }>;
  fetchThreads(token: string, threadIds: string[]): Promise<GmailThreadSummary[]>;
};

export type EmailIntelConnection = { email: string; canRead: boolean };

export type EmailIntelDeps = {
  now?: Date;
  /** Stop STARTING work after this (epoch ms). */
  deadline?: number;
  gmail?: EmailIntelGmail;
  connection?: (userId: string) => Promise<EmailIntelConnection | null>;
  eligible?: (userId: string) => Promise<boolean>;
};

export type EmailIntelSweepStats = {
  accounts: number;
  deferred: number;
  listed: number;
  fetched: number;
  stored: number;
  skipped: number;
  unchanged: number;
  exhausted: number;
  partial: number;
  errors: number;
};

const liveGmail: EmailIntelGmail = {
  accessToken: (userId) => getValidAccessToken(userId),
  listPage: (token, opts) => listGmailMessagePage(token, opts),
  fetchThreads: (token, ids) => fetchGmailThreadsBatched(token, ids),
};

async function loadConnection(userId: string): Promise<EmailIntelConnection | null> {
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { emailAddress: true, scopes: true, status: true },
  });
  if (!conn) return null;
  return { email: conn.emailAddress, canRead: conn.status === "active" && hasGmailReadScope(conn.scopes) };
}

/** Background code must not use `requireEntitlement`: it records a gate hit and throws. */
async function planAllows(userId: string): Promise<boolean> {
  try {
    return (await getEntitlements(userId)).canUseRecruiters === true;
  } catch {
    return false;
  }
}

function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

type Claimed = { userId: string; cursorAt: Date | null };

async function claimAccounts(now: Date, limit: number): Promise<Claimed[]> {
  const db = await getDb();
  const lease = new Date(now.getTime() + LEASE_MS);
  const rows = rowsOf<{ user_id: string; email_intel_cursor_at: string | Date | null }>(
    await db.execute(sql`
      UPDATE user_settings SET email_intel_next_at = ${lease}
       WHERE email_intel_enabled = 1
         AND (email_intel_next_at IS NULL OR email_intel_next_at <= ${now})
         AND user_id IN (
           SELECT user_id FROM user_settings
            WHERE email_intel_enabled = 1
              AND (email_intel_next_at IS NULL OR email_intel_next_at <= ${now})
            ORDER BY email_intel_next_at ASC NULLS FIRST, user_id
            LIMIT ${limit}
         )
      RETURNING user_id, email_intel_cursor_at
    `)
  );
  return rows.map((r) => ({
    userId: r.user_id,
    cursorAt: r.email_intel_cursor_at ? new Date(r.email_intel_cursor_at) : null,
  }));
}

type Settle = { nextAt: Date; cursorAt: Date | null };

async function settle(userId: string, s: Settle): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE user_settings
       SET email_intel_next_at = ${s.nextAt},
           email_intel_cursor_at = COALESCE(${s.cursorAt}::timestamptz, email_intel_cursor_at)
     WHERE user_id = ${userId}
  `);
}

async function processAccount(
  acct: Claimed,
  d: Required<Pick<EmailIntelDeps, "gmail" | "connection" | "eligible">> & Pick<EmailIntelDeps, "deadline">,
  now: Date,
  stats: EmailIntelSweepStats
): Promise<Settle> {
  const { userId } = acct;
  const conn = await d.connection(userId);
  if (!conn || !conn.canRead || !(await d.eligible(userId))) {
    stats.deferred += 1;
    return { nextAt: new Date(now.getTime() + DEFER_MS), cursorAt: null };
  }
  const token = await d.gmail.accessToken(userId);

  const start = acct.cursorAt ?? new Date(now.getTime() - BACKFILL_DAYS * DAY_MS);
  const query = buildRecruiterQuery({ after: new Date(start.getTime() - OVERLAP_DAYS * DAY_MS) });

  // Newest listed message per thread. Listing is newest first.
  const newest = new Map<string, string>();
  let pageToken: string | null = null;
  let listed = 0;
  do {
    const page = await d.gmail.listPage(token, {
      query,
      pageToken,
      maxResults: Math.min(LIST_PAGE, MAX_LISTED - listed),
    });
    for (const ref of page.messages) {
      listed += 1;
      if (!newest.has(ref.threadId)) newest.set(ref.threadId, ref.id);
    }
    pageToken = page.nextPageToken;
  } while (pageToken && listed < MAX_LISTED);
  stats.listed += listed;

  const known = await knownThreadVersions(userId, [...newest.keys()]);
  const todo = [...newest].filter(([threadId, messageId]) => known.get(threadId) !== messageId).map(([id]) => id);
  stats.unchanged += newest.size - todo.length;

  let stoppedBy: "budget" | "time" | null = null;
  for (let i = 0; i < todo.length; i += THREAD_BATCH) {
    if (d.deadline !== undefined && Date.now() >= d.deadline) {
      stoppedBy = "time";
      break;
    }
    const chunk = todo.slice(i, i + THREAD_BATCH);
    try {
      await consumeBucket("email-intel-daily", `${userId}:${utcDayKey(now)}`, RATE_LIMITS.emailIntelDaily, chunk.length);
    } catch (err) {
      if (isRateLimitedError(err)) {
        stoppedBy = "budget";
        break;
      }
      throw err;
    }
    const threads = await d.gmail.fetchThreads(token, chunk);
    stats.fetched += threads.length;
    for (const thread of threads) {
      const result = assessThread(thread, conn.email);
      if (!result.lastMessageId) continue;
      const { changed } = await upsertThreadResult(userId, result);
      if (!changed) stats.unchanged += 1;
      else if (result.decision === "skipped") stats.skipped += 1;
      else stats.stored += 1;
    }
  }

  if (stoppedBy === "budget") {
    stats.exhausted += 1;
    return { nextAt: nextUtcDay(now), cursorAt: null };
  }
  if (stoppedBy === "time") {
    stats.partial += 1;
    return { nextAt: now, cursorAt: null };
  }
  return { nextAt: new Date(now.getTime() + INTERVAL_MS), cursorAt: now };
}

export async function runEmailIntelSweep(deps: EmailIntelDeps = {}): Promise<EmailIntelSweepStats> {
  const now = deps.now ?? new Date();
  const d = {
    gmail: deps.gmail ?? liveGmail,
    connection: deps.connection ?? loadConnection,
    eligible: deps.eligible ?? planAllows,
    deadline: deps.deadline,
  };
  const stats: EmailIntelSweepStats = {
    accounts: 0, deferred: 0, listed: 0, fetched: 0, stored: 0, skipped: 0, unchanged: 0, exhausted: 0, partial: 0, errors: 0,
  };

  const claimed = await claimAccounts(now, SWEEP_USERS_PER_RUN);
  stats.accounts = claimed.length;
  for (const acct of claimed) {
    if (d.deadline !== undefined && Date.now() >= d.deadline) {
      // Claimed but never started: due again now, for the next run.
      await settle(acct.userId, { nextAt: now, cursorAt: null });
      continue;
    }
    let outcome: Settle;
    try {
      outcome = await processAccount(acct, d, now, stats);
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        stats.deferred += 1;
        outcome = { nextAt: new Date(now.getTime() + DEFER_MS), cursorAt: null };
      } else {
        stats.errors += 1;
        reportError(err, { where: "email-intel.sweep", extra: { userId: acct.userId } });
        outcome = { nextAt: new Date(now.getTime() + ERROR_BACKOFF_MS), cursorAt: null };
      }
    }
    await settle(acct.userId, outcome);
  }
  return stats;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-email-intel-sweep.ts`
Expected: every line `ok`, ending "All email-intel sweep checks passed." Likely adjustments if it does not:
- "the cap stops the account" fails: read `consumeBucket` in `src/lib/rate-limit.ts` to confirm it throws when `count + units > limit`; if it throws only when the count is already at the limit, seed the bucket with the full `limit` instead of `limit - 1`.
- `reportError` context shape: match the call sites (`{ where, extra }`).
- Raw `sql` timestamp parameters: if PGlite rejects a `Date`, pass `.toISOString()` with `::timestamptz` casts in `claimAccounts` and `settle`.

- [ ] **Step 5: Register and commit**

Add `"smoke-email-intel-sweep": "pglite",` to `MANIFEST`. Then:

```bash
npx tsc --noEmit
git add src/lib/email-intel/sweep.ts scripts/smoke-email-intel-sweep.ts scripts/run-smoke.ts
git commit -m "feat(email-intel): leased 15-minute sweep with watermark, daily cap and deferrals

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Route, schedule, and alerting

**Files:**
- Create: `src/app/api/email-intel/sweep/route.ts`
- Modify: `src/lib/cron-runs.ts` (`CronJobName`)
- Modify: `src/lib/public-routes.ts`
- Modify: `.github/workflows/ops.yml`
- Modify: `src/lib/ops-alerts.ts`, `src/lib/ops-sweep.ts`, `scripts/smoke-ops-alerts.ts`
- Modify: `scripts/smoke-schedules.ts`
- Modify: `docs/RUNBOOK.md`

**Interfaces:**
- Consumes: `runEmailIntelSweep` (Task 6), `startCronRun` / `finishCronRun`, `isInternalRequest`.
- Produces: `POST /api/email-intel/sweep` (bearer `CRON_SECRET`), cron job name `email-intel.sweep`, alert ids `emailintel.schedule_missed` and `emailintel.run_failed`.

- [ ] **Step 1: Failing schedule checks**

In `scripts/smoke-schedules.ts`, after the work-history checks, add:

```ts
// The email-insights sweep reads people's mail metadata: exactly one caller, on its own line.
check("the email-intel sweep is called from exactly one step",
  (ops.match(/\/api\/email-intel\/sweep/g) ?? []).length === 1);
check("that step is gated on its own quarter-hour schedule",
  ops.includes(`- cron: "5,20,35,50 * * * *"`) &&
    /if: github\.event\.schedule == '5,20,35,50 \* \* \* \*'[\s\S]{0,400}\/api\/email-intel\/sweep/.test(ops));
```

Run `npx tsx scripts/smoke-schedules.ts`. Expected: FAIL on those two checks.

- [ ] **Step 2: The route**

`src/app/api/email-intel/sweep/route.ts`:

```ts
/**
 * The email-insights sweep's entry point: reads new career-relevant Gmail threads for each
 * opted-in account. Every fifteen minutes from `.github/workflows/ops.yml` at :05/:20/:35/:50.
 *
 * Its own route, schedule and `cron_runs` job name, like the work-history sweep: it makes
 * network calls per account, and the ten-minute ops sweep is the alerting path and must
 * never wait on it. `POST` because it mutates.
 */
import { NextResponse } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { runEmailIntelSweep } from "@/lib/email-intel/sweep";
import { isInternalRequest } from "@/lib/internal-auth";

export const maxDuration = 300;

/** Stop starting accounts this far in, leaving room to settle leases under 300s. */
const START_DEADLINE_MS = 240_000;

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const handle = await startCronRun("email-intel.sweep");
  try {
    const stats = await runEmailIntelSweep({ deadline: started + START_DEADLINE_MS });
    await finishCronRun(handle, {
      // Out of time or out of daily budget is the ordinary partial shape, not a failure.
      status: stats.partial > 0 || stats.exhausted > 0 || stats.errors > 0 ? "partial" : "ok",
      stats: { ...stats },
    });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "email intel sweep failed" }, { status: 500 });
  }
}
```

- [ ] **Step 3: Job name, public route, schedule**

- `src/lib/cron-runs.ts`: add `| "email-intel.sweep"` to `CronJobName` (keep alphabetical: after `"credits.notices"`).
- `src/lib/public-routes.ts`: after `"/api/work-history/sweep",` add `"/api/email-intel/sweep",`.
- `.github/workflows/ops.yml`: in `on.schedule`, after the `"37 * * * *"` entry add

```yaml
    # The email-insights sweep: every fifteen minutes on its own line, offset from the
    # */10 and */15 jobs so it never shares a concurrency group with the connector sync.
    - cron: "5,20,35,50 * * * *"
```

and, after the work-history step, add

```yaml
      # Email insights: new career-relevant Gmail threads (metadata only, no body, no model)
      # for opted-in accounts. Its own line for the same reason as the work-history sweep;
      # 300s to match the route, which stops starting accounts at 240s.
      - name: Run the email-insights sweep (every 15 minutes)
        if: github.event.schedule == '5,20,35,50 * * * *' && steps.health.outcome == 'success'
        run: |
          curl -sS --fail-with-body --max-time 300 -X POST \
            -H "Authorization: Bearer $CRON_SECRET" \
            "$APP_URL/api/email-intel/sweep"
        env:
          APP_URL: ${{ secrets.APP_URL }}
          CRON_SECRET: ${{ secrets.CRON_SECRET }}
```

Update the header comment list at the top of `ops.yml` (lines 1-10) to mention the email-insights sweep.

- [ ] **Step 4: Alerting**

Mirror the work-history twin everywhere it appears (find them with `grep -n "workHistory" src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-ops-alerts.ts`):

1. `src/lib/ops-alerts.ts`: in the `OpsSnapshot` type next to `workHistory: { lastStartedAt; lastState }` add `emailIntel: { lastStartedAt: Date | null; lastState: CronRunState | null };`. Add the constant and the condition, right after the work-history block:

```ts
/**
 * The email-insights sweep runs every fifteen minutes; two hours of silence is eight missed
 * runs, not GitHub's ordinary lag. `warning`: a stage change noticed late costs nothing.
 * Never having run is NOT an alert — the feature is opt-in and may not be enabled anywhere.
 */
const EMAIL_INTEL_SILENT_MS = 2 * 60 * 60 * 1000;
```

```ts
  const emailIntel = s.cron.emailIntel;
  if (emailIntel.lastStartedAt && now.getTime() - emailIntel.lastStartedAt.getTime() > EMAIL_INTEL_SILENT_MS) {
    out.push({
      id: "emailintel.schedule_missed",
      severity: "warning",
      title: "Email-insights sweep has stopped running",
      detail: `Last started ${emailIntel.lastStartedAt.toISOString()}; new application updates are not being noticed.`,
      href: "/admin/health",
    });
  } else if (emailIntel.lastState === "failed" || emailIntel.lastState === "stale") {
    out.push({
      id: "emailintel.run_failed",
      severity: "warning",
      title: `Email-insights sweep ${emailIntel.lastState === "stale" ? "was killed" : "failed"}`,
      detail: `Last run ${emailIntel.lastStartedAt?.toISOString() ?? "unknown"} ended ${emailIntel.lastState}.`,
      href: "/admin/health",
    });
  }
```

2. `src/lib/ops-sweep.ts`: add a query for `cronRuns` where `job = "email-intel.sweep"` (ordered by `startedAt` desc, limit 1) **at the end** of the existing `Promise.all` array, destructure it last, and populate `cron.emailIntel` the same way `cron.workHistory` is populated (around line 268).
3. `scripts/smoke-ops-alerts.ts`: add `emailIntel: { lastStartedAt: hoursAgo(1), lastState: "ok" }` to the `HEALTHY` fixture (near line 43) and these checks next to the work-history ones:

```ts
  const emailIntel = (over: OpsSnapshot["cron"]["emailIntel"]): OpsSnapshot => ({
    ...HEALTHY,
    cron: { ...HEALTHY.cron, emailIntel: over },
  });
  check("an email-intel sweep silent for three hours warns", Boolean(find(emailIntel({ lastStartedAt: hoursAgo(3), lastState: "ok" }), "emailintel.schedule_missed")));
  check("never having run is not an alert", !find(emailIntel({ lastStartedAt: null, lastState: null }), "emailintel.schedule_missed"));
  check("a failed email-intel run warns", Boolean(find(emailIntel({ lastStartedAt: hoursAgo(1), lastState: "failed" }), "emailintel.run_failed")));
  check("a partial run is ordinary", !find(emailIntel({ lastStartedAt: hoursAgo(1), lastState: "partial" }), "emailintel.run_failed"));
```

(Match the surrounding file's `check`/`find` helper names and style.)

- [ ] **Step 5: Runbook**

In `docs/RUNBOOK.md`, in the section that lists scheduled jobs, add a row: `email-intel.sweep` — `POST /api/email-intel/sweep`, every 15 minutes (`5,20,35,50`), opt-in per account (`user_settings.email_intel_enabled`), metadata only, kill switch = set that column to 0 for one account, or delete the `ops.yml` step for all. Note that the feature ships dark behind Radar's release and that turning it on needs the Gmail mail scope (`email_intel` purpose).

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit
npx tsx scripts/smoke-schedules.ts
npx tsx scripts/smoke-ops-alerts.ts
npx tsx scripts/smoke-public-routes.ts
npx tsx scripts/smoke-internal-auth.ts
```

Expected: all pass. If `smoke-public-routes` or `smoke-internal-auth` keeps a hand-written list of internal routes (a grep for `work-history` found none, so it should scan), add the new path beside the neighbouring internal routes.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/email-intel/sweep/route.ts src/lib/cron-runs.ts src/lib/public-routes.ts .github/workflows/ops.yml src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-ops-alerts.ts scripts/smoke-schedules.ts docs/RUNBOOK.md
git commit -m "feat(email-intel): sweep route on its own quarter-hour schedule, with staleness alert

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The setting (action, UI, disconnect cascade)

**Files:**
- Create: `src/actions/email-intel.ts`
- Create: `src/components/settings/email-intel-setting.tsx`
- Modify: `src/actions/settings.ts` (`getSettings` return)
- Modify: `src/app/(clerk)/(app)/settings/page.tsx` (mount next to `RadarDigestSetting`, around line 194)
- Modify: `src/actions/gmail.ts` (`disconnectGmail`)
- Modify: `scripts/fixtures/behavior-golden.json` (via `--update`)

**Interfaces:**
- Consumes: `deleteEmailIntelData` (Task 4), `hasGmailReadScope`, `startGmailOAuth({ purpose: "email_intel", returnTo })` (already accepts any `GooglePurpose`), `getEntitlements`.
- Produces: `setEmailIntel(enabled: boolean): Promise<ActionResult<void>>`; `getSettings().emailIntelEnabled: boolean`.

Server-action files may export only async functions (a non-async export breaks every export in a `"use server"` file), so keep constants out of `src/actions/email-intel.ts`.

- [ ] **Step 1: The action**

`src/actions/email-intel.ts`:

```ts
"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { gmailConnections, userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { isDemoWorkspace } from "@/lib/demo-workspace";
import { requireEntitlement } from "@/lib/entitlements";
import { ActionResult, asActionResult, UserFacingError } from "@/lib/errors";
import { hasGmailReadScope } from "@/lib/google-scopes";

/**
 * The Email insights switch. Turning it on needs the recruiter plan and Gmail's read scope,
 * and starts a fresh backfill (cursor and schedule cleared). Turning it off stops the sweep
 * and leaves what it already recorded; deleting that is Gmail disconnect or an insights wipe.
 *
 * Answers rather than throws, like `setCalendarSync`: the switch shows the refusal verbatim.
 */
export async function setEmailIntel(enabled: boolean): Promise<ActionResult<void>> {
  return asActionResult(async () => {
    const userId = await requireUserId();
    if (await isDemoWorkspace(userId)) {
      throw new UserFacingError("Email insights aren’t available in the demo workspace");
    }
    const db = await getDb();
    if (enabled) {
      await requireEntitlement(userId, "recruiters");
      const conn = await db.query.gmailConnections.findFirst({
        where: eq(gmailConnections.userId, userId),
        columns: { scopes: true, status: true },
      });
      if (!conn || conn.status !== "active" || !hasGmailReadScope(conn.scopes)) {
        throw new UserFacingError("Allow Orbit to read your email first — connect Gmail and tick mail access");
      }
    }
    await db
      .insert(userSettings)
      .values({ userId, emailIntelEnabled: enabled ? 1 : 0 })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: {
          emailIntelEnabled: enabled ? 1 : 0,
          // A fresh enable backfills from scratch and is due at once.
          ...(enabled ? { emailIntelCursorAt: null, emailIntelNextAt: null } : {}),
          updatedAt: new Date(),
        },
      });
    revalidatePath("/settings");
  });
}
```

- [ ] **Step 2: Expose it in `getSettings`**

In `src/actions/settings.ts`, beside `workHistoryAutoEnabled`:

```ts
    /** Email insights (opt-in). Off unless switched on; see `user_settings.email_intel_enabled`. */
    emailIntelEnabled: (settings?.emailIntelEnabled ?? 0) !== 0,
```

- [ ] **Step 3: The component**

`src/components/settings/email-intel-setting.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { setEmailIntel } from "@/actions/email-intel";
import { startGmailOAuth } from "@/actions/gmail";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/settings/settings-section";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

/**
 * Email insights: Orbit checks new job and hiring-process threads in Gmail and notes where
 * each application stands. Shown only to viewers who can open Radar.
 */
export function EmailIntelSetting({
  initialEnabled,
  canRead,
  allowed,
}: {
  initialEnabled: boolean;
  /** The connected Gmail grant already covers mail access. */
  canRead: boolean;
  /** The plan includes it (same as the recruiter scan). */
  allowed: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, start] = useTransition();

  const toggle = () =>
    start(async () => {
      const next = !enabled;
      try {
        if (next && !canRead) {
          // Mail access is asked for only here, never on everyday Connect.
          const { url } = await startGmailOAuth({ purpose: "email_intel", returnTo: "/settings" });
          window.location.href = url;
          return;
        }
        const result = await setEmailIntel(next);
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        setEnabled(next);
        toast.success(next ? "Email insights on" : "Email insights off");
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t change that — try again?"));
      }
    });

  return (
    <SettingsRow
      title="Email insights"
      description="Every fifteen minutes Orbit checks Gmail for new job and hiring-process threads and notes where each application stands. It reads the sender, subject and Gmail’s short preview only — never the message — and does not send your mail to an AI provider."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={pending || !allowed} onClick={toggle}>
          {enabled ? "Turn off" : canRead ? "Turn on" : "Allow mail access"}
        </Button>
        <span className="text-sm text-muted-foreground" role="status">
          {!allowed ? "Available on Orbit Pro and Orbit Max" : enabled ? "On" : "Off"}
        </span>
      </div>
    </SettingsRow>
  );
}
```

- [ ] **Step 4: Mount it**

In `src/app/(clerk)/(app)/settings/page.tsx`, import the component, compute the two props in the server component, and render it right after `RadarDigestSetting` inside the same `shows("settings-notifications") && radarLive` condition:

```tsx
            {shows("settings-notifications") && radarLive ? (
              <EmailIntelSetting
                initialEnabled={initialSettings.emailIntelEnabled}
                canRead={emailIntelCanRead}
                allowed={emailIntelAllowed}
              />
            ) : null}
```

with `emailIntelCanRead = (await getGmailConnectionStatus()).canRead` and `emailIntelAllowed = (await getEntitlements(userId)).canUseRecruiters === true` computed where the page already loads its other data (read the file first and reuse any `userId` / entitlements already in scope rather than loading twice).

- [ ] **Step 5: Disconnect cascade**

In `src/actions/gmail.ts` `disconnectGmail`, after `await db.delete(gmailConnections)...` and before `revokeGoogleGrant`, add:

```ts
  // The mail it was reading is no longer reachable, and its records are derived from that
  // mail: remove them and switch the feature off rather than leave a sweep to fail on a dead grant.
  await deleteEmailIntelData(userId);
```

with `import { deleteEmailIntelData } from "@/lib/email-intel/store";`.

- [ ] **Step 6: Golden, types, smokes**

```bash
npx tsc --noEmit
npx tsx scripts/smoke-behavior-golden.ts --update
git diff scripts/fixtures/behavior-golden.json
npx tsx scripts/smoke-behavior-golden.ts
npx tsx scripts/smoke-action-user-scope.ts
```

Expected: the golden diff is exactly one added key, `"emailIntelEnabled": false`, wherever `workHistoryAutoEnabled` appears. `smoke-action-user-scope` (it parses `src/actions/**` for caller user ids) passes: `setEmailIntel` derives `userId` from `requireUserId()` and takes no user id argument.

- [ ] **Step 7: Commit**

```bash
git add src/actions/email-intel.ts src/components/settings/email-intel-setting.tsx src/actions/settings.ts "src/app/(clerk)/(app)/settings/page.tsx" src/actions/gmail.ts scripts/fixtures/behavior-golden.json
git commit -m "feat(email-intel): Email insights switch, mail-access grant, disconnect cascade

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Whole-branch verification

**Files:** none (verification only; fix in the owning task's files if anything fails).

- [ ] **Step 1: Static and suite**

```bash
npx tsc --noEmit
npx eslint src scripts --max-warnings=0
npx tsx scripts/run-smoke.ts --check
npx tsx scripts/run-smoke.ts --ci
```

Expected: no type errors, eslint clean (baseline is zero errors, so any error is yours), manifest complete, suite green. `admin-render` / `instrumentation` smokes can time out under load; rerun those alone before treating them as failures.

- [ ] **Step 2: Build**

Stop any running `next dev` (a build on a live `.next` wedges it), then `npm run build`. Expected: passes, and the internal route appears in the route list.

- [ ] **Step 3: End to end in demo mode**

Start the dev server with the repo's preview config (`preview_start`), open Settings with the "Preview unreleased" cookie set (Radar is still coming soon, so the switch is hidden without it). Confirm: the Email insights row renders; as the demo workspace, turning it on shows "Email insights aren’t available in the demo workspace". Then, from a shell, drive the sweep against local PGlite with the smoke's fake Gmail (already covered by `smoke-email-intel-sweep`) — the live Gmail path needs a Google account on the test-user list (CASA is pending) and is verified by Jason on his own account after merge: enable the switch, wait for the next quarter hour, and confirm rows in `email_threads` / `email_events` via the admin database view.

- [ ] **Step 4: Schema-version re-check before merge**

Re-run the Task 2 Step 1 scan. If anything now claims 145 or higher, renumber (`SCHEMA_VERSION`, the changelog comment, the `schema-ddl` lock) and re-run `smoke-schema-ddl` and `smoke-schema-bootstrap`. Merging main into this branch later must not silently keep this branch's number over main's.

---

## Deferred to later plans (each consumes the interfaces above)

| Plan | Spec section | Builds on |
|---|---|---|
| P2 AI extraction | 4 | `email_threads.status = 'pending_ai'`, the claim columns, `email_events.source = 'ai'`; adds the `email.understand` operation to `AI_OPERATIONS`, a fenced prompt and zod schema, and **rewrites the privacy callout and bumps the terms again** |
| P3 People and ranking | 5, 6 | `email_events.people`, `contact_identities` lookup, `src/lib/email-intel/relevance.ts`, `contact-merge.ts` handling for `people[].contactId` |
| P4 Radar signals | 7 | A signal producer beside `src/lib/radar/signals/internal.ts`, `RADAR_WEIGHTS`, accept-to-reminder, the unresolved-people surface |
| P5 Search | 8 | New `memory_chunks.source_kind`, `memory-backfill.ts` |
| Later | — | Outlook, Gmail `watch`, merging recruiter-scan summaries into `email_events` |

## Self-review

- **Spec coverage:** section 1 → Task 1 and Task 8 (setting, kill switch); section 2 → Tasks 2 and 5 (tables, purge, export; `contact-merge` is deferred to P3 with the `people` field it concerns); section 3 → Tasks 3, 6, 7 (route, lease, cap, budget, prefilter, idempotency, alerts; the stall-resume backstop is deferred to P2 because P1 has no long-lived claims); section 4's no-AI fallback → Tasks 3 and 6. Sections 5-8 are explicitly deferred.
- **Placeholders:** the only judgment calls left to the executor are named (drizzle `setWhere` fallback, `consumeBucket` boundary, `reportError` context shape, mounting props in the settings page), each with the action to take.
- **Type consistency:** `ThreadResult`, `RuleEvent`, `statusFor` are defined in Task 2 and used unchanged in Tasks 3, 4 and 6; `EmailIntelDeps`, `EmailIntelGmail`, `EmailIntelConnection`, the stats keys and the exported constants are defined in Task 6 and used unchanged in its smoke and the route; `deleteEmailIntelData` is defined in Task 4 and used in Task 8.
