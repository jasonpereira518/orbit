# Direct Email P3 — Outlook Sending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let people send Orbit email from their own Outlook / Microsoft 365 mailbox, alongside Gmail — follow-ups, Chat, approved agent drafts and Compose — asking Microsoft only for **`Mail.Send`**.

**Architecture:** A second `MailProvider` (`src/lib/email/providers/outlook.ts`) sends with Graph `POST /me/sendMail` (202, no body, no ids). Every outbound message carries an `X-Orbit-Send-Id` internet header equal to the outbox row's `rfc_message_id`, so a retry can look for it in Sent Items — only possible when the user has also granted `Mail.Read` (the recruiter-scan permission); without it an unsure send is marked "may have sent", exactly like Gmail without read access. Sender resolution learns to choose between two mailboxes (`user_settings.default_send_provider`, then Gmail); Compose and Settings get a mailbox picker. Outlook sending ships behind a coming-soon `feature.outlook-send` surface until the privacy page discloses `Mail.Send`.

**Tech Stack:** Next.js server actions, Drizzle, Microsoft Graph v1.0, tsx smokes.

**Spec:** `docs/superpowers/specs/2026-09-29-direct-email-design.md` §2 (provider interface) and §6 (Outlook). Read the "Planning amendments" sections at the end — this plan adds more.

## Global Constraints

- **Branch:** cut `claude/direct-email-p3-outlook` from P2's HEAD (`claude/direct-email-p2-compose`, PR #379, itself stacked on #374). Open the PR against the P2 branch; retarget as the stack merges.
- **Permission: `Mail.Send` only** (Jason's decision, Sep 30 2026). Never request `Mail.ReadWrite`. Never call `POST /me/messages` (draft creation needs `Mail.ReadWrite`).
- **No schema change.** `default_send_provider` and `email_sends.provider` already exist.
- Gate: surface key **`feature.outlook-send`**, `comingSoon: true`, `kind: "feature"`. While it's hidden for a user, Outlook is invisible to sender resolution and no UI offers "Connect Outlook" for sending.
- The privacy page is **not** edited in Tasks 1–7. Task 8 is gated on Jason's decision (it forces a `TERMS_VERSION` bump = re-consent for every user).
- Provider errors never reach users verbatim; copy comes from `ENQUEUE_COPY` / origin hooks / `friendlyError`. Toast copy: no trailing periods.
- `graphFetchWithRetry` (`src/lib/graph-fetch.ts`) retries 429/503/504 internally — **do not use it for `sendMail`** (a retried non-idempotent POST can double-send). Use it for read-only calls in `findSent`.
- Every new smoke registered in `scripts/run-smoke.ts` `MANIFEST`; `pglite` ones import `./smoke/_env` first.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- AGENTS.md: check `node_modules/next/dist/docs/` before using a Next API not already in the repo.

## Decisions (record in the spec in Task 1)

1. **`Mail.Send` + `/me/sendMail`, not create-draft-then-send.** Creating a draft requires `Mail.ReadWrite` ("read, update, create and delete your mail"); `Mail.Send` keeps Outlook's ask as narrow as Gmail's `gmail.send`. Consequence: Graph returns no message or thread id — `SendResult.providerMessageId` becomes nullable, and Outlook sends store none.
2. **Duplicate check by custom header.** Each message carries `X-Orbit-Send-Id: <rfc_message_id>`. `findSent` searches Sent Items (by subject, since the first attempt) and matches that header — only with `Mail.Read`; otherwise `"unknown"`.
3. **Status classification for sendMail:** 401/403 → auth; 400/413/other 4xx → permanent; **429 and 503 → transient** (explicit throttling / unavailable: not processed); **other 5xx and network errors → ambiguous** (a gateway timeout may have been accepted).
4. **Choosing a mailbox:** an explicit per-send choice (Compose's From picker) → `user_settings.default_send_provider` → the only sendable mailbox → Gmail. A blocked result names which provider to fix.
5. **Recruiter sends stay on Gmail** (their threads are Gmail threads). They pass `provider: "gmail"` explicitly.
6. **Chat's send dialog shows the resolved mailbox,** not Gmail's identity.
7. **Outlook sending ships dark** behind `feature.outlook-send` until the privacy page is updated (Task 8).
8. **Copy becomes mailbox-neutral** ("Connect your email", "Allow Orbit to send from your email").

## File Structure

| File | Change |
|---|---|
| `src/lib/microsoft-scopes.ts` | `MICROSOFT_SCOPES.mailSend`, `send` purpose |
| `src/lib/outlook.ts` | `hasSendScope`, exported `markOutlookNeedsReauth` |
| `src/actions/outlook.ts`, `src/lib/demo-workspace-connections.ts` | `canSend` on `OutlookConnectionStatus` |
| `src/lib/surfaces.ts` | `feature.outlook-send` (coming-soon) |
| `src/lib/email/providers/types.ts` | nullable `providerMessageId`; `FindSentRef`; `ProviderSendOptions.sendId` |
| `src/lib/email/providers/gmail.ts`, `demo.ts` | adapt to the interface |
| `src/lib/email/providers/outlook.ts` | **new** Outlook provider |
| `src/lib/email/providers/index.ts` | register Outlook |
| `src/lib/email/sender.ts` | two-mailbox resolution, `SendCapability.mailboxes`, `outlookConfigured` |
| `src/lib/email/outbox.ts` | `provider` override on enqueue; pass `FindSentRef`; Outlook reauth marking; neutral copy |
| `src/lib/email/settings.ts`, `src/actions/settings.ts` | `saveDefaultSendProvider` |
| `src/components/email/connect-mailbox-button.tsx` | provider-aware, offers both when not connected |
| `src/components/email/compose-dialog.tsx`, `src/lib/email/compose.ts`, `src/actions/email-compose.ts` | From picker, `provider` passthrough |
| `src/components/settings/email-settings.tsx` | default mailbox picker |
| `src/actions/chat-send.ts`, `src/components/chat/gmail-send-dialog.tsx` | resolved mailbox instead of Gmail identity |
| `src/components/follow-up/follow-up-draft-composer.tsx` | neutral hint |
| `src/actions/recruiter-messages.ts` | `provider: "gmail"` |
| Smokes: `smoke-microsoft-scopes` (update), `smoke-email-provider-outlook` (new), `smoke-email-sender` (new), `smoke-email-sends`, `smoke-email-provider-gmail`, `smoke-chat-send` (updates) | |

---

### Task 1: Microsoft `Mail.Send` scope and the `send` purpose

**Files:**
- Modify: `src/lib/microsoft-scopes.ts`, `src/lib/outlook.ts`, `src/actions/outlook.ts` (`OutlookConnectionStatus` ~43, `getOutlookConnectionStatus` ~69), `src/lib/demo-workspace-connections.ts` (~47)
- Modify: `src/lib/surfaces.ts` (add `feature.outlook-send`)
- Modify: `scripts/smoke-microsoft-scopes.ts`, `scripts/smoke-surface-visibility.ts`
- Modify: spec (append `## Planning amendments (P3 plan)` with Decisions 1–8)

**Interfaces:**
- Produces: `MICROSOFT_SCOPES.mailSend = "https://graph.microsoft.com/Mail.Send"`; `"send"` in `MICROSOFT_PURPOSES`; `hasSendScope(scopes)` in `src/lib/outlook.ts`; `markOutlookNeedsReauth(userId)` exported from `src/lib/outlook.ts`; `OutlookConnectionStatus.canSend: boolean`; `OUTLOOK_SEND_SURFACE_KEY = "feature.outlook-send"` exported from `src/lib/surfaces.ts`.

- [ ] **Step 1: Update `scripts/smoke-microsoft-scopes.ts` (failing).** Replace the "no scope is a write scope" check (:59) with:

```ts
check(
  "the only write scope is Mail.Send, and it is asked for only by the send purpose",
  Object.values(MICROSOFT_SCOPES).filter((s) => /write|send|readwrite/i.test(s)).join() === MICROSOFT_SCOPES.mailSend &&
    MICROSOFT_PURPOSES.filter((p) => requiredScopeFor(p) === MICROSOFT_SCOPES.mailSend).join() === "send"
);
check("never Mail.ReadWrite", !Object.values(MICROSOFT_SCOPES).some((s) => /readwrite/i.test(s)));
```

Replace `!isMicrosoftPurpose("send")` (:73) with `isMicrosoftPurpose("send")`. Add:

```ts
check("send asks for Mail.Send plus identity", JSON.stringify(microsoftScopesFor(["send"])) === JSON.stringify([...IDENTITY_FOR_TEST, MICROSOFT_SCOPES.mailSend]));
check("Connect still never asks to send", !microsoftScopesFor(MICROSOFT_CONNECT_PURPOSES).includes(MICROSOFT_SCOPES.mailSend));
check("the send copy names sending", /send/i.test(missingScopeMessage("send")));
```

(`IDENTITY_FOR_TEST`: build it the way the file's existing per-purpose loop (:48-52) computes the identity prefix; reuse that expression rather than a new constant.) Keep the per-purpose loop — `send` also asks for identity + exactly one scope.

In `scripts/smoke-surface-visibility.ts` `registryChecks()` add `check("outlook send ships coming-soon", COMING_SOON_KEYS.has(OUTLOOK_SEND_SURFACE_KEY) && getSurface(OUTLOOK_SEND_SURFACE_KEY)?.kind === "feature");`.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx scripts/smoke-microsoft-scopes.ts; npx tsx scripts/smoke-surface-visibility.ts`
Expected: FAIL (no `mailSend`, `send` not a purpose, no surface key).

- [ ] **Step 3: Implement.**

`src/lib/microsoft-scopes.ts`:

```ts
  mail: `${GRAPH_PREFIX}Mail.Read`,
  /**
   * Send mail as the user — the only write permission Orbit asks Microsoft for, and only when
   * the person chooses to send from Outlook. Deliberately NOT Mail.ReadWrite: sending needs no
   * access to what is already in the mailbox.
   */
  mailSend: `${GRAPH_PREFIX}Mail.Send`,
```

`MICROSOFT_PURPOSES = ["contacts", "calendar", "recruiter_scan", "send"] as const;` and `PURPOSE_SCOPE.send = MICROSOFT_SCOPES.mailSend`. Add a `hasSendScope` helper beside `hasMailScope` (`hasScope(scopes, MICROSOFT_SCOPES.mailSend)`), and a `case "send": return "Microsoft didn’t grant permission to send — reconnect and allow it";` in `missingScopeMessage`. `MICROSOFT_CONNECT_PURPOSES` stays `["contacts", "calendar"]`.

`src/lib/outlook.ts`: add `export function hasSendScope(scopes: string | null | undefined) { return hasMicrosoftSendScope(scopes); }` next to `hasMailScope` (import the helper under that alias), and rename the private `markNeedsReauth` to an exported `markOutlookNeedsReauth` (update its two call sites).

`src/actions/outlook.ts`: add `canSend: boolean` to `OutlookConnectionStatus` = `connected && hasSendScope(conn.scopes)`; set `canSend: true` in `demoOutlookConnectionStatus`.

`src/lib/surfaces.ts` — append to `FEATURES`:

```ts
  {
    key: OUTLOOK_SEND_SURFACE_KEY,
    kind: "feature",
    label: "Send from Outlook",
    description: "Send Orbit email from a connected Outlook or Microsoft 365 mailbox (Mail.Send).",
    comingSoon: true,
  },
```

with `export const OUTLOOK_SEND_SURFACE_KEY = "feature.outlook-send";` beside `COMPOSE_SURFACE_KEY`.

Grep for exhaustive uses of `MicrosoftPurpose` (`grep -rn "MicrosoftPurpose\|MICROSOFT_PURPOSES" src scripts`) — e.g. an OAuth-reason copy map or a `describeOAuthReason` switch — and add the `send` case where TypeScript requires it.

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit -p . && npx tsx scripts/run-smoke.ts --only smoke-microsoft-scopes smoke-outlook-scope-storage smoke-surface-visibility smoke-integrations-copy`
Expected: PASS (skip names that don't exist; `ls scripts | grep -i "outlook\|microsoft\|oauth"` for the relevant set).

- [ ] **Step 5: Record decisions in the spec** (`## Planning amendments (P3 plan)`, Decisions 1–8 verbatim).

- [ ] **Step 6: Commit**

```bash
git add src/lib/microsoft-scopes.ts src/lib/outlook.ts src/actions/outlook.ts src/lib/demo-workspace-connections.ts src/lib/surfaces.ts scripts/smoke-microsoft-scopes.ts scripts/smoke-surface-visibility.ts docs/superpowers/specs/2026-09-29-direct-email-design.md
git commit -m "feat(outlook): Mail.Send scope and send purpose, behind a coming-soon feature

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Provider interface — nullable ids and a richer `findSent`

**Files:**
- Modify: `src/lib/email/providers/types.ts`, `providers/gmail.ts`, `providers/demo.ts`, `src/lib/email/outbox.ts` (dispatch ~224-264)
- Modify: `scripts/smoke-email-provider-gmail.ts`, `scripts/smoke-email-sends.ts` (fake provider signatures)

**Interfaces:**
- Produces:
  - `SendResult = { providerMessageId: string | null; providerThreadId: string | null }`
  - `FindSentRef = { rfcMessageId: string; subject: string; since: Date }`
  - `ProviderSendOptions = { threadId?: string | null; sendId: string }` (the outbox row id, for Outlook's header)
  - `MailProvider.send(userId, msg, opts: ProviderSendOptions)`; `MailProvider.findSent(userId, ref: FindSentRef)`

- [ ] **Step 1: Change the types** in `src/lib/email/providers/types.ts`:

```ts
export type SendResult = { providerMessageId: string | null; providerThreadId: string | null };

/** What a provider can use to find an earlier attempt in Sent. */
export type FindSentRef = {
  /** The row's fixed RFC Message-ID (Gmail searches it; Outlook sends it as X-Orbit-Send-Id). */
  rfcMessageId: string;
  subject: string;
  /** No earlier than the row's creation, so a search can be bounded. */
  since: Date;
};

export type ProviderSendOptions = { threadId?: string | null; sendId: string };

export interface MailProvider {
  id: EmailProviderId;
  identity(userId: string): Promise<{ email: string } | null>;
  send(userId: string, msg: OutboundMessage, opts: ProviderSendOptions): Promise<SendResult>;
  findSent(userId: string, ref: FindSentRef): Promise<SendResult | null | "unknown">;
}
```

- [ ] **Step 2: Adapt callers.** `gmail.ts`: `send(userId, msg, opts)` unchanged in behavior (reads `opts.threadId`); `findSent(userId, ref)` uses `ref.rfcMessageId`. `demo.ts`: signatures only. `outbox.ts` dispatch:

```ts
    const prior = await provider
      .findSent(send.userId, { rfcMessageId: send.rfcMessageId, subject: send.subject, since: send.createdAt })
      .catch(() => "unknown" as const);
```

and `provider.send(..., { threadId: send.providerThreadId, sendId: send.id })`. `settleSent` already writes `result.providerMessageId` (nullable column) — keep `providerThreadId: result.providerThreadId ?? send.providerThreadId`.

Update the fake providers in `smoke-email-sends.ts`, `smoke-email-origins.ts`, `smoke-email-compose.ts`, `smoke-agent-sends.ts` to the new signatures (`findSent(_u, _ref)`), and `smoke-email-provider-gmail.ts`'s `findSent` calls to pass `{ rfcMessageId: "<found@x>", subject: "Hi", since: new Date(0) }`.

Run `npx tsc --noEmit -p .` and fix every consumer of `providerMessageId` that assumed a string (the recruiter hook's `gmailMessageId: send.providerMessageId` and the agent hook's `deliveryId: send.providerMessageId ?? undefined` already accept null — confirm).

- [ ] **Step 3: Run tests**

Run: `npx tsx scripts/run-smoke.ts --only smoke-email-sends smoke-email-origins smoke-email-compose smoke-agent-sends smoke-email-provider-gmail smoke-chat-send`
Expected: PASS (behavior unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/lib/email scripts/smoke-email-*.ts scripts/smoke-agent-sends.ts scripts/smoke-chat-send.ts
git commit -m "refactor(email): nullable provider ids and a findSent reference for providers without them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The Outlook provider

**Files:**
- Create: `src/lib/email/providers/outlook.ts`
- Modify: `src/lib/email/providers/index.ts`, `src/lib/email/outbox.ts` (`settleFailed` auth branch ~330)
- Test: `scripts/smoke-email-provider-outlook.ts` (tier `pglite`)

**Interfaces:**
- Consumes: `getValidAccessToken` (Outlook, `src/lib/outlook.ts:384`), `hasSendScope`, `hasMailScope`, `markOutlookNeedsReauth`, `graphFetchWithRetry`, `outlookConnections`.
- Produces: `outlookProvider: MailProvider` (`id: "outlook"`); `ORBIT_SEND_HEADER = "X-Orbit-Send-Id"`; `sendMailPayload(msg: OutboundMessage, sendHeader: string)` exported for tests.

**Graph facts to confirm first** (read the current Graph v1.0 reference pages for `user: sendMail`, `message` resource `internetMessageHeaders`, and `List messages` in a mail folder; write anything that differs into the file's header comment and adjust):
- `POST https://graph.microsoft.com/v1.0/me/sendMail` with `{ message, saveToSentItems: true }` → `202 Accepted`, empty body. Requires `Mail.Send`.
- `message.internetMessageHeaders`: array of `{ name, value }`; names must start with `X-` / `x-`; at most 5; only settable on create/send.
- `GET /me/mailFolders/sentitems/messages?$filter=...&$select=...` requires `Mail.Read`; `internetMessageHeaders` is returned only when `$select`ed.
- `bccRecipients` is a first-class field (no header trick, unlike Gmail).

- [ ] **Step 1: Write the failing test** `scripts/smoke-email-provider-outlook.ts`:

```ts
/**
 * Outlook provider: the sendMail payload, error classification (incl. the ambiguous 5xx rule),
 * the X-Orbit-Send-Id header, and findSent with and without Mail.Read. Fetch is mocked.
 * Run: npx tsx scripts/smoke-email-provider-outlook.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { MICROSOFT_SCOPES } from "../src/lib/microsoft-scopes";
import { ORBIT_SEND_HEADER, outlookProvider, sendMailPayload } from "../src/lib/email/providers/outlook";
import { MailProviderError } from "../src/lib/email/providers/types";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-outlook-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Mode = "ok" | "400" | "401" | "403" | "413" | "429" | "500" | "503" | "504" | "network";
let mode: Mode = "ok";
let sentHeaderInFolder: string | null = null;
const calls: { url: string; method: string; body: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
  if (url.includes("/me/sendMail")) {
    if (mode === "network") throw new TypeError("fetch failed");
    if (mode !== "ok") return new Response(JSON.stringify({ error: { code: "x", message: "nope" } }), { status: Number(mode) });
    return new Response(null, { status: 202 });
  }
  if (url.includes("/mailFolders/sentitems/messages?")) {
    return Response.json({ value: [{ id: "m-1", conversationId: "c-1", subject: "Hi" }] });
  }
  if (url.includes("/messages/m-1?")) {
    return Response.json({
      id: "m-1",
      conversationId: "c-1",
      internetMessageHeaders: sentHeaderInFolder ? [{ name: ORBIT_SEND_HEADER, value: sentHeaderInFolder }] : [],
    });
  }
  return new Response("unexpected", { status: 599 });
}) as typeof fetch;

const MSG = {
  from: { name: "Me", email: "me@contoso.io" },
  to: ["a@x.org"], cc: ["c@x.org"], bcc: ["b@x.org"],
  subject: "Hi", bodyText: "Body", bodyHtml: null, messageId: "<id-1@orbit.mail>",
};
const OPTS = { sendId: "row-1" };

async function kind(m: Mode): Promise<string> {
  mode = m;
  try {
    await outlookProvider.send(USER, MSG, OPTS);
    return "ok";
  } catch (e) {
    return e instanceof MailProviderError ? e.kind : `raw:${String(e)}`;
  }
}

async function main() {
  const db = await getDb();
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  try {
    console.log("payload");
    const p = sendMailPayload(MSG, MSG.messageId);
    check("to/cc/bcc as recipients", p.message.toRecipients[0]?.emailAddress.address === "a@x.org" && p.message.ccRecipients.length === 1 && p.message.bccRecipients[0]?.emailAddress.address === "b@x.org");
    check("plain body as Text", p.message.body.contentType === "Text" && p.message.body.content === "Body");
    check("html body as HTML", sendMailPayload({ ...MSG, bodyHtml: "<p>x</p>" }, "h").message.body.contentType === "HTML");
    check("carries the Orbit send header", p.message.internetMessageHeaders.some((h) => h.name === ORBIT_SEND_HEADER && h.value === MSG.messageId));
    check("saved to Sent Items", p.saveToSentItems === true);
    check("no From override (the signed-in mailbox sends)", !("from" in p.message));

    await db.insert(schema.outlookConnections).values({
      userId: USER, emailAddress: "Me@Contoso.io", accessTokenEncrypted: encrypt("tok"), refreshTokenEncrypted: encrypt("ref"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000), scopes: MICROSOFT_SCOPES.contacts, status: "active",
    });
    const where = eq(schema.outlookConnections.userId, USER);
    check("no send scope → no identity", (await outlookProvider.identity(USER)) === null);
    await db.update(schema.outlookConnections).set({ scopes: `${MICROSOFT_SCOPES.contacts} ${MICROSOFT_SCOPES.mailSend}` }).where(where);
    check("send scope → lowercased identity", (await outlookProvider.identity(USER))?.email === "me@contoso.io");

    console.log("send");
    calls.length = 0;
    mode = "ok";
    const res = await outlookProvider.send(USER, MSG, OPTS);
    check("202 → sent, with no ids (Graph returns none)", res.providerMessageId === null && res.providerThreadId === null);
    check("exactly one sendMail POST", calls.filter((c) => c.url.includes("/me/sendMail") && c.method === "POST").length === 1);
    check("400 → permanent", (await kind("400")) === "permanent");
    check("413 → permanent", (await kind("413")) === "permanent");
    check("401 → auth", (await kind("401")) === "auth");
    check("403 → auth", (await kind("403")) === "auth");
    check("429 → transient", (await kind("429")) === "transient");
    check("503 → transient", (await kind("503")) === "transient");
    check("500 → ambiguous", (await kind("500")) === "ambiguous");
    check("504 → ambiguous", (await kind("504")) === "ambiguous");
    check("network → ambiguous", (await kind("network")) === "ambiguous");
    calls.length = 0;
    await kind("503");
    check("sendMail is never retried inside the provider", calls.filter((c) => c.url.includes("/me/sendMail")).length === 1);

    console.log("findSent");
    const ref = { rfcMessageId: MSG.messageId, subject: "Hi", since: new Date(Date.now() - 60_000) };
    check("no Mail.Read → unknown", (await outlookProvider.findSent(USER, ref)) === "unknown");
    await db.update(schema.outlookConnections).set({ scopes: `${MICROSOFT_SCOPES.mailSend} ${MICROSOFT_SCOPES.mail}` }).where(where);
    sentHeaderInFolder = MSG.messageId;
    const hit = await outlookProvider.findSent(USER, ref);
    check("header match → found, with ids", typeof hit === "object" && hit?.providerMessageId === "m-1" && hit.providerThreadId === "c-1", JSON.stringify(hit));
    sentHeaderInFolder = "<someone-else@orbit.mail>";
    check("same subject, different header → not found", (await outlookProvider.findSent(USER, ref)) === null);
    const search = calls.find((c) => c.url.includes("/mailFolders/sentitems/messages?"));
    check("the search is bounded by time", Boolean(search && decodeURIComponent(search.url).includes("sentDateTime ge ")));

    console.log("auth marking");
    await db.update(schema.outlookConnections).set({ status: "needs_reauth" }).where(where);
    check("needs_reauth → no identity", (await outlookProvider.identity(USER)) === null);
    check("needs_reauth → send is auth, never ambiguous", (await kind("ok")) === "auth");
  } finally {
    globalThis.fetch = realFetch;
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Outlook provider checks passed.");
}

run(main);
```

Check the `outlookConnections` insert columns against `src/db/schema.ts:2848` (`syncStateColumns()` may add NOT NULL columns with defaults — fine). Register `"smoke-email-provider-outlook": "pglite",`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-email-provider-outlook.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/lib/email/providers/outlook.ts`:

```ts
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { outlookConnections } from "@/db/schema";
import { MailProviderError, type MailProvider, type OutboundMessage } from "@/lib/email/providers/types";
import { graphFetchWithRetry } from "@/lib/graph-fetch";
import { getValidAccessToken, hasMailScope, hasSendScope } from "@/lib/outlook";

/**
 * Sends as the user through Microsoft Graph `POST /me/sendMail`, with only the `Mail.Send`
 * permission (direct-email P3, decision 1). Graph answers 202 with no body, so a send has no
 * message or thread id. Each message carries `X-Orbit-Send-Id` = the outbox row's RFC id, so a
 * retry can look for it in Sent Items — which needs `Mail.Read` (granted only with the recruiter
 * scan). Without it an unsure send is reported "may have sent" by the outbox, never resent.
 *
 * sendMail is deliberately NOT sent through `graphFetchWithRetry`: that helper retries 429/503/
 * 504, and retrying a non-idempotent send is how a person gets two copies.
 */
export const ORBIT_SEND_HEADER = "X-Orbit-Send-Id";
const GRAPH = "https://graph.microsoft.com/v1.0/me";

type Recipient = { emailAddress: { address: string } };
const recipients = (emails: string[]): Recipient[] => emails.map((address) => ({ emailAddress: { address } }));

export function sendMailPayload(msg: OutboundMessage, sendHeader: string) {
  return {
    message: {
      subject: msg.subject,
      body: msg.bodyHtml ? { contentType: "HTML", content: msg.bodyHtml } : { contentType: "Text", content: msg.bodyText },
      toRecipients: recipients(msg.to),
      ccRecipients: recipients(msg.cc),
      bccRecipients: recipients(msg.bcc),
      internetMessageHeaders: [{ name: ORBIT_SEND_HEADER, value: sendHeader }],
    },
    saveToSentItems: true,
  };
}

async function connection(userId: string) {
  const db = await getDb();
  return db.query.outlookConnections.findFirst({
    where: eq(outlookConnections.userId, userId),
    columns: { status: true, scopes: true, emailAddress: true },
  });
}

/** Token errors happen before any request leaves, so they are never ambiguous. */
async function token(userId: string): Promise<string> {
  try {
    return await getValidAccessToken(userId);
  } catch (err) {
    throw new MailProviderError("auth", err instanceof Error ? err.message : "Outlook is not connected");
  }
}

function classify(status: number, body: string): MailProviderError {
  const detail = `Graph ${status}: ${body.slice(0, 200)}`;
  if (status === 401 || status === 403) return new MailProviderError("auth", detail);
  // Throttled or explicitly unavailable: Graph did not take the message.
  if (status === 429 || status === 503) return new MailProviderError("transient", detail);
  // Any other 5xx (a gateway timeout above all) may have been accepted before it failed.
  if (status >= 500) return new MailProviderError("ambiguous", detail);
  return new MailProviderError("permanent", detail);
}

const odataString = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const outlookProvider: MailProvider = {
  id: "outlook",

  async identity(userId) {
    const conn = await connection(userId);
    if (!conn || conn.status !== "active" || !hasSendScope(conn.scopes)) return null;
    return { email: conn.emailAddress.trim().toLowerCase() };
  },

  async send(userId, msg) {
    const accessToken = await token(userId);
    let res: Response;
    try {
      res = await fetch(`${GRAPH}/sendMail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(sendMailPayload(msg, msg.messageId)),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new MailProviderError("ambiguous", err instanceof Error ? err.message : "network error");
    }
    if (res.status !== 202 && !res.ok) throw classify(res.status, await res.text().catch(() => ""));
    return { providerMessageId: null, providerThreadId: null };
  },

  async findSent(userId, ref) {
    const conn = await connection(userId);
    if (!conn || conn.status !== "active" || !hasMailScope(conn.scopes)) return "unknown";
    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(userId);
    } catch {
      return "unknown";
    }
    const headers = { Authorization: `Bearer ${accessToken}` };
    const since = new Date(ref.since.getTime() - 5 * 60_000).toISOString();
    const filter = `sentDateTime ge ${since} and subject eq ${odataString(ref.subject)}`;
    const list = await graphFetchWithRetry(
      `${GRAPH}/mailFolders/sentitems/messages?$filter=${encodeURIComponent(filter)}&$select=id,conversationId&$top=10`,
      { headers, timeoutMs: 10_000 }
    ).catch(() => null);
    if (!list || !list.ok) return "unknown";
    const { value = [] } = (await list.json().catch(() => ({}))) as { value?: { id: string; conversationId?: string }[] };
    for (const candidate of value) {
      const one = await graphFetchWithRetry(
        `${GRAPH}/messages/${encodeURIComponent(candidate.id)}?$select=id,conversationId,internetMessageHeaders`,
        { headers, timeoutMs: 10_000 }
      ).catch(() => null);
      if (!one || !one.ok) return "unknown";
      const full = (await one.json().catch(() => ({}))) as {
        id?: string;
        conversationId?: string;
        internetMessageHeaders?: { name: string; value: string }[];
      };
      const tagged = full.internetMessageHeaders?.some(
        (h) => h.name.toLowerCase() === ORBIT_SEND_HEADER.toLowerCase() && h.value === ref.rfcMessageId
      );
      if (tagged && full.id) return { providerMessageId: full.id, providerThreadId: full.conversationId ?? null };
    }
    return null;
  },
};
```

Confirm `graphFetchWithRetry`'s option names (`headers`, `timeoutMs`) at `src/lib/graph-fetch.ts:35`. Verify the `sentDateTime ge` + `subject eq` filter combination against the Graph docs (Step "Graph facts"); if Graph rejects the combined filter, fall back to `$filter=sentDateTime ge …&$orderby=sentDateTime desc&$top=25` and compare subjects in code.

Register in `providers/index.ts`: `if (id === "outlook") return outlookProvider;`.

In `outbox.ts` `settleFailed`, extend the auth branch:

```ts
  if (kind === "auth" && done.provider === "outlook") {
    await markOutlookNeedsReauth(done.userId).catch(() => null);
  }
```

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/smoke-email-provider-outlook.ts && npx tsc --noEmit -p .`
Expected: PASS. Then add one outbox-level check to `scripts/smoke-email-sends.ts`: with a fake `outlook` provider override and an `outlook_connections` row carrying `Mail.Send`, a row enqueued with `provider: "outlook"` (Task 4 adds the option — if running Task 3 alone, insert the row directly via SQL) dispatches through the fake and settles `sent` with `provider_message_id IS NULL`, and an `auth` failure sets `outlook_connections.status = 'needs_reauth'`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/providers/outlook.ts src/lib/email/providers/index.ts src/lib/email/outbox.ts scripts/smoke-email-provider-outlook.ts scripts/smoke-email-sends.ts scripts/run-smoke.ts
git commit -m "feat(email): Outlook provider — sendMail with Mail.Send, header-based duplicate check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Choosing between two mailboxes

**Files:**
- Modify: `src/lib/email/sender.ts`, `src/lib/email/outbox.ts` (`EnqueueInput`, `enqueueEmail`, `ENQUEUE_COPY`)
- Modify: `src/lib/email/settings.ts` (+ `saveDefaultSendProvider`), `src/actions/settings.ts` (+ `saveDefaultSendProviderAction`)
- Test: `scripts/smoke-email-sender.ts` (tier `pglite`)

**Interfaces:**
- Produces:
  - `type MailboxId = "gmail" | "outlook"`
  - `type Mailbox = { id: MailboxId; email: string; canSend: boolean; needsReauth: boolean }`
  - `resolveSender(userId, preferred?: MailboxId | null): Promise<ResolvedSender>` where the failure branch is `{ ok: false; reason: SendBlockReason; provider: MailboxId | null }`
  - `SendCapability` success branch gains `mailboxes: Mailbox[]`, `defaultProvider: MailboxId | null`; both branches gain `outlookAvailable: boolean` (configured on this deployment AND `feature.outlook-send` live for the user); the failure branch gains `provider: MailboxId | null`
  - `listMailboxes(userId): Promise<Mailbox[]>`
  - `EnqueueInput.provider?: MailboxId` — honored only if that mailbox can send; otherwise `refuse("not_connected")`
  - `saveDefaultSendProvider(userId, provider: MailboxId | null): Promise<MailboxId | null>`

Resolution rules (Decision 4), in order: demo workspace → `demo`; explicit `preferred` if it can send; `default_send_provider` if it can send; the single sendable mailbox; Gmail if both can. When none can send, report the most actionable block: a mailbox that needs reauth → `needs_reauth` (that provider); a connected mailbox without send scope → `no_send_scope` (that provider; Gmail first); else `not_connected` (provider `null`). Outlook participates only when `outlookAvailable`.

- [ ] **Step 1: Write the failing test** `scripts/smoke-email-sender.ts`. Outlook is exercised through a test seam, `setOutlookSendOverride(v: boolean | null)` in `sender.ts` (like `setProviderOverride`), because `feature.outlook-send` is coming-soon; production reads `getOutlookOAuthConfigSummary().configured && await isSurfaceLive(userId, OUTLOOK_SEND_SURFACE_KEY)`.

```ts
/**
 * Choosing a mailbox: explicit choice → saved default → the only sendable one → Gmail; blocked
 * results name the provider to fix; Outlook is invisible until its feature is live.
 * Run: npx tsx scripts/smoke-email-sender.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { enqueueEmail } from "../src/lib/email/outbox";
import { getSendCapability, resolveSender, setOutlookSendOverride } from "../src/lib/email/sender";
import { saveDefaultSendProvider } from "../src/lib/email/settings";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { MICROSOFT_SCOPES } from "../src/lib/microsoft-scopes";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-sender-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const token = { accessTokenEncrypted: encrypt("t"), refreshTokenEncrypted: encrypt("r"), tokenExpiresAt: new Date(Date.now() + 3_600_000) };
const summary = async (preferred?: "gmail" | "outlook") => {
  const r = await resolveSender(USER, preferred);
  return r.ok ? `ok:${r.provider}` : `${r.reason}:${r.provider}`;
};

async function main() {
  const db = await getDb();
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  try {
    check("nothing connected", (await summary()) === "not_connected:null", await summary());

    await db.insert(schema.gmailConnections).values({ userId: USER, emailAddress: "me@gmail-mail.io", scopes: GOOGLE_SCOPES.contacts, status: "active", ...token });
    check("Gmail without send scope names Gmail", (await summary()) === "no_send_scope:gmail", await summary());

    await db.delete(schema.gmailConnections).where(eq(schema.gmailConnections.userId, USER));
    await db.insert(schema.outlookConnections).values({ userId: USER, emailAddress: "Me@Contoso.io", scopes: MICROSOFT_SCOPES.mailSend, status: "active", ...token });
    setOutlookSendOverride(null);
    check("Outlook is invisible while its feature is coming-soon", (await summary()) === "not_connected:null", await summary());

    setOutlookSendOverride(true);
    check("Outlook alone sends", (await summary()) === "ok:outlook", await summary());

    await db.insert(schema.gmailConnections).values({ userId: USER, emailAddress: "me@gmail-mail.io", scopes: GOOGLE_SCOPES.gmailSend, status: "active", ...token });
    check("both, no default → Gmail", (await summary()) === "ok:gmail");
    await saveDefaultSendProvider(USER, "outlook");
    check("saved default wins", (await summary()) === "ok:outlook");
    check("an explicit choice beats the default", (await summary("gmail")) === "ok:gmail");

    await db.update(schema.outlookConnections).set({ status: "needs_reauth" }).where(eq(schema.outlookConnections.userId, USER));
    check("default mailbox broken → falls back to the one that works", (await summary()) === "ok:gmail");
    await db.delete(schema.gmailConnections).where(eq(schema.gmailConnections.userId, USER));
    check("nothing sendable, one needs reauth → reconnect that one", (await summary()) === "needs_reauth:outlook", await summary());

    await db.execute(sql`DELETE FROM rate_limit_buckets WHERE bucket = ${`emailSend:${USER}`}`);
    const pinned = await enqueueEmail(USER, { to: ["a@acme-corp.io"], subject: "s", bodyText: "b", origin: "compose", delayMs: 10_000, provider: "outlook" });
    check("an explicit mailbox that can't send is refused, never swapped", !pinned.ok && pinned.reason === "not_connected", JSON.stringify(pinned));

    check("saving null clears the default", (await saveDefaultSendProvider(USER, null)) === null);

    await db.update(schema.outlookConnections).set({ status: "active" }).where(eq(schema.outlookConnections.userId, USER));
    await db.insert(schema.gmailConnections).values({ userId: USER, emailAddress: "me@gmail-mail.io", scopes: GOOGLE_SCOPES.contacts, status: "active", ...token });
    const cap = await getSendCapability(USER);
    check(
      "capability lists both mailboxes with what each can do",
      cap.ok &&
        cap.mailboxes.find((m) => m.id === "gmail")?.canSend === false &&
        cap.mailboxes.find((m) => m.id === "outlook")?.canSend === true &&
        cap.outlookAvailable === true,
      JSON.stringify(cap)
    );
  } finally {
    setOutlookSendOverride(null);
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll sender checks passed.");
}

run(main);
```

Register `"smoke-email-sender": "pglite",`. Confirm `purgeUserData` removes `outlook_connections` (the `connections` category should; `smoke-purge` enforces it).

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx scripts/smoke-email-sender.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `sender.ts`:

```ts
export type MailboxId = "gmail" | "outlook";
export type Mailbox = { id: MailboxId; email: string; canSend: boolean; needsReauth: boolean };

let outlookSendOverride: boolean | null = null;
/** Smoke tests only. */
export function setOutlookSendOverride(v: boolean | null) {
  outlookSendOverride = v;
}

async function outlookAvailable(userId: string): Promise<boolean> {
  if (outlookSendOverride !== null) return outlookSendOverride;
  if (!getOutlookOAuthConfigSummary().configured) return false;
  return isSurfaceLive(userId, OUTLOOK_SEND_SURFACE_KEY);
}

export async function listMailboxes(userId: string, includeOutlook?: boolean): Promise<Mailbox[]> {
  const db = await getDb();
  const withOutlook = includeOutlook ?? (await outlookAvailable(userId));
  const [gmail, outlook] = await Promise.all([
    db.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, userId), columns: { status: true, scopes: true, emailAddress: true } }),
    withOutlook
      ? db.query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, userId), columns: { status: true, scopes: true, emailAddress: true } })
      : Promise.resolve(undefined),
  ]);
  const out: Mailbox[] = [];
  if (gmail) out.push({ id: "gmail", email: gmail.emailAddress.trim().toLowerCase(), canSend: gmail.status === "active" && hasGmailSendScope(gmail.scopes), needsReauth: gmail.status !== "active" });
  if (outlook) out.push({ id: "outlook", email: outlook.emailAddress.trim().toLowerCase(), canSend: outlook.status === "active" && hasOutlookSendScope(outlook.scopes), needsReauth: outlook.status !== "active" });
  return out;
}

export type ResolvedSender =
  | { ok: true; provider: EmailProviderId; fromEmail: string }
  | { ok: false; reason: SendBlockReason; provider: MailboxId | null };

export async function resolveSender(userId: string, preferred?: MailboxId | null): Promise<ResolvedSender> {
  if (await isDemoWorkspace(userId)) {
    const id = await providerFor("demo").identity(userId);
    if (id) return { ok: true, provider: "demo", fromEmail: id.email };
  }
  const [mailboxes, { defaultProvider }] = await Promise.all([listMailboxes(userId), loadSendPreference(userId)]);
  const sendable = mailboxes.filter((m) => m.canSend);
  const pick =
    (preferred && sendable.find((m) => m.id === preferred)) ||
    (defaultProvider && sendable.find((m) => m.id === defaultProvider)) ||
    (sendable.length === 1 ? sendable[0] : sendable.find((m) => m.id === "gmail"));
  if (pick) return { ok: true, provider: pick.id, fromEmail: pick.email };
  const reauth = mailboxes.find((m) => m.needsReauth);
  if (reauth) return { ok: false, reason: "needs_reauth", provider: reauth.id };
  const scopeless = mailboxes.find((m) => !m.canSend);
  if (scopeless) return { ok: false, reason: "no_send_scope", provider: scopeless.id };
  return { ok: false, reason: "not_connected", provider: null };
}
```

`loadSendPreference(userId)` reads `user_settings.default_send_provider` (put it in `src/lib/email/settings.ts` beside `loadEmailSettings`, returning `{ defaultProvider }`). Update `getSendCapability` to return `mailboxes`, `defaultProvider`, `outlookAvailable`, and `provider` on failure. Imports: `outlookConnections`, `hasSendScope as hasOutlookSendScope` from `@/lib/outlook`, `hasSendScope as hasGmailSendScope` from `@/lib/gmail`, `getOutlookOAuthConfigSummary` from `@/lib/outlook`, `isSurfaceLive` from `@/lib/surface-visibility`, `OUTLOOK_SEND_SURFACE_KEY`.

`outbox.ts`: `EnqueueInput.provider?: MailboxId`; `const sender = await resolveSender(userId, input.provider ?? null);` and, when `input.provider` was given and `sender.provider !== input.provider`, `return refuse("not_connected")` (an explicit choice is never silently swapped). `ENQUEUE_COPY` becomes mailbox-neutral (Decision 8):

```ts
  not_connected: "Connect your email to send from your own address",
  no_send_scope: "Allow Orbit to send from your email, then try again",
  needs_reauth: "Your email connection expired — reconnect to send",
```

Grep smokes asserting the old strings (`grep -rn "Connect Gmail to send from your own address" scripts src`) and update them (e.g. `smoke-agent-sends.ts`).

`settings.ts` / actions: `saveDefaultSendProvider(userId, provider)` upserts `default_send_provider` (validate `"gmail" | "outlook" | null`); `saveDefaultSendProviderAction(provider)` wraps it with `requireUserForSurface("settings.email")` and returns the new capability (`getSendCapability(userId)`).

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/smoke-email-sender.ts && npx tsc --noEmit -p . && npx tsx scripts/run-smoke.ts --only smoke-email-sends smoke-email-origins smoke-email-compose smoke-agent-sends smoke-chat-send smoke-email-provider-gmail smoke-toast-copy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email src/actions/settings.ts scripts/smoke-email-sender.ts scripts/run-smoke.ts scripts/smoke-*.ts
git commit -m "feat(email): choose between Gmail and Outlook; mailbox-neutral copy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: UI — connect either mailbox, pick one, show the right one

**Files:**
- Modify: `src/components/email/connect-mailbox-button.tsx`, `src/components/settings/email-settings.tsx`, `src/components/email/compose-dialog.tsx`, `src/lib/email/compose.ts` (`ComposeInput.provider`), `src/actions/email-compose.ts`
- Modify: `src/actions/chat-send.ts` (`getChatSendContext`), `src/components/chat/gmail-send-dialog.tsx` (`Blocker`, From line), `src/components/follow-up/follow-up-draft-composer.tsx` (hint)
- Modify: `scripts/smoke-chat-send.ts` (context shape), `scripts/smoke-email-compose.ts` (+ provider choice)

**Interfaces:**
- Produces: `ConnectMailboxButton({ reason, provider, outlookAvailable, returnTo, size? })` — when `reason === "not_connected"` it renders **Connect Gmail** and, if `outlookAvailable`, **Connect Outlook**; otherwise one button for `provider` (`Allow Gmail/Outlook to send`, `Reconnect Gmail/Outlook`). Gmail uses `useConnectGoogle(returnTo).connect(["send"])`, Outlook `useConnectMicrosoft(returnTo).connect(["send"])`.
- `ComposeInput.provider?: MailboxId`; `sendComposedEmail` passes it through.
- `ChatSendContext.identity` becomes `{ canSend: boolean; sendingAs: string | null; displayName: string | null; block: { reason: SendBlockReason; provider: MailboxId | null } | null; outlookAvailable: boolean }`.

- [ ] **Step 1: Update tests first.** In `smoke-email-compose.ts` add: with Gmail and (via `setOutlookSendOverride(true)`) Outlook both sendable, `sendComposed(..., provider: "outlook")` queues a row with `provider = 'outlook'`, and `provider: "outlook"` when Outlook lacks `Mail.Send` returns `not_connected`. In `smoke-chat-send.ts`, replace assertions on `ctx.identity.connected` with `ctx.identity.block === null && ctx.identity.sendingAs === "me@gmail-mail.io"` for the connected case and `ctx.identity.block?.reason === "not_connected"` for the disconnected case.

Run them — expect FAIL.

- [ ] **Step 2: Implement.**

`connect-mailbox-button.tsx`:

```tsx
"use client";

import { Button } from "@/components/ui/button";
import { useConnectGoogle, useConnectMicrosoft } from "@/components/settings/use-provider-connection";
import type { MailboxId, SendBlockReason } from "@/lib/email/sender";

const NAME: Record<MailboxId, string> = { gmail: "Gmail", outlook: "Outlook" };

/**
 * The one CTA a send surface shows when it can't send. Asks each provider only for its send
 * permission. With nothing connected it offers every mailbox this deployment supports.
 */
export function ConnectMailboxButton({
  reason,
  provider,
  outlookAvailable,
  returnTo,
  size = "sm",
}: {
  reason: SendBlockReason;
  provider: MailboxId | null;
  outlookAvailable: boolean;
  returnTo: string;
  size?: "sm" | "default";
}) {
  const google = useConnectGoogle(returnTo);
  const microsoft = useConnectMicrosoft(returnTo);
  const connect = (id: MailboxId) => (id === "gmail" ? google.connect(["send"]) : microsoft.connect(["send"]));
  const busy = google.connecting || microsoft.connecting;

  if (reason === "not_connected" || !provider) {
    return (
      <span className="inline-flex flex-wrap gap-2">
        <Button type="button" size={size} variant="outline" disabled={busy} onClick={() => connect("gmail")}>
          Connect Gmail
        </Button>
        {outlookAvailable && (
          <Button type="button" size={size} variant="outline" disabled={busy} onClick={() => connect("outlook")}>
            Connect Outlook
          </Button>
        )}
      </span>
    );
  }
  const label = reason === "needs_reauth" ? `Reconnect ${NAME[provider]}` : `Allow ${NAME[provider]} to send`;
  return (
    <Button type="button" size={size} variant="outline" disabled={busy} onClick={() => connect(provider)}>
      {label}
    </Button>
  );
}
```

`useConnectMicrosoft`'s purposes type must accept `"send"` (Task 1 added it to `MicrosoftPurpose`). Update every call site (`grep -rn "<ConnectMailboxButton" src`) to pass `provider` and `outlookAvailable` from the capability they already hold.

`email-settings.tsx` "Sending from" row: when `capability.ok && capability.mailboxes.filter((m) => m.canSend).length > 1`, render a `Select` (from `@/components/ui/select`) of sendable mailboxes bound to `capability.provider`; on change call `saveDefaultSendProviderAction(id)` (wrapped in the file's `withTimeout`), update local state, toast `Sending from ${email}`. Below it, for each connected mailbox that can't send, render its `ConnectMailboxButton` (so a Gmail user can also allow Outlook). The settings page passes the same server-read `initial` it does today.

`compose-dialog.tsx` From row: when more than one mailbox can send, a `Select` of them (default `capability.provider`), stored in state `provider`, passed as `sendComposedEmail({ ..., provider })`. Otherwise unchanged. `compose.ts`/`email-compose.ts`: add `provider?: MailboxId` to `ComposeInput` and pass it into `enqueueEmail`; the action validates it is `"gmail" | "outlook"` or drops it.

`chat-send.ts` `getChatSendContext`: replace `getGmailSendIdentity()` with `getSendCapability(userId)` plus the Clerk display name (`getCurrentUserProfile()`), building the new `identity` shape. `gmail-send-dialog.tsx`: the From line reads `identity.sendingAs`; `Blocker`'s not-connected and no-scope branches render `<ConnectMailboxButton reason={identity.block.reason} provider={identity.block.provider} outlookAvailable={identity.outlookAvailable} returnTo={…} />`, keeping the existing `stashSendResume` call before redirecting (call it in an `onBeforeConnect` — simplest: keep the dialog's own `connect()` for Gmail and render `ConnectMailboxButton` only for Outlook; pick whichever keeps the resume behavior for both — the resume stash must run before either redirect). Rename user-facing copy that says "Gmail" when the resolved mailbox is Outlook.

`follow-up-draft-composer.tsx` hint: "Connect your email to send this from your own address — or copy and mark sent."

- [ ] **Step 3: Run tests**

Run: `npx tsc --noEmit -p . && npx tsx scripts/run-smoke.ts --only smoke-email-compose smoke-chat-send smoke-toast-copy smoke-behavior-golden && npm run lint`
Expected: PASS / 0 errors (re-record the behavior golden with `--update` only if the diff is exactly the send-options/capability shape change).

- [ ] **Step 4: Commit**

```bash
git add src/components src/lib/email src/actions scripts
git commit -m "feat(email): connect and choose Gmail or Outlook in Compose, Chat and Settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Recruiter sends stay on Gmail

**Files:**
- Modify: `src/actions/recruiter-messages.ts` (`sendRecruiterDrafts` enqueue call; capability check)
- Test: `scripts/smoke-email-origins.ts` (recruiter section)

- [ ] **Step 1: Failing check.** In the recruiter section of `smoke-email-origins.ts`, with a default of `outlook` saved and both mailboxes sendable (`setOutlookSendOverride(true)`), assert the recruiter row enqueued by the action path is `provider = 'gmail'`. Because the section drives `enqueueEmail` directly, add the assertion by calling `enqueueEmail(USER, { …recruiter input…, provider: "gmail" })` and checking the row; and add a source check: `readFileSync("src/actions/recruiter-messages.ts","utf8").includes('provider: "gmail"')`.

- [ ] **Step 2: Implement.** In `sendRecruiterDrafts`, pass `provider: "gmail"` to `enqueueEmail`, and base the pre-check on the Gmail mailbox: `const gmail = (await listMailboxes(userId, false)).find((m) => m.id === "gmail"); if (!gmail?.canSend) throw new UserFacingError(gmail?.needsReauth ? "Reconnect Gmail to send recruiter replies" : "Connect Gmail to send recruiter replies");` (demo workspace short-circuit stays first). Comment: recruiter threads are Gmail threads (`gmailThreadId`), so replies go from Gmail.

- [ ] **Step 3: Run and commit**

Run: `npx tsx scripts/run-smoke.ts --only smoke-email-origins smoke-connect-gates smoke-toast-copy`
Expected: PASS.

```bash
git add src/actions/recruiter-messages.ts scripts/smoke-email-origins.ts
git commit -m "fix(email): recruiter replies always send from Gmail, where their threads live

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Verification

- [ ] **Step 1: Full suite and build** (no dev server on this worktree's `.next`; never pipe `npm test` through `tail`):

```bash
npm run test:check
npm test > /tmp/p3-smoke.log 2>&1; echo "exit=$?"; grep "passed in" /tmp/p3-smoke.log
npx tsc --noEmit -p .
npm run lint
npm run build
```

Expected: exit 0, all passed, 0 type/lint errors, build compiles. Allowlists keyed on line numbers (`smoke-provider-exhaustive`) may need re-numbering if `src/actions/settings.ts` or `outlook.ts` shifted — update the numbers, never the reasons.

- [ ] **Step 2: Browser pass** (`rm -rf .next`, start `orbit-web`). Local demo mode treats the user as an admin; neither feature is previewed without the cookie, so for this pass only, temporarily delete `comingSoon: true` from **both** `feature.compose` and `feature.outlook-send`, restore both before committing (`git diff src/lib/surfaces.ts` empty at the end). Local Outlook OAuth likely isn't configured (`MICROSOFT_CLIENT_ID` unset) — then `outlookAvailable` is false and only Gmail appears, which is itself the check that an unconfigured deployment never offers Outlook. Verify:
  1. Compose / Settings / Chat dialog with nothing connected show **Connect Gmail** (and **Connect Outlook** only when configured).
  2. No copy anywhere still says "Connect Gmail to send…" where the mailbox could be Outlook.
  3. With `comingSoon` restored, no Outlook sending UI appears.

- [ ] **Step 3: Manual acceptance on a preview with Microsoft OAuth configured (owed by Jason):** as an admin previewing unreleased, connect Outlook with Send; send from Compose choosing Outlook — arrives from the Outlook address, appears in Outlook Sent Items; switch default in Settings; revoke the app in the Microsoft account → next send fails, the Outlook connection alert appears. If the recruiter-scan `Mail.Read` is also granted, force a 504 path is not practical — instead confirm `findSent` finds a real sent message by `X-Orbit-Send-Id` by calling it from a script against the preview DB.

---

### Task 8 (Jason's decision — do not start without it): disclose `Mail.Send` and release

The privacy page currently says Microsoft access is "one read-only permission per feature" and that Orbit "cannot send mail or change anything in your Microsoft account" (`src/app/(site)/(docs)/privacy/page.tsx` ~70 and ~133-141; asserted by `scripts/smoke-legal-pages.ts` ~92). Asking for `Mail.Send` makes that false, so `feature.outlook-send` must stay coming-soon until the page changes.

Any edit to `/privacy` trips `scripts/legal-pages.lock.json`, which requires `LEGAL_LAST_UPDATED` **and** `TERMS_VERSION` to move (`src/lib/legal.ts:12-13`); moving `TERMS_VERSION` makes every user re-accept. **Pricing v2 (#370) already bumps `TERMS_VERSION`** (to `2026-09-29`).

Options to put to Jason:
- **(a) Fold into pricing v2's legal update (recommended):** add the Microsoft wording + a `MICROSOFT_SCOPE_DISCLOSURES` table to #370's pending legal change, so one re-consent covers both. Then release by deleting `comingSoon` from `feature.outlook-send`.
- **(b) Separate bump:** its own `TERMS_VERSION` after #370 lands — a second re-consent.

When decided, the work is:
1. `src/lib/legal.ts`: `MICROSOFT_SCOPE_DISCLOSURES` (rows for `Contacts.Read`, `Calendars.Read`, `Mail.Read`, `Mail.Send` with `permission`, `use`, `askedWhen`), mirroring `GOOGLE_SCOPE_DISCLOSURES`.
2. Privacy page: render the Microsoft table beside Google's; rewrite the Microsoft processor row and the "read-only … cannot send mail" paragraph to: read-only permissions per feature, plus `Mail.Send` "only if you choose to send email from Outlook, and only to send what you confirm".
3. `smoke-legal-pages.ts`: replace the "read-only per feature" assertion with (i) the table matches `MICROSOFT_SCOPES` exactly (like the Google check) and (ii) the page no longer claims Orbit "cannot send mail".
4. Bump `LEGAL_LAST_UPDATED`/`TERMS_VERSION` per the chosen option; `npx tsx scripts/smoke-legal-pages.ts --update`.
5. Delete `comingSoon: true` from `feature.outlook-send`.

---

## PR notes

- Stacked on #379 (P2) → #374 (P1).
- **Ships dark:** `feature.outlook-send` is coming-soon; the privacy page is unchanged in this PR on purpose (see Task 8).
- Permission: `Mail.Send` only. Outlook sends have no provider message/thread id; duplicate checks need `Mail.Read` (recruiter scan) and otherwise fall back to "may have sent".
- User-visible now (not gated): send copy is mailbox-neutral ("Connect your email…"), and Chat's dialog shows whichever mailbox will send.
- Recruiter replies are pinned to Gmail.
- No schema change.
