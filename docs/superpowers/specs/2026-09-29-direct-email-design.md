# Direct email from Orbit — design

**Date:** 2026-09-29
**Status:** Approved in brainstorming; awaiting spec review
**Branch:** `claude/orbit-direct-email-cc0746`

## Problem

Orbit already sends email, but through four unrelated paths:

| Surface | Transport | Gate | Cap |
|---|---|---|---|
| Chat drafts (`src/actions/chat-send.ts`) | Gmail (`sendGmailMessage`) | `sync` entitlement | `CHAT_SEND_DAILY_CAP = 25` |
| Agent/MCP drafts (`src/lib/agent-send-approve.ts`) | Gmail, Resend fallback | none (approval card) | `countSendsToday` / `DAILY_SEND_LIMIT = 50` |
| Recruiter drafts (`src/actions/recruiter-messages.ts`) | Gmail | `recruiters` | own quota |
| Contact follow-ups (`sendContactFollowUpEmail` in `src/actions/contacts.ts`) | **Resend only** (needs a key) | `canSendEmail` | `DAILY_SEND_LIMIT = 50` |

There is no free-form "email this person" anywhere, Outlook has no send scope
(`src/lib/microsoft-scopes.ts` has `Mail.Read` only), and person-to-person mail on the
follow-up path arrives from Orbit's domain rather than the user's.

## Goal

One send engine, sending **from the user's own mailbox** (Gmail or Outlook), that every
surface uses — then a first-class Compose experience built on it.

## Settled decisions

1. **Scope:** unify the existing send paths on one engine *and* add Compose as the first new
   surface (Compose on today's split paths would have been a fifth path).
2. **Providers:** Gmail and Outlook. The engine is provider-agnostic; Outlook ships in its own
   phase so it does not wait on Microsoft publisher verification.
3. **Resend is removed from person-to-person mail.** Sending requires a connected mailbox.
   Resend stays only for Orbit's system mail (invites, broadcasts, `/contact`, interest list)
   and for Outreach campaigns, which are out of scope and keep whatever their own spec decides.
4. **Every plan can send**, including Free, with a per-plan daily cap. Sending from the user's
   own mailbox costs Orbit nothing. AI drafting keeps its existing BYOK/AI gating.
5. **Compose scope is everything:** CC/BCC + multiple recipients, AI draft, undo send,
   HTML signature, scheduled send, attachments, reply-in-thread — delivered in phases.
6. **Architecture:** a durable outbox table (approach 1), not send-now + a side table, and not
   Vercel Workflow/Queues.

## Phases

Each phase gets its own implementation plan from this spec and ships as its own PR.

| Phase | Contents | Gate |
|---|---|---|
| **P1 — Engine + Gmail** | `email_sends` outbox, provider interface, Gmail provider, caps, interaction logging, undo, drain, migrate follow-ups/chat/agent/recruiter, remove Resend from 1:1 mail | ungated (changes existing Send buttons) |
| **P2 — Compose** | Contact-page + command-bar Compose, AI draft, CC/BCC/multi-recipient, HTML signature, Email settings section | `surfaces.ts` `action.compose`, `comingSoon: true` |
| **P3 — Outlook** | `Mail.Send` scope, Outlook provider, legal/privacy updates | inherits Compose gate |
| **P4 — Scheduled send + attachments** | Send menu scheduling, Blob attachments, blob cleanup | inherits |
| **P5 — Reply in thread** | (a) Orbit-originated threads; (b) inbox threads — Outlook now, Gmail after CASA | inherits |

## 1. Data model

### `email_sends` (new table)

`SCHEMA_VERSION`: claim the next free number **at implementation time**. On Sep 29 2026 main
was at 136 and `claude/pricing-v2` claimed 138, so P1 needs ≥ 139 — re-scan every remote
branch for `export const SCHEMA_VERSION` before committing, and again before merge (a branch
number below main's silently skips its own DDL). New tables follow the DDL template path.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | text not null | |
| `provider` | text not null | `gmail` \| `outlook`, recorded at enqueue |
| `from_email` | text not null | connected account address, recorded at enqueue |
| `from_name` | text | |
| `to` | jsonb `string[]` not null | ≥ 1 |
| `cc`, `bcc` | jsonb `string[]` default `[]` | |
| `subject` | text not null | |
| `body_text` | text not null | |
| `body_html` | text | sanitized; signature / HTML part (P2) |
| `contact_ids` | jsonb `uuid[]` default `[]` | recipients resolved to contacts; drives logging |
| `origin` | text not null | `compose` \| `follow_up` \| `chat` \| `agent` \| `recruiter` |
| `origin_ref` | text | e.g. `agent_send_requests.id`, follow-up contact id |
| `idempotency_key` | text | natural key per surface (`chat-send:…`, `agent:…`, `recruiter:…`); partial unique with `user_id` on active + ambiguous rows |
| `status` | text not null | `queued` \| `sending` \| `sent` \| `failed` \| `canceled` |
| `send_at` | timestamptz not null | |
| `sent_at` | timestamptz | |
| `attempts` | int default 0 | |
| `claimed_by` | uuid | drain/dispatcher lease owner |
| `lease_until` | timestamptz | |
| `last_error` | text | internal; never shown raw (use `friendlyError`) |
| `failure_kind` | text | `auth` \| `permanent` \| `ambiguous` \| `exhausted` |
| `rfc_message_id` | text not null | generated at enqueue; the idempotency key |
| `provider_message_id` | text | |
| `provider_thread_id` | text | |
| `in_reply_to_send_id` | uuid | nullable (P5) |
| `in_reply_to_rfc_id` | text | nullable (P5, inbox threads) |
| `attachments` | jsonb default `[]` | `{ blobKey, filename, contentType, size }[]` (P4) |
| `dismissed_at` | timestamptz | failed-send alert dismissal |
| `created_at`, `updated_at` | timestamptz | |

Every column P2–P5 needs is created in P1, so later phases add no DDL.

Indexes:
- partial `(send_at) WHERE status = 'queued'` — drain scan
- `(user_id, created_at)` — cap counting, settings usage
- `(user_id, status)` — account alert / scheduled list
- GIN on `contact_ids` — contact timeline pending items, P5 thread lookup

Registrations (all required or a smoke fails): `purgeUserData` category (sends are user
content; delete on "delete all data" and account deletion) + fixture in `smoke-purge.ts`.

### Settings

`user_settings` (`src/db/schema.ts`, beside `writing_instructions`) gains `email_signature_text`,
`email_signature_html`, `default_send_provider`. Added in P1's DDL for the same reason.

## 2. Provider interface

`src/lib/email/providers/types.ts`:

```ts
export type OutboundMessage = {
  from: { email: string; name: string | null };
  to: string[]; cc: string[]; bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  rfcMessageId: string;
  inReplyTo?: { rfcMessageId: string; providerThreadId: string | null } | null;
  attachments?: { filename: string; contentType: string; bytes: Uint8Array }[];
};

export type SendResult = {
  providerMessageId: string;
  providerThreadId: string | null;
};

export class MailProviderError extends Error {
  kind: "auth" | "transient" | "permanent" | "ambiguous";
}

export interface MailProvider {
  id: "gmail" | "outlook";
  /** null = not connected, no send scope, or needs reauth. */
  identity(userId: string): Promise<{ email: string; name: string | null } | null>;
  send(userId: string, msg: OutboundMessage): Promise<SendResult>;
  /** Is a message with this Message-ID already in Sent? null = can't tell (no read scope). */
  findSent(userId: string, rfcMessageId: string): Promise<SendResult | null | "unknown">;
}
```

- **Gmail** (`gmail.ts`): wraps and extends `src/lib/gmail-send.ts` — CC/BCC headers,
  multipart/alternative for HTML, multipart/mixed for attachments, explicit `Message-ID`
  header. Existing header-injection guards (`sanitizeHeader`, RFC 2047 encoding) apply to
  every new header. `findSent` uses `rfc822msgid:` search and returns `"unknown"` without
  `gmail.readonly`.
- **Outlook** (`outlook.ts`, P3): `POST /me/messages` (returns `id`, `internetMessageId`,
  `conversationId`) then `POST /me/messages/{id}/send`. **Not** `/me/sendMail`, which
  returns 202 with no body and so no ids. Set `internetMessageId` to our `rfc_message_id`.
  Attachments > ~3 MB use a Graph upload session on the draft. `findSent` filters Sent Items
  on `internetMessageId` (`Mail.Read` is already granted).
- **Error classification:** 401 / `invalid_grant` → `auth`; 429 / 5xx → `transient`;
  network timeout or abort **after the request was sent** → `ambiguous`; 4xx otherwise →
  `permanent`.

### Choosing the mailbox

`resolveSender(userId)`: the `default_send_provider` if it has an identity, else the single
connected provider with send scope, else Gmail when both qualify. None → the action throws a
`UserFacingError` the UI renders as a "Connect Gmail or Outlook" button that starts
`startGmailOAuth({ purposes: ["send"] })` (or the Outlook equivalent in P3).

`getSendCapability(userId)` replaces `canSendEmail` and `getContactFollowUpSendOptions`:

```ts
type SendCapability =
  | { ok: true; provider; fromEmail; fromName; remainingToday: number; dailyCap: number }
  | { ok: false; reason: "not_connected" | "no_send_scope" | "needs_reauth" | "cap_reached" };
```

## 3. Send lifecycle

### Enqueue — `enqueueEmail(userId, draft, { origin, originRef, delayMs })`

One lib function (`src/lib/email/enqueue.ts`, not an action, so MCP/agent paths can call it —
actions start with `requireUserId()`). In order:

1. Validate recipients: parse, lowercase, dedupe across To/CC/BCC, reject CR/LF and malformed
   addresses, **≤ 20 total**, ≥ 1 in To.
2. `resolveSender` → provider + identity (else throw as above).
3. Burst limit: `consumeBucket("emailSend", userId)` — 10 per 600s; add a `BUCKET_LABELS`
   entry (a test enforces this).
4. Daily cap (below).
5. Resolve `contact_ids`: match every recipient against `contacts.email` and
   `contact_identities` (kind `email`) for this user.
6. Insert with `status = queued`, `send_at = now() + delayMs` (DB clock),
   `rfc_message_id = <uuid@orbit-domain>`.

`delayMs`: **10 000** for interactive sends (undo window), the chosen time for scheduled sends
(P4), **0** for pre-approved sends (agent approval).

### Dispatch

The action returns `{ id, sendAt }` immediately, then `after()`:
waits until `send_at`, then `dispatchEmailSend(id)`.

`dispatchEmailSend(id)`:
1. Claim: `UPDATE … SET status='sending', claimed_by=$me, lease_until=now()+interval '2 min',
   attempts=attempts+1 WHERE id=$id AND status='queued' AND send_at<=now() RETURNING *`.
   No row → someone else has it, or it was canceled; stop.
2. If `attempts > 1` (a retry), first `provider.findSent(rfc_message_id)`:
   found → mark `sent` with those ids; `"unknown"` and the previous failure was `ambiguous` →
   mark `failed` / `failure_kind='ambiguous'` ("may have sent — check your Sent folder"), never
   re-send.
3. Load attachments (P4), `provider.send(...)`.
4. On success, in one `db.batch`: mark `sent` (guarded by `claimed_by=$me`), insert one
   `interactions` row per `contact_ids` entry (`interaction_type='email'`, `direction='out'`,
   `source=origin`, `external_id=provider_message_id`, `raw_notes` = subject + body excerpt),
   bump `contacts.last_interaction_at`. Then origin side effects (§4).
5. On error by kind: `auth` → set the connection `needs_reauth`, mark `failed`; `permanent` →
   `failed`; `transient` → back to `queued` with `send_at = now() + backoff`; `ambiguous` →
   back to `queued` with backoff (step 2 decides on retry). `attempts >= 5` → `failed`
   / `exhausted`.

Backoff ladder: 1 → 5 → 30 → 120 minutes. The drain runs every ~10 min, so early steps
collapse; that is fine.

Claim/lease/stale-result rules copy `src/lib/connectors/outbox.ts` (DB-clock leases, a
post-delivery write guarded on `claimed_by`), including its reasoning comments.

### Undo

`cancelEmailSend(id)`: `UPDATE … SET status='canceled' WHERE id=$id AND user_id=$u AND
status='queued'`. Zero rows → return `"already_sent"`; the toast says "Already sent."
Scheduled sends (P4) use the same action.

### Drain

`drainEmailSends({ budgetMs, limit })` runs from the existing ops workflow
(`.github/workflows/ops.yml`, every 10 min) via an internal route (add to `PUBLIC_ROUTES`,
authenticate with `isInternalRequest`, record with `startCronRun`/`finishCronRun`). It claims
due `queued` rows and `sending` rows whose lease has lapsed, and dispatches them within a 40s
budget. It covers: `after()` never running (function recycled), scheduled sends, retries.

### Caps

One daily cap across all origins, counted from `email_sends` where
`status IN ('queued','sending','sent')` and `created_at > now() - interval '24 hours'`:

| Plan | Cap |
|---|---|
| Free | 20 / day |
| Orbit, Lifetime | 100 / day |

Defined in `plan-limits.ts` beside the other plan numbers. Removed: `CHAT_SEND_DAILY_CAP`,
the 1:1 use of `DAILY_SEND_LIMIT`/`countSendsToday`, and the recruiter send quota. Outreach
campaigns keep theirs. Scheduled sends count on the day they are created.

### Failure surfaces

- **Account alert** (panel footer, existing account-alerts pattern): "N emails didn't send —
  Review". Predicate: `failed` rows in the last 7 days not yet dismissed.
- **Contact timeline:** `queued` (scheduled) and `failed` sends render as pending items with
  Cancel / Retry / Edit. Retry = re-enqueue a copy with a new `rfc_message_id` only when
  `failure_kind` is not `ambiguous`; for `ambiguous` the UI says to check Sent first.
- `needs_reauth` also raises the existing connection alert.

## 4. Migrating existing surfaces (P1)

| Surface | Change |
|---|---|
| Contact follow-ups | `sendContactFollowUpEmail` → `enqueueEmail(origin: "follow_up", originRef: reminderId, delayMs: 10_000)`. The reminder is cleared by the dispatcher **on success only**, so undo leaves it open. Composer's "add a Resend key" hint → Connect-mailbox CTA from `getSendCapability`. |
| Chat drafts | `sendChatDraftViaGmail` → `enqueueEmail(origin: "chat")`. Delete the claim-row-before-send `interactions` insert (the outbox row is the claim). Remove the `sync` entitlement check. `GmailSendDialog` becomes the shared confirm UI or is replaced by the P2 composer body. |
| Agent (MCP) drafts | `approveAgentSend` → `enqueueEmail(origin: "agent", originRef: requestId, delayMs: 0)`; the request row moves to approved/sent from the dispatcher. **Delete the Resend fallback.** `request_send` tool unchanged. |
| Recruiter drafts | `sendRecruiterDrafts` → one `enqueueEmail(origin: "recruiter")` per draft, preserving its `threadId`/`In-Reply-To` via `inReplyTo`. Quota → shared cap. `requireRecruitersUser` stays on the page, not the send. |

Origin side effects run in the dispatcher after success, keyed by `origin` in a small
registry (`src/lib/email/origins.ts`), so each surface's post-send behavior lives in one place.

After P1, `sendOutreachMessage` (Resend) is reachable only from Outreach campaign code; a
source-parse smoke asserts no 1:1 path imports it.

## 5. Compose UI (P2)

Gated by a new `surfaces.ts` entry `action.compose` with `comingSoon: true`; previewable via
"Preview unreleased".

**Entry points:** contact page header action + mobile action sheet; command bar verb
"Email ‹contact›"; chat and follow-up surfaces reuse the composer body.

**Composer** (dialog on `md:`, bottom sheet below — device switch in CSS, not `useIsMobile`):
- **From** — connected address; a picker once both mailboxes are connected.
- **To / CC / BCC** — chip inputs. Suggestions: this contact's addresses first
  (`contacts.email` + `contact_identities`), then other contacts by name/email. Free-typed
  addresses allowed; ones that resolve to a contact show that contact's avatar.
- **Subject**, **Body** (plain text; signature appended and shown greyed).
- **Draft with AI** — reuses `src/lib/follow-up-drafts.ts` + `writing-instructions.ts`, under
  the existing BYOK gate; hidden (not disabled) when AI is unavailable.
- **Send** — split button; the menu gains schedule options in P4.
- Drop zone for attachments (P4).
- Footer shows "N of M sends left today" when under 25% remain.

**Undo toast:** "Sending to ‹name›… Undo" for 10s, then "Sent · Open in Gmail/Outlook".
Follows the friendly-error / toast-voice conventions; errors come through `friendlyError`.

**Drafts:** no server-side drafts in v1. Unsent content persists in `localStorage` keyed by
contact id (wrapped in try/catch), cleared on send.

**Settings → Email** (new `sections.ts` group; section id is a surface key, never rename):
signature (plain text or basic HTML, sanitized server-side with an allowlist), default sending
mailbox, today's usage.

## 6. Outlook (P3)

- `microsoft-scopes.ts`: add `Mail.Send` under a `send` purpose, requested incrementally.
- Outlook provider per §2.
- `legal.ts` + privacy page: add Microsoft scope entries (`Mail.Send`, and describe the
  existing `Mail.Read`). Privacy-policy update, not a versioned terms change.
- Re-consent: existing Outlook users see the Connect-to-send CTA the first time they send.

## 7. Scheduled send + attachments (P4)

- Send menu: "Tomorrow 8:00", "Monday 8:00", "Pick a time" — user's timezone, labelled
  "around" since delivery lands within ~10 min of the drain.
- Scheduled rows on the contact timeline with Cancel / Edit (Edit = cancel + new compose
  prefilled).
- Attachments: direct client upload to **private** Vercel Blob (bypasses the 4.5 MB function
  body limit); ≤ 25 MB total per message (Gmail's limit; Outlook uses upload sessions).
  Keys stored on the row; fetched at dispatch. Housekeeping sweep deletes blobs 7 days after
  `sent`/`canceled`/`failed`. Blobs are covered by `purgeUserData`.

## 8. Reply in thread (P5)

- Composer offers "Reply to: ‹last subject›" when a prior thread exists with any recipient.
- **P5a:** threads Orbit sent — look up the latest `email_sends` row for the contact; use its
  `provider_thread_id` + `rfc_message_id`. No new scope.
- **P5b:** inbox threads — Outlook via existing `Mail.Read`; Gmail only once `gmail.readonly`
  passes CASA verification (already a long pole for recruiter scan). Until then the inbox
  option is simply not offered to Gmail users.

## 9. Security & privacy

- Header injection: every header value goes through `sanitizeHeader`; recipients are parsed,
  not concatenated.
- HTML signature/body sanitized server-side with a strict allowlist before storage and send.
- `enqueueEmail` takes `userId` from the caller's auth only; the action user-scope smoke
  (`src/actions/**` parse) must pass.
- Agent path keeps the human approval card as the control; no MCP tool can call `enqueueEmail`.
- Tokens never leave `gmail.ts` / `outlook.ts` token helpers.
- `last_error` is internal; user-facing text goes through `friendlyError`.

## 10. Testing

Smoke scripts (register each, or the suite fails):

- `smoke-email-sends.ts` with a fake provider:
  - enqueue → dispatch → sent, interactions written per matched contact, `last_interaction_at`
    bumped
  - undo before claim → canceled, no interaction; undo after claim → `already_sent`
  - lease lapse → re-claim by drain; stale result write matches nothing
  - transient backoff; exhaustion at 5 attempts
  - ambiguous timeout → retry → `findSent` hit → `sent` once; `findSent` unknown → `failed`,
    provider `send` called exactly once
  - `auth` → connection `needs_reauth`
  - cap counts across origins; canceled/failed don't count
  - recipient validation (CR/LF, > 20, dedupe)
- `smoke-email-origins.ts`: follow-up reminder cleared only on success; agent request status
  transitions; recruiter threading carried through.
- Source-parse guard: no 1:1 send path imports `sendOutreachMessage` / Resend.
- Extend `gmail-send` tests: CC/BCC, multipart/alternative, multipart/mixed, `Message-ID`.
- `smoke-purge.ts` fixture for `email_sends`.
- Manual live check (preview deploy, real account — **never the demo account**): send to self
  via Gmail; undo; failed-send alert. Repeated for Outlook in P3.

Local-dev caution: smoke scripts use `.env.local`'s `DATABASE_URL` if present — run
`email_sends` smokes against PGlite or a disposable Neon branch.

## 11. Rollout

- **P1 ships ungated.** The visible behavior change: follow-up emails now send from the
  user's mailbox and require a connected Gmail; users who relied on a Resend key see a
  Connect CTA. Call this out in the PR description.
- **P2** behind `action.compose` (coming soon) until acceptance.
- **P3–P5** each their own PR; no further DDL expected.

## Out of scope

- Outreach campaigns' sending (their own spec).
- Syncing replies into Orbit / an inbox view (overlaps Outreach v2 stages 3–4).
- Server-side draft storage, templates, mail merge, open/click tracking.

## Planning amendments (P1 plan)

Decided while writing `docs/superpowers/plans/2026-09-29-direct-email-p1-engine.md`:

1. **`idempotency_key` column** (nullable text) with a partial unique index on `(user_id, idempotency_key)` for active/ambiguous rows. Chat, agent and recruiter sends already have natural keys; this replaces chat's claim-row-before-send.
2. **Interaction `source` is per origin, not the origin name**, so existing readers keep working: `chat` → `"chat_send"` (read by `src/actions/chat.ts`), `agent` → `"mcp"`, `follow_up` → `"follow_up"`, `recruiter` → `"recruiter_send"`, `compose` → `"email_send"`.
3. **A `demo` provider**: demo workspaces (`isDemoWorkspace`) have no OAuth tokens; the demo provider marks sends sent without network, matching `sendRecruiterDrafts`'s existing demo short-circuit.
4. **`from_name` is captured at enqueue** from the calling action (Clerk profile needs a request; the drain has none).
5. **Contact-timeline pending items move to P2** (they belong with Compose). P1 ships the failed-send account alert only.
6. `email_sends` is purged in the **`contacts`** data category: deleting contacts must also stop their queued mail.
7. (Implementation) The recipients column is **`to_emails`** in SQL (`to` in Drizzle): `to` is reserved, and the schema-ddl guard does not parse quoted identifiers. Shipped as **schema v140** (pricing-v2 claimed 139).

## Planning amendments (P2 plan)

Decided while writing `docs/superpowers/plans/2026-09-30-direct-email-p2-compose.md`:

1. **Gate via a new `feature` surface kind.** `comingSoon` only worked on `page` surfaces (`COMING_SOON_KEYS` was built from pages). P2 adds `kind: "feature"`; a coming-soon feature lands in `hidden` for non-previewers, so the existing client hook (`useHiddenSurfaces`) and server guard (`requireUserForSurface`) both apply unchanged. `settings.email` is its companion. The surface key is `feature.compose`, not `action.compose`.
2. **Signature is plain text in P2.** The repo has no HTML sanitizer; adding one for a signature isn't worth the dependency. `email_signature_html` stays unused until rich signatures are asked for.
3. **"Default sending mailbox" is read-only in P2** ("Sending from me@…"). With only Gmail there is nothing to choose; P3 (Outlook) turns it into a picker.
4. **The signature applies to Compose only.** Chat and follow-up drafts are AI-written with their own sign-off.
5. **A Compose send clears a due follow-up** for every matched contact, the same as a Chat send.
6. **The AI draft is body-only** (`generateContactFollowUpDraft` returns no subject). An empty subject becomes `Following up` when the AI draft is inserted.
7. **The palette verb is typed:** `email maya` / `mail maya` turns People rows into "Email Maya" rows. No new row appears for ordinary searches.
