# Direct email P5 — reply in thread — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose can send an email as a reply in an existing conversation with the contact: a thread Orbit sent, a message the user BCC-logged to Orbit, or (dark, behind `feature.reply-inbox`) the latest message in their mailbox.

**Architecture:** A reply is an ordinary outbox row whose `in_reply_to_rfc_id` (and, for Gmail-in-the-same-mailbox, `provider_thread_id`) are set at enqueue. The engine already writes `In-Reply-To`/`References` and passes Gmail's `threadId`. P5 adds a reply-target resolver (`reply-targets.ts`) that the composer lists and the server re-resolves from an opaque key; an Outlook MIME `sendMail` path so Outlook replies carry real threading headers with `Mail.Send` only; mailbox lookups (`inbox-threads.ts`) that ship dark; and a "Reply in thread" picker in the composer.

**Tech Stack:** Next.js 16 server actions, Drizzle (Neon / PGlite), Gmail API, Microsoft Graph v1.0, tsx smoke scripts.

**Spec:** `docs/superpowers/specs/2026-09-29-direct-email-design.md` (§8 Reply in thread; P3 and P4 planning amendments). Stacked on P4 (PR #388) → #382 → #379 → #374.

## Global Constraints

- **No DDL.** Every column P5 uses exists since P1 (`provider_thread_id`, `in_reply_to_send_id`, `in_reply_to_rfc_id`). Do not bump `SCHEMA_VERSION`.
- **Outlook stays on `Mail.Send` only.** Never request `Mail.ReadWrite`. Mailbox *reads* use only scopes the user already granted for the recruiter scan (`gmail.readonly`, `Mail.Read`).
- **Mailbox lookups ship dark** behind a new coming-soon feature surface `feature.reply-inbox` (Jason, Sep 30 2026). Releasing it needs a `/privacy` mention → `TERMS_VERSION` bump — fold into the pricing-v2 legal update (#370) with `feature.outlook-send`.
- **The server never trusts client headers.** The client sends only a reply *key*; the server re-reads the target by owner and derives `In-Reply-To`, subject and thread id itself.
- **`userId` only from auth** (`requireUserForSurface(COMPOSE_SURFACE_KEY)`); the action user-scope smoke must pass.
- Header values go through `sanitizeHeader` (already inside `buildMime`).
- Toast/inline copy: no trailing periods (`smoke-toast-copy`).
- Every new smoke is registered in `scripts/run-smoke.ts` `MANIFEST` or the suite fails.
- Run the full suite as `npm test > log 2>&1; echo exit=$?` — never pipe through `tail`.
- A smoke that fails even alone: rerun on a fresh `ORBIT_PGLITE_DIR` before suspecting code.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/email/config.ts` (modify) | `MAX_ATTACHMENT_BYTES_OUTLOOK_REPLY`; `maxAttachmentBytesFor(provider, { reply })` |
| `src/lib/email/mime.ts` (modify) | `MimeInput.extraHeaders` (for `x-orbit-send-id`) |
| `src/lib/email/providers/outlook.ts` (modify) | MIME `sendMail` when `msg.inReplyTo` is set |
| `src/lib/email/attachments.ts` (modify) | `verifyAttachmentRefs(..., { reply })` |
| `src/lib/email/reply-targets.ts` (create) | `ReplyTarget`, `listReplyTargets`, `resolveReplyTarget`, `replySubject`, key format |
| `src/lib/email/inbox-threads.ts` (create) | Gmail/Graph latest-message lookup + by-id re-read (dark) |
| `src/lib/surfaces.ts` (modify) | `REPLY_INBOX_SURFACE_KEY = "feature.reply-inbox"` (coming-soon) |
| `src/lib/email/outbox.ts` (modify) | `EnqueueInput.inReplyToSendId` |
| `src/lib/email/compose.ts` (modify) | `ComposeContext.replyTargets`, `ComposeInput.replyTo`, retry keeps reply fields |
| `src/actions/email-compose.ts` (modify) | validate `replyTo` |
| `src/lib/compose-events.ts` (modify) | `ComposeRequest.replyTo` |
| `src/components/email/reply-picker.tsx` (create) | "Reply in thread" picker |
| `src/components/email/compose-dialog.tsx` (modify) | picker, locked `Re:` subject, send `replyTo` |
| `src/components/email/pending-sends.tsx` (modify) | Edit keeps the reply (`copy:<id>`) |
| `scripts/smoke-email-reply-targets.ts` (create, pglite) | sources, resolution, ownership, dark gate, inbox lookups |
| `scripts/smoke-email-provider-outlook.ts`, `smoke-email-mime.ts`, `smoke-email-compose.ts` (modify) | provider + compose checks |

---

### Task 1: Outlook replies as MIME, with threading headers

Graph's `POST /me/sendMail` accepts a base64 MIME body (`Content-Type: text/plain`) with `Mail.Send` only (v1.0 docs, checked Sep 30 2026). MIME is the only `sendMail` form that can set `In-Reply-To`/`References` — JSON `internetMessageHeaders` only accepts `x-` names. New (non-reply) messages keep the JSON path. The MIME body is base64 of a message whose attachments are already base64, and Graph caps a request at ~4 MB, so Outlook **replies** allow 2 MB of files (4 MB ÷ 1.37² ≈ 2.1 MB).

**Files:**
- Modify: `src/lib/email/config.ts:36-46`, `src/lib/email/mime.ts:55-95`, `src/lib/email/providers/outlook.ts:96-118`, `src/lib/email/attachments.ts:86-130`
- Modify: `docs/superpowers/specs/2026-09-29-direct-email-design.md` (append "Planning amendments (P5 plan)")
- Test: `scripts/smoke-email-provider-outlook.ts`, `scripts/smoke-email-mime.ts`, `scripts/smoke-email-attachments.ts`

**Interfaces:**
- Produces: `MAX_ATTACHMENT_BYTES_OUTLOOK_REPLY = 2 * 1024 * 1024`; `maxAttachmentBytesFor(provider, opts?: { reply?: boolean }): number`; `MimeInput.extraHeaders?: [name: string, value: string][]`; `verifyAttachmentRefs(userId, inputs, provider, opts?: { reply?: boolean })`.

- [ ] **Step 1: Failing checks.** In `smoke-email-provider-outlook.ts`, after the existing sendMail checks (the file mocks `globalThis.fetch` into `calls`):

```ts
console.log("replies go as MIME");
calls.length = 0;
await outlookProvider.send(USER, { ...MSG, inReplyTo: "<parent@x.org>", references: "<parent@x.org>" }, { sendId: "row-r" });
const mimeCall = calls.find((c) => c.url.endsWith("/me/sendMail"));
const mime = Buffer.from(mimeCall?.body ?? "", "base64").toString("utf8");
check("a reply posts base64 MIME", mimeCall !== undefined && !mimeCall.body.trim().startsWith("{"));
check("with In-Reply-To", /^In-Reply-To: <parent@x\.org>$/m.test(mime));
check("and References", /^References: <parent@x\.org>$/m.test(mime));
check("and the duplicate-check header", mime.includes(`\r\nx-orbit-send-id: ${MSG.messageId}\r\n`));
check("Bcc rides in the MIME headers", /^Bcc: /m.test(mime.split("\r\n\r\n")[0]!) === (MSG.bcc.length > 0));
calls.length = 0;
await outlookProvider.send(USER, MSG, { sendId: "row-n" });
check("a new message keeps JSON", (calls.find((c) => c.url.endsWith("/me/sendMail"))?.body ?? "").trim().startsWith("{"));
const big = { filename: "a.pdf", contentType: "application/pdf", bytes: new Uint8Array(2 * 1024 * 1024 + 1) };
const bigErr = await outlookProvider
  .send(USER, { ...MSG, inReplyTo: "<p@x>", references: "<p@x>", attachments: [big] }, { sendId: "row-b" })
  .then(() => null, (e) => e);
check("a reply over 2 MB of files is refused before any request", bigErr instanceof MailProviderError && bigErr.kind === "permanent");
```

The file's fetch mock (line ~30) records `url/method/body`; add `contentType: new Headers(init?.headers).get("content-type") ?? ""` to each recorded call and assert `mimeCall?.contentType === "text/plain"` for the reply. Pass the file's existing `OPTS` (not a literal) as the third argument if the `{ sendId }` shape above differs from it. In `smoke-email-mime.ts` add:

```ts
const withX = buildMime({ ...base, extraHeaders: [["x-orbit-send-id", "<a@b>"], ["x-evil", "v\r\nBcc: x@y"]] });
check("extra headers are written", /^x-orbit-send-id: <a@b>$/m.test(withX));
check("extra header values are sanitized", !/^Bcc: x@y/m.test(withX));
```

(`base` is the file's existing `MimeInput` at line ~13.) In `smoke-email-attachments.ts` (which has `MB` and `putFake`), import `maxAttachmentBytesFor` from `../src/lib/email/config` and add after the Outlook checks:

```ts
check("Outlook replies allow 2 MB", maxAttachmentBytesFor("outlook", { reply: true }) === 2 * MB && maxAttachmentBytesFor("gmail", { reply: true }) === 20 * MB);
putFake(`${mine}5/two.pdf`, 2 * MB + 1);
const replyTooBig = await verifyAttachmentRefs(USER, [{ pathname: `${mine}5/two.pdf`, filename: "two.pdf" }], "outlook", { reply: true });
check("an Outlook reply over 2 MB is refused", !replyTooBig.ok && replyTooBig.reason === "too_large");
check("the same file is fine for a new Outlook email", (await verifyAttachmentRefs(USER, [{ pathname: `${mine}5/two.pdf`, filename: "two.pdf" }], "outlook")).ok);
```

- [ ] **Step 2: Run to see them fail.** `npx tsx scripts/run-smoke.ts --only smoke-email-provider-outlook smoke-email-mime smoke-email-attachments` → FAIL.

- [ ] **Step 3: Implement.**

`config.ts`:

```ts
/** Outlook replies go as MIME, base64 twice over inside Graph's ~4 MB request (P5). */
export const MAX_ATTACHMENT_BYTES_OUTLOOK_REPLY = 2 * 1024 * 1024;

export function maxAttachmentBytesFor(provider: "gmail" | "outlook" | "demo", opts: { reply?: boolean } = {}): number {
  if (provider !== "outlook") return MAX_ATTACHMENT_BYTES_GMAIL;
  return opts.reply ? MAX_ATTACHMENT_BYTES_OUTLOOK_REPLY : MAX_ATTACHMENT_BYTES_OUTLOOK;
}
```

`mime.ts` — add to `MimeInput`: `/** Extra `x-` headers (Outlook's duplicate-check id). Values are sanitized. */ extraHeaders?: [string, string][];` and in `buildMime`, after the `References` line:

```ts
for (const [name, value] of input.extraHeaders ?? []) {
  if (/^x-[a-z0-9-]+$/i.test(name)) headers.push(`${name}: ${sanitizeHeader(value)}`);
}
```

`outlook.ts` — in `send`, after the size guard, branch before the JSON fetch:

```ts
const reply = Boolean(msg.inReplyTo);
const limit = reply ? MAX_ATTACHMENT_BYTES_OUTLOOK_REPLY : MAX_ATTACHMENT_BYTES_OUTLOOK;
if (attached > limit) throw new MailProviderError("permanent", "attachments over Outlook's sendMail limit");
const accessToken = await token(userId);
// A reply needs In-Reply-To/References, which only the MIME form of sendMail can carry
// (JSON internetMessageHeaders takes x- names only). Bcc rides in the headers; Exchange
// strips it on delivery like any MTA.
const request = reply
  ? {
      contentType: "text/plain",
      body: Buffer.from(
        withBccHeader(buildMime({ ...msg, extraHeaders: [[ORBIT_SEND_HEADER, msg.messageId]] }), msg.bcc),
        "utf8"
      ).toString("base64"),
    }
  : { contentType: "application/json", body: JSON.stringify(sendMailPayload(msg, msg.messageId)) };
```

then `fetch(`${GRAPH}/sendMail`, { method: "POST", headers: { Authorization: …, "Content-Type": request.contentType }, body: request.body, signal: AbortSignal.timeout(reply && msg.attachments?.length ? 60_000 : 20_000) })`. Replace the old single `attached > MAX_ATTACHMENT_BYTES_OUTLOOK` check with the `limit` one. Import `buildMime, withBccHeader` from `@/lib/email/mime` and the new constant. Update the file header comment: replies use MIME (`Mail.Send`, checked Sep 30 2026).

`attachments.ts` — `verifyAttachmentRefs(userId, inputs, provider, opts: { reply?: boolean } = {})` and use `maxAttachmentBytesFor(provider, opts)` for `cap`.

Spec: append

```md
## Planning amendments (P5 plan)

Decided while writing `docs/superpowers/plans/2026-09-30-direct-email-p5-reply-thread.md`:

1. **Outlook replies use MIME `sendMail`** (`Content-Type: text/plain`, base64) — still `Mail.Send` only. It is the only sendMail form that carries `In-Reply-To`/`References`; `x-orbit-send-id` is written as a MIME header. New messages keep JSON. Outlook reply attachments ≤ 2 MB (double base64 inside Graph's ~4 MB request).
2. **Reply sources:** threads Orbit sent (`email_sends`), messages BCC-logged to Orbit (`interactions.external_id = mail:<Message-ID>:<contactId>`), and — dark — the latest mailbox message via existing read scopes.
3. **Mailbox lookups ship dark** behind `feature.reply-inbox` (Jason, Sep 30 2026) until `/privacy` discloses the use (TERMS_VERSION bump, folded into #370). This replaces §8's "Gmail only after CASA": the gate is the user's granted read scope plus this surface, for both providers.
4. **The client sends a key, never headers.** Keys: `orbit:<sendId>`, `logged:<interactionId>`, `inbox:gmail:<messageId>`, `inbox:outlook:<graphId>`, and `copy:<sendId>` (reuse a queued/failed row's reply fields — Edit and Retry). The server re-reads each by owner.
5. **Subject is `Re: <original>`, fixed while replying** — Gmail only threads a `threadId` send whose subject matches.
6. **Gmail `threadId` only when the thread lives in the sending mailbox** (same provider and address); otherwise headers alone thread it for recipients.
7. **`References` = the parent's Message-ID only** (no chain column; no DDL). Recipients' clients thread on `In-Reply-To` + subject.
8. **Retry now keeps `In-Reply-To`** (P1's retry copied the thread id but dropped it).
```

- [ ] **Step 4: Run.** `npx tsx scripts/run-smoke.ts --only smoke-email-provider-outlook smoke-email-mime smoke-email-attachments && npx tsc --noEmit -p .` → PASS.

- [ ] **Step 5: Commit.** `git add -A src/lib/email scripts docs/superpowers/specs && git commit -m "feat(email): Outlook replies as MIME sendMail with threading headers"` (with the Co-Authored-By trailer).

---

### Task 2: Reply targets — threads Orbit sent and BCC-logged mail

**Files:**
- Create: `src/lib/email/reply-targets.ts`
- Create: `scripts/smoke-email-reply-targets.ts` (register `"smoke-email-reply-targets": "pglite"`)

**Interfaces:**
- Consumes: `emailSends`, `interactions` (schema), `mailExternalIdBase` format `mail:<Message-ID without brackets>` + `:<contactId>` suffix (`interactionExternalId`).
- Produces:

```ts
export type ReplySource = "orbit" | "logged" | "inbox";
export type ReplyTarget = {
  /** Opaque to the client: orbit:<sendId> | logged:<interactionId> | inbox:gmail:<id> | inbox:outlook:<id> */
  key: string;
  source: ReplySource;
  /** The original subject, without any Re: prefix. */
  subject: string;
  /** ISO time of the message replied to. */
  at: string;
};
export type ResolvedReply = {
  rfcMessageId: string;          // with angle brackets
  subject: string;               // original, no prefix
  inReplyToSendId: string | null;
  /** Where providerThreadId is valid: only a send from this exact mailbox may use it. */
  thread: { provider: "gmail" | "outlook"; email: string; threadId: string } | null;
};
export function replySubject(subject: string): string;
export function listReplyTargets(userId: string, contactId: string): Promise<ReplyTarget[]>;
export function resolveReplyTarget(userId: string, key: string): Promise<ResolvedReply | null>;
```

- [ ] **Step 1: Failing smoke.** `scripts/smoke-email-reply-targets.ts`:

```ts
/**
 * Reply targets: which conversations Compose can reply into, and how a key is re-resolved
 * server-side (owner-scoped). Run: npx tsx scripts/smoke-email-reply-targets.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { listReplyTargets, replySubject, resolveReplyTarget } from "../src/lib/email/reply-targets";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-reply-user";
const OTHER = "smoke-reply-other";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

async function main() {
  const db = await getDb();
  for (const u of [USER, OTHER]) await purgeUserData(u, { keepSettings: false }).catch(() => {});
  try {
    const [maya] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Maya Chen", email: "maya@work.org" }).returning();
    const [sam] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Sam Lee", email: "sam@work.org" }).returning();

    console.log("subjects");
    check("adds Re:", replySubject("Coffee?") === "Re: Coffee?");
    check("never doubles it", replySubject("RE: Coffee?") === "RE: Coffee?" && replySubject("re:x") === "re:x");
    check("empty stays readable", replySubject("") === "Re: (no subject)");

    console.log("nothing yet");
    check("no targets for a fresh contact", (await listReplyTargets(USER, maya!.id)).length === 0);

    console.log("threads Orbit sent");
    const insertSend = async (status: string, subject: string, sentDaysAgo: number, contactId: string, extra: Partial<typeof schema.emailSends.$inferInsert> = {}) => {
      const [row] = await db.insert(schema.emailSends).values({
        userId: USER, provider: "gmail", fromEmail: "me@acme-corp.io", to: ["maya@work.org"], subject, bodyText: "B",
        origin: "compose", status: status as never, sendAt: ago(sentDaysAgo), sentAt: status === "sent" ? ago(sentDaysAgo) : null,
        rfcMessageId: `<${subject.replace(/\W/g, "")}@orbit.mail>`, contactIds: [contactId], providerThreadId: "t-1", ...extra,
      }).returning();
      return row!;
    };
    const older = await insertSend("sent", "Older", 9, maya!.id);
    const newest = await insertSend("sent", "Coffee next week?", 2, maya!.id);
    await insertSend("canceled", "Never went", 1, maya!.id);
    await insertSend("sent", "For Sam", 1, sam!.id);
    const list = await listReplyTargets(USER, maya!.id);
    const orbit = list.filter((t) => t.source === "orbit");
    check("the newest sent thread is offered", orbit.length === 1 && orbit[0]!.key === `orbit:${newest.id}` && orbit[0]!.subject === "Coffee next week?", JSON.stringify(list));
    check("canceled sends are not", !list.some((t) => t.subject === "Never went"));
    check("other contacts' threads are not", !list.some((t) => t.subject === "For Sam"));
    const r = await resolveReplyTarget(USER, `orbit:${newest.id}`);
    check("resolves to its Message-ID and thread", r?.rfcMessageId === newest.rfcMessageId && r?.inReplyToSendId === newest.id && r?.thread?.threadId === "t-1" && r.thread.email === "me@acme-corp.io");
    check("an older thread still resolves by key", (await resolveReplyTarget(USER, `orbit:${older.id}`))?.subject === "Older");
    check("someone else's send does not", (await resolveReplyTarget(OTHER, `orbit:${newest.id}`)) === null);
    check("a Re: subject is stored without its prefix", (await resolveReplyTarget(USER, `orbit:${(await insertSend("sent", "Re: Lunch", 3, maya!.id)).id}`))?.subject === "Lunch");

    console.log("BCC-logged mail");
    const [logged] = await db.insert(schema.interactions).values({
      userId: USER, contactId: maya!.id, interactionType: "email", interactionDate: ago(1), source: "inbound_mail",
      externalId: `mail:CAB+x.y@mail.gmail.com:${maya!.id}`, aiSummary: "Intro: Maya <> Dev",
    }).returning();
    const withLogged = await listReplyTargets(USER, maya!.id);
    check("the latest logged email is offered, newest first", withLogged[0]?.key === `logged:${logged!.id}` && withLogged[0]?.source === "logged", JSON.stringify(withLogged));
    const lr = await resolveReplyTarget(USER, `logged:${logged!.id}`);
    check("its Message-ID comes from the external id, bracketed", lr?.rfcMessageId === "<CAB+x.y@mail.gmail.com>" && lr.thread === null && lr.subject === "Intro: Maya <> Dev", JSON.stringify(lr));
    check("another user cannot resolve it", (await resolveReplyTarget(OTHER, `logged:${logged!.id}`)) === null);

    console.log("copy");
    const failed = await insertSend("failed", "Retry me", 0, maya!.id, { inReplyToRfcId: "<parent@x>", inReplyToSendId: newest.id });
    const cr = await resolveReplyTarget(USER, `copy:${failed.id}`);
    check("copy reuses a row's reply fields", cr?.rfcMessageId === "<parent@x>" && cr.inReplyToSendId === newest.id && cr.subject === "Retry me");
    check("copy of a row that was not a reply is null", (await resolveReplyTarget(USER, `copy:${newest.id}`)) === null);

    console.log("junk keys");
    for (const k of ["", "orbit:not-a-uuid", "nope:1", "logged:", "inbox:gmail:x"]) {
      check(`"${k}" resolves to null`, (await resolveReplyTarget(USER, k)) === null);
    }
  } finally {
    for (const u of [USER, OTHER]) await purgeUserData(u, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll reply-target checks passed.");
}

run(main);
```

(`inbox:gmail:x` is null here because the dark surface is off by default in smokes — Task 3 turns it on with an override.) The inserts follow `smoke-email-compose.ts` (contacts: `userId, fullName, email`) and `smoke-contact-delete.ts` (interactions: `userId, contactId, interactionType`); `emailSends.to` is the Drizzle name of the `to_emails` column.

- [ ] **Step 2: Register and run** → FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/email/reply-targets.ts`.**

```ts
import { and, desc, eq, like, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { emailSends, interactions } from "@/db/schema";

/**
 * Which conversation a Compose send replies into (direct-email P5). The composer lists
 * targets; the send carries only the key, and the server re-reads it here by owner — the
 * client never supplies a Message-ID, subject or thread id.
 *
 *   orbit:<sendId>          a thread Orbit sent (email_sends, status sent)
 *   logged:<interactionId>  a message the user BCC-logged (external_id mail:<Message-ID>:<contactId>)
 *   inbox:<provider>:<id>   the latest mailbox message (dark: feature.reply-inbox, Task 3)
 *   copy:<sendId>           a queued/failed row's own reply fields (Edit, Retry)
 */
export type ReplySource = "orbit" | "logged" | "inbox";
export type ReplyTarget = { key: string; source: ReplySource; subject: string; at: string };
export type ResolvedReply = {
  rfcMessageId: string;
  subject: string;
  inReplyToSendId: string | null;
  thread: { provider: "gmail" | "outlook"; email: string; threadId: string } | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE = /^\s*(re|aw|sv)\s*:\s*/i;

export function stripReply(subject: string): string {
  let s = subject.trim();
  while (RE.test(s)) s = s.replace(RE, "");
  return s;
}

/** Gmail only threads a send whose subject matches, so the subject is fixed while replying. */
export function replySubject(subject: string): string {
  const s = subject.trim();
  if (!s) return "Re: (no subject)";
  return RE.test(s) ? s : `Re: ${s}`;
}

function bracket(id: string) {
  const bare = id.trim().replace(/^<|>$/g, "");
  return `<${bare}>`;
}

/** `mail:<Message-ID>:<contactId>` → the Message-ID (it may itself contain colons). */
function messageIdFromExternal(externalId: string, contactId: string): string | null {
  const suffix = `:${contactId}`;
  if (!externalId.startsWith("mail:") || !externalId.endsWith(suffix)) return null;
  const id = externalId.slice("mail:".length, -suffix.length);
  return id ? bracket(id) : null;
}

async function latestOrbitSend(userId: string, contactId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ id: emailSends.id, subject: emailSends.subject, sentAt: emailSends.sentAt })
    .from(emailSends)
    .where(
      and(
        eq(emailSends.userId, userId),
        eq(emailSends.status, "sent"),
        sql`${emailSends.contactIds} @> ${JSON.stringify([contactId])}::jsonb`
      )
    )
    .orderBy(desc(emailSends.sentAt))
    .limit(1);
  return row ?? null;
}

async function latestLogged(userId: string, contactId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ id: interactions.id, subject: interactions.aiSummary, at: interactions.interactionDate })
    .from(interactions)
    .where(
      and(
        eq(interactions.userId, userId),
        eq(interactions.contactId, contactId),
        eq(interactions.interactionType, "email"),
        like(interactions.externalId, "mail:%")
      )
    )
    .orderBy(desc(interactions.interactionDate))
    .limit(1);
  return row ?? null;
}

/** Newest first, at most one per source. */
export async function listReplyTargets(userId: string, contactId: string): Promise<ReplyTarget[]> {
  const [sent, logged] = await Promise.all([latestOrbitSend(userId, contactId), latestLogged(userId, contactId)]);
  const out: ReplyTarget[] = [];
  if (sent?.sentAt) out.push({ key: `orbit:${sent.id}`, source: "orbit", subject: stripReply(sent.subject), at: sent.sentAt.toISOString() });
  if (logged) out.push({ key: `logged:${logged.id}`, source: "logged", subject: stripReply(logged.subject ?? ""), at: logged.at.toISOString() });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export async function resolveReplyTarget(userId: string, key: string): Promise<ResolvedReply | null> {
  const [kind, ...rest] = String(key ?? "").split(":");
  const id = rest.join(":");
  const db = await getDb();
  if (kind === "orbit" && UUID.test(id)) {
    const row = await db.query.emailSends.findFirst({
      where: and(eq(emailSends.id, id), eq(emailSends.userId, userId), eq(emailSends.status, "sent")),
    });
    if (!row) return null;
    const threadId = row.providerThreadId;
    return {
      rfcMessageId: row.rfcMessageId,
      subject: stripReply(row.subject),
      inReplyToSendId: row.id,
      thread: threadId && (row.provider === "gmail" || row.provider === "outlook") ? { provider: row.provider, email: row.fromEmail, threadId } : null,
    };
  }
  if (kind === "logged" && UUID.test(id)) {
    const row = await db.query.interactions.findFirst({
      where: and(eq(interactions.id, id), eq(interactions.userId, userId), eq(interactions.interactionType, "email")),
    });
    const rfc = row?.externalId ? messageIdFromExternal(row.externalId, row.contactId) : null;
    if (!row || !rfc) return null;
    return { rfcMessageId: rfc, subject: stripReply(row.aiSummary ?? ""), inReplyToSendId: null, thread: null };
  }
  if (kind === "copy" && UUID.test(id)) {
    const row = await db.query.emailSends.findFirst({ where: and(eq(emailSends.id, id), eq(emailSends.userId, userId)) });
    if (!row?.inReplyToRfcId) return null;
    return {
      rfcMessageId: row.inReplyToRfcId,
      subject: stripReply(row.subject),
      inReplyToSendId: row.inReplyToSendId,
      thread: row.providerThreadId && row.provider === "gmail" ? { provider: "gmail", email: row.fromEmail, threadId: row.providerThreadId } : null,
    };
  }
  return null; // inbox:* — Task 3
}
```

Notes for the implementer: `emailSends.provider` may also be `"demo"`; the `thread` guard above keeps demo rows threadless. Keep `stripReply` exported (Task 4 uses it).

- [ ] **Step 4: Run** `npx tsx scripts/run-smoke.ts --only smoke-email-reply-targets && npx tsc --noEmit -p .` → PASS.

- [ ] **Step 5: Commit** `feat(email): reply targets for threads Orbit sent and BCC-logged mail`.

---

### Task 3: Mailbox lookups, dark behind `feature.reply-inbox`

**Files:**
- Modify: `src/lib/surfaces.ts` (FEATURES)
- Create: `src/lib/email/inbox-threads.ts`
- Modify: `src/lib/email/reply-targets.ts` (inbox source in list + resolve)
- Test: extend `scripts/smoke-email-reply-targets.ts`

**Interfaces:**
- Produces: `REPLY_INBOX_SURFACE_KEY = "feature.reply-inbox"`; `setReplyInboxOverride(v: boolean | null)` (smokes only); 

```ts
export type InboxMessage = { provider: "gmail" | "outlook"; id: string; subject: string; at: Date; rfcMessageId: string; threadId: string | null; mailbox: string };
export function latestInboxMessage(userId: string, provider: "gmail" | "outlook", addresses: string[]): Promise<InboxMessage | null>;
export function readInboxMessage(userId: string, provider: "gmail" | "outlook", id: string): Promise<InboxMessage | null>;
```

Both return null (never throw) when the connection is missing, inactive, lacks the read scope (`hasScope(scopes, GOOGLE_SCOPES.gmailRead)` / `hasMailScope(scopes)` from `@/lib/outlook`), the token fails, or the API errors.

- [ ] **Step 1: Failing checks** appended to `smoke-email-reply-targets.ts` (inside the `try`, before `junk keys`):

```ts
console.log("mailbox lookups (dark)");
// Gmail connection with read scope; fetch mocked.
await db.insert(schema.gmailConnections).values({
  userId: USER, emailAddress: "me@acme-corp.io", accessTokenEncrypted: encrypt("t"), refreshTokenEncrypted: encrypt("r"),
  tokenExpiresAt: new Date(Date.now() + 3_600_000), scopes: `${GOOGLE_SCOPES.gmailSend} ${GOOGLE_SCOPES.gmailRead}`, status: "active",
});
const seen: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  seen.push(url);
  if (url.includes("/messages?q=")) return Response.json({ messages: [{ id: "g-1", threadId: "gt-1" }] });
  if (url.includes("/messages/g-1")) {
    return Response.json({
      id: "g-1", threadId: "gt-1", internalDate: String(Date.now()),
      payload: { headers: [{ name: "Message-ID", value: "<inbox-1@mail.gmail.com>" }, { name: "Subject", value: "Re: Plans" }] },
    });
  }
  return new Response("nope", { status: 404 });
}) as typeof fetch;
try {
  const dark = await listReplyTargets(USER, maya!.id);
  check("dark: no mailbox call and no inbox target", !dark.some((t) => t.source === "inbox") && seen.length === 0);
  check("dark: an inbox key does not resolve", (await resolveReplyTarget(USER, "inbox:gmail:g-1")) === null);
  setReplyInboxOverride(true);
  const lit = await listReplyTargets(USER, maya!.id);
  const inbox = lit.find((t) => t.source === "inbox");
  check("released: the latest mailbox message is offered", inbox?.key === "inbox:gmail:g-1" && inbox.subject === "Plans", JSON.stringify(lit));
  check("the search is by the contact's address", seen.some((u) => decodeURIComponent(u).includes("from:maya@work.org OR to:maya@work.org")));
  const ir = await resolveReplyTarget(USER, "inbox:gmail:g-1");
  check("an inbox key re-reads the message", ir?.rfcMessageId === "<inbox-1@mail.gmail.com>" && ir.thread?.threadId === "gt-1" && ir.thread.email === "me@acme-corp.io");
  await db.update(schema.gmailConnections).set({ scopes: GOOGLE_SCOPES.gmailSend }).where(eq(schema.gmailConnections.userId, USER));
  seen.length = 0;
  check("without the read scope: nothing, and no call", !(await listReplyTargets(USER, maya!.id)).some((t) => t.source === "inbox") && seen.length === 0);
} finally {
  globalThis.fetch = realFetch;
  setReplyInboxOverride(null);
}
```

Add the matching Outlook block with `outlookConnections` (`scopes` including Mail.Read — use `MICROSOFT_SCOPES` from `@/lib/microsoft-scopes` exactly as `smoke-email-compose.ts` does), a mocked `GET /me/messages?$search=...` returning `{ value: [{ id: "o-1", subject: "Plans", internetMessageId: "<o1@outlook.com>", receivedDateTime: new Date().toISOString(), conversationId: "c-1" }] }` and `GET /me/messages/o-1?...` returning the same object; assert `inbox:outlook:o-1` resolves to `<o1@outlook.com>` with `thread === null` (Outlook threads by headers; Mail.Send can't target a conversation). Add imports: `import { eq } from "drizzle-orm";`, `import { encrypt } from "../src/lib/crypto";`, `import { GOOGLE_SCOPES } from "../src/lib/google-scopes";`, `import { MICROSOFT_SCOPES } from "../src/lib/microsoft-scopes";`, and `setReplyInboxOverride` from `../src/lib/email/reply-targets`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.**

`surfaces.ts` — add after `OUTLOOK_SEND_SURFACE_KEY`:

```ts
export const REPLY_INBOX_SURFACE_KEY = "feature.reply-inbox";
```

and a FEATURES entry:

```ts
  {
    key: REPLY_INBOX_SURFACE_KEY,
    kind: "feature",
    label: "Reply to inbox threads",
    description: "Compose can reply to the latest email with a contact found in your mailbox (Gmail read / Mail.Read).",
    // Until the privacy page discloses this use of the read scopes (direct-email P5).
    comingSoon: true,
  },
```

`inbox-threads.ts`:

```ts
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailConnections, outlookConnections } from "@/db/schema";
import { getValidAccessToken as gmailToken } from "@/lib/gmail";
import { GOOGLE_SCOPES, hasScope } from "@/lib/google-scopes";
import { getValidAccessToken as outlookToken, hasMailScope } from "@/lib/outlook";

/**
 * The newest message with a contact in the user's own mailbox, for Compose's "reply in thread"
 * (direct-email P5, dark behind feature.reply-inbox). Metadata only — Message-ID, subject,
 * date, thread — read on demand and never stored except as the reply's In-Reply-To. Uses only
 * read scopes the user already granted (the recruiter scan's). Never throws: any failure is
 * "no target".
 */
export type InboxMessage = {
  provider: "gmail" | "outlook";
  id: string;
  subject: string;
  at: Date;
  rfcMessageId: string;
  threadId: string | null;
  mailbox: string;
};

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH = "https://graph.microsoft.com/v1.0/me";
const EMAIL = /^[^\s@"<>]+@[^\s@"<>]+$/;

async function gmailAccess(userId: string) {
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { status: true, scopes: true, emailAddress: true },
  });
  if (!conn || conn.status !== "active" || !hasScope(conn.scopes, GOOGLE_SCOPES.gmailRead)) return null;
  const token = await gmailToken(userId).catch(() => null);
  return token ? { token, mailbox: conn.emailAddress.trim().toLowerCase() } : null;
}

async function outlookAccess(userId: string) {
  const db = await getDb();
  const conn = await db.query.outlookConnections.findFirst({
    where: eq(outlookConnections.userId, userId),
    columns: { status: true, scopes: true, emailAddress: true },
  });
  if (!conn || conn.status !== "active" || !hasMailScope(conn.scopes)) return null;
  const token = await outlookToken(userId).catch(() => null);
  return token ? { token, mailbox: conn.emailAddress.trim().toLowerCase() } : null;
}

async function getJson<T>(url: string, token: string): Promise<T | null> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!res || !res.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

type GmailMeta = { id: string; threadId?: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } };

function fromGmail(m: GmailMeta, mailbox: string): InboxMessage | null {
  const header = (n: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
  const rfc = header("message-id").trim();
  if (!rfc) return null;
  return {
    provider: "gmail",
    id: m.id,
    subject: header("subject"),
    at: new Date(Number(m.internalDate) || Date.now()),
    rfcMessageId: rfc.startsWith("<") ? rfc : `<${rfc}>`,
    threadId: m.threadId ?? null,
    mailbox,
  };
}

async function gmailById(token: string, mailbox: string, id: string) {
  const q = ["format=metadata", "metadataHeaders=Message-ID", "metadataHeaders=Subject"].join("&");
  const m = await getJson<GmailMeta>(`${GMAIL}/messages/${encodeURIComponent(id)}?${q}`, token);
  return m ? fromGmail(m, mailbox) : null;
}

type GraphMessage = { id: string; subject?: string; internetMessageId?: string; receivedDateTime?: string };
const GRAPH_SELECT = "$select=id,subject,internetMessageId,receivedDateTime";

function fromGraph(m: GraphMessage, mailbox: string): InboxMessage | null {
  if (!m.internetMessageId) return null;
  return {
    provider: "outlook",
    id: m.id,
    subject: m.subject ?? "",
    at: new Date(m.receivedDateTime ?? Date.now()),
    rfcMessageId: m.internetMessageId,
    // Mail.Send cannot target a conversation; Outlook replies thread by headers alone.
    threadId: null,
    mailbox,
  };
}

export async function latestInboxMessage(
  userId: string,
  provider: "gmail" | "outlook",
  addresses: string[]
): Promise<InboxMessage | null> {
  const emails = addresses.map((a) => a.trim().toLowerCase()).filter((a) => EMAIL.test(a)).slice(0, 3);
  if (!emails.length) return null;
  if (provider === "gmail") {
    const access = await gmailAccess(userId);
    if (!access) return null;
    const q = emails.map((e) => `from:${e} OR to:${e}`).join(" OR ");
    const list = await getJson<{ messages?: { id: string }[] }>(`${GMAIL}/messages?q=${encodeURIComponent(q)}&maxResults=1`, access.token);
    const first = list?.messages?.[0];
    return first ? gmailById(access.token, access.mailbox, first.id) : null;
  }
  const access = await outlookAccess(userId);
  if (!access) return null;
  // KQL `participants:` covers from/to/cc; $search results come newest first and can't take $orderby.
  const kql = emails.map((e) => `participants:${e}`).join(" OR ");
  const list = await getJson<{ value?: GraphMessage[] }>(
    `${GRAPH}/messages?$search=${encodeURIComponent(`"${kql}"`)}&$top=1&${GRAPH_SELECT}`,
    access.token
  );
  const first = list?.value?.[0];
  return first ? fromGraph(first, access.mailbox) : null;
}

export async function readInboxMessage(userId: string, provider: "gmail" | "outlook", id: string): Promise<InboxMessage | null> {
  if (!id || id.length > 512) return null;
  if (provider === "gmail") {
    const access = await gmailAccess(userId);
    return access ? gmailById(access.token, access.mailbox, id) : null;
  }
  const access = await outlookAccess(userId);
  if (!access) return null;
  const m = await getJson<GraphMessage>(`${GRAPH}/messages/${encodeURIComponent(id)}?${GRAPH_SELECT}`, access.token);
  return m ? fromGraph(m, access.mailbox) : null;
}
```

`reply-targets.ts` — add the gate and the inbox source:

```ts
import { isSurfaceLive } from "@/lib/surface-visibility";
import { REPLY_INBOX_SURFACE_KEY } from "@/lib/surfaces";
import { latestInboxMessage, readInboxMessage } from "@/lib/email/inbox-threads";
import { contacts, contactIdentities } from "@/db/schema";

let replyInboxOverride: boolean | null = null;
/** Smoke tests only. */
export function setReplyInboxOverride(v: boolean | null) {
  replyInboxOverride = v;
}
async function inboxLive(userId: string) {
  return replyInboxOverride ?? (await isSurfaceLive(userId, REPLY_INBOX_SURFACE_KEY));
}

async function contactAddresses(userId: string, contactId: string): Promise<string[]> {
  const db = await getDb();
  const [c] = await db.select({ email: contacts.email }).from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
  if (!c) return [];
  const ids = await db
    .select({ value: contactIdentities.value })
    .from(contactIdentities)
    .where(and(eq(contactIdentities.userId, userId), eq(contactIdentities.contactId, contactId), eq(contactIdentities.kind, "email")));
  return [...new Set([c.email, ...ids.map((i) => i.value)].filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase()))];
}
```

In `listReplyTargets`, when `await inboxLive(userId)`: read `contactAddresses`, then `Promise.all` over `["gmail", "outlook"]` of `latestInboxMessage` (each null-safe) and push the newest as `{ key: \`inbox:${m.provider}:${m.id}\`, source: "inbox", subject: stripReply(m.subject), at: m.at.toISOString() }` — at most one inbox target (the newer of the two). Skip it when its `rfcMessageId` equals an `orbit` target's Message-ID (the user's own Orbit send found in Sent). In `resolveReplyTarget`, before `return null`:

```ts
if (kind === "inbox" && (await inboxLive(userId))) {
  const [provider, ...rest2] = id.split(":");
  const msgId = rest2.join(":");
  if (provider !== "gmail" && provider !== "outlook") return null;
  const m = await readInboxMessage(userId, provider, msgId);
  if (!m) return null;
  return {
    rfcMessageId: m.rfcMessageId,
    subject: stripReply(m.subject),
    inReplyToSendId: null,
    thread: m.threadId ? { provider: m.provider, email: m.mailbox, threadId: m.threadId } : null,
  };
}
```

`isSurfaceLive(userId: string, surfaceKey: string): Promise<boolean>` is in `src/lib/surface-visibility.ts` (false for hidden and coming-soon keys).

- [ ] **Step 4: Run** `npx tsx scripts/run-smoke.ts --only smoke-email-reply-targets smoke-surface-visibility smoke-account-alerts && npx tsc --noEmit -p .` → PASS.

- [ ] **Step 5: Commit** `feat(email): mailbox reply targets, dark behind feature.reply-inbox`.

---

### Task 4: Replies through Compose and the outbox

**Files:**
- Modify: `src/lib/email/outbox.ts` (`EnqueueInput.inReplyToSendId`, insert)
- Modify: `src/lib/email/compose.ts` (`ComposeContext.replyTargets`, `ComposeInput.replyTo`, `sendComposed`, `retryFailedSend`, `PendingSend.replyKey`)
- Modify: `src/actions/email-compose.ts` (validate `replyTo`)
- Test: `scripts/smoke-email-compose.ts`

**Interfaces:**
- Consumes: `resolveReplyTarget`, `listReplyTargets`, `replySubject`, `ResolvedReply` (Task 2/3); `verifyAttachmentRefs(..., { reply })` (Task 1).
- Produces: `ComposeContext.replyTargets: ReplyTarget[]`; `ComposeInput.replyTo?: string`; `ComposeResult` refusal reason `"reply_gone"`; `PendingSend.replyKey: string | null` (= `copy:<id>` when the row is a reply).

- [ ] **Step 1: Failing checks** in `smoke-email-compose.ts`, a new section before `finally` (the file already has a Gmail connection for `USER`, `maya`, `resetBucket`, and a fake provider whose `send` pushes each message into `const sent: OutboundMessage[]` at line ~40. Add beside it `const sentOpts: ProviderSendOptions[] = [];` and push `opts` in the fake's `send(userId, msg, opts)`; import `ProviderSendOptions` from `../src/lib/email/providers/types`):

```ts
console.log("reply in thread");
await resetBucket();
const first = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "Coffee?", body: "Hi", contactId: maya!.id, fromName: null });
if (!first.ok) throw new Error("stop");
await db.execute(sql`UPDATE email_sends SET send_at = now() - interval '1 second' WHERE id = ${first.sendId}::uuid`);
await dispatchEmailSend(first.sendId);
const ctx = await getComposeContext(USER, maya!.id);
const target = ctx?.replyTargets.find((t) => t.source === "orbit");
check("the composer offers the thread it just sent", target?.subject === "Coffee?", JSON.stringify(ctx?.replyTargets));
await resetBucket();
const reply = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "ignored", body: "Following up", contactId: maya!.id, fromName: null, replyTo: target!.key });
check("a reply queues", reply.ok, JSON.stringify(reply));
if (!reply.ok) throw new Error("stop");
const [row] = await db.select().from(schema.emailSends).where(eq(schema.emailSends.id, reply.sendId));
const [parent] = await db.select().from(schema.emailSends).where(eq(schema.emailSends.id, first.sendId));
check("subject is Re: the original, not what was typed", row?.subject === "Re: Coffee?");
check("it points at the parent", row?.inReplyToRfcId === parent?.rfcMessageId && row?.inReplyToSendId === first.sendId);
check("same Gmail mailbox → the thread id rides along", row?.providerThreadId === parent?.providerThreadId && row?.providerThreadId !== null);
await db.execute(sql`UPDATE email_sends SET send_at = now() - interval '1 second' WHERE id = ${reply.sendId}::uuid`);
await dispatchEmailSend(reply.sendId);
check("the provider gets In-Reply-To", sent[sent.length - 1]?.inReplyTo === parent?.rfcMessageId);
check("and the thread id", sentOpts[sentOpts.length - 1]?.threadId === parent?.providerThreadId);

await resetBucket();
const gone = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "x", body: "y", contactId: maya!.id, fromName: null, replyTo: `orbit:${crypto.randomUUID()}` });
check("an unknown key is refused, not sent as new", !gone.ok && gone.reason === "reply_gone");

// Thread id only for the same mailbox: pretend the parent went from another address.
await db.update(schema.emailSends).set({ fromEmail: "old@acme-corp.io" }).where(eq(schema.emailSends.id, first.sendId));
await resetBucket();
const cross = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "", body: "z", contactId: maya!.id, fromName: null, replyTo: `orbit:${first.sendId}` });
const [crossRow] = cross.ok ? await db.select().from(schema.emailSends).where(eq(schema.emailSends.id, cross.sendId)) : [];
check("another mailbox's thread → headers only, no thread id", crossRow?.inReplyToRfcId === parent?.rfcMessageId && crossRow?.providerThreadId === null);

await db.execute(sql`UPDATE email_sends SET status = 'failed', failure_kind = 'permanent' WHERE id = ${reply.sendId}::uuid`);
await resetBucket();
const again = await retryFailedSend(USER, reply.sendId, null);
const [retryRow] = again.ok ? await db.select().from(schema.emailSends).where(eq(schema.emailSends.id, again.sendId)) : [];
check("retry keeps In-Reply-To and the parent", retryRow?.inReplyToRfcId === parent?.rfcMessageId && retryRow?.inReplyToSendId === first.sendId);
const pendingReply = (await listContactPendingSends(USER, maya!.id)).find((p) => again.ok && p.id === again.sendId);
check("a pending reply carries a copy key for Edit", pendingReply?.replyKey === `copy:${again.ok ? again.sendId : ""}`);
```

- [ ] **Step 2: Run** `npx tsx scripts/smoke-email-compose.ts` → FAIL.

- [ ] **Step 3: Implement.**

`outbox.ts` — `EnqueueInput`: `/** The Orbit send this replies to (P5), for the thread picker and retries. */ inReplyToSendId?: string | null;` and in the insert `inReplyToSendId: input.inReplyToSendId ?? null,`.

`compose.ts`:
- `ComposeContext`: `/** Conversations this can reply into, newest first (P5). Empty without a contact. */ replyTargets: ReplyTarget[];` — `getComposeContext` returns `replyTargets: []` when `!contactId`, else `await listReplyTargets(userId, contactId)` (start it in the existing `Promise.all` once the contact row is confirmed; it must not run for a contact that isn't the user's).
- `ComposeInput`: `/** A reply key from ComposeContext.replyTargets or a pending row's replyKey. */ replyTo?: string;`
- `ComposeResult` refusal union gets `"reply_gone"`; copy `const REPLY_GONE = "That conversation isn’t available any more — send it as a new email?";`
- In `sendComposed`, after the subject checks:

```ts
let reply: ResolvedReply | null = null;
if (input.replyTo) {
  reply = await resolveReplyTarget(userId, input.replyTo);
  if (!reply) return { ok: false, reason: "reply_gone", message: REPLY_GONE };
}
```

  Resolve the sender once (move the existing `resolveSender` call out of the attachments branch so it runs when `input.attachments?.length || reply`), pass `{ reply: Boolean(reply) }` to `verifyAttachmentRefs`, and enqueue with:

```ts
subject: reply ? replySubject(reply.subject) : subject,
inReplyToRfcId: reply?.rfcMessageId ?? null,
inReplyToSendId: reply?.inReplyToSendId ?? null,
// Gmail threads a send only inside the mailbox that holds the thread.
threadId:
  reply?.thread && sender?.ok && reply.thread.provider === sender.provider && reply.thread.email === sender.fromEmail
    ? reply.thread.threadId
    : null,
```

  Note: `enqueueEmail` resolves the sender again from `input.provider`; pass `provider: input.provider ?? (sender?.ok ? (sender.provider === "demo" ? undefined : sender.provider) : undefined)` only if that is already how P4 passes it — otherwise leave `provider: input.provider` (both resolutions read the same settings, so they agree).
- `retryFailedSend`: add `inReplyToRfcId: old.inReplyToRfcId, inReplyToSendId: old.inReplyToSendId,` to the enqueue.
- `PendingSend`: `/** Edit keeps the reply: resolves to this row's own reply fields. */ replyKey: string | null;` mapped as `r.inReplyToRfcId ? \`copy:${r.id}\` : null`.
- Import `listReplyTargets, replySubject, resolveReplyTarget, type ReplyTarget, type ResolvedReply` from `@/lib/email/reply-targets`.

`actions/email-compose.ts` — in `sendComposedEmail`: `replyTo: typeof input?.replyTo === "string" && input.replyTo.length <= 600 ? input.replyTo : undefined,`.

- [ ] **Step 4: Run** `npx tsx scripts/run-smoke.ts --only smoke-email-compose smoke-email-sends smoke-email-origins smoke-chat-send smoke-agent-sends smoke-action-user-scope smoke-toast-copy smoke-email-reply-targets && npx tsc --noEmit -p .` → PASS.

- [ ] **Step 5: Commit** `feat(email): Compose replies in thread; retry keeps In-Reply-To`.

---

### Task 5: Compose UI — the reply picker

**Files:**
- Create: `src/components/email/reply-picker.tsx`
- Modify: `src/components/email/compose-dialog.tsx`, `src/lib/compose-events.ts`, `src/components/email/pending-sends.tsx`

**Interfaces:**
- Consumes: `ComposeContext.replyTargets`, `PendingSend.replyKey`, `replySubject` (client-safe? — `reply-targets.ts` imports `@/db`, so **do not** import it in client code; duplicate the two-line `Re:` rule in the picker, or move `replySubject`/`stripReply` into a tiny pure `src/lib/email/reply-subject.ts` and re-export from `reply-targets.ts` — prefer the latter, per [[orbit-client-bundle-db-import]]).
- Produces: `ComposeRequest.replyTo?: string`.

- [ ] **Step 1: Move the pure helpers.** Create `src/lib/email/reply-subject.ts` containing `stripReply` and `replySubject` (and the `RE` regex) from Task 2; in `reply-targets.ts` replace them with `export { replySubject, stripReply } from "@/lib/email/reply-subject";` plus an import for internal use. Run `npx tsx scripts/smoke-email-reply-targets.ts` → still PASS.

- [ ] **Step 2: `ComposeRequest`** — add `/** Reply into this conversation (a reply key). */ replyTo?: string;`.

- [ ] **Step 3: `reply-picker.tsx`:**

```tsx
"use client";

import { CornerUpLeft, X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ReplyTarget } from "@/lib/email/reply-targets";
import { replySubject } from "@/lib/email/reply-subject";

const NEW = "new";
const SOURCE: Record<ReplyTarget["source"], string> = { orbit: "sent from Orbit", logged: "logged", inbox: "from your inbox" };

function when(iso: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso));
}

/**
 * New email, or a reply in one of the contact's recent conversations. Off by default: a new
 * topic shouldn't land in an old thread unless the person chooses it.
 */
export function ReplyPicker({
  targets,
  value,
  onChange,
  disabled,
}: {
  targets: ReplyTarget[];
  value: string | null;
  onChange: (key: string | null) => void;
  disabled?: boolean;
}) {
  if (!targets.length) return null;
  const items = [
    { value: NEW, label: "New email" },
    ...targets.map((t) => ({ value: t.key, label: `Reply to “${replySubject(t.subject)}” · ${when(t.at)} · ${SOURCE[t.source]}` })),
  ];
  return (
    <div className="flex min-h-9 items-center gap-2 border-b border-border/60 py-1">
      <CornerUpLeft className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <Select value={value ?? NEW} onValueChange={(v) => onChange(v === NEW || typeof v !== "string" ? null : v)} items={items} disabled={disabled}>
        <SelectTrigger aria-label="Reply in thread" className="h-8 min-w-0 flex-1 border-0 px-0 shadow-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} className="p-1">
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value} className="py-1.5 pl-2">
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value && (
        <button type="button" aria-label="Send as a new email" className="rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => onChange(null)} disabled={disabled}>
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire the dialog.** In `compose-dialog.tsx`:
  - `const [replyTo, setReplyTo] = useState<string | null>(request.replyTo ?? null);`
  - Render `<ReplyPicker targets={ready?.replyTargets ?? []} value={replyTo} onChange={setReplyTo} disabled={sending} />` directly under the recipients (after the Cc/Bcc fields, before Subject).
  - `const replyingTo = ready?.replyTargets.find((t) => t.key === replyTo) ?? null;` When `replyTo` is set: render the subject as read-only text (`<p aria-label="Subject" className="border-b border-border/60 py-2">{replySubject(replyingTo?.subject ?? subject)}</p>`) instead of the `<Input>`, since the server fixes it anyway. A `copy:` key (from Edit) has no entry in `replyTargets`; show the handed-in `request.subject` read-only then.
  - Pass `replyTo: replyTo ?? undefined` to `sendComposedEmail`.
  - On `res.ok === false && res.reason === "reply_gone"`: `setReplyTo(null)` and show `res.message` in `problem`.
  - Draft persistence stays as-is (a reply key is not saved in the local draft — reopening starts as a new email).
- [ ] **Step 5: Pending Edit keeps the reply.** In `pending-sends.tsx`, the `reopen` helper passes `replyTo: s.replyKey ?? undefined`.
- [ ] **Step 6: Typecheck, lint, smokes.** `npx tsc --noEmit -p . && npx eslint src/components/email src/lib/email && npx tsx scripts/run-smoke.ts --only smoke-email-compose smoke-email-reply-targets smoke-behavior-golden smoke-action-user-scope` → PASS.
- [ ] **Step 7: Commit** `feat(email): reply-in-thread picker in Compose`.

---

### Task 6: Verification

- [ ] **Step 1: Full suite and build** (no dev server on this `.next`):

```bash
npm run test:check
npm test > "$SCRATCH/p5-smoke.log" 2>&1; echo "exit=$?"; grep "passed in" "$SCRATCH/p5-smoke.log"
npx tsc --noEmit -p .
npm run lint
rm -rf .next && npm run build
```

Line-number allowlists (`smoke-provider-exhaustive`) may shift — renumber, never change reasons.

- [ ] **Step 2: Browser pass** (`rm -rf .next`, start `orbit-web`). Temporarily, and restore both before committing (mark each line `// TEMP-P5-BROWSER-PASS`, finish with `grep -rn TEMP-P5 src` = 0):
  - `feature.compose` → `comingSoon: false`;
  - `demoWorkspaceEmail` returns `"demo@orbit.test"` in development (the demo mailbox sends nothing).
  Then, on a contact whose email is changed locally to a non-placeholder address (restore it afterwards):
  1. Send a new email; after the undo window, open Compose again → "Reply to “Re: …” · sent from Orbit" is offered; the default is "New email".
  2. Choose it: Subject becomes read-only `Re: …`; send; the pending card shows it; Edit reopens with the reply still selected and the subject locked.
  3. Clear the reply with ×: the Subject input returns.
  4. Phone width (375px): picker and locked subject fit, no horizontal scroll.
  5. The inbox option never appears (dark), and no network call to Gmail/Graph is made (`read_network_requests`).
- [ ] **Step 3: Manual acceptance on a preview (owed by Jason):**
  - Gmail: reply to a thread Orbit sent → lands in the same Gmail thread for sender and recipient.
  - Outlook: reply (MIME sendMail) → recipient sees it threaded; the Sent Items copy groups with the original; Bcc is not visible to To/Cc recipients.
  - BCC-logged message → reply threads for the recipient.
  - With `feature.reply-inbox` previewed (cookie): the inbox target appears for an account with `gmail.readonly` / `Mail.Read`, and not for one without.

## PR notes

- Stacked on #388 (P4) → #382 → #379 → #374. Still behind `feature.compose`.
- No schema change.
- Outlook replies switch to MIME `sendMail` (still `Mail.Send` only); Outlook reply attachments ≤ 2 MB.
- New dark surface `feature.reply-inbox`: mailbox lookups reuse the recruiter scan's read scopes; releasing it needs the `/privacy` mention → `TERMS_VERSION` bump (fold into #370 with `feature.outlook-send`).
- Fix: retries now keep `In-Reply-To` (P1 dropped it; affected retried recruiter replies).
