# Direct Email P1 — Send Engine + Gmail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Orbit's four person-to-person send paths with one durable outbox (`email_sends`) that sends from the user's own Gmail, with a 10-second undo, per-plan daily caps, retries, and interaction logging.

**Architecture:** Every 1:1 send becomes an `email_sends` row created by `enqueueEmail()`. A dispatcher claims due rows with a DB-clock lease (copying `src/lib/connectors/outbox.ts`), sends through a `MailProvider` (Gmail, or a no-network demo provider), writes interactions on success, and runs per-origin side effects. Interactive sends are dispatched by `after()` once the undo window lapses; an internal drain route on the existing 10-minute ops workflow picks up anything missed, plus retries.

**Tech Stack:** Next.js (App Router, server actions, `after()` from `next/server`), Drizzle on Neon/PGlite, Gmail REST API, tsx smoke scripts via `scripts/run-smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-09-29-direct-email-design.md` (read §1–§4, §9–§11).

## Global Constraints

- Read `AGENTS.md`: this Next.js has breaking changes — check `node_modules/next/dist/docs/` before using any Next API you haven't seen in this repo.
- `SCHEMA_VERSION`: main is 136; `claude/pricing-v2` claims 138. Claim the next free integer **≥ 139**, scanning every ref first (Task 1 Step 1). Never ship a number below main's.
- Daily caps: **Free 20 / day, Orbit 100 / day, Lifetime 100 / day**, rolling 24h, counted from `email_sends` with `status IN ('queued','sending','sent')`, across all origins.
- Burst bucket: `emailSend` = `{ limit: 10, windowSec: 600 }`.
- Undo window: **10 000 ms** for interactive sends; **0** for agent approvals and recruiter batch sends.
- Retry backoff (minutes): **1, 5, 30, 120**; **MAX_EMAIL_ATTEMPTS = 5**. Lease: **120 s**.
- Recipients: ≥ 1 in To, **≤ 20 total** across To/CC/BCC, deduped case-insensitively, each passing `checkRecipient` (`src/lib/chat-send.ts`).
- Resend (`sendOutreachMessage`, `getOutreachSendConfig`) must be unreachable from any 1:1 path after P1. Outreach campaigns keep it.
- User-facing errors: `UserFacingError` / `friendlyError` (`src/lib/errors.ts`); never surface `err.message` from providers.
- Low-level lib modules must NOT import `next/server` (it keeps tsx scripts alive). Only `src/lib/email/schedule.ts` (Task 8) and actions may import `after`.
- Every new `scripts/smoke-*.ts` must be registered in `MANIFEST` in `scripts/run-smoke.ts` with a tier, and `pglite` smokes must start with `import "./smoke/_env";`.
- Never run smokes with `SMOKE_ALLOW_REMOTE=1` against a real database.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Deviations from the spec (decided while planning — update the spec in Task 1)

1. **`idempotency_key` column** (nullable text) with a partial unique index on `(user_id, idempotency_key)` for active/ambiguous rows. Chat, agent and recruiter sends already have natural keys; this replaces chat's claim-row-before-send.
2. **Interaction `source` is per origin, not the origin name**, so existing readers keep working: `chat` → `"chat_send"` (read by `src/actions/chat.ts`), `agent` → `"mcp"`, `follow_up` → `"follow_up"`, `recruiter` → `"recruiter_send"`, `compose` → `"email_send"`.
3. **A `demo` provider**: demo workspaces (`isDemoWorkspace`) have no OAuth tokens; the demo provider marks sends sent without network, matching `sendRecruiterDrafts`'s existing demo short-circuit.
4. **`from_name` is captured at enqueue** from the calling action (Clerk profile needs a request; the drain has none).
5. **Contact-timeline pending items move to P2** (they belong with Compose). P1 ships the failed-send account alert only.
6. `email_sends` is purged in the **`contacts`** data category: deleting contacts must also stop their queued mail.

## File Structure

| File | Responsibility |
|---|---|
| `src/db/schema.ts` | `emailSends` table; `userSettings` signature + default-provider columns |
| `src/db/index.ts` | DDL, `alters`, `ensureColumn`s, `SCHEMA_VERSION` |
| `src/lib/email/config.ts` | Constants: caps, backoff, lease, undo delay, types shared by all email modules (pure) |
| `src/lib/email/recipients.ts` | `normalizeRecipients()` (pure) |
| `src/lib/email/mime.ts` | MIME building for multi-recipient / HTML / Message-ID (pure; moved from `gmail-send.ts`) |
| `src/lib/email/providers/types.ts` | `MailProvider`, `OutboundMessage`, `SendResult`, `MailProviderError` |
| `src/lib/email/providers/gmail.ts` | Gmail provider (send, findSent, identity) |
| `src/lib/email/providers/demo.ts` | No-network provider for demo workspaces |
| `src/lib/email/providers/index.ts` | `providerFor(id)` registry, overridable in tests |
| `src/lib/email/sender.ts` | `resolveSender()`, `getSendCapability()` |
| `src/lib/email/contacts.ts` | `resolveRecipientContacts()` — email → contact ids |
| `src/lib/email/origins.ts` | Per-origin interaction source/externalId + success/failure hooks |
| `src/lib/email/outbox.ts` | `enqueueEmail`, `cancelEmailSend`, `dispatchEmailSend`, `drainEmailSends`, `countEmailSendsToday` |
| `src/lib/email/schedule.ts` | `scheduleDispatch()` — the only module that imports `after` |
| `src/actions/email-sends.ts` | `cancelEmailSendAction`, `getSendCapabilityAction`, `dismissFailedSendsAction` |
| `src/components/email/undo-send-toast.tsx` | `showUndoSendToast()` |
| `src/components/email/connect-mailbox-button.tsx` | "Connect Gmail" / "Allow Gmail to send" CTA |
| `src/app/api/email/drain/route.ts` | Internal drain route |
| `src/lib/reminder-writes.ts` | + `clearContactFollowUpForUser()` (request-free) |
| `scripts/smoke-email-recipients.ts`, `smoke-email-mime.ts`, `smoke-email-provider-gmail.ts`, `smoke-email-sends.ts`, `smoke-email-origins.ts`, `smoke-email-no-resend.ts` | Tests |

---

### Task 1: Schema — `email_sends` + settings columns

**Files:**
- Modify: `src/db/schema.ts` (new table near `connectorOutbox` ~line 5403; `userSettings` ~line 113)
- Modify: `src/db/index.ts` (DDL template; `alters` ~line 3665; `migratePglite` `ensureColumn`s ~line 3475; `SCHEMA_VERSION` ~line 2342 + changelog comment)
- Modify: `src/lib/user-data.ts` (`contacts` STEP)
- Modify: `scripts/smoke-purge.ts` (seed), `scripts/schema-ddl.lock.json` (via `--update`)
- Modify: `docs/superpowers/specs/2026-09-29-direct-email-design.md` (record deviations 1–6)

**Interfaces:**
- Produces: `emailSends` Drizzle table; `EmailSendStatus`, `EmailOrigin`, `EmailFailureKind`, `EmailProviderId` types exported from `src/db/schema.ts`; `userSettings.emailSignatureText`, `.emailSignatureHtml`, `.defaultSendProvider`.

- [ ] **Step 1: Claim a schema version**

```bash
bash -c 'git fetch -q origin; for b in $(git for-each-ref --format="%(refname:short)" refs/remotes refs/heads); do v=$(git show "${b}:src/db/index.ts" 2>/dev/null | grep -o "export const SCHEMA_VERSION = [0-9]*" | grep -o "[0-9]*$"); echo "$v $b"; done | sort -n | tail -3'
```

Use `max + 1` (call it `N` below; ≥ 139). Run under `bash -c` — zsh mangles `$b:src`.

- [ ] **Step 2: Add the Drizzle table** in `src/db/schema.ts` directly after `connectorOutbox`:

```ts
export type EmailProviderId = "gmail" | "outlook" | "demo";
export type EmailOrigin = "compose" | "follow_up" | "chat" | "agent" | "recruiter";
export type EmailSendStatus = "queued" | "sending" | "sent" | "failed" | "canceled";
export type EmailFailureKind = "auth" | "permanent" | "ambiguous" | "exhausted";
export type EmailAttachmentRef = { blobKey: string; filename: string; contentType: string; size: number };

/**
 * One person-to-person email, from enqueue to delivery. The single path every 1:1 send in
 * Orbit takes (spec: docs/superpowers/specs/2026-09-29-direct-email-design.md). Claim/lease
 * columns follow `connector_outbox`: `claimed_by` + `lease_until` are evaluated on the
 * DATABASE clock, and every post-send write is guarded on `claimed_by`.
 */
export const emailSends = pgTable(
  "email_sends",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider").$type<EmailProviderId>().notNull(),
    fromEmail: text("from_email").notNull(),
    fromName: text("from_name"),
    to: jsonb("to").$type<string[]>().notNull(),
    cc: jsonb("cc").$type<string[]>().default([]).notNull(),
    bcc: jsonb("bcc").$type<string[]>().default([]).notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    contactIds: jsonb("contact_ids").$type<string[]>().default([]).notNull(),
    origin: text("origin").$type<EmailOrigin>().notNull(),
    originRef: text("origin_ref"),
    idempotencyKey: text("idempotency_key"),
    status: text("status").$type<EmailSendStatus>().default("queued").notNull(),
    sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    attempts: integer("attempts").default(0).notNull(),
    claimedBy: uuid("claimed_by"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    failureKind: text("failure_kind").$type<EmailFailureKind>(),
    rfcMessageId: text("rfc_message_id").notNull(),
    providerMessageId: text("provider_message_id"),
    providerThreadId: text("provider_thread_id"),
    inReplyToSendId: uuid("in_reply_to_send_id"),
    inReplyToRfcId: text("in_reply_to_rfc_id"),
    attachments: jsonb("attachments").$type<EmailAttachmentRef[]>().default([]).notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Partial in the DDL (active + ambiguous rows only); the guard compares name + columns.
    uniqueIndex("email_sends_idempotency_uidx").on(t.userId, t.idempotencyKey),
    index("email_sends_due_idx").on(t.sendAt),
    index("email_sends_user_created_idx").on(t.userId, t.createdAt),
    index("email_sends_user_status_idx").on(t.userId, t.status),
    index("email_sends_contact_ids_idx").using("gin", t.contactIds),
  ]
);
```

And in `userSettings` (next to `writingInstructions`):

```ts
    emailSignatureText: text("email_signature_text"),
    emailSignatureHtml: text("email_signature_html"),
    defaultSendProvider: text("default_send_provider").$type<"gmail" | "outlook">(),
```

- [ ] **Step 3: Add the DDL.** In the `DDL` template, directly after the `connector_outbox` block:

```sql
CREATE TABLE IF NOT EXISTS email_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  provider text NOT NULL,
  from_email text NOT NULL,
  from_name text,
  "to" jsonb NOT NULL,
  cc jsonb NOT NULL DEFAULT '[]'::jsonb,
  bcc jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  contact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  origin text NOT NULL,
  origin_ref text,
  idempotency_key text,
  status text NOT NULL DEFAULT 'queued',
  send_at timestamptz NOT NULL,
  sent_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  claimed_by uuid,
  lease_until timestamptz,
  last_error text,
  failure_kind text,
  rfc_message_id text NOT NULL,
  provider_message_id text,
  provider_thread_id text,
  in_reply_to_send_id uuid,
  in_reply_to_rfc_id text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_sends_idempotency_uidx ON email_sends(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND (status IN ('queued','sending','sent') OR failure_kind = 'ambiguous');
CREATE INDEX IF NOT EXISTS email_sends_due_idx ON email_sends(send_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS email_sends_user_created_idx ON email_sends(user_id, created_at);
CREATE INDEX IF NOT EXISTS email_sends_user_status_idx ON email_sends(user_id, status);
CREATE INDEX IF NOT EXISTS email_sends_contact_ids_idx ON email_sends USING gin (contact_ids);
```

In the `user_settings` CREATE TABLE add:

```sql
  email_signature_text text,
  email_signature_html text,
  default_send_provider text,
```

Append to `alters` (end of list), each a one-line template string, under `// Schema vN: email_sends — the person-to-person outbox (direct email P1), plus the signature and default sending mailbox on user_settings.`: the same `CREATE TABLE IF NOT EXISTS email_sends (...)` collapsed to one line (as `connector_outbox` is at ~line 4081), the five index statements, and:

```ts
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS email_signature_text text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS email_signature_html text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS default_send_provider text`,
```

In `migratePglite` after the last `ensureColumn` block:

```ts
  // vN: direct email — signature and default sending mailbox. Same reasoning as every block above.
  await ensureColumn(client, "user_settings", "email_signature_text", "text");
  await ensureColumn(client, "user_settings", "email_signature_html", "text");
  await ensureColumn(client, "user_settings", "default_send_provider", "text");
```

Bump `SCHEMA_VERSION = N` and add a changelog comment above it in the existing style:

```ts
// N = email_sends (the person-to-person outbox every 1:1 send goes through — direct email P1)
// and user_settings.email_signature_text/_html + default_send_provider. Scanned every local and
// remote ref on <date>: <max> is the highest claimed anywhere, so N is the next free integer.
```

- [ ] **Step 4: Run the DDL guard to see it fail, then update the lock**

Run: `npx tsx scripts/smoke-schema-ddl.ts`
Expected: FAIL on the fingerprint (version/DDL changed). Then:
Run: `npx tsx scripts/smoke-schema-ddl.ts --update && npx tsx scripts/smoke-schema-ddl.ts`
Expected: PASS.

- [ ] **Step 5: Register for purge.** In `src/lib/user-data.ts`'s `contacts` STEP: add `own(emailSends)` to `exports`, `emailSends` to `counts`, and at the top of `run`:

```ts
      // Queued and sent 1:1 mail. Deleted with contacts so a purge also stops anything still
      // waiting in the outbox — a queued send outliving its contact would still go out.
      await db.delete(emailSends).where(eq(emailSends.userId, userId));
```

In `scripts/smoke-purge.ts` `seed()` add:

```ts
  // A queued outbound email, body included.
  await db.insert(schema.emailSends).values({
    userId: USER,
    provider: "gmail",
    fromEmail: "me@example.org",
    to: ["friend@example.org"],
    subject: "Hi",
    bodyText: "Unsent body",
    origin: "compose",
    sendAt: new Date(),
    rfcMessageId: "<smoke-purge@orbit>",
  });
```

- [ ] **Step 6: Run purge + schema smokes**

Run: `npx tsx scripts/run-smoke.ts --only smoke-schema-ddl smoke-purge smoke-admin-redaction smoke-delete-partial`
Expected: all PASS (no `LEAK`).

- [ ] **Step 7: Record the deviations in the spec.** Add a `## Planning amendments (P1 plan)` section at the end of the spec listing deviations 1–6 from this plan verbatim, and add `idempotency_key` to the §1 column table.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/index.ts src/lib/user-data.ts scripts/smoke-purge.ts scripts/schema-ddl.lock.json docs/superpowers/specs/2026-09-29-direct-email-design.md
git commit -m "feat(email): email_sends outbox table + signature settings (schema vN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Config, recipient normalization, rate bucket

**Files:**
- Create: `src/lib/email/config.ts`, `src/lib/email/recipients.ts`
- Modify: `src/lib/rate-limit.ts` (`BUCKET_LABELS` ~line 21, `RATE_LIMITS` ~line 84)
- Test: `scripts/smoke-email-recipients.ts` (tier `pure`)
- Modify: `scripts/run-smoke.ts` (MANIFEST)

**Interfaces:**
- Produces:
  - `EMAIL_SEND_DAILY_CAP: Record<Plan, number>`, `UNDO_DELAY_MS = 10_000`, `MAX_EMAIL_ATTEMPTS = 5`, `EMAIL_LEASE_SECONDS = 120`, `EMAIL_BACKOFF_MINUTES = [1, 5, 30, 120]`, `MAX_RECIPIENTS = 20`, `emailBackoffSeconds(attempt: number): number`
  - `normalizeRecipients(input: { to: string[]; cc?: string[]; bcc?: string[] }): RecipientsResult` where `RecipientsResult = { ok: true; to: string[]; cc: string[]; bcc: string[]; all: string[] } | { ok: false; reason: "no_recipient" | "too_many" | "invalid_recipient" | "placeholder"; address?: string }`
  - `RATE_LIMITS.emailSend`

- [ ] **Step 1: Write the failing test** `scripts/smoke-email-recipients.ts`:

```ts
/**
 * Recipient normalization for the email outbox: dedupe, caps, and the one-mailbox rule.
 * Run: npx tsx scripts/smoke-email-recipients.ts
 */
import { normalizeRecipients } from "../src/lib/email/recipients";
import { emailBackoffSeconds, EMAIL_SEND_DAILY_CAP, MAX_EMAIL_ATTEMPTS } from "../src/lib/email/config";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const one = normalizeRecipients({ to: ["  Maya@Example.org "] });
check("trims and lowercases", one.ok && one.to[0] === "maya@example.org", JSON.stringify(one));

const dup = normalizeRecipients({ to: ["a@x.org"], cc: ["A@x.org", "b@x.org"], bcc: ["b@x.org"] });
check(
  "dedupes across fields, first field wins",
  dup.ok && dup.to.join() === "a@x.org" && dup.cc.join() === "b@x.org" && dup.bcc.length === 0,
  JSON.stringify(dup)
);
check("all lists every unique address", dup.ok && dup.all.length === 2);

check("empty To is refused", (() => { const r = normalizeRecipients({ to: [], cc: ["a@x.org"] }); return !r.ok && r.reason === "no_recipient"; })());

const many = Array.from({ length: 21 }, (_, i) => `p${i}@x.org`);
check("21 recipients is refused", (() => { const r = normalizeRecipients({ to: many }); return !r.ok && r.reason === "too_many"; })());
check("20 recipients is allowed", normalizeRecipients({ to: many.slice(0, 20) }).ok);

const inj = normalizeRecipients({ to: ["a@x.org\r\nBcc: evil@x.org"] });
check("header injection is refused", !inj.ok && inj.reason === "invalid_recipient");

const pair = normalizeRecipients({ to: ["a@x.org, b@x.org"] });
check("a comma pair is not one mailbox", !pair.ok && pair.reason === "invalid_recipient");

const ph = normalizeRecipients({ to: ["someone@example.com"] });
check("placeholder domains are refused", !ph.ok && ph.reason === "placeholder" && ph.address === "someone@example.com");

check("caps per plan", EMAIL_SEND_DAILY_CAP.free === 20 && EMAIL_SEND_DAILY_CAP.orbit === 100 && EMAIL_SEND_DAILY_CAP.lifetime === 100);
check("backoff ladder", [1, 2, 3, 4, 9].map(emailBackoffSeconds).join() === "60,300,1800,7200,7200");
check("attempt limit", MAX_EMAIL_ATTEMPTS === 5);

console.log("\nAll email-recipient checks passed.");
```

Register in `scripts/run-smoke.ts` MANIFEST: `"smoke-email-recipients": "pure",`

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-email-recipients.ts`
Expected: FAIL — cannot find module `../src/lib/email/recipients`.

- [ ] **Step 3: Implement** `src/lib/email/config.ts`:

```ts
import type { Plan } from "@/lib/plan-limits";

/**
 * The numbers every 1:1 send obeys. One cap across every origin (compose, follow-ups,
 * chat, agent approvals, recruiters) — see the direct-email spec §3. Pure: no DB, no
 * next/server, safe for client and pure smokes.
 */
export const EMAIL_SEND_DAILY_CAP: Record<Plan, number> = {
  free: 20,
  orbit: 100,
  lifetime: 100,
};

/** How long an interactive send waits before it goes out — the Undo window. */
export const UNDO_DELAY_MS = 10_000;

export const MAX_RECIPIENTS = 20;
export const MAX_EMAIL_ATTEMPTS = 5;
/** Claim lease. Longer than one provider call (20s timeout) with margin; DB clock. */
export const EMAIL_LEASE_SECONDS = 120;
/** Nominal retry ladder. The drain runs every ten minutes, so the first steps collapse. */
export const EMAIL_BACKOFF_MINUTES = [1, 5, 30, 120] as const;

/** Seconds to wait before retry number `attempt` (1-based: the attempt that just failed). */
export function emailBackoffSeconds(attempt: number): number {
  const i = Math.min(Math.max(attempt, 1), EMAIL_BACKOFF_MINUTES.length) - 1;
  return EMAIL_BACKOFF_MINUTES[i]! * 60;
}
```

`src/lib/email/recipients.ts`:

```ts
import { checkRecipient } from "@/lib/chat-send";
import { MAX_RECIPIENTS } from "@/lib/email/config";

export type RecipientsResult =
  | { ok: true; to: string[]; cc: string[]; bcc: string[]; all: string[] }
  | {
      ok: false;
      reason: "no_recipient" | "too_many" | "invalid_recipient" | "placeholder";
      address?: string;
    };

/**
 * Validates and normalizes To/CC/BCC. Each entry must be exactly one mailbox
 * (`checkRecipient` refuses commas, angle brackets, whitespace and control characters, which
 * is also what keeps CR/LF out of the headers). Addresses are lowercased and deduped across
 * all three fields; the first field an address appears in keeps it.
 */
export function normalizeRecipients(input: {
  to: string[];
  cc?: string[];
  bcc?: string[];
}): RecipientsResult {
  const seen = new Set<string>();
  const out = { to: [] as string[], cc: [] as string[], bcc: [] as string[] };
  for (const field of ["to", "cc", "bcc"] as const) {
    for (const raw of input[field] ?? []) {
      const check = checkRecipient(raw);
      if (!check.ok) {
        if (check.reason === "no_email") continue; // blank chip — ignore
        return { ok: false, reason: check.reason, address: raw.trim() };
      }
      const email = check.email.toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      out[field].push(email);
    }
  }
  if (out.to.length === 0) return { ok: false, reason: "no_recipient" };
  if (seen.size > MAX_RECIPIENTS) return { ok: false, reason: "too_many" };
  return { ok: true, ...out, all: [...seen] };
}
```

In `src/lib/rate-limit.ts` add to `BUCKET_LABELS`: `emailSend: "email send",` and to `RATE_LIMITS`:

```ts
  /**
   * Any person-to-person email through the outbox (`src/lib/email/outbox.ts`). Outbound and
   * sent as the user, so measured over ten minutes like `chatSend`, which it replaces. The
   * daily cap is separate and per plan (`EMAIL_SEND_DAILY_CAP`).
   */
  emailSend: { limit: 10, windowSec: 600 },
```

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/smoke-email-recipients.ts && npx tsx scripts/smoke-consume-bucket-args.ts`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/config.ts src/lib/email/recipients.ts src/lib/rate-limit.ts scripts/smoke-email-recipients.ts scripts/run-smoke.ts
git commit -m "feat(email): send limits, retry ladder and recipient normalization

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: MIME builder for multi-recipient, HTML and Message-ID

**Files:**
- Create: `src/lib/email/mime.ts`
- Modify: `src/lib/gmail-send.ts` (re-export helpers from `mime.ts`; keep `sendGmailMessage` until Task 14)
- Test: `scripts/smoke-email-mime.ts` (tier `pure`); `scripts/smoke-gmail-send-mime.ts` must still pass

**Interfaces:**
- Produces:
  - `type MimeInput = { from: { name: string | null; email: string }; to: string[]; cc: string[]; bcc: string[]; subject: string; bodyText: string; bodyHtml: string | null; messageId: string; inReplyTo?: string | null; references?: string | null }`
  - `buildMime(input: MimeInput, boundary?: string): string`
  - `toBase64Url(input: string): string`, `formatAddress(name, email)`, `sanitizeHeader(value)`, `encodeHeader(value)`
  - `newRfcMessageId(domain?: string): string` → `<uuid@orbit.mail>`

- [ ] **Step 1: Write the failing test** `scripts/smoke-email-mime.ts`:

```ts
/**
 * The outbox's MIME builder: multi-recipient headers, Bcc never written, HTML alternative,
 * fixed Message-ID, and no header smuggling. Run: npx tsx scripts/smoke-email-mime.ts
 */
import { buildMime, newRfcMessageId } from "../src/lib/email/mime";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const base = {
  from: { name: "Jason P", email: "me@x.org" },
  to: ["a@x.org", "b@x.org"],
  cc: ["c@x.org"],
  bcc: ["hidden@x.org"],
  subject: "Café plans",
  bodyText: "Hi there",
  bodyHtml: null,
  messageId: "<fixed-id@orbit.mail>",
};

const plain = buildMime(base);
const [head, body] = plain.split("\r\n\r\n");
check("To lists every address", /^To: a@x\.org, b@x\.org$/m.test(head!), head);
check("Cc present", /^Cc: c@x\.org$/m.test(head!));
check("Bcc is NEVER written into the message", !/hidden@x\.org/.test(plain));
check("Message-ID is the fixed id", /^Message-ID: <fixed-id@orbit\.mail>$/m.test(head!));
check("non-ascii subject is an encoded-word", /^Subject: =\?UTF-8\?B\?/m.test(head!));
check("plain body follows the blank line", body === "Hi there");

const html = buildMime({ ...base, bodyHtml: "<p>Hi <b>there</b></p>" }, "BOUNDARY");
check("html uses multipart/alternative", /^Content-Type: multipart\/alternative; boundary="BOUNDARY"$/m.test(html));
check("text part precedes html part", html.indexOf("text/plain") < html.indexOf("text/html"));
check("closing boundary present", html.includes("--BOUNDARY--"));

const inj = buildMime({ ...base, subject: "Hi\r\nBcc: evil@x.org" });
check("subject CR/LF cannot start a header", !/^Bcc:/m.test(inj));

const reply = buildMime({ ...base, inReplyTo: "<orig@x.org>", references: "<root@x.org> <orig@x.org>" });
check("In-Reply-To set", /^In-Reply-To: <orig@x\.org>$/m.test(reply));
check("References carries the chain", /^References: <root@x\.org> <orig@x\.org>$/m.test(reply));

const id = newRfcMessageId();
check("generated ids are angle-bracketed and unique", /^<[0-9a-f-]{36}@orbit\.mail>$/.test(id) && id !== newRfcMessageId(), id);

console.log("\nAll MIME checks passed.");
```

Register: `"smoke-email-mime": "pure",`

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-email-mime.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/lib/email/mime.ts`. Move `isAscii`, `encodeHeader`, `sanitizeHeader`, `formatAddress`, `toBase64Url` out of `src/lib/gmail-send.ts` verbatim (keep their comments), export them, and add:

```ts
import { randomUUID } from "node:crypto";

export type MimeInput = {
  from: { name: string | null; email: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  /** Fixed at enqueue; the outbox's duplicate check searches Sent for it. */
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
};

/** `<uuid@orbit.mail>` — globally unique, and searchable via Gmail's `rfc822msgid:`. */
export function newRfcMessageId(domain = "orbit.mail"): string {
  return `<${randomUUID()}@${domain}>`;
}

function addressList(emails: string[]) {
  return emails.map((e) => sanitizeHeader(e)).join(", ");
}

/**
 * RFC 5322 message. Bcc is deliberately never written: Gmail and Graph take Bcc from the
 * envelope we pass separately, and a Bcc header in the raw message would reveal the list to
 * every recipient on some clients.
 */
export function buildMime(input: MimeInput, boundary = `orbit-${randomUUID()}`): string {
  const headers = [
    `From: ${formatAddress(input.from.name, input.from.email)}`,
    `To: ${addressList(input.to)}`,
    ...(input.cc.length ? [`Cc: ${addressList(input.cc)}`] : []),
    `Subject: ${encodeHeader(sanitizeHeader(input.subject))}`,
    `Message-ID: ${sanitizeHeader(input.messageId)}`,
    "MIME-Version: 1.0",
  ];
  if (input.inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeader(input.inReplyTo)}`);
  if (input.references) headers.push(`References: ${sanitizeHeader(input.references)}`);

  if (!input.bodyHtml) {
    headers.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit");
    return `${headers.join("\r\n")}\r\n\r\n${input.bodyText}`;
  }
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const part = (type: string, content: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset="UTF-8"`, "Content-Transfer-Encoding: 8bit", "", content].join("\r\n");
  return [
    headers.join("\r\n"),
    "",
    part("text/plain", input.bodyText),
    part("text/html", input.bodyHtml),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
```

Note: Gmail's `messages.send` delivers to Bcc recipients only if they appear in a `Bcc:` header of the raw message (Gmail strips it before delivery). **Therefore the Gmail provider (Task 4) appends the Bcc header itself** via `withBccHeader(raw, bcc)`; add to `mime.ts`:

```ts
/** Gmail reads Bcc from the raw headers and strips it before delivery. Graph does not need this. */
export function withBccHeader(mime: string, bcc: string[]): string {
  if (!bcc.length) return mime;
  const split = mime.indexOf("\r\n\r\n");
  return `${mime.slice(0, split)}\r\nBcc: ${addressList(bcc)}${mime.slice(split)}`;
}
```

Add to the test (Step 1 file) before the final log:

```ts
import { withBccHeader } from "../src/lib/email/mime";
const gmailRaw = withBccHeader(plain, ["hidden@x.org"]);
check("Gmail variant carries Bcc in the header block only", /^Bcc: hidden@x\.org$/m.test(gmailRaw.split("\r\n\r\n")[0]!));
```

In `src/lib/gmail-send.ts`, replace the moved helpers with `import { encodeHeader, formatAddress, sanitizeHeader, toBase64Url } from "@/lib/email/mime";` and keep `export { formatAddress } from "@/lib/email/mime";` so `smoke-gmail-send-mime.ts` imports still resolve.

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/smoke-email-mime.ts && npx tsx scripts/smoke-gmail-send-mime.ts`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/mime.ts src/lib/gmail-send.ts scripts/smoke-email-mime.ts scripts/run-smoke.ts
git commit -m "feat(email): multi-recipient MIME builder with fixed Message-ID

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Provider interface, Gmail + demo providers, sender resolution

**Files:**
- Create: `src/lib/email/providers/types.ts`, `providers/gmail.ts`, `providers/demo.ts`, `providers/index.ts`, `src/lib/email/sender.ts`
- Test: `scripts/smoke-email-provider-gmail.ts` (tier `pglite`)

**Interfaces:**
- Consumes: `buildMime`, `withBccHeader`, `toBase64Url` (Task 3); `getValidAccessToken`, `hasSendScope` (`src/lib/gmail.ts`); `hasScope`, `GOOGLE_SCOPES` (`src/lib/google-scopes.ts`); `isDemoWorkspace` (`src/lib/demo-workspace.ts`); `getEntitlements` (`src/lib/entitlements.ts`).
- Produces:
  - `type OutboundMessage = MimeInput` (re-exported)
  - `type SendResult = { providerMessageId: string; providerThreadId: string | null }`
  - `class MailProviderError extends Error { kind: "auth" | "transient" | "permanent" | "ambiguous" }`
  - `interface MailProvider { id: EmailProviderId; identity(userId): Promise<{ email: string } | null>; send(userId, msg, opts?: { threadId?: string | null }): Promise<SendResult>; findSent(userId, rfcMessageId): Promise<SendResult | null | "unknown"> }`
  - `providerFor(id: EmailProviderId): MailProvider`; `setProviderOverride(id, provider | null)` (tests only)
  - `resolveSender(userId): Promise<{ ok: true; provider: EmailProviderId; fromEmail: string } | { ok: false; reason: SendBlockReason }>` with `SendBlockReason = "not_connected" | "no_send_scope" | "needs_reauth"`
  - `getSendCapability(userId): Promise<SendCapability>` where `SendCapability = { ok: true; provider: EmailProviderId; fromEmail: string; dailyCap: number; usedToday: number; remainingToday: number } | { ok: false; reason: SendBlockReason | "cap_reached"; dailyCap: number; usedToday: number }`
  - `countEmailSendsToday(userId): Promise<number>` (lives in `sender.ts` so `outbox.ts` and capability share it)

- [ ] **Step 1: Write the failing test** `scripts/smoke-email-provider-gmail.ts`:

```ts
/**
 * Gmail provider: error classification, Bcc handling, findSent, and sender resolution.
 * Fetch is mocked; no network. Run: npx tsx scripts/smoke-email-provider-gmail.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { gmailProvider } from "../src/lib/email/providers/gmail";
import { MailProviderError } from "../src/lib/email/providers/types";
import { resolveSender } from "../src/lib/email/sender";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-provider-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Mode = "ok" | "500" | "429" | "400" | "401" | "403" | "network" | "noid";
let mode: Mode = "ok";
const calls: { url: string; body: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  calls.push({ url: u, body: String(init?.body ?? "") });
  if (u.includes("/messages?q=")) {
    return new Response(JSON.stringify(u.includes("found") ? { messages: [{ id: "m-found", threadId: "t-found" }] } : {}), { status: 200 });
  }
  if (mode === "network") throw new TypeError("fetch failed");
  if (mode === "noid") return new Response("{}", { status: 200 });
  if (mode !== "ok") return new Response("nope", { status: Number(mode) });
  return new Response(JSON.stringify({ id: "m1", threadId: "t1" }), { status: 200 });
}) as typeof fetch;

const MSG = {
  from: { name: "Me", email: "me@x.org" },
  to: ["a@x.org"], cc: [], bcc: ["b@x.org"],
  subject: "Hi", bodyText: "Body", bodyHtml: null, messageId: "<id-1@orbit.mail>",
};

async function kind(m: Mode): Promise<string> {
  mode = m;
  try { await gmailProvider.send(USER, MSG); return "ok"; }
  catch (e) { return e instanceof MailProviderError ? e.kind : `raw:${String(e)}`; }
}

async function main() {
  const db = await getDb();
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  try {
    check("not connected → resolveSender refuses", (await resolveSender(USER)).ok === false);

    await db.insert(schema.gmailConnections).values({
      userId: USER,
      emailAddress: "Me@X.org",
      accessTokenEncrypted: encrypt("tok"),
      refreshTokenEncrypted: encrypt("ref"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: GOOGLE_SCOPES.contacts,
      status: "active",
    } as typeof schema.gmailConnections.$inferInsert);
    const noScope = await resolveSender(USER);
    check("no send scope → no_send_scope", !noScope.ok && noScope.reason === "no_send_scope");

    await db.update(schema.gmailConnections).set({ scopes: `${GOOGLE_SCOPES.contacts} ${GOOGLE_SCOPES.gmailSend}` });
    const ok = await resolveSender(USER);
    check("send scope → gmail, lowercased address", ok.ok && ok.provider === "gmail" && ok.fromEmail === "me@x.org", JSON.stringify(ok));

    mode = "ok"; calls.length = 0;
    const sent = await gmailProvider.send(USER, MSG);
    check("returns provider ids", sent.providerMessageId === "m1" && sent.providerThreadId === "t1");
    const raw = Buffer.from(JSON.parse(calls[0]!.body).raw, "base64url").toString("utf8");
    check("Bcc travels in the raw header for Gmail", /^Bcc: b@x\.org$/m.test(raw.split("\r\n\r\n")[0]!));

    check("500 → transient", (await kind("500")) === "transient");
    check("429 → transient", (await kind("429")) === "transient");
    check("400 → permanent", (await kind("400")) === "permanent");
    check("401 → auth", (await kind("401")) === "auth");
    check("403 → auth (missing scope)", (await kind("403")) === "auth");
    check("network drop → ambiguous", (await kind("network")) === "ambiguous");
    check("200 without id → ambiguous", (await kind("noid")) === "ambiguous");

    check("findSent without read scope → unknown", (await gmailProvider.findSent(USER, "<found@x>")) === "unknown");
    await db.update(schema.gmailConnections).set({ scopes: `${GOOGLE_SCOPES.gmailSend} ${GOOGLE_SCOPES.gmailRead}` });
    const found = await gmailProvider.findSent(USER, "<found@x>");
    check("findSent with read scope finds by rfc822msgid", typeof found === "object" && found?.providerMessageId === "m-found");
    check("findSent miss → null", (await gmailProvider.findSent(USER, "<missing@x>")) === null);

    await db.update(schema.gmailConnections).set({ status: "needs_reauth" });
    const re = await resolveSender(USER);
    check("needs_reauth surfaces", !re.ok && re.reason === "needs_reauth");
  } finally {
    globalThis.fetch = realFetch;
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Gmail provider checks passed.");
}

run(main);
```

Before writing, confirm the `gmailConnections` insert columns against `src/db/schema.ts:~2501` and the encrypt helper's path (`grep -rn "export function encrypt" src/lib`); adjust the import and column names to match exactly. Register: `"smoke-email-provider-gmail": "pglite",`

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-email-provider-gmail.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/lib/email/providers/types.ts`:

```ts
import type { EmailProviderId } from "@/db/schema";
import type { MimeInput } from "@/lib/email/mime";

export type OutboundMessage = MimeInput;
export type SendResult = { providerMessageId: string; providerThreadId: string | null };
export type MailErrorKind = "auth" | "transient" | "permanent" | "ambiguous";

/**
 * How a send failed, which decides what the outbox does next:
 *   auth       — connection needs reconnecting; fail, don't retry
 *   transient  — 429/5xx; back off and retry
 *   permanent  — the provider refused this message; fail
 *   ambiguous  — the request may have reached the provider; never blindly resend
 * `message` is internal. Users see `friendlyError`/origin copy, never this text.
 */
export class MailProviderError extends Error {
  readonly kind: MailErrorKind;
  constructor(kind: MailErrorKind, message: string) {
    super(message);
    this.name = "MailProviderError";
    this.kind = kind;
  }
}

export interface MailProvider {
  id: EmailProviderId;
  /** The sending address, or null when not connected / no send scope / needs reauth. */
  identity(userId: string): Promise<{ email: string } | null>;
  send(userId: string, msg: OutboundMessage, opts?: { threadId?: string | null }): Promise<SendResult>;
  /** Is a message with this Message-ID already in Sent? "unknown" = no read access. */
  findSent(userId: string, rfcMessageId: string): Promise<SendResult | null | "unknown">;
}
```

`src/lib/email/providers/gmail.ts`:

```ts
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailConnections } from "@/db/schema";
import { getValidAccessToken, hasSendScope } from "@/lib/gmail";
import { GOOGLE_SCOPES, hasScope } from "@/lib/google-scopes";
import { buildMime, toBase64Url, withBccHeader } from "@/lib/email/mime";
import { MailProviderError, type MailProvider, type SendResult } from "@/lib/email/providers/types";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function connection(userId: string) {
  const db = await getDb();
  return db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { status: true, scopes: true, emailAddress: true },
  });
}

/** Token errors happen before any request leaves, so they are never ambiguous. */
async function token(userId: string): Promise<string> {
  try {
    return await getValidAccessToken(userId);
  } catch (err) {
    if (err instanceof Error && err.name === "ReauthRequiredError") {
      throw new MailProviderError("auth", err.message);
    }
    throw new MailProviderError("auth", err instanceof Error ? err.message : "Gmail is not connected");
  }
}

function classify(status: number, body: string): MailProviderError {
  if (status === 401 || status === 403) return new MailProviderError("auth", `Gmail ${status}: ${body.slice(0, 200)}`);
  if (status === 429 || status >= 500) return new MailProviderError("transient", `Gmail ${status}: ${body.slice(0, 200)}`);
  return new MailProviderError("permanent", `Gmail ${status}: ${body.slice(0, 200)}`);
}

export const gmailProvider: MailProvider = {
  id: "gmail",

  async identity(userId) {
    const conn = await connection(userId);
    if (!conn || conn.status !== "active" || !hasSendScope(conn.scopes)) return null;
    return { email: conn.emailAddress.trim().toLowerCase() };
  },

  async send(userId, msg, opts = {}) {
    const accessToken = await token(userId);
    const raw = toBase64Url(withBccHeader(buildMime(msg), msg.bcc));
    let res: Response;
    try {
      res = await fetch(`${API}/messages/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(opts.threadId ? { raw, threadId: opts.threadId } : { raw }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      // The request may have reached Gmail. The outbox checks Sent before any retry.
      throw new MailProviderError("ambiguous", err instanceof Error ? err.message : "network error");
    }
    if (!res.ok) throw classify(res.status, await res.text().catch(() => ""));
    const data = (await res.json().catch(() => ({}))) as { id?: string; threadId?: string };
    if (!data.id) throw new MailProviderError("ambiguous", "Gmail accepted the send but returned no id");
    return { providerMessageId: data.id, providerThreadId: data.threadId ?? null } satisfies SendResult;
  },

  async findSent(userId, rfcMessageId) {
    const conn = await connection(userId);
    if (!conn || conn.status !== "active" || !hasScope(conn.scopes, GOOGLE_SCOPES.gmailRead)) return "unknown";
    const accessToken = await token(userId);
    const q = encodeURIComponent(`rfc822msgid:${rfcMessageId.replace(/^<|>$/g, "")}`);
    const res = await fetch(`${API}/messages?q=${q}&maxResults=1&includeSpamTrash=false`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res || !res.ok) return "unknown";
    const data = (await res.json().catch(() => ({}))) as { messages?: { id: string; threadId?: string }[] };
    const hit = data.messages?.[0];
    return hit ? { providerMessageId: hit.id, providerThreadId: hit.threadId ?? null } : null;
  },
};
```

Note for the test's mock: `findSent`'s URL for `<found@x>` contains `found`, which is how the mock returns a hit. Confirm `GOOGLE_SCOPES.gmailRead` is the key name (`src/lib/google-scopes.ts:16`).

`src/lib/email/providers/demo.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { MailProvider } from "@/lib/email/providers/types";
import { demoWorkspaceEmail } from "@/lib/demo-workspace";

/**
 * The demo workspace's mailbox: sends are recorded as sent and nothing leaves Orbit, the same
 * way `sendRecruiterDrafts` already short-circuits it. The workspace has no OAuth tokens.
 */
export const demoProvider: MailProvider = {
  id: "demo",
  async identity(userId) {
    const email = await demoWorkspaceEmail(userId);
    return email ? { email } : null;
  },
  async send() {
    return { providerMessageId: `demo-${randomUUID()}`, providerThreadId: null };
  },
  async findSent() {
    return null;
  },
};
```

(Check `demoWorkspaceEmail`'s exact export name/signature in `src/lib/demo-workspace.ts`; `src/actions/gmail.ts` imports it.)

`src/lib/email/providers/index.ts`:

```ts
import type { EmailProviderId } from "@/db/schema";
import { demoProvider } from "@/lib/email/providers/demo";
import { gmailProvider } from "@/lib/email/providers/gmail";
import type { MailProvider } from "@/lib/email/providers/types";

const overrides = new Map<EmailProviderId, MailProvider>();

export function providerFor(id: EmailProviderId): MailProvider {
  const override = overrides.get(id);
  if (override) return override;
  if (id === "gmail") return gmailProvider;
  if (id === "demo") return demoProvider;
  throw new Error(`Mail provider ${id} is not available yet`);
}

/** Smoke tests only: swap a provider for a fake. Pass null to restore. */
export function setProviderOverride(id: EmailProviderId, provider: MailProvider | null) {
  if (provider) overrides.set(id, provider);
  else overrides.delete(id);
}
```

`src/lib/email/sender.ts`:

```ts
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { emailSends, gmailConnections, type EmailProviderId } from "@/db/schema";
import { EMAIL_SEND_DAILY_CAP } from "@/lib/email/config";
import { isDemoWorkspace } from "@/lib/demo-workspace";
import { providerFor } from "@/lib/email/providers";
import { getEntitlements } from "@/lib/entitlements";
import { hasSendScope } from "@/lib/gmail";

export type SendBlockReason = "not_connected" | "no_send_scope" | "needs_reauth";

export type ResolvedSender =
  | { ok: true; provider: EmailProviderId; fromEmail: string }
  | { ok: false; reason: SendBlockReason };

/**
 * Which mailbox a send goes out through. P1 knows Gmail and the demo workspace; Outlook
 * (P3) slots in here and honours `user_settings.default_send_provider`.
 */
export async function resolveSender(userId: string): Promise<ResolvedSender> {
  if (await isDemoWorkspace(userId)) {
    const id = await providerFor("demo").identity(userId);
    if (id) return { ok: true, provider: "demo", fromEmail: id.email };
  }
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { status: true, scopes: true, emailAddress: true },
  });
  if (!conn) return { ok: false, reason: "not_connected" };
  if (conn.status !== "active") return { ok: false, reason: "needs_reauth" };
  if (!hasSendScope(conn.scopes)) return { ok: false, reason: "no_send_scope" };
  return { ok: true, provider: "gmail", fromEmail: conn.emailAddress.trim().toLowerCase() };
}

/** Rolling 24h, every origin, counting anything not canceled or failed. */
export async function countEmailSendsToday(userId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailSends)
    .where(
      and(
        eq(emailSends.userId, userId),
        inArray(emailSends.status, ["queued", "sending", "sent"]),
        gte(emailSends.createdAt, sql`now() - interval '24 hours'`)
      )
    );
  return row?.n ?? 0;
}

export type SendCapability =
  | { ok: true; provider: EmailProviderId; fromEmail: string; dailyCap: number; usedToday: number; remainingToday: number }
  | { ok: false; reason: SendBlockReason | "cap_reached"; dailyCap: number; usedToday: number };

export async function getSendCapability(userId: string): Promise<SendCapability> {
  const [sender, ent, usedToday] = await Promise.all([
    resolveSender(userId),
    getEntitlements(userId),
    countEmailSendsToday(userId),
  ]);
  const dailyCap = EMAIL_SEND_DAILY_CAP[ent.plan];
  if (!sender.ok) return { ok: false, reason: sender.reason, dailyCap, usedToday };
  if (usedToday >= dailyCap) return { ok: false, reason: "cap_reached", dailyCap, usedToday };
  return { ok: true, provider: sender.provider, fromEmail: sender.fromEmail, dailyCap, usedToday, remainingToday: dailyCap - usedToday };
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/smoke-email-provider-gmail.ts`
Expected: PASS (all `ok`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/providers src/lib/email/sender.ts scripts/smoke-email-provider-gmail.ts scripts/run-smoke.ts
git commit -m "feat(email): Gmail and demo mail providers with error classification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Recipient → contact resolution and the origin registry

**Files:**
- Create: `src/lib/email/contacts.ts`, `src/lib/email/origins.ts`
- Test: extended in Task 6's `scripts/smoke-email-sends.ts` (contact resolution) and Task 9–12 (hooks). This task adds `scripts/smoke-email-contacts.ts` (tier `pglite`) for resolution only.

**Interfaces:**
- Consumes: `identityKeysFor` (`src/lib/duplicates.ts:222`), `findIdentityOwners` (`src/lib/contact-identity.ts:32`).
- Produces:
  - `resolveRecipientContacts(userId: string, emails: string[]): Promise<string[]>` — distinct contact ids, stable order by first matching email.
  - `type EmailSendRow = typeof emailSends.$inferSelect`
  - `type OriginHooks = { interactionSource: string; interactionExternalId(send: EmailSendRow, contactId: string): string; onSent?(send: EmailSendRow): Promise<void>; onFailed?(send: EmailSendRow, kind: EmailFailureKind, message: string): Promise<void> }`
  - `originHooks(origin: EmailOrigin): OriginHooks`; `registerOriginHooks(origin, partial)` used by Tasks 9–12.

- [ ] **Step 1: Write the failing test** `scripts/smoke-email-contacts.ts`:

```ts
/**
 * Recipient → contact resolution: primary email, identity emails, case, and ownership.
 * Run: npx tsx scripts/smoke-email-contacts.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { resolveRecipientContacts } from "../src/lib/email/contacts";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-contacts-user";
const OTHER = "smoke-email-contacts-other";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const db = await getDb();
  for (const u of [USER, OTHER]) await purgeUserData(u, { keepSettings: false }).catch(() => {});
  try {
    const [maya] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Maya", email: "Maya@Work.org" }).returning();
    const [sam] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Sam" }).returning();
    await db.insert(schema.contactIdentities).values({ userId: USER, contactId: sam!.id, kind: "email", value: "sam@home.org" } as typeof schema.contactIdentities.$inferInsert);
    const [foreign] = await db.insert(schema.contacts).values({ userId: OTHER, fullName: "X", email: "x@else.org" }).returning();

    const ids = await resolveRecipientContacts(USER, ["maya@work.org", "sam@home.org", "nobody@x.org", "x@else.org"]);
    check("primary email matches case-insensitively", ids.includes(maya!.id));
    check("identity email matches", ids.includes(sam!.id));
    check("another user's contact never matches", !ids.includes(foreign!.id));
    check("order follows the recipients", ids[0] === maya!.id && ids[1] === sam!.id, JSON.stringify(ids));
    check("empty input → empty", (await resolveRecipientContacts(USER, [])).length === 0);
  } finally {
    for (const u of [USER, OTHER]) await purgeUserData(u, { keepSettings: false }).catch(() => {});
  }
  console.log("\nAll email-contact checks passed.");
}

run(main);
```

Check `contactIdentities` column names (`src/db/schema.ts:~667`) and the exact `value` normalization `identityKeysFor` produces before running; adjust the seed to match. Register: `"smoke-email-contacts": "pglite",`

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-email-contacts.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/lib/email/contacts.ts`:

```ts
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { findIdentityOwners } from "@/lib/contact-identity";
import { identityKeysFor } from "@/lib/duplicates";

/**
 * The contacts a set of recipient addresses belong to, for interaction logging. Matches the
 * contact's primary `email` (case-insensitive) and its `contact_identities` email keys — the
 * same normalizer duplicate detection uses, so a match here is a match there. Role addresses
 * (`isRoleEmail`) have no identity key and match only by primary email.
 */
export async function resolveRecipientContacts(userId: string, emails: string[]): Promise<string[]> {
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return [];
  const db = await getDb();

  const byEmail = new Map<string, string>();
  const primary = await db
    .select({ id: contacts.id, email: sql<string>`lower(${contacts.email})` })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), inArray(sql`lower(${contacts.email})`, wanted)));
  for (const row of primary) if (!byEmail.has(row.email)) byEmail.set(row.email, row.id);

  const keys = wanted.flatMap((email) => identityKeysFor({ email }));
  if (keys.length) {
    for (const owner of await findIdentityOwners(userId, keys)) {
      const email = owner.key.value.toLowerCase();
      if (!byEmail.has(email)) byEmail.set(email, owner.contactId);
    }
  }

  const ordered: string[] = [];
  for (const email of wanted) {
    const id = byEmail.get(email);
    if (id && !ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}
```

Confirm `IdentityKey`'s field names (`kind`/`value`) and `identityKeysFor`'s input type in `src/lib/duplicates.ts`; adjust `owner.key.value` accordingly.

`src/lib/email/origins.ts`:

```ts
import type { EmailFailureKind, EmailOrigin, emailSends } from "@/db/schema";

export type EmailSendRow = typeof emailSends.$inferSelect;

/**
 * What each kind of send does beyond sending. The dispatcher calls these after the row is
 * settled, so they run exactly once per outcome, and in the drain as well as in a request —
 * hooks must not call `requireUserId()` or anything else that needs a request.
 *
 * `interactionSource` keeps each surface's existing `interactions.source` so current readers
 * (Chat's "already sent" lookup reads `chat_send`) keep working.
 */
export type OriginHooks = {
  interactionSource: string;
  interactionExternalId(send: EmailSendRow, contactId: string): string;
  onSent?(send: EmailSendRow): Promise<void>;
  onFailed?(send: EmailSendRow, kind: EmailFailureKind, message: string): Promise<void>;
};

const defaults = (source: string): OriginHooks => ({
  interactionSource: source,
  interactionExternalId: (send, contactId) => `email-send:${send.id}:${contactId}`,
});

const HOOKS: Record<EmailOrigin, OriginHooks> = {
  compose: defaults("email_send"),
  follow_up: defaults("follow_up"),
  chat: defaults("chat_send"),
  agent: defaults("mcp"),
  recruiter: defaults("recruiter_send"),
};

export function originHooks(origin: EmailOrigin): OriginHooks {
  return HOOKS[origin];
}

/** Each surface's module registers its behaviour at import time (Tasks 9–12). */
export function registerOriginHooks(origin: EmailOrigin, hooks: Partial<OriginHooks>) {
  HOOKS[origin] = { ...HOOKS[origin], ...hooks };
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/smoke-email-contacts.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/contacts.ts src/lib/email/origins.ts scripts/smoke-email-contacts.ts scripts/run-smoke.ts
git commit -m "feat(email): recipient-to-contact resolution and origin hook registry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Outbox core — enqueue, cancel, dispatch

**Files:**
- Create: `src/lib/email/outbox.ts`
- Test: `scripts/smoke-email-sends.ts` (tier `pglite`)

**Interfaces:**
- Consumes: Tasks 2–5; `consumeBucket`, `RATE_LIMITS`, `isRateLimitedError` (`src/lib/rate-limit.ts`); `logInteractionForUser` (`src/lib/contact-writes.ts:961`); `getEntitlements`; `UserFacingError`.
- Produces:
  - `type EnqueueInput = { to: string[]; cc?: string[]; bcc?: string[]; subject: string; bodyText: string; bodyHtml?: string | null; fromName?: string | null; origin: EmailOrigin; originRef?: string | null; idempotencyKey?: string | null; delayMs: number; threadId?: string | null; inReplyToRfcId?: string | null; contactIds?: string[] }`
  - `type EnqueueResult = { ok: true; id: string; sendAt: Date; to: string[]; provider: EmailProviderId } | { ok: false; reason: EnqueueRefusal; message: string }` with `EnqueueRefusal = "not_connected" | "no_send_scope" | "needs_reauth" | "cap_reached" | "rate_limited" | "no_recipient" | "too_many" | "invalid_recipient" | "placeholder" | "empty_body" | "duplicate"`
  - `enqueueEmail(userId: string, input: EnqueueInput): Promise<EnqueueResult>`
  - `cancelEmailSend(userId: string, id: string): Promise<"canceled" | "already_sent" | "not_found">`
  - `type DispatchOutcome = "sent" | "retry" | "failed" | "not_due" | "not_claimable"`
  - `dispatchEmailSend(id: string, opts?: { worker?: string }): Promise<DispatchOutcome>`
  - `ENQUEUE_COPY: Record<EnqueueRefusal, string>` (user-facing strings)

Design notes for the implementer:
- `enqueueEmail` validates in this order: content (non-empty trimmed body; subject defaults to `"(no subject)"`, collapsed to one line, ≤ 200 chars) → `normalizeRecipients` → `resolveSender` → `consumeBucket("emailSend", userId, RATE_LIMITS.emailSend)` → cap (`countEmailSendsToday` vs `EMAIL_SEND_DAILY_CAP[plan]`) → contact ids (`input.contactIds ?? resolveRecipientContacts`) → insert.
- `threadId` is stored in `provider_thread_id` before sending (recruiter replies); the dispatcher passes it through to `provider.send`.
- The insert uses `send_at = now() + delayMs` on the DB clock: `sql\`now() + (${delayMs / 1000}::double precision * interval '1 second')\``.
- A unique violation on `email_sends_idempotency_uidx` (SQLSTATE 23505, check `e.code` and `e.cause?.code`) returns `{ ok: false, reason: "duplicate" }`.
- Dispatcher claim copies the connector-outbox claim SQL; post-send writes are guarded on `claimed_by`.

- [ ] **Step 1: Write the failing test** `scripts/smoke-email-sends.ts`:

```ts
/**
 * The email outbox end to end with a fake provider: enqueue refusals, undo, claim races,
 * leases, backoff, exhaustion, the ambiguous-send rule, auth failure, caps and logging.
 * Run: npx tsx scripts/smoke-email-sends.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { cancelEmailSend, dispatchEmailSend, enqueueEmail } from "../src/lib/email/outbox";
import { setProviderOverride } from "../src/lib/email/providers";
import { MailProviderError, type MailProvider, type OutboundMessage } from "../src/lib/email/providers/types";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-sends-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Next = "ok" | "transient" | "permanent" | "auth" | "ambiguous";
let next: Next[] = [];
let found: "hit" | "miss" | "unknown" = "unknown";
const sent: OutboundMessage[] = [];
const fake: MailProvider = {
  id: "gmail",
  async identity() { return { email: "me@x.org" }; },
  async send(_u, msg) {
    const n = next.shift() ?? "ok";
    if (n !== "ok") throw new MailProviderError(n, `fake ${n}`);
    sent.push(msg);
    return { providerMessageId: `pm-${sent.length}`, providerThreadId: "pt" };
  },
  async findSent() {
    return found === "hit" ? { providerMessageId: "pm-found", providerThreadId: "pt" } : found === "miss" ? null : "unknown";
  },
};

async function row(id: string) {
  const db = await getDb();
  return (await db.select().from(schema.emailSends).where(eq(schema.emailSends.id, id)))[0]!;
}
async function makeDue(id: string) {
  const db = await getDb();
  await db.execute(sql`UPDATE email_sends SET send_at = now() - interval '1 second', lease_until = NULL WHERE id = ${id}::uuid`);
}
const base = { to: ["maya@work.org"], subject: "Hi", bodyText: "Hello Maya", origin: "compose" as const, delayMs: 0 };

async function main() {
  const db = await getDb();
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  setProviderOverride("gmail", fake);
  try {
    // --- refusals before connecting
    const nc = await enqueueEmail(USER, base);
    check("not connected is refused", !nc.ok && nc.reason === "not_connected");

    await db.insert(schema.gmailConnections).values({
      userId: USER, emailAddress: "me@x.org", accessTokenEncrypted: encrypt("t"), refreshTokenEncrypted: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000), scopes: GOOGLE_SCOPES.gmailSend, status: "active",
    } as typeof schema.gmailConnections.$inferInsert);
    const [maya] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Maya", email: "maya@work.org" }).returning();

    check("empty body is refused", (await enqueueEmail(USER, { ...base, bodyText: "   " })).ok === false);
    const bad = await enqueueEmail(USER, { ...base, to: ["a@x.org\r\nBcc: e@x.org"] });
    check("injection is refused", !bad.ok && bad.reason === "invalid_recipient");

    // --- happy path
    const q = await enqueueEmail(USER, base);
    check("enqueue succeeds", q.ok);
    if (!q.ok) throw new Error("stop");
    const r0 = await row(q.id);
    check("queued with contact resolved", r0.status === "queued" && r0.contactIds.includes(maya!.id));
    check("rfc id fixed at enqueue", /^<.+@orbit\.mail>$/.test(r0.rfcMessageId));
    check("dispatch sends", (await dispatchEmailSend(q.id)) === "sent");
    const r1 = await row(q.id);
    check("row marked sent with ids", r1.status === "sent" && r1.providerMessageId === "pm-1" && r1.sentAt !== null);
    check("message used the stored Message-ID", sent[0]!.messageId === r1.rfcMessageId);
    const logged = await db.select().from(schema.interactions).where(and(eq(schema.interactions.userId, USER), eq(schema.interactions.contactId, maya!.id)));
    check("one outbound email interaction logged", logged.length === 1 && logged[0]!.interactionType === "email" && logged[0]!.direction === "out" && logged[0]!.source === "email_send");
    check("second dispatch is a no-op", (await dispatchEmailSend(q.id)) === "not_claimable" && sent.length === 1);

    // --- undo
    const u = await enqueueEmail(USER, { ...base, delayMs: 10_000 });
    if (!u.ok) throw new Error("stop");
    check("not due before the window", (await dispatchEmailSend(u.id)) === "not_due");
    check("undo cancels", (await cancelEmailSend(USER, u.id)) === "canceled");
    await makeDue(u.id);
    check("canceled row never sends", (await dispatchEmailSend(u.id)) === "not_claimable" && sent.length === 1);
    check("undo of a sent row says already_sent", (await cancelEmailSend(USER, q.id)) === "already_sent");
    check("undo of someone else's row is not_found", (await cancelEmailSend("someone-else", u.id)) === "not_found");

    // --- concurrent claim: exactly one send
    const c = await enqueueEmail(USER, base);
    if (!c.ok) throw new Error("stop");
    const outcomes = await Promise.all([dispatchEmailSend(c.id), dispatchEmailSend(c.id)]);
    check("two dispatchers, one send", outcomes.filter((o) => o === "sent").length === 1, outcomes.join());

    // --- transient → retry with backoff, then success
    next = ["transient"];
    const t = await enqueueEmail(USER, base);
    if (!t.ok) throw new Error("stop");
    check("transient → retry", (await dispatchEmailSend(t.id)) === "retry");
    const rt = await row(t.id);
    check("back in queue, due ~1 minute out", rt.status === "queued" && rt.sendAt.getTime() > Date.now() + 30_000 && rt.claimedBy === null);
    await makeDue(t.id);
    found = "miss";
    check("retry sends after Sent-folder miss", (await dispatchEmailSend(t.id)) === "sent");

    // --- exhaustion
    const x = await enqueueEmail(USER, base);
    if (!x.ok) throw new Error("stop");
    for (let i = 0; i < 5; i++) {
      next = ["transient"];
      await makeDue(x.id);
      await dispatchEmailSend(x.id);
    }
    const rx = await row(x.id);
    check("5 attempts → failed/exhausted", rx.status === "failed" && rx.failureKind === "exhausted" && rx.attempts === 5);

    // --- permanent and auth
    next = ["permanent"];
    const p = await enqueueEmail(USER, base);
    if (!p.ok) throw new Error("stop");
    check("permanent → failed", (await dispatchEmailSend(p.id)) === "failed" && (await row(p.id)).failureKind === "permanent");
    next = ["auth"];
    const a = await enqueueEmail(USER, base);
    if (!a.ok) throw new Error("stop");
    check("auth → failed", (await dispatchEmailSend(a.id)) === "failed" && (await row(a.id)).failureKind === "auth");

    // --- ambiguous: never sent twice
    const before = sent.length;
    next = ["ambiguous"];
    found = "unknown";
    const m = await enqueueEmail(USER, base);
    if (!m.ok) throw new Error("stop");
    check("ambiguous → retry", (await dispatchEmailSend(m.id)) === "retry");
    await makeDue(m.id);
    check("ambiguous + unknown Sent → failed", (await dispatchEmailSend(m.id)) === "failed");
    const rm = await row(m.id);
    check("marked ambiguous, provider called once", rm.failureKind === "ambiguous" && sent.length === before);

    next = ["ambiguous"];
    const h = await enqueueEmail(USER, base);
    if (!h.ok) throw new Error("stop");
    await dispatchEmailSend(h.id);
    await makeDue(h.id);
    found = "hit";
    check("ambiguous + found in Sent → sent without resending", (await dispatchEmailSend(h.id)) === "sent" && (await row(h.id)).providerMessageId === "pm-found" && sent.length === before);

    // --- lease lapse
    const l = await enqueueEmail(USER, base);
    if (!l.ok) throw new Error("stop");
    await db.execute(sql`UPDATE email_sends SET status = 'sending', claimed_by = gen_random_uuid(), lease_until = now() - interval '1 second', attempts = 1 WHERE id = ${l.id}::uuid`);
    found = "miss";
    check("lapsed lease is re-claimable", (await dispatchEmailSend(l.id)) === "sent");

    // --- idempotency
    const k1 = await enqueueEmail(USER, { ...base, idempotencyKey: "k-1", delayMs: 10_000 });
    const k2 = await enqueueEmail(USER, { ...base, idempotencyKey: "k-1" });
    check("duplicate key refused while active", k1.ok && !k2.ok && k2.reason === "duplicate");
    if (k1.ok) await cancelEmailSend(USER, k1.id);
    check("key reusable after cancel", (await enqueueEmail(USER, { ...base, idempotencyKey: "k-1", delayMs: 10_000 })).ok);

    // --- daily cap (free plan: 20). Canceled/failed rows don't count.
    const [{ n }] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM email_sends WHERE user_id = ${USER} AND status IN ('queued','sending','sent')`));
    await db.execute(sql`INSERT INTO email_sends (user_id, provider, from_email, "to", subject, body_text, origin, status, send_at, rfc_message_id)
      SELECT ${USER}, 'gmail', 'me@x.org', '["z@x.org"]'::jsonb, 's', 'b', 'chat', 'sent', now(), '<cap-' || g || '@orbit.mail>' FROM generate_series(1, ${20 - n}) g`);
    const capped = await enqueueEmail(USER, base);
    check("21st send in 24h refused on Free", !capped.ok && capped.reason === "cap_reached", JSON.stringify(capped));
  } finally {
    setProviderOverride("gmail", null);
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll email-outbox checks passed.");
}

run(main);
```

The burst bucket (10 / 10 min) would refuse this test's 11th enqueue. Reset it between phases by deleting this user's `rate_limit_buckets` rows: before each `enqueueEmail` block beyond the 10th call, run `await db.execute(sql\`DELETE FROM rate_limit_buckets WHERE bucket LIKE ${"%" + USER + "%"}\`)`. Check the bucket key format in `consumeBucket` (`src/lib/rate-limit.ts:273`) and add a `resetBucket()` helper in the test that matches it; call it at the top of every section. Also add one explicit check: 11 enqueues with no reset → the 11th is `rate_limited`.

Register: `"smoke-email-sends": "pglite",`

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-email-sends.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/lib/email/outbox.ts`:

```ts
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { emailSends, type EmailFailureKind, type EmailOrigin, type EmailProviderId } from "@/db/schema";
import { resolveRecipientContacts } from "@/lib/email/contacts";
import { EMAIL_LEASE_SECONDS, EMAIL_SEND_DAILY_CAP, MAX_EMAIL_ATTEMPTS, emailBackoffSeconds } from "@/lib/email/config";
import { newRfcMessageId } from "@/lib/email/mime";
import { originHooks, type EmailSendRow } from "@/lib/email/origins";
import { providerFor } from "@/lib/email/providers";
import { MailProviderError } from "@/lib/email/providers/types";
import { normalizeRecipients } from "@/lib/email/recipients";
import { countEmailSendsToday, resolveSender } from "@/lib/email/sender";
import { logInteractionForUser } from "@/lib/contact-writes";
import { getEntitlements } from "@/lib/entitlements";
import { consumeBucket, isRateLimitedError, RATE_LIMITS } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";

export type EnqueueRefusal =
  | "not_connected" | "no_send_scope" | "needs_reauth" | "cap_reached" | "rate_limited"
  | "no_recipient" | "too_many" | "invalid_recipient" | "placeholder" | "empty_body" | "duplicate";

export const ENQUEUE_COPY: Record<EnqueueRefusal, string> = {
  not_connected: "Connect Gmail to send from your own address.",
  no_send_scope: "Allow Gmail to send, then try again.",
  needs_reauth: "Your Gmail connection expired — reconnect to send.",
  cap_reached: "You've reached today's email limit. It resets over the next 24 hours.",
  rate_limited: "That's a lot of email in a few minutes — try again shortly.",
  no_recipient: "Add at least one recipient.",
  too_many: "That's more than 20 recipients — trim the list.",
  invalid_recipient: "One of those addresses doesn't look right.",
  placeholder: "That's a placeholder address, not a real inbox.",
  empty_body: "Write something before sending.",
  duplicate: "That message is already on its way.",
};

export type EnqueueInput = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  fromName?: string | null;
  origin: EmailOrigin;
  originRef?: string | null;
  idempotencyKey?: string | null;
  delayMs: number;
  threadId?: string | null;
  inReplyToRfcId?: string | null;
  /** Skip lookup when the caller already knows (e.g. a contact-page send). */
  contactIds?: string[];
};

export type EnqueueResult =
  | { ok: true; id: string; sendAt: Date; to: string[]; provider: EmailProviderId }
  | { ok: false; reason: EnqueueRefusal; message: string };

const refuse = (reason: EnqueueRefusal): EnqueueResult => ({ ok: false, reason, message: ENQUEUE_COPY[reason] });

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

function cleanSubject(subject: string): string {
  const one = subject.replace(/\s+/g, " ").trim();
  return (one || "(no subject)").slice(0, 200);
}

/**
 * The only way a person-to-person email enters Orbit's outbox. Validates, checks the sender,
 * the burst bucket and the daily cap, then inserts a `queued` row due at now() + delayMs on
 * the database clock. It never sends: `dispatchEmailSend` does, from `after()` or the drain.
 */
export async function enqueueEmail(userId: string, input: EnqueueInput): Promise<EnqueueResult> {
  const bodyText = input.bodyText.replace(/\r\n/g, "\n").trim();
  if (!bodyText) return refuse("empty_body");

  const recipients = normalizeRecipients({ to: input.to, cc: input.cc, bcc: input.bcc });
  if (!recipients.ok) return refuse(recipients.reason);

  const sender = await resolveSender(userId);
  if (!sender.ok) return refuse(sender.reason);

  try {
    await consumeBucket("emailSend", userId, RATE_LIMITS.emailSend);
  } catch (err) {
    if (isRateLimitedError(err)) return refuse("rate_limited");
    throw err;
  }

  const [ent, used] = await Promise.all([getEntitlements(userId), countEmailSendsToday(userId)]);
  if (used >= EMAIL_SEND_DAILY_CAP[ent.plan]) return refuse("cap_reached");

  const contactIds = input.contactIds ?? (await resolveRecipientContacts(userId, recipients.all));
  const db = await getDb();
  try {
    const [row] = await db
      .insert(emailSends)
      .values({
        userId,
        provider: sender.provider,
        fromEmail: sender.fromEmail,
        fromName: input.fromName?.trim() || null,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject: cleanSubject(input.subject),
        bodyText,
        bodyHtml: input.bodyHtml ?? null,
        contactIds,
        origin: input.origin,
        originRef: input.originRef ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        status: "queued",
        sendAt: sql`now() + (${Math.max(0, input.delayMs) / 1000}::double precision * interval '1 second')`,
        rfcMessageId: newRfcMessageId(),
        providerThreadId: input.threadId ?? null,
        inReplyToRfcId: input.inReplyToRfcId ?? null,
      })
      .returning(); // bare: a field selector breaks over the Db union
    return { ok: true, id: row!.id, sendAt: row!.sendAt, to: recipients.to, provider: sender.provider };
  } catch (err) {
    if (isUniqueViolation(err)) return refuse("duplicate");
    throw err;
  }
}

/** Undo. Only a row nobody has claimed yet can be canceled. */
export async function cancelEmailSend(userId: string, id: string): Promise<"canceled" | "already_sent" | "not_found"> {
  const db = await getDb();
  const canceled = await db
    .update(emailSends)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(and(eq(emailSends.id, id), eq(emailSends.userId, userId), eq(emailSends.status, "queued")))
    .returning();
  if (canceled.length) return "canceled";
  const existing = await db.query.emailSends.findFirst({
    where: and(eq(emailSends.id, id), eq(emailSends.userId, userId)),
    columns: { id: true },
  });
  return existing ? "already_sent" : "not_found";
}

export type DispatchOutcome = "sent" | "retry" | "failed" | "not_due" | "not_claimable";

/**
 * Claim → (duplicate check on retries) → send → settle. The claim and every settle write
 * follow `src/lib/connectors/outbox.ts`: the lease is `now() + interval` on the DATABASE
 * clock, and each settle is guarded on `claimed_by`, so a dispatcher whose lease lapsed can't
 * overwrite the one that re-claimed the row.
 */
export async function dispatchEmailSend(id: string, opts: { worker?: string } = {}): Promise<DispatchOutcome> {
  const db = await getDb();
  const worker = opts.worker ?? randomUUID();
  const claimed = rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE email_sends
         SET status = 'sending',
             claimed_by = ${worker}::uuid,
             lease_until = now() + (${EMAIL_LEASE_SECONDS}::double precision * interval '1 second'),
             attempts = attempts + 1,
             updated_at = now()
       WHERE id = ${id}::uuid
         AND send_at <= now()
         AND (
           status = 'queued'
           OR (status = 'sending' AND lease_until < now())
         )
      RETURNING id
    `)
  )[0];
  if (!claimed) {
    const probe = await db.query.emailSends.findFirst({ where: eq(emailSends.id, id), columns: { status: true, sendAt: true } });
    if (probe?.status === "queued" && probe.sendAt.getTime() > Date.now()) return "not_due";
    return "not_claimable";
  }
  const send = (await db.query.emailSends.findFirst({ where: eq(emailSends.id, id) }))!;
  const provider = providerFor(send.provider);

  // A retry whose earlier attempt may have reached the provider: look in Sent first.
  if (send.attempts > 1) {
    const prior = await provider.findSent(send.userId, send.rfcMessageId).catch(() => "unknown" as const);
    if (prior && prior !== "unknown") return settleSent(send, worker, prior);
    if (prior === "unknown" && send.failureKind === "ambiguous") {
      return settleFailed(send, worker, "ambiguous", "May have sent — check Sent before retrying");
    }
  }

  try {
    const result = await provider.send(
      send.userId,
      {
        from: { name: send.fromName, email: send.fromEmail },
        to: send.to, cc: send.cc, bcc: send.bcc,
        subject: send.subject, bodyText: send.bodyText, bodyHtml: send.bodyHtml,
        messageId: send.rfcMessageId,
        inReplyTo: send.inReplyToRfcId, references: send.inReplyToRfcId,
      },
      { threadId: send.providerThreadId }
    );
    return settleSent(send, worker, result);
  } catch (err) {
    const kind = err instanceof MailProviderError ? err.kind : "ambiguous";
    const message = err instanceof Error ? err.message : String(err);
    if (kind === "auth" || kind === "permanent") return settleFailed(send, worker, kind, message);
    if (send.attempts >= MAX_EMAIL_ATTEMPTS) return settleFailed(send, worker, kind === "ambiguous" ? "ambiguous" : "exhausted", message);
    return settleRetry(send, worker, kind === "ambiguous", message);
  }
}

async function settleSent(send: EmailSendRow, worker: string, result: { providerMessageId: string; providerThreadId: string | null }): Promise<DispatchOutcome> {
  const db = await getDb();
  const settled = await db
    .update(emailSends)
    .set({
      status: "sent", sentAt: new Date(), providerMessageId: result.providerMessageId,
      providerThreadId: result.providerThreadId ?? send.providerThreadId,
      claimedBy: null, leaseUntil: null, lastError: null, failureKind: null, updatedAt: new Date(),
    })
    .where(and(eq(emailSends.id, send.id), eq(emailSends.claimedBy, worker)))
    .returning();
  if (!settled.length) return "not_claimable";
  const done = settled[0]!;
  const hooks = originHooks(done.origin);
  for (const contactId of done.contactIds) {
    // Logged at send time, never at enqueue: an undone send is not a touch.
    await logInteractionForUser(
      done.userId,
      {
        contactId,
        interactionType: "email",
        direction: "out",
        source: hooks.interactionSource,
        externalId: hooks.interactionExternalId(done, contactId),
        interactionDate: done.sentAt ?? new Date(),
        rawNotes: done.bodyText,
        aiSummary: `Emailed: ${done.subject}`,
      },
      { skipRevalidate: true }
    ).catch((err) => reportError(err, { where: "email.log-interaction", userId: done.userId }));
  }
  await hooks.onSent?.(done).catch((err) => reportError(err, { where: `email.on-sent.${done.origin}`, userId: done.userId }));
  return "sent";
}

async function settleFailed(send: EmailSendRow, worker: string, kind: EmailFailureKind, message: string): Promise<DispatchOutcome> {
  const db = await getDb();
  const settled = await db
    .update(emailSends)
    .set({ status: "failed", failureKind: kind, lastError: message.slice(0, 500), claimedBy: null, leaseUntil: null, updatedAt: new Date() })
    .where(and(eq(emailSends.id, send.id), eq(emailSends.claimedBy, worker)))
    .returning();
  if (!settled.length) return "not_claimable";
  await originHooks(send.origin).onFailed?.(settled[0]!, kind, message)
    .catch((err) => reportError(err, { where: `email.on-failed.${send.origin}`, userId: send.userId }));
  return "failed";
}

async function settleRetry(send: EmailSendRow, worker: string, ambiguous: boolean, message: string): Promise<DispatchOutcome> {
  const db = await getDb();
  const settled = await db
    .update(emailSends)
    .set({
      status: "queued",
      sendAt: sql`now() + (${emailBackoffSeconds(send.attempts)}::double precision * interval '1 second')`,
      failureKind: ambiguous ? "ambiguous" : null,
      lastError: message.slice(0, 500),
      claimedBy: null, leaseUntil: null, updatedAt: new Date(),
    })
    .where(and(eq(emailSends.id, send.id), eq(emailSends.claimedBy, worker)))
    .returning();
  return settled.length ? "retry" : "not_claimable";
}
```

Check before running: `rowsOf` is exported from `@/db` (the connector drain imports it); `reportError`'s signature in `src/lib/report-error.ts`; `LogInteractionInput` accepts all fields used (it does per research: `direction`, `externalId`, `interactionDate`, `source`, `aiSummary`). If `failureKind` must be cleared when an ambiguous retry is later found in Sent, `settleSent` already sets it to null.

Also mark auth failures on the connection: in `settleFailed`, when `kind === "auth"` and `send.provider === "gmail"`, run `db.update(gmailConnections).set({ status: "needs_reauth", nextSyncAt: null, updatedAt: new Date() }).where(eq(gmailConnections.userId, send.userId))` — `getValidAccessToken` already does this for refresh failures, but a 401/403 on the send itself does not. Add to the smoke's auth section: `check("auth failure flags the connection", (await db.query.gmailConnections.findFirst({ where: eq(schema.gmailConnections.userId, USER) }))?.status === "needs_reauth")`, then reset status to `"active"` for the following sections.

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/smoke-email-sends.ts`
Expected: PASS (every line `ok`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/outbox.ts scripts/smoke-email-sends.ts scripts/run-smoke.ts
git commit -m "feat(email): outbox enqueue, undo and leased dispatch with safe retries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Drain route + ops schedule

**Files:**
- Modify: `src/lib/email/outbox.ts` (add `drainEmailSends`)
- Create: `src/app/api/email/drain/route.ts`
- Modify: `src/lib/cron-runs.ts` (`CronJobName` += `"email.drain"`), `src/lib/public-routes.ts` (~line 77), `scripts/smoke-public-routes.ts` (`internalRoutes`), `.github/workflows/ops.yml` (~line 143 + header prose)
- Test: extend `scripts/smoke-email-sends.ts`; source guard in same file

**Interfaces:**
- Produces: `drainEmailSends(opts: { budgetMs: number; max: number }): Promise<{ attempted: number; sent: number; retried: number; failed: number; skipped: number }>`

- [ ] **Step 1: Add failing checks** at the end of `main()` in `scripts/smoke-email-sends.ts` (before `finally`):

```ts
    // --- drain picks up due rows and lapsed leases, skips future ones
    const d1 = await enqueueEmail(USER, { ...base, delayMs: 0 });
    const d2 = await enqueueEmail(USER, { ...base, delayMs: 3_600_000 });
    await db.execute(sql`UPDATE rate_limit_buckets SET count = 0`); // cap/bucket headroom for the drain section
    const stats = await drainEmailSends({ budgetMs: 10_000, max: 50 });
    check("drain sent the due row", d1.ok && (await row(d1.id)).status === "sent", JSON.stringify(stats));
    check("drain left the future row queued", d2.ok && (await row(d2.id)).status === "queued");

    // --- source guard: the claim keeps both lease predicates and the DB-clock lease
    const src = (await import("node:fs")).readFileSync("src/lib/email/outbox.ts", "utf8");
    check("claim leases on the DB clock", src.includes("lease_until = now() +"));
    check("claim accepts lapsed leases only", src.includes("status = 'sending' AND lease_until < now()"));
    check("outbox never imports next/server", !/from "next\/server"/.test(src));
```

Import `drainEmailSends` at the top. Adjust the bucket reset line to the real table/column names from `src/lib/rate-limit.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-email-sends.ts`
Expected: FAIL — `drainEmailSends` is not exported.

- [ ] **Step 3: Implement** in `src/lib/email/outbox.ts`:

```ts
/**
 * The backstop. `after()` dispatches interactive sends; this catches everything it didn't —
 * a recycled function, a scheduled send, a retry, a lapsed lease. Runs from the ten-minute
 * ops workflow. Rows are picked oldest-due first and dispatched one at a time within budget.
 */
export async function drainEmailSends(opts: { budgetMs: number; max: number }) {
  const db = await getDb();
  const deadline = Date.now() + opts.budgetMs;
  const stats = { attempted: 0, sent: 0, retried: 0, failed: 0, skipped: 0 };
  const due = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT id FROM email_sends
       WHERE send_at <= now()
         AND (status = 'queued' OR (status = 'sending' AND lease_until < now()))
       ORDER BY send_at
       LIMIT ${opts.max}
    `)
  );
  for (const { id } of due) {
    // One provider call is capped at 20s; stop while there is room for it.
    if (deadline - Date.now() < 22_000) break;
    stats.attempted++;
    const outcome = await dispatchEmailSend(id).catch((err) => {
      reportError(err, { where: "email.drain-item" });
      return "failed" as const;
    });
    if (outcome === "sent") stats.sent++;
    else if (outcome === "retry") stats.retried++;
    else if (outcome === "failed") stats.failed++;
    else stats.skipped++;
  }
  return stats;
}
```

`src/app/api/email/drain/route.ts`:

```ts
import { NextResponse } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { drainEmailSends } from "@/lib/email/outbox";
import "@/lib/email/origin-registrations";
import { isInternalRequest } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const handle = await startCronRun("email.drain");
  try {
    // 40s of a 60s budget, leaving room for the ledger write.
    const stats = await drainEmailSends({ budgetMs: 40_000, max: 100 });
    await finishCronRun(handle, { status: stats.failed > 0 ? "partial" : "ok", stats });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    const ref = reportError(err, { where: "job.email-drain" });
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "drain failed", ref }, { status: 500 });
  }
}
```

The `origin-registrations` import is created in Task 9 — until then, create `src/lib/email/origin-registrations.ts` now as an empty module with this header, so hooks registered later are loaded wherever the dispatcher runs:

```ts
/**
 * Side-effect imports that register every origin's hooks with `src/lib/email/origins.ts`.
 * Imported by every entry point that can dispatch (the drain route, `schedule.ts`, and
 * smoke tests), so a send dispatched from the drain runs the same hooks as one dispatched
 * from a request.
 */
export {};
```

Add `"email.drain"` to `CronJobName` in `src/lib/cron-runs.ts`; add `"/api/email/drain",` to the internal-routes block in `src/lib/public-routes.ts` and to `internalRoutes` in `scripts/smoke-public-routes.ts`.

In `.github/workflows/ops.yml`, after the connector-outbox step:

```yaml
      # Person-to-person email. after() sends interactive mail once its undo window lapses;
      # this catches the rest — scheduled sends, retries, and anything a recycled function
      # dropped. Same ten-minute schedule and gate as the connector outbox above.
      - name: Drain the email outbox
        if: (github.event.schedule == '*/10 * * * *' || github.event_name == 'workflow_dispatch') && steps.health.outcome == 'success'
        run: |
          curl -sS --fail-with-body --max-time 55 -X POST \
            -H "Authorization: Bearer $CRON_SECRET" \
            "$APP_URL/api/email/drain"
        env:
          APP_URL: ${{ secrets.APP_URL }}
          CRON_SECRET: ${{ secrets.CRON_SECRET }}
```

and add the email drain to the jobs listed in the file's header comment.

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/run-smoke.ts --only smoke-email-sends smoke-public-routes smoke-internal-auth smoke-ops-sweep`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email src/app/api/email src/lib/cron-runs.ts src/lib/public-routes.ts scripts/smoke-public-routes.ts scripts/smoke-email-sends.ts .github/workflows/ops.yml
git commit -m "feat(email): internal drain route on the ten-minute ops schedule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: After-response dispatch, actions, and shared UI pieces

**Files:**
- Create: `src/lib/email/schedule.ts`, `src/actions/email-sends.ts`, `src/components/email/undo-send-toast.tsx`, `src/components/email/connect-mailbox-button.tsx`
- Test: `scripts/smoke-email-actions.ts` (tier `pglite`) — static checks + cancel action ownership

**Interfaces:**
- Consumes: `dispatchEmailSend`, `cancelEmailSend`, `getSendCapability`.
- Produces:
  - `scheduleDispatch(id: string, sendAt: Date): void` (server-only)
  - Actions (`"use server"`, all async): `cancelEmailSendAction(id: string): Promise<{ result: "canceled" | "already_sent" | "not_found" }>`, `getSendCapabilityAction(): Promise<SendCapability>`
  - `showUndoSendToast(opts: { sendId: string; recipientLabel: string; onUndone?: () => void }): void` (client)
  - `<ConnectMailboxButton reason={SendBlockReason} returnTo={string} size?="sm" />` (client)

- [ ] **Step 1: Write the failing test** `scripts/smoke-email-actions.ts`:

```ts
/**
 * The email actions' shape: every export async (a non-async export kills the whole "use
 * server" file), cancel scoped to the caller, and schedule.ts is the only after() importer.
 * Run: npx tsx scripts/smoke-email-actions.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const actions = readFileSync("src/actions/email-sends.ts", "utf8");
  check("use server file", actions.startsWith('"use server"'));
  check("every export is an async function", !/export (const|function|class|type) /.test(actions.replace(/export type [^\n]+/g, "")));
  check("cancel uses the caller's id", /cancelEmailSend\(\s*userId/.test(actions));

  const libFiles = readdirSync("src/lib/email", { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  const afterImporters = libFiles.filter((f) => /from "next\/server"/.test(readFileSync(join("src/lib/email", f), "utf8")));
  check("only schedule.ts imports next/server", afterImporters.join() === "schedule.ts", afterImporters.join());
  console.log("\nAll email-action checks passed.");
}

run(main);
```

Register: `"smoke-email-actions": "pglite",`

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-email-actions.ts`
Expected: FAIL — ENOENT on `src/actions/email-sends.ts`.

- [ ] **Step 3: Implement** `src/lib/email/schedule.ts`:

```ts
import { after } from "next/server";
import { dispatchEmailSend } from "@/lib/email/outbox";
import "@/lib/email/origin-registrations";
import { reportError } from "@/lib/report-error";

/**
 * Sends a queued email once its undo window has passed, after the response has gone out.
 * `after()` runs within the function's own maxDuration (it buys no extra time), which is
 * plenty for a 10s wait plus one 20s provider call. If this never runs — the instance is
 * recycled — the ten-minute drain sends it instead, so nothing here is load-bearing for
 * delivery, only for speed. The only module under src/lib/email that imports next/server.
 */
export function scheduleDispatch(id: string, sendAt: Date): void {
  const task = async () => {
    const wait = Math.max(0, sendAt.getTime() - Date.now()) + 250;
    await new Promise((resolve) => setTimeout(resolve, wait));
    await dispatchEmailSend(id).catch((err) => reportError(err, { where: "email.after-dispatch" }));
  };
  try {
    after(task);
  } catch {
    // No request scope (script/job): the drain will pick it up.
  }
}
```

`src/actions/email-sends.ts`:

```ts
"use server";

import { requireUserId } from "@/lib/auth";
import { cancelEmailSend } from "@/lib/email/outbox";
import { getSendCapability, type SendCapability } from "@/lib/email/sender";

export async function cancelEmailSendAction(id: string): Promise<{ result: "canceled" | "already_sent" | "not_found" }> {
  const userId = await requireUserId();
  return { result: await cancelEmailSend(userId, id) };
}

export async function getSendCapabilityAction(): Promise<SendCapability> {
  const userId = await requireUserId();
  return getSendCapability(userId);
}
```

(Confirm `requireUserId`'s import path — other actions import it; grep `import { requireUserId` in `src/actions/contacts.ts`.)

`src/components/email/undo-send-toast.tsx`:

```tsx
"use client";

import { toast } from "sonner";
import { cancelEmailSendAction } from "@/actions/email-sends";
import { UNDO_DELAY_MS } from "@/lib/email/config";
import { friendlyError } from "@/lib/errors";

/**
 * "Sending to Maya… Undo". The row is already queued with send_at = now + 10s; Undo cancels
 * it if nobody has claimed it yet. The toast lives exactly as long as the window.
 */
export function showUndoSendToast(opts: { sendId: string; recipientLabel: string; onUndone?: () => void }) {
  const id = toast(`Sending to ${opts.recipientLabel}…`, {
    duration: UNDO_DELAY_MS,
    action: {
      label: "Undo",
      onClick: async () => {
        try {
          const { result } = await cancelEmailSendAction(opts.sendId);
          if (result === "canceled") {
            toast.success("Send canceled", { id });
            opts.onUndone?.();
          } else {
            toast.message("Already sent", { id });
          }
        } catch (err) {
          toast.error(friendlyError(err, "Couldn’t undo that — it may already be on its way."), { id });
        }
      },
    },
  });
}
```

(Check the repo's sonner import path — `grep -rn "from \"sonner\"" src/components | head -1` — and use the same one; if the repo wraps it, use the wrapper.)

`src/components/email/connect-mailbox-button.tsx`:

```tsx
"use client";

import { Button } from "@/components/ui/button";
import { useConnectGoogle } from "@/components/settings/use-provider-connection";
import type { SendBlockReason } from "@/lib/email/sender";

const LABEL: Record<SendBlockReason, string> = {
  not_connected: "Connect Gmail",
  no_send_scope: "Allow Gmail to send",
  needs_reauth: "Reconnect Gmail",
};

/** The one CTA every send surface shows when it can't send. Asks only for the send scope. */
export function ConnectMailboxButton({ reason, returnTo, size = "sm" }: { reason: SendBlockReason; returnTo: string; size?: "sm" | "default" }) {
  const { connect, connecting } = useConnectGoogle(returnTo);
  return (
    <Button size={size} variant="outline" disabled={connecting} onClick={() => connect(["send"])}>
      {LABEL[reason]}
    </Button>
  );
}
```

`src/lib/email/sender.ts` must stay importable from a client component for the type only — the import above is `import type`, which is erased. Confirm `useConnectGoogle`'s signature at `src/components/settings/use-provider-connection.ts:160`.

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/smoke-email-actions.ts && npx tsx scripts/smoke-action-user-scope.ts`
Expected: PASS (use the real name of the action user-scope smoke: `ls scripts | grep -i scope`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/schedule.ts src/actions/email-sends.ts src/components/email scripts/smoke-email-actions.ts scripts/run-smoke.ts
git commit -m "feat(email): after-response dispatch, undo action and shared send UI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Migrate contact follow-ups off Resend

**Files:**
- Modify: `src/lib/reminder-writes.ts` (+ `clearContactFollowUpForUser`), `src/actions/reminders.ts:648` (delegate)
- Create: `src/lib/email/origin-hooks/follow-up.ts`; Modify: `src/lib/email/origin-registrations.ts`
- Modify: `src/actions/contacts.ts` (`getContactFollowUpSendOptions` ~1400, `sendContactFollowUpEmail` ~1431; drop `sendOutreachMessage`/`getOutreachSendConfig` imports)
- Modify: `src/components/follow-up/follow-up-draft-composer.tsx`, `follow-up-draft-sheet.tsx`, `src/components/contacts/contact-follow-up-section.tsx`
- Modify: `scripts/fixtures/behavior-golden.json` (via `--update`)
- Test: `scripts/smoke-email-origins.ts` (tier `pglite`)

**Interfaces:**
- Consumes: `enqueueEmail`, `scheduleDispatch`, `getSendCapability`, `registerOriginHooks`, `showUndoSendToast`, `ConnectMailboxButton`.
- Produces:
  - `clearContactFollowUpForUser(userId: string, contactId: string): Promise<{ remindersClosed: number }>`
  - `ContactFollowUpSendOptions` gains `sendBlock: SendBlockReason | "cap_reached" | null` and keeps `canSendEmail` (now `hasEmail && capability.ok`)
  - `sendContactFollowUpEmail(contactId, body, subject?)` returns `{ ok: true; sendId: string; sendAt: string; to: string } | { ok: false; reason: EnqueueRefusal | "no_email"; message: string }`

- [ ] **Step 1: Write the failing test** `scripts/smoke-email-origins.ts`:

```ts
/**
 * Origin side effects run by the dispatcher: follow-up reminders clear only on a real send.
 * (Chat/agent/recruiter sections are added by Tasks 10–12.)
 * Run: npx tsx scripts/smoke-email-origins.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import "../src/lib/email/origin-registrations";
import { cancelEmailSend, dispatchEmailSend, enqueueEmail } from "../src/lib/email/outbox";
import { setProviderOverride } from "../src/lib/email/providers";
import { MailProviderError, type MailProvider } from "../src/lib/email/providers/types";
import { createReminderForUser } from "../src/lib/reminder-writes";
import { purgeUserData } from "../src/lib/user-data";

export const USER = "smoke-email-origins-user";
let failures = 0;
export function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
let fail = false;
const fake: MailProvider = {
  id: "gmail",
  async identity() { return { email: "me@x.org" }; },
  async send() { if (fail) throw new MailProviderError("permanent", "nope"); return { providerMessageId: "pm", providerThreadId: "pt" }; },
  async findSent() { return null; },
};

async function followUpSection() {
  const db = await getDb();
  const [c] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Maya", email: "maya@work.org", followUpStatus: "due", nextFollowUpAt: new Date() }).returning();
  await createReminderForUser(USER, { contactId: c!.id, title: "Follow up with Maya", dueDate: new Date().toISOString() } as Parameters<typeof createReminderForUser>[1]);

  const undone = await enqueueEmail(USER, { to: ["maya@work.org"], subject: "Hi", bodyText: "Hey", origin: "follow_up", originRef: c!.id, delayMs: 10_000 });
  if (undone.ok) await cancelEmailSend(USER, undone.id);
  const still = await db.query.contacts.findFirst({ where: eq(schema.contacts.id, c!.id) });
  check("undone follow-up leaves the follow-up due", still?.followUpStatus === "due");

  fail = true;
  const failed = await enqueueEmail(USER, { to: ["maya@work.org"], subject: "Hi", bodyText: "Hey", origin: "follow_up", originRef: c!.id, delayMs: 0 });
  if (failed.ok) await dispatchEmailSend(failed.id);
  check("failed follow-up leaves the follow-up due", (await db.query.contacts.findFirst({ where: eq(schema.contacts.id, c!.id) }))?.followUpStatus === "due");

  fail = false;
  const ok = await enqueueEmail(USER, { to: ["maya@work.org"], subject: "Hi", bodyText: "Hey", origin: "follow_up", originRef: c!.id, delayMs: 0 });
  if (ok.ok) await dispatchEmailSend(ok.id);
  const after = await db.query.contacts.findFirst({ where: eq(schema.contacts.id, c!.id) });
  check("sent follow-up clears the follow-up", after?.followUpStatus === "none" && after?.nextFollowUpAt === null);
  const open = await db.select().from(schema.reminders).where(and(eq(schema.reminders.contactId, c!.id), eq(schema.reminders.status, "pending")));
  check("pending reminders completed", open.length === 0);
  const logged = await db.select().from(schema.interactions).where(eq(schema.interactions.contactId, c!.id));
  check("interaction source is follow_up", logged.length === 1 && logged[0]!.source === "follow_up");
}

async function main() {
  const db = await getDb();
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  setProviderOverride("gmail", fake);
  try {
    await db.insert(schema.gmailConnections).values({
      userId: USER, emailAddress: "me@x.org", accessTokenEncrypted: encrypt("t"), refreshTokenEncrypted: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000), scopes: GOOGLE_SCOPES.gmailSend, status: "active",
    } as typeof schema.gmailConnections.$inferInsert);
    await followUpSection();
  } finally {
    setProviderOverride("gmail", null);
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll email-origin checks passed.");
}

run(main);
```

Check `createReminderForUser`'s input fields in `src/lib/reminder-writes.ts:23` and fix the seed call to match (drop the cast once it type-checks). Register: `"smoke-email-origins": "pglite",`. Because the burst bucket allows 10 per 10 minutes, and Tasks 10–12 add sections, reset it at the top of each section the same way as in Task 6.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-email-origins.ts`
Expected: FAIL — "sent follow-up clears the follow-up" (no hook yet).

- [ ] **Step 3: Implement.** In `src/lib/reminder-writes.ts` add (move the body out of the action; request-free):

```ts
import { completeReminder } from "@/lib/reminders";
import { revalidatePathIfRequestScoped, revalidateReminderPaths } from "@/lib/reminder-paths";

/**
 * Clears a contact's due follow-up and completes its pending reminders. Request-free so the
 * email dispatcher can call it from the drain; `clearContactFollowUp` (the action) delegates
 * here. Revalidation is a no-op outside a request.
 */
export async function clearContactFollowUpForUser(userId: string, contactId: string): Promise<{ remindersClosed: number }> {
  const db = await getDb();
  await db
    .update(contacts)
    .set({ nextFollowUpAt: null, followUpStatus: "none", updatedAt: new Date() })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
  const open = await db.query.reminders.findMany({
    where: and(eq(reminders.userId, userId), eq(reminders.contactId, contactId), eq(reminders.status, "pending")),
  });
  for (const r of open) await completeReminder(userId, r.id);
  revalidateReminderPaths(contactId);
  revalidatePathIfRequestScoped("/contacts");
  return { remindersClosed: open.length };
}
```

Check `revalidateReminderPaths` is safe outside a request (read `src/lib/reminder-paths.ts:33`; if it calls `revalidatePath` unguarded, use `revalidatePathIfRequestScoped` for each path instead). Then reduce `clearContactFollowUp` in `src/actions/reminders.ts` to:

```ts
export async function clearContactFollowUp(contactId: string) {
  const userId = await requireUserId();
  const { remindersClosed } = await clearContactFollowUpForUser(userId, contactId);
  // The count is load-bearing, not telemetry: … (keep the existing comment)
  return { ok: true, remindersClosed };
}
```

`src/lib/email/origin-hooks/follow-up.ts`:

```ts
import { registerOriginHooks } from "@/lib/email/origins";
import { clearContactFollowUpForUser } from "@/lib/reminder-writes";

// A follow-up is cleared only when the email actually went out: an undone or failed send
// leaves it due. `origin_ref` is the contact id the follow-up belongs to.
registerOriginHooks("follow_up", {
  async onSent(send) {
    if (send.originRef) await clearContactFollowUpForUser(send.userId, send.originRef);
  },
});
```

`src/lib/email/origin-registrations.ts`: replace `export {};` with `import "@/lib/email/origin-hooks/follow-up";` (keep the header comment).

In `src/actions/contacts.ts` — remove the `sendOutreachMessage` and `getOutreachSendConfig` imports and rewrite:

```ts
export type ContactFollowUpSendOptions = {
  canSendEmail: boolean;
  /** Why email can't be sent from Orbit right now, or null when it can. */
  sendBlock: SendBlockReason | "cap_reached" | null;
  hasEmail: boolean;
  hasLinkedIn: boolean;
  email: string | null;
  linkedinUrl: string | null;
};

export async function getContactFollowUpSendOptions(contactId: string): Promise<ContactFollowUpSendOptions> {
  const userId = await requireUserId();
  const db = await getDb();
  const capabilityRead = settle(getSendCapability(userId));
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { email: true, linkedinUrl: true },
  });
  if (!contact) throw new Error("Contact not found");
  const capability = unwrap(await capabilityRead);
  const email = contact.email?.trim() || null;
  const linkedinUrl = contact.linkedinUrl?.trim() || null;
  return {
    hasEmail: Boolean(email),
    hasLinkedIn: Boolean(linkedinUrl),
    email,
    linkedinUrl,
    canSendEmail: Boolean(email && capability.ok),
    sendBlock: capability.ok ? null : capability.reason,
  };
}

export type FollowUpSendResult =
  | { ok: true; sendId: string; sendAt: string; to: string }
  | { ok: false; reason: EnqueueRefusal | "no_email"; message: string };

/** Queue a follow-up email from the user's own mailbox. It goes out after the undo window. */
export async function sendContactFollowUpEmail(contactId: string, body: string, subject?: string): Promise<FollowUpSendResult> {
  const userId = await requireUserId();
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { id: true, email: true, fullName: true, preferredName: true },
  });
  if (!contact) throw new Error("Contact not found");
  if (!contact.email?.trim()) return { ok: false, reason: "no_email", message: "Add an email address for this contact first." };
  const name = contact.preferredName || contact.fullName;
  const profile = await getCurrentUserProfile().catch(() => null);
  const queued = await enqueueEmail(userId, {
    to: [contact.email.trim()],
    subject: subject?.trim() || `Following up · ${name}`,
    bodyText: body,
    fromName: profile?.name?.trim() || null,
    origin: "follow_up",
    originRef: contactId,
    contactIds: [contactId],
    delayMs: UNDO_DELAY_MS,
  });
  if (!queued.ok) return queued;
  scheduleDispatch(queued.id, queued.sendAt);
  return { ok: true, sendId: queued.id, sendAt: queued.sendAt.toISOString(), to: queued.to[0]! };
}
```

Imports to add: `getSendCapability`, `type SendBlockReason` from `@/lib/email/sender`; `enqueueEmail`, `type EnqueueRefusal` from `@/lib/email/outbox`; `scheduleDispatch` from `@/lib/email/schedule`; `UNDO_DELAY_MS` from `@/lib/email/config`; `getCurrentUserProfile` from `@/lib/auth`. Exported types from a `"use server"` file are fine (`export type` is erased); only runtime exports must be async.

Components:
- `follow-up-draft-composer.tsx` hint: replace the `sendOptions.hasEmail ?` Resend line with `sendOptions.hasEmail ? (sendOptions.sendBlock === "cap_reached" ? "You've reached today's email limit — copy and mark sent." : "Connect Gmail to send this from your own address — or copy and mark sent.")`, and render `<ConnectMailboxButton reason={sendOptions.sendBlock} returnTo={pathname} />` next to the hint when `sendOptions.hasEmail && sendOptions.sendBlock && sendOptions.sendBlock !== "cap_reached"` (use `usePathname()` from `next/navigation`).
- `follow-up-draft-sheet.tsx` `sendEmail()`:

```ts
const res = await sendContactFollowUpEmail(contactId, draft);
if (!res.ok) { toast.error(res.message); return; }
showUndoSendToast({ sendId: res.sendId, recipientLabel: contactName, onUndone: () => router.refresh() });
onOpenChange(false);
router.refresh();
```

(adapt to the sheet's existing close/refresh helpers — `finishAndClose` shows its own success toast, so don't call it; close and refresh directly.)
- `contact-follow-up-section.tsx` `sendEmail()`: same pattern.

- [ ] **Step 4: Run tests and refresh the golden**

Run: `npx tsx scripts/smoke-email-origins.ts && npx tsx scripts/run-smoke.ts --only smoke-follow-up-actions`
Expected: PASS.
Run: `npx tsx scripts/smoke-behavior-golden.ts`
Expected: FAIL only on `getContactFollowUpSendOptions` (new `sendBlock` field). Inspect the diff; if that is the only difference, run `npx tsx scripts/smoke-behavior-golden.ts --update`, re-run, expect PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/reminder-writes.ts src/actions/reminders.ts src/lib/email src/actions/contacts.ts src/components/follow-up src/components/contacts/contact-follow-up-section.tsx scripts/smoke-email-origins.ts scripts/run-smoke.ts scripts/fixtures/behavior-golden.json
git commit -m "feat(email): follow-up emails send from the user's mailbox with undo

Follow-ups no longer go through Resend or need a Resend key. The follow-up clears
only once the email actually sends.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Migrate Chat drafts

**Files:**
- Modify: `src/actions/chat-send.ts` (`sendChatDraftViaGmail` ~163–279)
- Modify: `src/lib/chat-send.ts` (remove `CHAT_SEND_DAILY_CAP`, `classifySendError`, `SendFailureKind` once unused)
- Create: `src/lib/email/origin-hooks/chat.ts`; Modify: `origin-registrations.ts`
- Modify: `src/components/chat/gmail-send-dialog.tsx` (`send()` ~140–180, `Blocker`)
- Modify: `scripts/smoke-chat-send.ts`; `scripts/smoke-email-origins.ts` (+ chat section)

**Interfaces:**
- Produces: `ChatSendResult = { ok: true; sendId: string; sendAt: string; to: string } | { ok: false; reason: ChatSendReason; message: string }` — `ChatSendReason` drops `"plan"`, `"failed"`, `"ambiguous"` (no longer returned synchronously) and adds `"cap_reached"`.

Behavior: the chat idempotency key is `chatSendExternalId(messageId, contactId)` (`chat-send:<msg>:<contact>`), and the chat hook's `interactionExternalId` returns that same string so `src/actions/chat.ts`'s already-sent lookup (source `chat_send`, `split_part(external_id, ':', 2)`) keeps working unchanged. The `sync` entitlement check is removed (spec decision 4).

- [ ] **Step 1: Update `scripts/smoke-chat-send.ts` to the new contract (failing).** Keep its fetch mock and fixtures. Replace the send-path assertions:
  - After a successful `sendChatDraftViaGmail`, expect `{ ok: true, sendId }`, then call `await dispatchEmailSend(res.sendId)` after making it due (`UPDATE email_sends SET send_at = now() WHERE id = …`), then assert exactly one Gmail POST, To/From as before, and one interaction with `externalId === chatSendExternalId(messageId, contactId)`, `source === "chat_send"`, `direction === "out"`.
  - "second send returns already_sent": call again before dispatch → `reason === "already_sent"` (mapped from `duplicate`).
  - "two concurrent sends → exactly one row": `Promise.all` two calls → one `ok`, one `already_sent`.
  - Gmail HTTP error → dispatch outcome `failed`, and a new send for the same pair is allowed (key freed because the row is `failed` and not ambiguous).
  - Network drop → dispatch outcome `retry`; a second send for the pair → `already_sent` (row still queued).
  - Missing scope / needs reconnect / not connected → the matching reason, no `email_sends` row.
  - Rate limit: 10 allowed, 11th `rate_limited`.
  - Replace the `daily_limit` case with `cap_reached` (seed 20 sent rows as in Task 6).
  - Delete the source-text assertions at ~288–290 (`onConflictDoNothing` before `sendGmailMessage`) and replace with: `check("chat send goes through the outbox", /enqueueEmail\(/.test(src) && !/sendGmailMessage/.test(src))`.
  - Keep every `loadTarget` refusal (foreign/non-recommended/non-uuid ids, `changed_recipient`, `invalid_recipient`, `placeholder`, `no_email`) unchanged.
  - Add `import "../src/lib/email/origin-registrations";` and `import { dispatchEmailSend } from "../src/lib/email/outbox";`.

Also append to `scripts/smoke-email-origins.ts` a `chatSection()` that enqueues `origin: "chat"`, `originRef: <messageId>`, `idempotencyKey: "chat-send:<msg>:<contact>"`, dispatches, and asserts the interaction's `externalId === "chat-send:<msg>:<contact>"` and `source === "chat_send"`. Call it from `main()`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-chat-send.ts`
Expected: FAIL (result has no `sendId`).

- [ ] **Step 3: Implement.** `src/lib/email/origin-hooks/chat.ts`:

```ts
import { registerOriginHooks } from "@/lib/email/origins";
import { clearContactFollowUpForUser } from "@/lib/reminder-writes";

// Chat's "already sent" badge reads interactions by this exact key (src/actions/chat.ts),
// so the interaction reuses the idempotency key rather than the generic email-send id.
registerOriginHooks("chat", {
  interactionExternalId: (send, contactId) => send.idempotencyKey ?? `email-send:${send.id}:${contactId}`,
  async onSent(send) {
    // Emailing someone from Chat answers their follow-up, as it did before the outbox.
    for (const contactId of send.contactIds) await clearContactFollowUpForUser(send.userId, contactId);
  },
});
```

Add `import "@/lib/email/origin-hooks/chat";` to `origin-registrations.ts`.

`sendChatDraftViaGmail` becomes (keep `loadTarget`, `fail`, `COPY`, input type):

```ts
export async function sendChatDraftViaGmail(input: {
  messageId: string; contactId: string; subject?: string | null; body: string;
  /** The address the dialog showed. Compared only; it is never where the mail goes. */
  shownTo: string;
}): Promise<ChatSendResult> {
  const userId = await requireUserForSurface("page.chat");
  const contact = await loadTarget(userId, input.messageId, input.contactId);
  if (!contact) return fail("invalid");
  const recipient = checkRecipient(contact.email);
  if (!recipient.ok) return fail(recipient.reason === "placeholder" ? "placeholder" : recipient.reason);
  if (recipient.email.toLowerCase() !== (input.shownTo ?? "").trim().toLowerCase()) return fail("changed_recipient");
  const content = checkContent({ subject: input.subject, body: input.body });
  if (!content.ok) return fail("invalid");

  const profile = await getCurrentUserProfile().catch(() => null);
  const queued = await enqueueEmail(userId, {
    to: [recipient.email],
    subject: content.subject,
    bodyText: content.body,
    fromName: profile?.name?.trim() || null,
    origin: "chat",
    originRef: input.messageId,
    idempotencyKey: chatSendExternalId(input.messageId, input.contactId),
    contactIds: [input.contactId],
    delayMs: UNDO_DELAY_MS,
  });
  if (!queued.ok) return fail(CHAT_REASON_FOR[queued.reason]);
  scheduleDispatch(queued.id, queued.sendAt);
  return { ok: true, sendId: queued.id, sendAt: queued.sendAt.toISOString(), to: recipient.email };
}

const CHAT_REASON_FOR: Record<EnqueueRefusal, ChatSendReason> = {
  not_connected: "not_connected",
  no_send_scope: "missing_scope",
  needs_reauth: "needs_reconnect",
  cap_reached: "cap_reached",
  rate_limited: "rate_limited",
  duplicate: "already_sent",
  no_recipient: "no_email",
  too_many: "invalid_recipient",
  invalid_recipient: "invalid_recipient",
  placeholder: "placeholder",
  empty_body: "invalid",
};
```

`CHAT_REASON_FOR` is a non-exported `const` — allowed in a `"use server"` file (only exports must be async). Update `ChatSendReason` and `COPY` (add `cap_reached: ENQUEUE_COPY.cap_reached`, remove `plan`, `failed`, `ambiguous`, `daily_limit`). Remove imports that are now unused: `sendGmailMessage`, `getValidAccessToken`, `requireEntitlement`, `PaywallError`, `consumeBucket`, `RATE_LIMITS`, `settleWrittenInteraction`, `CHAT_SEND_DAILY_CAP`, `classifySendError`, `getGmailSendIdentity`, `interactions` (if unused). Then delete `CHAT_SEND_DAILY_CAP`, `classifySendError` and `SendFailureKind` from `src/lib/chat-send.ts` if nothing else imports them (`grep -rn "CHAT_SEND_DAILY_CAP\|classifySendError" src scripts`), and update the `chatSend` comment in `rate-limit.ts` to say it is superseded by `emailSend` — leave the `chatSend` entry only if something still consumes it; otherwise delete it and its label.

`gmail-send-dialog.tsx` `send()`:

```ts
const res = await sendChatDraftViaGmail({ messageId, contactId, subject: content.subject, body: content.body, shownTo: ctx.to });
if (res.ok) {
  onSent(res.sendAt, false);
  onClose();
  showUndoSendToast({ sendId: res.sendId, recipientLabel: name, onUndone: () => onUndone?.() });
  return;
}
if (res.reason === "already_sent") { onSent(new Date().toISOString(), false); onClose(); return; }
if (res.reason === "needs_reconnect" || res.reason === "missing_scope" || res.reason === "not_connected") {
  setCtx({ ...ctx, identity: { ...ctx.identity, canSend: false, connected: res.reason !== "not_connected" } });
}
setProblem(res.message);
```

Add an optional `onUndone?: () => void` prop and wire it in the parent that renders the dialog so an undone send clears the card's local "sent" state (find the parent with `grep -rn "GmailSendDialog" src/components`). Remove the `plan` branch from `Blocker` and the Copy/mailto "plan" fallback path (sending is on every plan now); keep the Copy/mailto fallbacks for the not-connected state.

`getChatSendContext` (lines 124–161): if it reports plan gating, remove that field's plan dependency; keep its `alreadySent` logic (reads interactions — unchanged).

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/run-smoke.ts --only smoke-chat-send smoke-email-origins smoke-bounded-reads`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/actions/chat-send.ts src/lib/chat-send.ts src/lib/rate-limit.ts src/lib/email src/components/chat scripts/smoke-chat-send.ts scripts/smoke-email-origins.ts
git commit -m "feat(email): chat drafts send through the outbox, on every plan, with undo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Migrate agent (MCP) draft approvals

**Files:**
- Modify: `src/lib/agent-send-approve.ts`, `src/lib/agent-sends.ts` (`finishAgentSend` statuses)
- Create: `src/lib/email/origin-hooks/agent.ts`; Modify: `origin-registrations.ts`
- Modify: `src/actions/agent-sends.ts` (pass `fromName`), `src/components/dashboard/agent-drafts-card.tsx` (ambiguous copy)
- Modify: `scripts/smoke-agent-sends.ts`, `scripts/smoke-ai-guardrails-db.ts` (if assertions depend on Resend), `scripts/smoke-email-origins.ts` (+ agent section)

**Interfaces:**
- Produces: `ApproveResult = { sent: boolean; via: EmailProviderId | null; status: "sent" | "retrying" | "failed"; error?: string }`; `approveAgentSend(userId, draftId, opts: { subject?; body?; confirmRecipient?; fromName?: string | null })`.

Behavior: approval is the confirmation, so `delayMs: 0` and the approve call dispatches **inline** (awaited) to give the card an immediate result. Idempotency key `agent:<draftId>`. Hooks: `onSent` → `finishAgentSend(id, { ok: true, deliveryId })`; `onFailed` → definite kinds return the draft to `pending` with the reason (existing behavior); `ambiguous` → status `failed` with "May have sent — check your Sent folder" (uses the reserved `failed` status; never re-approvable). Interaction source stays `"mcp"` with externalId `mcp:send:<draftId>`. The Resend fallback is deleted.

- [ ] **Step 1: Update tests (failing).** In `scripts/smoke-agent-sends.ts`:
  - Replace `countSendsToday(USER) === 1` (outreach) with `countEmailSendsToday(USER) === 1` from `src/lib/email/sender`.
  - Install a fake Gmail provider via `setProviderOverride` and a `gmailConnections` row with the send scope; assert approve → `{ sent: true, via: "gmail", status: "sent" }`, the draft row `status === "sent"` with `deliveryId === "pm…"`, one `email_sends` row with `origin === "agent"` and `idempotencyKey === "agent:<id>"`.
  - Permanent failure → draft back to `pending` with `errorMessage`; re-approve works.
  - Ambiguous (fake throws `ambiguous`, `findSent` → `"unknown"`): first approve → `status: "retrying"`; after `makeDue` + `dispatchEmailSend` → draft `status === "failed"` and a second approve throws "no longer waiting for approval".
  - No connection → approve throws a `UserFacingError` whose message is `ENQUEUE_COPY.not_connected`, draft back to `pending`.
  - Keep the source regexes; add `src/lib/email/outbox` to the forbidden-imports list for `src/lib/mcp/server.ts` and `src/lib/tools/definitions.ts` (no MCP tool may enqueue).
  - Add an agent section to `smoke-email-origins.ts` asserting the interaction `externalId === "mcp:send:<draftId>"`, `source === "mcp"`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-agent-sends.ts`
Expected: FAIL (still using Resend/Gmail directly; `status` missing).

- [ ] **Step 3: Implement.** `src/lib/email/origin-hooks/agent.ts`:

```ts
import { finishAgentSend, markAgentSendAmbiguous } from "@/lib/agent-sends";
import { registerOriginHooks } from "@/lib/email/origins";

// An approved assistant draft. `origin_ref` is the agent_send_requests id.
registerOriginHooks("agent", {
  interactionExternalId: (send) => `mcp:send:${send.originRef}`,
  async onSent(send) {
    if (send.originRef) await finishAgentSend(send.originRef, { ok: true, deliveryId: send.providerMessageId ?? undefined });
  },
  async onFailed(send, kind, message) {
    if (!send.originRef) return;
    if (kind === "ambiguous") await markAgentSendAmbiguous(send.originRef);
    else await finishAgentSend(send.originRef, { ok: false, error: message });
  },
});
```

In `src/lib/agent-sends.ts` add:

```ts
/**
 * The send may have gone out (a timeout after Gmail accepted it). Never re-approvable: the
 * user checks their Sent folder. Uses the `failed` status reserved for exactly this.
 */
export async function markAgentSendAmbiguous(id: string) {
  const db = await getDb();
  await db
    .update(agentSendRequests)
    .set({ status: "failed", errorMessage: "May have sent — check your Sent folder before sending again.", updatedAt: new Date() })
    .where(eq(agentSendRequests.id, id));
}
```

Add `import "@/lib/email/origin-hooks/agent";` to `origin-registrations.ts`.

`approveAgentSend` becomes (keep the recipient-confirmation block and claim verbatim):

```ts
export type ApproveResult = { sent: boolean; via: EmailProviderId | null; status: "sent" | "retrying" | "failed"; error?: string };

export async function approveAgentSend(
  userId: string,
  draftId: string,
  opts: { subject?: string; body?: string; confirmRecipient?: boolean; fromName?: string | null } = {}
): Promise<ApproveResult> {
  const current = await getAgentSendRequest(userId, draftId);
  if (current && recipientNeedsConfirmation(current.recipientTrust) && !opts.confirmRecipient) {
    throw new UserFacingError(
      current.recipientTrust === "mismatch"
        ? `This draft is attached to ${current.contactName ?? "a contact"} but addressed to ${current.toEmail}. Confirm the address to send.`
        : `${current.toEmail} isn't one of your contacts. Confirm the address to send.`
    );
  }
  const claimed = await claimAgentSendForApproval(userId, draftId);
  if (!claimed) throw new UserFacingError("That draft is no longer waiting for approval");

  const queued = await enqueueEmail(userId, {
    to: [claimed.toEmail],
    subject: opts.subject ?? claimed.subject ?? "",
    bodyText: opts.body ?? claimed.body,
    fromName: opts.fromName ?? null,
    origin: "agent",
    originRef: claimed.id,
    idempotencyKey: `agent:${claimed.id}`,
    contactIds: claimed.contactId ? [claimed.contactId] : undefined,
    delayMs: 0,
  });
  if (!queued.ok) {
    await finishAgentSend(claimed.id, { ok: false, error: queued.message });
    throw new UserFacingError(queued.message);
  }
  // Approval was the confirmation: send now so the card can say what happened.
  const outcome = await dispatchEmailSend(queued.id);
  if (outcome === "sent") return { sent: true, via: queued.provider, status: "sent" };
  if (outcome === "retry") return { sent: false, via: queued.provider, status: "retrying" };
  return { sent: false, via: queued.provider, status: "failed", error: "That didn’t send. The draft is back in your queue." };
}
```

Imports: add `enqueueEmail`, `dispatchEmailSend` from `@/lib/email/outbox`, `type EmailProviderId` from `@/db/schema`, and `import "@/lib/email/origin-registrations";` (the approve path dispatches inline, so the hooks must be loaded). Remove `sendGmailMessage`, `sendOutreachMessage`, `getOutreachSendConfig`, `gmailCanSend`, `hasScope`, `GOOGLE_SCOPES`, `logInteractionForUser` imports. Note: `agent-sends.ts` must not import any send module (the smoke regex `/gmail-send|outreach-send|resend/i`) — the hook file imports `agent-sends`, not the reverse, so that stays true.

`src/actions/agent-sends.ts`: pass `fromName: (await getCurrentUserProfile().catch(() => null))?.name?.trim() || null`.

`agent-drafts-card.tsx`: after `result.ok`, branch on `result.value.status`: `"sent"` → `toast.success(\`Sent to ${draft.toEmail}\`)`; `"retrying"` → `toast.message("Gmail is slow to respond — Orbit will keep trying and let you know if it doesn't send.")`; `"failed"` → `toast.error(result.value.error ?? "That didn’t send.")`. Call `onDone()` in all three.

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/run-smoke.ts --only smoke-agent-sends smoke-ai-guardrails-db smoke-ai-guardrails smoke-email-origins`
Expected: PASS. (`smoke-ai-guardrails-db` asserts the confirm-address refusal before any claim — unchanged.)

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/agent-send-approve.ts src/lib/agent-sends.ts src/lib/email src/actions/agent-sends.ts src/components/dashboard/agent-drafts-card.tsx scripts/smoke-agent-sends.ts scripts/smoke-email-origins.ts
git commit -m "feat(email): approved assistant drafts send through the outbox; drop Resend fallback

A timed-out send is marked 'may have sent' instead of returning to the queue, so an
approval can no longer be sent twice.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Migrate recruiter sends

**Files:**
- Modify: `src/actions/recruiter-messages.ts` (`countSendsToday`, `getRecruiterSendQuota` 57–82; `sendRecruiterDrafts` 276–428)
- Modify: `src/lib/recruiter-message-types.ts` (remove `DAILY_RECRUITER_SEND_LIMIT` if unused)
- Create: `src/lib/email/origin-hooks/recruiter.ts`; Modify: `origin-registrations.ts`
- Modify: `src/components/recruiters/compose-workspace.tsx` (quota label unaffected in shape; verify)
- Test: `scripts/smoke-email-origins.ts` (+ recruiter section), `scripts/smoke-connect-gates.ts` (must still pass)

**Interfaces:**
- Produces: `getRecruiterSendQuota(): Promise<{ used: number; limit: number; remaining: number }>` now backed by the shared cap; `SendDraftsResult` unchanged in shape.

Behavior: batch send, no undo (`delayMs: 0`), dispatched inline one at a time with the existing `SEND_SPACING_MS` spacing so the result counts stay synchronous. Idempotency key `recruiter:<messageId>`; `originRef` = recruiter message id; `threadId` = `row.message.gmailThreadId`. Hooks: `onSent` → recruiter message `status: "sent"`, `sentAt`, `gmailMessageId`, `gmailThreadId`; `onFailed` → `status: "failed"` with a user-safe `errorMessage` (ambiguous → "May have sent — check your Sent folder"). Demo workspaces now go through the demo provider instead of the short-circuit. Contacts matching the recruiter's address get an interaction (`source: "recruiter_send"`) — new behavior, called out in the PR.

- [ ] **Step 1: Add a failing recruiter section** to `scripts/smoke-email-origins.ts`: seed a `recruiters` row + `recruiterMessages` draft for `USER` (check required columns in `src/db/schema.ts`), enqueue `origin: "recruiter"`, `originRef: <msgId>`, `idempotencyKey: "recruiter:<msgId>"`, dispatch, and assert the message row becomes `status: "sent"` with `gmailMessageId === "pm"`; then a permanent-failure variant → `status: "failed"` and `errorMessage` not containing `"Gmail 4"` (no raw provider text).

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-email-origins.ts`
Expected: FAIL on the recruiter checks.

- [ ] **Step 3: Implement.** `src/lib/email/origin-hooks/recruiter.ts`:

```ts
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { recruiterMessages } from "@/db/schema";
import { registerOriginHooks } from "@/lib/email/origins";

// A recruiter draft. `origin_ref` is the recruiter_messages id; the row mirrors the outcome
// so the compose page's lists stay the source of truth for recruiter threads.
registerOriginHooks("recruiter", {
  async onSent(send) {
    if (!send.originRef) return;
    const db = await getDb();
    await db
      .update(recruiterMessages)
      .set({ status: "sent", sentAt: send.sentAt ?? new Date(), gmailMessageId: send.providerMessageId, gmailThreadId: send.providerThreadId, errorMessage: null, updatedAt: new Date() })
      .where(eq(recruiterMessages.id, send.originRef));
  },
  async onFailed(send, kind) {
    if (!send.originRef) return;
    const db = await getDb();
    const errorMessage =
      kind === "ambiguous" ? "May have sent — check your Sent folder before resending."
      : kind === "auth" ? "Gmail needs reconnecting before this can send."
      : "Gmail didn’t accept this message.";
    await db.update(recruiterMessages).set({ status: "failed", errorMessage, updatedAt: new Date() }).where(eq(recruiterMessages.id, send.originRef));
  },
});
```

Add `import "@/lib/email/origin-hooks/recruiter";` to `origin-registrations.ts`.

In `src/actions/recruiter-messages.ts`: delete the private `countSendsToday`; `getRecruiterSendQuota` becomes:

```ts
export async function getRecruiterSendQuota() {
  const userId = await requireUserId();
  const capability = await getSendCapability(userId);
  const remaining = capability.ok ? capability.remainingToday : 0;
  return { used: capability.usedToday, limit: capability.dailyCap, remaining };
}
```

`sendRecruiterDrafts` keeps its row query, `pooledIdsForViewer` and `resolveRecruiterPii`; replace the quota pre-checks, demo short-circuit, connection check and per-row `sendGmailMessage` block with:

```ts
    const capability = await getSendCapability(userId);
    if (!capability.ok) {
      throw new UserFacingError(ENQUEUE_COPY[capability.reason]);
    }
    if (unique.length > capability.remainingToday) {
      throw new UserFacingError(`You can send ${capability.remainingToday} more today. Deselect ${unique.length - capability.remainingToday}.`);
    }
    const profile = await getCurrentUserProfile().catch(() => null);
    // … existing rows query + pooled …
    for (const [index, row] of rows.entries()) {
      const to = resolveRecruiterPii(row.recruiter, row.link, pooled.has(row.recruiter.id)).email;
      if (!to) { failed.push({ id: row.message.id, recruiterName: row.recruiter.fullName, error: `${row.recruiter.fullName} has no email address on file` }); continue; }
      const queued = await enqueueEmail(userId, {
        to: [to], subject: row.message.subject, bodyText: row.message.body,
        fromName: profile?.name?.trim() || null,
        origin: "recruiter", originRef: row.message.id, idempotencyKey: `recruiter:${row.message.id}`,
        threadId: row.message.gmailThreadId, delayMs: 0,
      });
      if (!queued.ok) {
        failed.push({ id: row.message.id, recruiterName: row.recruiter.fullName, error: queued.message });
        continue;
      }
      const outcome = await dispatchEmailSend(queued.id);
      if (outcome === "sent") sent += 1;
      else if (outcome === "retry") failed.push({ id: row.message.id, recruiterName: row.recruiter.fullName, error: `Gmail is slow — Orbit will keep trying to send to ${row.recruiter.fullName}.` });
      else failed.push({ id: row.message.id, recruiterName: row.recruiter.fullName, error: `Couldn’t send to ${row.recruiter.fullName} — try again?` });
      if (index < rows.length - 1) await new Promise((resolve) => setTimeout(resolve, SEND_SPACING_MS));
    }
    revalidatePath("/recruiters/compose");
    revalidatePath("/recruiters");
    return { sent, failed, quotaRemaining: Math.max(0, capability.remainingToday - sent) };
```

Add `import "@/lib/email/origin-registrations";`, `enqueueEmail`, `dispatchEmailSend`, `ENQUEUE_COPY`, `getSendCapability`. Remove `sendGmailMessage`, `DAILY_RECRUITER_SEND_LIMIT`, the `isDemoWorkspace` short-circuit and the `gmailConnections` lookup if now unused. Keep `requireRecruitersUser()` as the first line (`smoke-connect-gates.ts` asserts it).

Delete `DAILY_RECRUITER_SEND_LIMIT` from `src/lib/recruiter-message-types.ts` if `grep -rn DAILY_RECRUITER_SEND_LIMIT src scripts` shows no other users.

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/run-smoke.ts --only smoke-email-origins smoke-connect-gates smoke-batched-writes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/actions/recruiter-messages.ts src/lib/recruiter-message-types.ts src/lib/email src/components/recruiters scripts/smoke-email-origins.ts
git commit -m "feat(email): recruiter drafts send through the outbox and share the daily cap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Failed-send account alert

**Files:**
- Modify: `src/lib/account-alerts.ts` (`HealthCode` ~66, `HealthInput` ~106, `evaluateAccountHealth` ~217, `DISMISSIBLE_CODES` ~405, `KIND_BY_CODE` ~430, `CODE_RANK` ~461, `toAccountAlerts` ~490)
- Modify: `src/lib/account-health.ts` (`loadAccountHealthInput` ~190)
- Modify: `src/actions/email-sends.ts` (+ `dismissFailedSendsAction`); the alert-dismiss plumbing if dismissals route through a shared action (read how `DISMISSIBLE_CODES` dismissals are stored first)
- Test: `scripts/smoke-account-alerts.ts`

**Interfaces:**
- Produces: `HealthCode` `"email.send_failed"`; `HealthInput.failedEmailSends: number | null`; `dismissFailedSendsAction(): Promise<{ dismissed: number }>`

- [ ] **Step 1: Write failing cases** in `scripts/smoke-account-alerts.ts` (follow the file's existing pure-evaluation pattern):

```ts
{
  const findings = evaluateAccountHealth({ ...baseInput, failedEmailSends: 2 }, NOW);
  check("failed sends raise email.send_failed", findings.some((f) => f.code === "email.send_failed" && f.data.count === 2));
  const alerts = toAccountAlerts(findings);
  const a = alerts.find((x) => x.code === "email.send_failed");
  check("copy pluralizes", a?.title === "2 emails didn't send");
  check("links to where the send can be retried", a?.cta?.href === "/contacts");
}
check("no failed sends, no alert", !evaluateAccountHealth({ ...baseInput, failedEmailSends: 0 }, NOW).some((f) => f.code === "email.send_failed"));
```

Adapt `baseInput`/`NOW`/`check` names to the file's own. Keep the query-budget check (`paidStatements <= 4`) passing: the new count must be a scalar subquery inside the existing single select.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-account-alerts.ts`
Expected: FAIL (type error / missing code).

- [ ] **Step 3: Implement.**
- `HealthCode`: add `| "email.send_failed"`.
- `HealthInput`: add `/** email_sends failed in the last 7 days and not dismissed. */ failedEmailSends: number | null;`
- `loadAccountHealthInput`: add to the single select a scalar subquery:

```ts
failedEmailSends: sql<number>`(select count(*)::int from email_sends where user_id = ${userId} and status = 'failed' and dismissed_at is null and updated_at > now() - interval '7 days')`,
```

- `evaluateAccountHealth`:

```ts
  if (input.failedEmailSends) {
    findings.push({ code: "email.send_failed", severity: "warning", data: { count: input.failedEmailSends } });
  }
```

- `DISMISSIBLE_CODES`: add `"email.send_failed"`. `KIND_BY_CODE`: `"email.send_failed": "connection"`. `CODE_RANK`: place just after `import.failed`.
- `toAccountAlerts`:

```ts
      case "email.send_failed": {
        const n = int(f.data.count) ?? 1;
        alerts.push({
          ...base,
          title: n === 1 ? "An email didn't send" : `${n} emails didn't send`,
          body: "Nothing went out. Open the contact to try again, or reconnect Gmail if it asked you to.",
          cta: { label: "Open contacts", href: "/contacts", external: false },
          surfaceKey: "page.contacts",
        });
        break;
      }
```

- Dismissal: read how existing `DISMISSIBLE_CODES` dismissals persist (grep `DISMISSIBLE_CODES` and `dismiss` in `src/lib/account-alerts.ts` / `src/actions`). If dismissals are stored generically per code, that is enough. If the alert should also stop counting the dismissed rows (so a later failure re-raises it), add `dismissFailedSendsAction` in `src/actions/email-sends.ts`:

```ts
export async function dismissFailedSendsAction(): Promise<{ dismissed: number }> {
  const userId = await requireUserId();
  const db = await getDb();
  const rows = await db
    .update(emailSends)
    .set({ dismissedAt: new Date() })
    .where(and(eq(emailSends.userId, userId), eq(emailSends.status, "failed"), isNull(emailSends.dismissedAt)))
    .returning();
  return { dismissed: rows.length };
}
```

and call it from the generic dismiss path for this code.

(The contact-timeline Retry/Edit surface is P2; this alert points to contacts until then.)

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/run-smoke.ts --only smoke-account-alerts smoke-email-actions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/account-alerts.ts src/lib/account-health.ts src/actions/email-sends.ts scripts/smoke-account-alerts.ts
git commit -m "feat(email): account alert when an email didn't send

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Remove the old paths, guard them, full verification

**Files:**
- Delete or trim: `src/lib/gmail-send.ts` (`sendGmailMessage`, `GmailSendInput`, `GmailSendResult`, `buildMimeMessage` once unused)
- Modify: `scripts/smoke-gmail-send-mime.ts` (retarget to `src/lib/email/mime.ts` or delete + unregister, if `buildMimeMessage` is removed)
- Create: `scripts/smoke-email-no-resend.ts` (tier `pure`)

- [ ] **Step 1: Write the guard** `scripts/smoke-email-no-resend.ts`:

```ts
/**
 * After direct-email P1, no person-to-person path may reach Resend or call Gmail's send
 * endpoint outside the outbox's provider. Outreach campaigns are the one allowed Resend
 * user. Run: npx tsx scripts/smoke-email-no-resend.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []
  );
}

const files = walk("src");
const RESEND_1TO1 = /from "@\/lib\/outreach-send"/;
const OUTREACH_ALLOWED = new Set(["src/actions/outreach.ts"]);
const offenders = files.filter((f) => RESEND_1TO1.test(readFileSync(f, "utf8")) && !OUTREACH_ALLOWED.has(f) && f !== "src/lib/outreach-send.ts");
check("only Outreach campaigns import outreach-send", offenders.length === 0, offenders.join(", "));

const SEND_ENDPOINT = /gmail\/v1\/users\/me\/messages\/send/;
const senders = files.filter((f) => SEND_ENDPOINT.test(readFileSync(f, "utf8")));
check("only the Gmail provider calls messages/send", senders.join() === "src/lib/email/providers/gmail.ts", senders.join(", "));

const legacy = files.filter((f) => /sendGmailMessage\(/.test(readFileSync(f, "utf8")));
check("sendGmailMessage has no callers", legacy.length === 0, legacy.join(", "));

console.log("\nNo 1:1 path reaches Resend.");
```

Register `"smoke-email-no-resend": "pure",`. Normalize path separators if needed (`f.replaceAll("\\", "/")`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-email-no-resend.ts`
Expected: FAIL on "only the Gmail provider calls messages/send" (`src/lib/gmail-send.ts` still has it).

- [ ] **Step 3: Remove the legacy sender.** Delete `sendGmailMessage`, `GmailSendInput`, `GmailSendResult` and `buildMimeMessage` from `src/lib/gmail-send.ts`. If the file is left with only re-exports, delete it and update importers (`grep -rn "gmail-send" src scripts`) to import from `@/lib/email/mime`. Update `smoke-gmail-send-mime.ts`: either delete it (and its MANIFEST entry — its coverage now lives in `smoke-email-mime.ts`; port its injection/quoting checks there first) or retarget its imports to `buildMime`/`formatAddress`. Update `smoke-agent-sends.ts`'s forbidden-import regex list if it named `gmail-send`, so it still forbids `src/lib/email/outbox`/`providers` in MCP tool files.

- [ ] **Step 4: Full verification**

Run each; all must pass:

```bash
npx tsx scripts/smoke-email-no-resend.ts
npm run test:check
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Expected: smoke suite green (rerun `smoke-admin-render`/`smoke-instrumentation` alone if they time out under load — known flake), `tsc` clean, eslint 0 errors, build compiles. Stop any running dev server on this worktree's `.next` before `npm run build` (a build wedges it).

- [ ] **Step 5: Manual acceptance (preview deploy, real Gmail — never the demo account)**

1. Connect Gmail with send permission on a preview.
2. Contact with your own second address → Follow-up → Send email → toast "Sending to …" with Undo → click Undo → toast "Send canceled"; nothing in Gmail Sent; follow-up still due.
3. Send again, let it go → arrives from your address within ~15s; follow-up cleared; timeline shows the email.
4. Chat draft → Send → arrives; card shows sent.
5. Revoke Orbit in Google account settings → send → failure; within one drain run the "An email didn't send" alert appears and Gmail shows Reconnect.

- [ ] **Step 6: Commit**

```bash
git add -A src scripts
git commit -m "chore(email): remove the direct Gmail sender and guard 1:1 sends off Resend

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## PR notes (for the P1 pull request description)

- **User-visible change:** follow-up emails now send from the user's own Gmail and need Gmail connected with send permission; the "add a Resend key" path is gone. Outreach campaigns still use Resend.
- Chat sending is now on every plan (was `sync`-gated). One daily cap for all 1:1 email: Free 20, paid 100.
- Every interactive send has a 10-second Undo.
- Recruiter sends now log an interaction on any matching contact.
- New schema version N (`email_sends`); re-scan all branches for `SCHEMA_VERSION` before merging.
- Ops: new `Drain the email outbox` step in `ops.yml`; no new secrets.
