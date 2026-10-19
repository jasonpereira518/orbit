# Direct Email P4 — Scheduled Send + Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Compose, let a person (1) schedule an email for later ("Tomorrow 8:00", "Monday 8:00", or a chosen date and time) and (2) attach files, sent from Gmail or Outlook through the existing outbox.

**Architecture:** *Scheduling* is only a future `send_at` on an outbox row. The ten-minute drain sends it, so the time is shown as "around". It needs no new dispatch path, only a rule that `after()` is used only for short (undo-window) delays. *Attachments* upload straight from the browser to Vercel Blob under `email-attachments/<userId>/…`, using a Clerk-authed client-upload token route. That bypasses the 4.5 MB function body limit. The composer passes only blob pathnames. The server re-reads each blob's real size and type (`head`), checks ownership by path prefix, and stores `EmailAttachmentRef`s on the row. At dispatch it fetches the bytes and hands them to the provider: Gmail gets a `multipart/mixed` MIME sent to the media upload endpoint, and Outlook gets inline `fileAttachment`s. An hourly sweep deletes attachment blobs 7 days after a send settles, and deletes uploads that never made it into a send. `purgeUserData` deletes the user's whole prefix.

**Tech Stack:** Next.js server actions and a route handler, `@vercel/blob` ^2.8 (server `head`/`get`/`del`/`list`, client `upload`/`handleUpload`), Gmail API upload endpoint, Microsoft Graph `sendMail`, tsx smokes.

**Spec:** `docs/superpowers/specs/2026-09-29-direct-email-design.md`, §5 (Send menu, drop zone) and §7 (P4). Also read the planning amendments for P2 and P3. P3 chose `Mail.Send` only, which caps Outlook attachments; see Decision 3.

## Global Constraints

- **Branch:** cut `claude/direct-email-p4-schedule-attachments` from P3's HEAD (`claude/direct-email-p3-outlook`, PR #382). Open its PR against the P3 branch.
- **No schema change.** `email_sends.send_at` and `email_sends.attachments jsonb` (`EmailAttachmentRef[]`) already exist.
- **Limits** (in `src/lib/email/config.ts`):
  - `MAX_ATTACHMENTS = 10`.
  - `MAX_ATTACHMENT_BYTES_GMAIL = 20 * 1024 * 1024` (total, raw). base64 makes that about 27 MB of MIME, under Gmail's 35 MB upload cap, and within Gmail's 25 MB attachment limit once headers are counted.
  - `MAX_ATTACHMENT_BYTES_OUTLOOK = 3 * 1024 * 1024` (total).
  - `SCHEDULE_MIN_LEAD_MS = 60_000`, `SCHEDULE_MAX_LEAD_MS = 30 days`.
  - `ATTACHMENT_RETENTION_MS = 7 days` after a send settles; `ORPHAN_UPLOAD_TTL_MS = 2 days`.
- **Blocked file extensions** (Gmail refuses these; refuse them up front, case-insensitive, including inside `.zip` names is out of scope): `ade adp apk appx appxbundle bat cab chm cmd com cpl diagcab diagcfg diagpack dll dmg ex ex_ exe hta img ins iso isp jar jnlp js jse lib lnk mde mjs msc msi msix msixbundle msp mst nsh pif ps1 scr sct shb sys vb vbe vbs vhd vxd wsc wsf wsh xll`.
- Blob access goes through `src/lib/blob-lazy.ts` (lazy import) — extend it with `head`, `get`, `list`; never import `@vercel/blob` at module top in server code. Client code imports `upload` from `@vercel/blob/client`.
- Attachments exist only when Blob is configured (`hasBlobStorage()` in `src/lib/contact-avatar.ts`); otherwise the composer hides the attach control. No inline fallback.
- Scheduled sends: only Compose schedules. Chat/follow-ups/agent/recruiter are unchanged.
- A scheduled send's time is chosen in the browser (the user's zone) and sent as an ISO instant; the server validates `now + 60s ≤ sendAt ≤ now + 30 days` on the DB clock.
- `scheduleDispatch` (the only `after()` user) is called only when the delay ≤ `UNDO_DELAY_MS + 5_000`.
- Toast copy: no trailing periods. User-facing errors via returned `message` / `friendlyError`.
- Every new smoke registered in `scripts/run-smoke.ts`; `pglite` ones import `./smoke/_env` first. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions (record in the spec in Task 1)

1. **Scheduling = a future `send_at`; the drain delivers it** (~10 min granularity; UI says "around"). No new queue.
2. **Browser computes the instant.** The composer builds "8:00 tomorrow" etc. from the browser's clock/zone (the same zone `syncTimeZoneCookie` records) and sends ISO; the server only bounds it. No server-side wall-clock conversion.
3. **Outlook attachments ≤ 3 MB total.** With `Mail.Send` only (P3), attachments must ride inline in `sendMail`; bigger needs a draft + upload session = `Mail.ReadWrite`, which was ruled out. The composer shows the right limit for the chosen mailbox and refuses over it; Gmail allows 20 MB.
4. **Direct client upload to Blob, user-prefixed paths, server-verified at send.** The token route only issues tokens for `email-attachments/<userId>/…`; enqueue re-checks the prefix and reads real size/type with `head()` — client-declared sizes and types are never trusted.
5. **Private blobs if the store supports them, else public + random suffix.** Task 1 confirms which; either way the URL never reaches another user and the server reads bytes via the SDK / URL.
6. **Attachments aren't kept in the local compose draft.** Uploaded files not sent within 2 days are swept.
7. **Retry and Edit carry attachments** (the refs are copied; blobs live until 7 days after the final send settles).
8. **Gmail sends with attachments use the media upload endpoint** (`/upload/gmail/v1/users/me/messages/send`, multipart with `threadId` metadata when present); plain sends keep the JSON `raw` endpoint.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/email/config.ts` | limits above |
| `src/lib/blob-lazy.ts` | + lazy `head`, `get`, `list` |
| `src/lib/email/attachments.ts` | path rules, blocked extensions, `verifyAttachmentRefs`, `loadAttachmentBytes`, sweep + purge helpers, test seam |
| `src/app/api/email/attachments/upload/route.ts` | Clerk-authed `handleUpload` token route |
| `src/lib/email/mime.ts` | `multipart/mixed` with base64 attachment parts |
| `src/lib/email/providers/types.ts` | `OutboundMessage.attachments?` |
| `src/lib/email/providers/gmail.ts` | upload endpoint when attachments present |
| `src/lib/email/providers/outlook.ts` | inline `fileAttachment`s, 3 MB guard |
| `src/lib/email/outbox.ts` | `EnqueueInput.attachments` / `sendAt`; dispatch loads bytes; drain floor |
| `src/lib/email/compose.ts`, `src/actions/email-compose.ts` | `attachments`, `scheduledFor` on compose; retry copies attachments |
| `src/lib/email/schedule-presets.ts` | pure: "tomorrow 8:00", "Monday 8:00", day+time → Date (browser) |
| `src/components/email/compose-dialog.tsx` | Send menu, attach button + element drop zone, chips |
| `src/components/email/attachment-list.tsx` | chips with name/size/progress/remove |
| `src/components/email/schedule-menu.tsx` | Send ▾ menu + pick date/time |
| `src/components/email/pending-sends.tsx` | "Scheduled for …", Edit for queued |
| `src/app/api/imports/process-stalled/route.ts` | wire the attachment sweep |
| `src/lib/user-data.ts` | purge the user's attachment prefix |
| Smokes: `smoke-email-mime` (+), `smoke-email-attachments` (new), `smoke-email-schedule` (new), `smoke-email-provider-gmail` (+), `smoke-email-provider-outlook` (+), `smoke-schedule-presets` (new) | |

---

### Task 1: Confirm Blob and Gmail upload facts; limits; blob helpers

**Files:**
- Modify: `src/lib/email/config.ts`, `src/lib/blob-lazy.ts`
- Modify: spec (append `## Planning amendments (P4 plan)` with Decisions 1–8)

- [ ] **Step 1: Confirm the facts this plan depends on** (read the installed SDK and the provider docs; write what you find into the header comment of `src/lib/email/attachments.ts` in Task 2, and adjust this plan where they differ):
  1. `node_modules/@vercel/blob/dist/client.d.ts` and `index.d.ts`: `upload(pathname, file, { access, handleUploadUrl, onUploadProgress, clientPayload, multipart })`; `handleUpload({ body, request, onBeforeGenerateToken, onUploadCompleted })` — is `onUploadCompleted` required, and when is it called (only with a `callbackUrl`)? `onBeforeGenerateToken(pathname, clientPayload, multipart)` return shape (`allowedContentTypes`, `maximumSizeInBytes`, `addRandomSuffix`, `tokenPayload`, `callbackUrl`, `access`?). `head(url|pathname)` → `{ size, contentType, pathname, url }`. `get(urlOrPathname, { access })` → stream/bytes for **private** blobs. `del`, `list({ prefix, cursor, limit })`.
  2. Whether this project's store accepts `access: "private"`: with a real `BLOB_READ_WRITE_TOKEN` in a scratch script (`npx tsx -e` with `put("email-attachments/_probe.txt", "x", { access: "private" })`, then `get` and `del`). If private is refused, use `access: "public"` with `addRandomSuffix: true` everywhere below and read bytes with `fetch(url)` (Decision 5). If no token is available locally, write the code for private with a single `BLOB_ACCESS` constant that Task 9's preview check flips if needed.
  3. Gmail `users.messages.send` upload: `POST https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart` with a `multipart/related` body (JSON metadata part `{ "threadId": … }` + `message/rfc822` part), max 35 MB; `uploadType=media` with `Content-Type: message/rfc822` when there's no metadata. Response JSON has `id`, `threadId`.
  4. Graph `sendMail` with `message.attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", name, contentType, contentBytes (base64) }]` — "attachments under 3 MB" per the sendMail doc.

- [ ] **Step 2: Limits** — append to `src/lib/email/config.ts`:

```ts
/** Attachments (P4). Totals are raw bytes, before base64. */
export const MAX_ATTACHMENTS = 10;
/** Gmail: 20 MB raw ≈ 27 MB as base64 MIME — under the 35 MB upload cap and Gmail's 25 MB attachment rule. */
export const MAX_ATTACHMENT_BYTES_GMAIL = 20 * 1024 * 1024;
/** Outlook with Mail.Send only: attachments ride inline in sendMail, which takes ~3 MB (P3 decision 1). */
export const MAX_ATTACHMENT_BYTES_OUTLOOK = 3 * 1024 * 1024;
export const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ORPHAN_UPLOAD_TTL_MS = 2 * 24 * 60 * 60 * 1000;

/** Scheduled send bounds (P4). */
export const SCHEDULE_MIN_LEAD_MS = 60_000;
export const SCHEDULE_MAX_LEAD_MS = 30 * 24 * 60 * 60 * 1000;

export function maxAttachmentBytesFor(provider: "gmail" | "outlook" | "demo"): number {
  return provider === "outlook" ? MAX_ATTACHMENT_BYTES_OUTLOOK : MAX_ATTACHMENT_BYTES_GMAIL;
}
```

Add to `smoke-email-recipients.ts`: `check("attachment limits per mailbox", maxAttachmentBytesFor("outlook") === 3 * 1024 * 1024 && maxAttachmentBytesFor("gmail") === 20 * 1024 * 1024);`

- [ ] **Step 3: Blob helpers** — in `src/lib/blob-lazy.ts`, add lazy `head`, `get`, `list` in the file's existing shape:

```ts
export async function head(...args: Parameters<typeof blobHead>): ReturnType<typeof blobHead> {
  const blob = await import("@vercel/blob");
  return blob.head(...args);
}
```

(same for `get` and `list`; import their types beside the existing `put`/`del` type imports).

- [ ] **Step 4: Run and commit**

Run: `npx tsc --noEmit -p . && npx tsx scripts/smoke-email-recipients.ts`
Expected: PASS.

```bash
git add src/lib/email/config.ts src/lib/blob-lazy.ts scripts/smoke-email-recipients.ts docs/superpowers/specs/2026-09-29-direct-email-design.md
git commit -m "feat(email): attachment and scheduling limits; lazy blob head/get/list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Attachment rules, verification and loading

**Files:**
- Create: `src/lib/email/attachments.ts`
- Test: `scripts/smoke-email-attachments.ts` (tier `pglite`)

**Interfaces:**
- Produces:
  - `ATTACHMENT_PREFIX = "email-attachments"`; `attachmentPrefixFor(userId): string` → `email-attachments/<userId>/`
  - `isBlockedFilename(name: string): boolean`
  - `safeFilename(name: string): string` — strips path separators/control chars, caps at 120 chars, never empty (`"attachment"`)
  - `type AttachmentInput = { pathname: string; filename: string }` (what the client sends)
  - `verifyAttachmentRefs(userId, inputs: AttachmentInput[], provider: EmailProviderId): Promise<{ ok: true; refs: EmailAttachmentRef[] } | { ok: false; reason: "too_many" | "too_large" | "blocked_type" | "not_found"; message: string }>`
  - `loadAttachmentBytes(refs: EmailAttachmentRef[]): Promise<{ filename: string; contentType: string; bytes: Uint8Array }[]>` — throws `MailProviderError("transient")` if a blob read fails (Blob outage) and `("permanent")` if a blob is gone (404)
  - `setAttachmentBlobClientForTests(client: { head; get; del; list } | null)`

`EmailAttachmentRef.blobKey` holds the blob **pathname** (for private) or URL (public fallback); `verifyAttachmentRefs` resolves either through `head`.

- [ ] **Step 1: Write the failing test** `scripts/smoke-email-attachments.ts`:

```ts
/**
 * Attachment rules: ownership by path prefix, real sizes from head(), per-mailbox limits,
 * blocked types, filename cleaning, and loading bytes. The blob client is faked.
 * Run: npx tsx scripts/smoke-email-attachments.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import {
  attachmentPrefixFor,
  isBlockedFilename,
  loadAttachmentBytes,
  safeFilename,
  setAttachmentBlobClientForTests,
  verifyAttachmentRefs,
} from "../src/lib/email/attachments";
import { MailProviderError } from "../src/lib/email/providers/types";

const USER = "user-a";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const store = new Map<string, { size: number; contentType: string; bytes: Uint8Array }>();
const MB = 1024 * 1024;
function putFake(pathname: string, size: number, contentType = "application/pdf") {
  store.set(pathname, { size, contentType, bytes: new Uint8Array(Math.min(size, 16)).fill(7) });
}
let outage = false;
setAttachmentBlobClientForTests({
  async head(p: string) {
    const b = store.get(p);
    if (!b) throw Object.assign(new Error("not found"), { name: "BlobNotFoundError" });
    return { pathname: p, url: `https://blob.test/${p}`, size: b.size, contentType: b.contentType };
  },
  async get(p: string) {
    if (outage) throw new Error("503");
    const b = store.get(p);
    return b ? { bytes: b.bytes } : null;
  },
  async del() {},
  async list() {
    return { blobs: [], hasMore: false, cursor: undefined };
  },
});

async function main() {
  const mine = attachmentPrefixFor(USER);
  check("prefix is user-scoped", mine === "email-attachments/user-a/");

  console.log("names and types");
  check("exe is blocked", isBlockedFilename("invoice.EXE") && isBlockedFilename("a.b.js"));
  check("pdf is fine", !isBlockedFilename("resume.pdf") && !isBlockedFilename("notes"));
  check("paths are stripped", safeFilename("../../etc/passwd") === "passwd" && safeFilename("C:\\x\\y.pdf") === "y.pdf");
  check("control chars stripped, never empty", safeFilename("a\u0000\r\nb.pdf") === "ab.pdf" && safeFilename("\u0000") === "attachment");

  console.log("verification");
  putFake(`${mine}1/resume.pdf`, 2 * MB);
  putFake(`${mine}2/deck.pdf`, 2 * MB);
  putFake("email-attachments/user-b/3/theirs.pdf", 1 * MB);
  const ok = await verifyAttachmentRefs(USER, [{ pathname: `${mine}1/resume.pdf`, filename: "resume.pdf" }], "gmail");
  check("own upload verifies, with the real size", ok.ok && ok.refs[0]!.size === 2 * MB && ok.refs[0]!.contentType === "application/pdf", JSON.stringify(ok));
  const foreign = await verifyAttachmentRefs(USER, [{ pathname: "email-attachments/user-b/3/theirs.pdf", filename: "x.pdf" }], "gmail");
  check("another user's upload is refused", !foreign.ok && foreign.reason === "not_found");
  const escape = await verifyAttachmentRefs(USER, [{ pathname: `${mine}../user-b/3/theirs.pdf`, filename: "x.pdf" }], "gmail");
  check("a traversal out of the prefix is refused", !escape.ok);
  const missing = await verifyAttachmentRefs(USER, [{ pathname: `${mine}9/gone.pdf`, filename: "gone.pdf" }], "gmail");
  check("a missing blob is refused", !missing.ok && missing.reason === "not_found");
  const blocked = await verifyAttachmentRefs(USER, [{ pathname: `${mine}1/resume.pdf`, filename: "run.exe" }], "gmail");
  check("a blocked name is refused", !blocked.ok && blocked.reason === "blocked_type");
  const twoForOutlook = await verifyAttachmentRefs(USER, [
    { pathname: `${mine}1/resume.pdf`, filename: "resume.pdf" },
    { pathname: `${mine}2/deck.pdf`, filename: "deck.pdf" },
  ], "outlook");
  check("4 MB is over Outlook's 3 MB", !twoForOutlook.ok && twoForOutlook.reason === "too_large" && /Outlook/.test(twoForOutlook.message), JSON.stringify(twoForOutlook));
  check("but fine for Gmail", (await verifyAttachmentRefs(USER, [
    { pathname: `${mine}1/resume.pdf`, filename: "resume.pdf" },
    { pathname: `${mine}2/deck.pdf`, filename: "deck.pdf" },
  ], "gmail")).ok);
  putFake(`${mine}4/huge.zip`, 21 * MB, "application/zip");
  check("21 MB is over Gmail's 20 MB", !(await verifyAttachmentRefs(USER, [{ pathname: `${mine}4/huge.zip`, filename: "huge.zip" }], "gmail")).ok);
  const eleven = Array.from({ length: 11 }, () => ({ pathname: `${mine}1/resume.pdf`, filename: "r.pdf" }));
  const tooMany = await verifyAttachmentRefs(USER, eleven, "gmail");
  check("11 files is too many", !tooMany.ok && tooMany.reason === "too_many");
  check("no attachments is fine", (await verifyAttachmentRefs(USER, [], "outlook")).ok);

  console.log("loading");
  const refs = ok.ok ? ok.refs : [];
  const loaded = await loadAttachmentBytes(refs);
  check("bytes load with the stored name and type", loaded.length === 1 && loaded[0]!.filename === "resume.pdf" && loaded[0]!.bytes.length > 0);
  outage = true;
  const outageErr = await loadAttachmentBytes(refs).then(() => null, (e) => e);
  check("a blob outage is transient", outageErr instanceof MailProviderError && outageErr.kind === "transient");
  outage = false;
  store.delete(`${mine}1/resume.pdf`);
  const goneErr = await loadAttachmentBytes(refs).then(() => null, (e) => e);
  check("a deleted blob is permanent", goneErr instanceof MailProviderError && goneErr.kind === "permanent");

  setAttachmentBlobClientForTests(null);
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll attachment checks passed.");
}

run(main);
```

Register `"smoke-email-attachments": "pglite",`.

- [ ] **Step 2: Run to verify failure** — `npx tsx scripts/smoke-email-attachments.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `src/lib/email/attachments.ts`:

```ts
import type { EmailAttachmentRef, EmailProviderId } from "@/db/schema";
import * as blob from "@/lib/blob-lazy";
import { MAX_ATTACHMENTS, maxAttachmentBytesFor } from "@/lib/email/config";
import { MailProviderError } from "@/lib/email/providers/types";

/**
 * Email attachments (direct-email P4). The browser uploads straight to Vercel Blob under
 * `email-attachments/<userId>/…` (token route: src/app/api/email/attachments/upload); the
 * composer then sends only pathnames. Nothing about a file is trusted from the client: the
 * owner comes from the path prefix, and size and type from Blob's own `head()`.
 *
 * <Task 1 findings: private vs public access on this store, SDK signatures.>
 */
export const ATTACHMENT_PREFIX = "email-attachments";
export const BLOB_ACCESS = "private" as const; // Task 1 may switch this to "public" (Decision 5).

export function attachmentPrefixFor(userId: string): string {
  return `${ATTACHMENT_PREFIX}/${userId}/`;
}

const BLOCKED = new Set(
  "ade adp apk appx appxbundle bat cab chm cmd com cpl diagcab diagcfg diagpack dll dmg ex ex_ exe hta img ins iso isp jar jnlp js jse lib lnk mde mjs msc msi msix msixbundle msp mst nsh pif ps1 scr sct shb sys vb vbe vbs vhd vxd wsc wsf wsh xll".split(" ")
);

/** Gmail refuses these outright; refusing them here gives a clear message instead of a bounce. */
export function isBlockedFilename(name: string): boolean {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return name.includes(".") && BLOCKED.has(ext);
}

export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = Array.from(base)
    .filter((ch) => ch.codePointAt(0)! >= 32 && ch.codePointAt(0) !== 127)
    .join("")
    .trim()
    .slice(0, 120);
  return clean || "attachment";
}

type BlobClient = {
  head(p: string): Promise<{ pathname: string; url: string; size: number; contentType: string }>;
  get(p: string): Promise<{ bytes: Uint8Array } | null>;
  del(p: string | string[]): Promise<void>;
  list(opts: { prefix: string; cursor?: string; limit?: number }): Promise<{
    blobs: { pathname: string; url: string; uploadedAt: Date }[];
    hasMore: boolean;
    cursor?: string;
  }>;
};

const realClient: BlobClient = {
  async head(p) {
    return blob.head(p);
  },
  async get(p) {
    // Adjust to the SDK shape confirmed in Task 1 (stream → bytes).
    const res = await blob.get(p, { access: BLOB_ACCESS });
    if (!res) return null;
    const bytes = new Uint8Array(await new Response(res.stream).arrayBuffer());
    return { bytes };
  },
  async del(p) {
    await blob.del(p);
  },
  async list(opts) {
    return blob.list(opts);
  },
};
let client: BlobClient = realClient;
/** Smoke tests only. */
export function setAttachmentBlobClientForTests(c: BlobClient | null) {
  client = c ?? realClient;
}
export function attachmentBlobClient(): BlobClient {
  return client;
}

export type AttachmentInput = { pathname: string; filename: string };
type VerifyFailure = { ok: false; reason: "too_many" | "too_large" | "blocked_type" | "not_found"; message: string };

function mb(bytes: number) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export async function verifyAttachmentRefs(
  userId: string,
  inputs: AttachmentInput[],
  provider: EmailProviderId
): Promise<{ ok: true; refs: EmailAttachmentRef[] } | VerifyFailure> {
  if (!inputs.length) return { ok: true, refs: [] };
  if (inputs.length > MAX_ATTACHMENTS) {
    return { ok: false, reason: "too_many", message: `Attach up to ${MAX_ATTACHMENTS} files` };
  }
  const prefix = attachmentPrefixFor(userId);
  const refs: EmailAttachmentRef[] = [];
  let total = 0;
  for (const input of inputs) {
    const pathname = String(input.pathname ?? "");
    if (!pathname.startsWith(prefix) || pathname.includes("..")) {
      return { ok: false, reason: "not_found", message: "One of those files isn’t available — attach it again" };
    }
    const filename = safeFilename(String(input.filename ?? ""));
    if (isBlockedFilename(filename)) {
      return { ok: false, reason: "blocked_type", message: `${filename} can’t be sent by email` };
    }
    let meta;
    try {
      meta = await client.head(pathname);
    } catch {
      return { ok: false, reason: "not_found", message: "One of those files isn’t available — attach it again" };
    }
    total += meta.size;
    refs.push({ blobKey: meta.pathname, filename, contentType: meta.contentType || "application/octet-stream", size: meta.size });
  }
  const cap = maxAttachmentBytesFor(provider);
  if (total > cap) {
    const where = provider === "outlook" ? "Outlook" : "Gmail";
    return { ok: false, reason: "too_large", message: `Attachments over ${mb(cap)} can’t be sent from ${where} — ${mb(total)} attached` };
  }
  return { ok: true, refs };
}

export async function loadAttachmentBytes(refs: EmailAttachmentRef[]) {
  const out: { filename: string; contentType: string; bytes: Uint8Array }[] = [];
  for (const ref of refs) {
    let got;
    try {
      got = await client.get(ref.blobKey);
    } catch (err) {
      throw new MailProviderError("transient", `attachment read failed: ${err instanceof Error ? err.message : err}`);
    }
    if (!got) throw new MailProviderError("permanent", `attachment ${ref.filename} is gone`);
    out.push({ filename: ref.filename, contentType: ref.contentType, bytes: got.bytes });
  }
  return out;
}
```

- [ ] **Step 4: Run** — `npx tsx scripts/smoke-email-attachments.ts && npx tsc --noEmit -p .` → PASS.

- [ ] **Step 5: Commit** — `git add src/lib/email/attachments.ts scripts/smoke-email-attachments.ts scripts/run-smoke.ts && git commit -m "feat(email): attachment ownership, limits and loading" …`

---

### Task 3: Upload token route

**Files:**
- Create: `src/app/api/email/attachments/upload/route.ts`
- Modify: `scripts/smoke-email-attachments.ts` (+ a source guard)

**Interfaces:** `POST /api/email/attachments/upload` — the `handleUploadUrl` for `upload()` from `@vercel/blob/client`. Clerk-authed (not in `PUBLIC_ROUTES`). Gated on `feature.compose` via `requireUserForSurface`.

- [ ] **Step 1: Implement** (adjust to the `handleUpload` shape confirmed in Task 1):

```ts
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { hasBlobStorage } from "@/lib/contact-avatar";
import { attachmentPrefixFor, BLOB_ACCESS, isBlockedFilename } from "@/lib/email/attachments";
import { MAX_ATTACHMENT_BYTES_GMAIL } from "@/lib/email/config";
import { requireUserForSurface } from "@/lib/plan-guards";
import { COMPOSE_SURFACE_KEY } from "@/lib/surfaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issues a one-file upload token for an email attachment. The browser uploads straight to Blob,
 * so the 4.5 MB function body limit never applies. The token is only good for a path under this
 * user's prefix; enqueue re-checks the prefix and reads the real size from Blob (P4 decision 4).
 * No completion callback: the send, not the upload, is what records an attachment.
 */
export async function POST(request: Request) {
  if (!hasBlobStorage()) return NextResponse.json({ error: "Attachments aren’t available" }, { status: 503 });
  const userId = await requireUserForSurface(COMPOSE_SURFACE_KEY);
  const body = (await request.json()) as HandleUploadBody;
  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(attachmentPrefixFor(userId)) || pathname.includes("..")) {
          throw new Error("Invalid upload path");
        }
        if (isBlockedFilename(pathname)) throw new Error("That file type can’t be sent by email");
        return {
          access: BLOB_ACCESS,
          addRandomSuffix: true,
          maximumSizeInBytes: MAX_ATTACHMENT_BYTES_GMAIL,
          tokenPayload: JSON.stringify({ userId }),
        };
      },
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(json);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Upload refused" }, { status: 400 });
  }
}
```

If `requireUserForSurface` throws for a signed-out or gated caller, let it propagate (the route 401s/404s the way other authed routes do — check one existing authed API route's pattern and mirror it). Check whether the proxy (`src/proxy.ts`) requires new API routes to be registered anywhere (e.g. `ROUTE_PATTERNS` is pages-only; `PUBLIC_ROUTES` must NOT include this route).

- [ ] **Step 2: Source guard** — append to `smoke-email-attachments.ts`:

```ts
  const route = (await import("node:fs")).readFileSync("src/app/api/email/attachments/upload/route.ts", "utf8");
  check("the token route is gated on Compose", route.includes("requireUserForSurface(COMPOSE_SURFACE_KEY)"));
  check("tokens are only for the user's own prefix", route.includes("attachmentPrefixFor(userId)"));
  const publicRoutes = (await import("node:fs")).readFileSync("src/lib/public-routes.ts", "utf8");
  check("the token route is not public", !publicRoutes.includes("/api/email/attachments"));
```

- [ ] **Step 3: Run and commit** — `npx tsx scripts/smoke-email-attachments.ts && npx tsc --noEmit -p . && npx tsx scripts/run-smoke.ts --only smoke-public-routes` → PASS; commit.

---

### Task 4: MIME `multipart/mixed` and provider support

**Files:**
- Modify: `src/lib/email/mime.ts`, `src/lib/email/providers/types.ts`, `providers/gmail.ts`, `providers/outlook.ts`
- Test: `scripts/smoke-email-mime.ts`, `smoke-email-provider-gmail.ts`, `smoke-email-provider-outlook.ts`

**Interfaces:**
- `MimeInput.attachments?: { filename: string; contentType: string; bytes: Uint8Array }[]` (so `OutboundMessage` gains it)
- `buildMime` returns `string` still; binary parts are base64 inside it (76-char lines).
- Gmail: when `msg.attachments?.length`, POST to `https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart` with `Content-Type: multipart/related; boundary=…`, part 1 `application/json; charset=UTF-8` = `{ threadId? }`, part 2 `message/rfc822` = the MIME (with Bcc header); 60s timeout. Otherwise unchanged.
- Outlook: `sendMailPayload` adds `message.attachments` as `fileAttachment`s; `send` throws `MailProviderError("permanent", …)` before any request if total raw bytes > `MAX_ATTACHMENT_BYTES_OUTLOOK` (defense in depth — enqueue already refuses).

- [ ] **Step 1: Failing tests.** In `smoke-email-mime.ts`:

```ts
const withFiles = buildMime(
  { ...base, bodyHtml: "<p>Hi</p>", attachments: [{ filename: "résumé.pdf", contentType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) }] },
  "B"
);
check("attachments make multipart/mixed", /^Content-Type: multipart\/mixed; boundary="B-mixed"$/m.test(withFiles));
check("the alternative part nests inside", withFiles.includes('Content-Type: multipart/alternative; boundary="B"'));
check("attachment is base64", withFiles.includes("Content-Transfer-Encoding: base64") && withFiles.includes("JVBERg=="));
check("non-ascii filenames use RFC 2231", /filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/.test(withFiles));
check("closing mixed boundary", withFiles.trimEnd().endsWith("--B-mixed--"));
const plainWithFile = buildMime({ ...base, attachments: [{ filename: "a.txt", contentType: "text/plain", bytes: new TextEncoder().encode("x") }] }, "C");
check("plain body is the first part of mixed", plainWithFile.indexOf('text/plain; charset="UTF-8"') < plainWithFile.indexOf('filename="a.txt"'));
```

In `smoke-email-provider-gmail.ts` (mock the upload URL): with `attachments`, the POST goes to `/upload/gmail/v1/users/me/messages/send?uploadType=multipart`, its body contains `message/rfc822`, and a `threadId` in `opts` appears in the JSON part; without attachments it still hits the JSON endpoint.

In `smoke-email-provider-outlook.ts`: `sendMailPayload` with one attachment has `message.attachments[0]["@odata.type"] === "#microsoft.graph.fileAttachment"` and base64 `contentBytes`; a 4 MB attachment makes `send` throw `permanent` **without** calling fetch.

Run them → FAIL.

- [ ] **Step 2: Implement.** `mime.ts` — add the field to `MimeInput` and restructure `buildMime`:

```ts
function base64Lines(bytes: Uint8Array): string {
  return (Buffer.from(bytes).toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

/** RFC 2231 for non-ASCII names; a quoted ASCII name otherwise. */
function dispositionFilename(name: string): string {
  const clean = sanitizeHeader(name).replace(/["\\]/g, "_");
  return isAscii(clean) ? `filename="${clean}"` : `filename*=UTF-8''${encodeURIComponent(clean)}`;
}
```

Build the body part (text or `multipart/alternative`) exactly as today into a string `inner` with its own `Content-Type` header lines; when `attachments?.length`, wrap:

```ts
  const mixed = `${boundary}-mixed`;
  headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
  const parts = [
    `--${mixed}\r\n${innerHeaders}\r\n\r\n${innerBody}`,
    ...input.attachments.map(
      (a) =>
        `--${mixed}\r\nContent-Type: ${sanitizeHeader(a.contentType)}; name="${sanitizeHeader(a.filename).replace(/["\\]/g, "_")}"\r\n` +
        `Content-Disposition: attachment; ${dispositionFilename(a.filename)}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(a.bytes)}`
    ),
  ];
  return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--${mixed}--\r\n`;
```

Keep the no-attachment output byte-for-byte identical (existing MIME checks must pass unchanged). Refactor so the inner part (plain or alternative) is produced once and reused.

`gmail.ts` — in `send`:

```ts
    const mime = withBccHeader(buildMime(msg), msg.bcc);
    const request = msg.attachments?.length
      ? (() => {
          const b = `orbit-rel-${crypto.randomUUID()}`;
          const meta = JSON.stringify(opts.threadId ? { threadId: opts.threadId } : {});
          return {
            url: "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart",
            headers: { "Content-Type": `multipart/related; boundary=${b}` },
            body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: message/rfc822\r\n\r\n${mime}\r\n--${b}--`,
            timeoutMs: 60_000,
          };
        })()
      : {
          url: `${API}/messages/send`,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts.threadId ? { raw: toBase64Url(mime), threadId: opts.threadId } : { raw: toBase64Url(mime) }),
          timeoutMs: 20_000,
        };
```

then `fetch(request.url, { method: "POST", headers: { Authorization: …, ...request.headers }, body: request.body, signal: AbortSignal.timeout(request.timeoutMs) })` with the existing error handling.

`outlook.ts` — `sendMailPayload`:

```ts
      ...(msg.attachments?.length
        ? {
            attachments: msg.attachments.map((a) => ({
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: a.filename,
              contentType: a.contentType,
              contentBytes: Buffer.from(a.bytes).toString("base64"),
            })),
          }
        : {}),
```

and at the top of `send`, `const total = (msg.attachments ?? []).reduce((n, a) => n + a.bytes.length, 0); if (total > MAX_ATTACHMENT_BYTES_OUTLOOK) throw new MailProviderError("permanent", "attachments over Outlook's sendMail limit");`.

- [ ] **Step 3: Run and commit** — `npx tsx scripts/run-smoke.ts --only smoke-email-mime smoke-email-provider-gmail smoke-email-provider-outlook && npx tsc --noEmit -p .` → PASS; commit `feat(email): multipart/mixed attachments for Gmail and Outlook`.

---

### Task 5: Outbox — attachments and scheduled send

**Files:**
- Modify: `src/lib/email/outbox.ts` (`EnqueueInput`, insert, dispatch, drain floor), `src/lib/email/compose.ts` (`ComposeInput`, `sendComposed`, `retryFailedSend`, `PendingSend`), `src/actions/email-compose.ts`
- Test: `scripts/smoke-email-schedule.ts` (tier `pglite`, new); extend `smoke-email-compose.ts`

**Interfaces:**
- `EnqueueInput.attachments?: EmailAttachmentRef[]` (already verified by the caller); `EnqueueInput.sendAt?: Date` — when set, overrides `delayMs` and must satisfy the schedule bounds (else refuse with new reason `"bad_schedule"`, copy "Pick a time between a minute and 30 days from now").
- `EnqueueRefusal` gains `"bad_schedule"`, `"too_large"`, `"too_many_files"`, `"blocked_type"`, `"file_missing"` (with `ENQUEUE_COPY` entries or passthrough messages from `verifyAttachmentRefs`).
- `ComposeInput.attachments?: AttachmentInput[]`; `ComposeInput.scheduledFor?: string` (ISO); `ComposeResult` success adds `scheduled: boolean`.
- `PendingSend` adds `scheduledFor: string | null` (= `sendAt` when later than `createdAt + UNDO_DELAY_MS + 5s`) and `attachments: { filename: string; size: number }[]`.
- Dispatch loads attachments: `const files = send.attachments.length ? await loadAttachmentBytes(send.attachments) : undefined;` placed inside the existing try so a `MailProviderError` from loading is classified like a send error; pass `attachments: files` in the `OutboundMessage`.
- Drain floor: `if (deadline - Date.now() < 30_000) break;` (was 22s) — an item with attachments can take a blob read plus a 60s Gmail upload; the lease is 120s, and a slow item simply finishes in the next run.

- [ ] **Step 1: Failing test** `scripts/smoke-email-schedule.ts`:

```ts
/**
 * Scheduled send: bounds, the drain waiting for the time, cancel, cap counting at creation,
 * and attachments carried from enqueue to the provider. Run: npx tsx scripts/smoke-email-schedule.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { setAttachmentBlobClientForTests } from "../src/lib/email/attachments";
import { cancelEmailSend, dispatchEmailSend, drainEmailSends, enqueueEmail } from "../src/lib/email/outbox";
import { setProviderOverride } from "../src/lib/email/providers";
import type { MailProvider, OutboundMessage } from "../src/lib/email/providers/types";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-schedule-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sent: OutboundMessage[] = [];
const fake: MailProvider = {
  id: "gmail",
  async identity() { return { email: "me@acme-corp.io" }; },
  async send(_u, msg) { sent.push(msg); return { providerMessageId: `pm-${sent.length}`, providerThreadId: null }; },
  async findSent() { return null; },
};
const base = { to: ["maya@work.io"], subject: "Later", bodyText: "Hi", origin: "compose" as const, delayMs: 10_000 };
const at = (ms: number) => new Date(Date.now() + ms);

async function main() {
  const db = await getDb();
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  setProviderOverride("gmail", fake);
  setAttachmentBlobClientForTests({
    async head(p) { return { pathname: p, url: p, size: 3, contentType: "text/plain" }; },
    async get() { return { bytes: new TextEncoder().encode("abc") }; },
    async del() {},
    async list() { return { blobs: [], hasMore: false }; },
  });
  try {
    await db.insert(schema.gmailConnections).values({
      userId: USER, emailAddress: "me@acme-corp.io", accessTokenEncrypted: encrypt("t"), refreshTokenEncrypted: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000), scopes: GOOGLE_SCOPES.gmailSend, status: "active",
    });
    const reset = () => db.execute(sql`DELETE FROM rate_limit_buckets WHERE bucket = ${`emailSend:${USER}`}`);

    console.log("bounds");
    await reset();
    const soon = await enqueueEmail(USER, { ...base, sendAt: at(10_000) });
    check("less than a minute out is refused", !soon.ok && soon.reason === "bad_schedule");
    const far = await enqueueEmail(USER, { ...base, sendAt: at(31 * 24 * 3600_000) });
    check("more than 30 days out is refused", !far.ok && far.reason === "bad_schedule");

    console.log("the drain waits for the time");
    const later = await enqueueEmail(USER, { ...base, sendAt: at(2 * 3600_000) });
    check("two hours out is queued", later.ok);
    await drainEmailSends({ budgetMs: 30_000, max: 50 });
    check("the drain leaves it alone", sent.length === 0);
    if (later.ok) {
      const r = await db.query.emailSends.findFirst({ where: eq(schema.emailSends.id, later.id) });
      check("send_at is the chosen time", Math.abs(r!.sendAt.getTime() - later.sendAt.getTime()) < 1000);
      await db.execute(sql`UPDATE email_sends SET send_at = now() - interval '1 second' WHERE id = ${later.id}::uuid`);
      await drainEmailSends({ budgetMs: 30_000, max: 50 });
      check("once due, the drain sends it", sent.length === 1);
    }

    console.log("cancel and cap");
    await reset();
    const toCancel = await enqueueEmail(USER, { ...base, sendAt: at(3600_000) });
    check("a scheduled send can be canceled", toCancel.ok && (await cancelEmailSend(USER, toCancel.id)) === "canceled");
    const [{ n }] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM email_sends WHERE user_id = ${USER} AND status IN ('queued','sending','sent')`)
    );
    check("scheduled sends count toward today's cap when created", Number(n) >= 1);

    console.log("attachments ride along");
    await reset();
    const withFile = await enqueueEmail(USER, {
      ...base,
      delayMs: 0,
      attachments: [{ blobKey: `email-attachments/${USER}/a/notes.txt`, filename: "notes.txt", contentType: "text/plain", size: 3 }],
    });
    if (withFile.ok) await dispatchEmailSend(withFile.id);
    const last = sent[sent.length - 1];
    check("the provider gets the file", last?.attachments?.[0]?.filename === "notes.txt" && last.attachments[0]!.bytes.length === 3, JSON.stringify(last?.attachments?.map((a) => a.filename)));
  } finally {
    setProviderOverride("gmail", null);
    setAttachmentBlobClientForTests(null);
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll schedule checks passed.");
}

run(main);
```

Register `"smoke-email-schedule": "pglite",`.

In `smoke-email-compose.ts` add: `sendComposed` with `attachments: [{ pathname: \`email-attachments/${USER}/x/a.pdf\`, filename: "a.pdf" }]` (fake blob client) queues a row whose `attachments[0].filename === "a.pdf"`; with `scheduledFor` two hours out returns `scheduled: true`; `retryFailedSend` of a failed row with attachments copies them.

Run → FAIL.

- [ ] **Step 2: Implement.**

`outbox.ts`:
- `EnqueueInput`: `attachments?: EmailAttachmentRef[]; sendAt?: Date;`.
- Before the burst charge: if `input.sendAt`, compute `lead = input.sendAt.getTime() - Date.now()` and refuse `bad_schedule` unless `SCHEDULE_MIN_LEAD_MS ≤ lead ≤ SCHEDULE_MAX_LEAD_MS`.
- Insert `sendAt: input.sendAt ? input.sendAt : sql\`now() + …delayMs…\``, `attachments: input.attachments ?? []`.
- Dispatch: load bytes inside the send `try` and pass `attachments: files`.
- Drain floor 30s.

`compose.ts` `sendComposed`: after content checks and before enqueue, resolve the provider the send will use (`resolveSender(userId, input.provider)`; on block return its refusal), then `verifyAttachmentRefs(userId, input.attachments ?? [], sender.provider)` → map failure `reason` to the new `EnqueueRefusal`s with its `message`. Parse `scheduledFor` (`new Date(iso)`; invalid → `bad_schedule`). Call `enqueueEmail` with `attachments: refs`, `sendAt`, and `provider: input.provider`. Return `scheduled: Boolean(sendAt)`.

`retryFailedSend`: pass `attachments: old.attachments`. `listContactPendingSends`: map `scheduledFor` and `attachments`.

`email-compose.ts` `sendComposedEmail`: pass `attachments` (validated as `{pathname, filename}` strings, max 10) and `scheduledFor` (string or undefined); call `scheduleDispatch` **only when** `!result.scheduled`.

- [ ] **Step 3: Run and commit** — `npx tsx scripts/run-smoke.ts --only smoke-email-schedule smoke-email-compose smoke-email-sends smoke-email-origins smoke-chat-send smoke-agent-sends smoke-toast-copy && npx tsc --noEmit -p .` → PASS; commit `feat(email): scheduled sends and attachments through the outbox`.

---

### Task 6: Sweep and purge

**Files:**
- Modify: `src/lib/email/attachments.ts` (+ `sweepEmailAttachments`, `purgeEmailAttachmentsForUser`), `src/app/api/imports/process-stalled/route.ts` (housekeeping block ~226-259, stats ~175), `src/lib/user-data.ts` (`contacts` step ~621)
- Test: extend `scripts/smoke-email-attachments.ts` (sweep, with the fake client) and rely on `smoke-purge` for rows

**Interfaces:**
- `sweepEmailAttachments(now = new Date(), limit = 200): Promise<{ settled: number; orphans: number }>`:
  1. **Settled sends:** in one statement, pick and clear, returning the refs that were there:
     ```sql
     WITH picked AS (
       SELECT id, attachments FROM email_sends
        WHERE attachments <> '[]'::jsonb
          AND status IN ('sent','canceled','failed')
          AND updated_at < $cutoff
        LIMIT $limit
        FOR UPDATE SKIP LOCKED
     )
     UPDATE email_sends e SET attachments = '[]'::jsonb
       FROM picked WHERE e.id = picked.id
     RETURNING picked.attachments
     ```
     then `del` every `blobKey` (best-effort, rows first).
  2. **Orphans:** `list({ prefix: "email-attachments/", limit: 1000 })` one page per run (cursor stored nowhere — each run restarts; fine at this volume), keep blobs with `uploadedAt < now - 2 days`, drop any whose pathname appears in a live row (`SELECT 1 FROM email_sends WHERE attachments @> jsonb_build_array(jsonb_build_object('blobKey', $p))`), `del` the rest.
- `purgeEmailAttachmentsForUser(userId)`: page through `list({ prefix: attachmentPrefixFor(userId) })` and `del` everything (covers sent, queued and orphaned uploads).

- [ ] **Step 1: Failing checks** in `smoke-email-attachments.ts` (make the fake `list`/`del` record calls): a row `sent` 8 days ago with one attachment gets its `attachments` emptied and its blob deleted; one sent 1 day ago is untouched; a listed orphan uploaded 3 days ago and unreferenced is deleted; one referenced by a queued row is kept; one uploaded 1 hour ago is kept. Use `USER`-scoped rows inserted via SQL and `purgeUserData` in `finally`.

- [ ] **Step 2: Implement** the two functions (best-effort `del`, never throw out of the sweep for a blob error; `reportError` with `where: "email.attachment-sweep"` at `warning`). In `process-stalled/route.ts` housekeeping block:

```ts
      const swept = await sweepEmailAttachments();
      stats.emailAttachmentsSwept = swept.settled + swept.orphans;
```

with a stats field `/** Email attachment blobs deleted: settled sends past ATTACHMENT_RETENTION_MS, and uploads never sent. */ emailAttachmentsSwept: 0,`. Only call it when `hasBlobStorage()`.

In `user-data.ts` `contacts` step, before `db.delete(emailSends)`: nothing to read (the prefix covers it); after the row deletes, `await purgeEmailAttachmentsForUser(userId).catch(() => {});` with the file's "after the rows: a Blob outage leaves orphaned objects, never undeleted people" convention (only when `hasBlobStorage()`).

- [ ] **Step 3: Run and commit** — `npx tsx scripts/run-smoke.ts --only smoke-email-attachments smoke-purge smoke-delete-partial && npx tsc --noEmit -p .` → PASS; commit `feat(email): sweep settled and orphaned attachment blobs; purge on delete`.

---

### Task 7: Schedule presets (pure)

**Files:**
- Create: `src/lib/email/schedule-presets.ts`
- Test: `scripts/smoke-schedule-presets.ts` (tier `pure`)

**Interfaces:**
- `schedulePresets(now: Date): { tomorrowMorning: Date; mondayMorning: Date }` — 8:00 local (the `Date`'s own zone = the browser's) tomorrow; 8:00 the coming Monday (if today is Monday, next Monday; if it's before 8:00 on a Monday — still next Monday, keep it simple and predictable).
- `atLocal(ymd: string, hhmm: string): Date` — local wall clock → instant.
- `timeOptions(): string[]` — `"06:00"` … `"22:30"` in 30-min steps.
- `formatScheduled(d: Date, now: Date): string` — `"around 8:00 AM tomorrow"`, `"around 8:00 AM Mon, Oct 6"`.

- [ ] **Step 1: Failing test** — run under a fixed zone so results are deterministic: the smoke sets `process.env.TZ = "America/New_York"` **before** any import (first line after the header). Checks:

```ts
const wed = new Date(2026, 8, 30, 15, 0); // Wed Sep 30 2026 15:00 local
const p = schedulePresets(wed);
check("tomorrow 8:00", p.tomorrowMorning.getDate() === 1 && p.tomorrowMorning.getHours() === 8 && p.tomorrowMorning.getMinutes() === 0);
check("Monday 8:00 is Oct 5", p.mondayMorning.getMonth() === 9 && p.mondayMorning.getDate() === 5 && p.mondayMorning.getDay() === 1 && p.mondayMorning.getHours() === 8);
const mon = new Date(2026, 9, 5, 7, 0);
check("on a Monday, Monday means next week", schedulePresets(mon).mondayMorning.getDate() === 12);
check("atLocal is wall-clock local", atLocal("2026-11-01", "09:30").getHours() === 9 && atLocal("2026-11-01", "09:30").getMinutes() === 30);
check("DST day still lands at the wall time", atLocal("2026-11-01", "08:00").getHours() === 8);
check("time options every 30 min", timeOptions()[0] === "06:00" && timeOptions().includes("22:30") && timeOptions().length === 34);
check("label says around", formatScheduled(p.tomorrowMorning, wed).startsWith("around 8:00"));
```

Register `"smoke-schedule-presets": "pure",`. Run → FAIL.

- [ ] **Step 2: Implement** with plain `Date` local-time setters (`new Date(y, m, d, 8, 0, 0, 0)`), `Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })` and `{ weekday: "short", month: "short", day: "numeric" }` for labels ("tomorrow" when the date is `now + 1 day`).

- [ ] **Step 3: Run and commit** — PASS; commit `feat(email): schedule presets and labels`.

---

### Task 8: Compose UI — Send menu, attachments, pending card

**Files:**
- Create: `src/components/email/schedule-menu.tsx`, `src/components/email/attachment-list.tsx`
- Modify: `src/components/email/compose-dialog.tsx`, `src/lib/email/compose.ts` (`ComposeContext.attachmentsAvailable`), `src/components/email/pending-sends.tsx`, `src/lib/compose-events.ts` (`ComposeRequest.attachments?`)

**Interfaces:**
- `ComposeContext.attachmentsAvailable: boolean` (= `hasBlobStorage()`), `ComposeContext.maxAttachmentBytes: number` (for the resolved/default mailbox).
- `ScheduleMenu({ disabled, onSendNow, onSchedule(d: Date) })` — a split button: main "Send" = send now (undo window); the chevron opens a `DropdownMenu` with "Tomorrow 8:00 AM", "Monday 8:00 AM", "Pick date & time…" (opens a small `Popover` with `MonthCalendar` from `src/components/ui/date-picker.tsx` + a `Select` of `timeOptions()`; confirm button). Labels come from `formatScheduled`.
- `AttachmentList({ items, onRemove })` — chips: filename, `formatUploadSize(size)` (from `src/lib/capture-limits.ts`), a progress bar while uploading, an error state, and a remove button.
- Compose state: `attachments: { id: string; filename: string; size: number; pathname?: string; progress: number; error?: string }[]`.

- [ ] **Step 1: Implement.**
  - Attach button (paperclip icon) next to "Draft with AI", shown only when `ctx.attachmentsAvailable`; a hidden `<input type="file" multiple>`; and an element-scoped drop on the dialog body (`onDragOver` prevent default, `onDrop` reads `e.dataTransfer.files` synchronously before any await — the same rule `use-window-file-drop.ts` documents). Do **not** use `useWindowFileDrop` (it cancels drops window-wide).
  - For each file: refuse blocked names and anything that would push the total over `ctx.maxAttachmentBytes` (toast `"<name> is too big for <Gmail|Outlook> — <limit> total"`) before uploading; otherwise `upload(\`${prefixForClient}/${crypto.randomUUID()}/${safeName}\`, file, { access: BLOB_ACCESS, handleUploadUrl: "/api/email/attachments/upload", onUploadProgress: ({ percentage }) => … })` from `@vercel/blob/client`, then store `pathname` from the result. `prefixForClient` = `email-attachments/<userId>` — pass `userId` (already a prop of the dialog) and duplicate the prefix rule in a tiny client-safe helper, or export `attachmentPrefixFor` from a client-safe module (`src/lib/email/attachment-paths.ts`, no blob imports) and have `attachments.ts` re-export it. Prefer the latter.
  - Changing the From mailbox re-checks the total against the new limit and shows the message inline (Outlook 3 MB).
  - Send disabled while any upload is in flight. Send passes `attachments: items.filter((a) => a.pathname).map(({ pathname, filename }) => ({ pathname: pathname!, filename }))`.
  - Replace the Send button with `ScheduleMenu`. `onSchedule(d)` calls `sendComposedEmail({ ..., scheduledFor: d.toISOString() })`; on success close, clear draft, and toast `"Scheduled — ${formatScheduled(d, new Date())}"` with an Undo action that calls `cancelEmailSendAction` (reuse `showUndoSendToast`'s shape with a custom message; extend it with an optional `message` and `durationMs`).
  - Update the dialog description when a schedule is chosen? No — keep "Sends from your own email after a 10-second undo window." and let the menu labels carry scheduling.
  - `pending-sends.tsx`: a queued row with `scheduledFor` shows `Scheduled ${formatScheduled(new Date(s.scheduledFor), new Date())}` and an **Edit** button (cancel it, then `openCompose({ contactId, to, subject, body, attachments })`); rows list attachment count ("· 2 files"). `ComposeRequest.attachments` prefills the attachment list as already-uploaded chips.

- [ ] **Step 2: Typecheck, lint, smokes**

Run: `npx tsc --noEmit -p . && npm run lint && npx tsx scripts/run-smoke.ts --only smoke-email-compose smoke-toast-copy smoke-behavior-golden smoke-action-user-scope`
Expected: 0 errors; PASS.

- [ ] **Step 3: Commit** — `feat(email): schedule and attach in Compose`.

---

### Task 9: Verification

- [ ] **Step 1: Full suite and build** (never pipe `npm test` through `tail`; no dev server on this `.next`):

```bash
npm run test:check
npm test > /tmp/p4-smoke.log 2>&1; echo "exit=$?"; grep "passed in" /tmp/p4-smoke.log
npx tsc --noEmit -p .
npm run lint
npm run build
```

Line-number allowlists (`smoke-provider-exhaustive`) may shift — renumber, never change reasons.

- [ ] **Step 2: Browser pass** (`rm -rf .next`, start `orbit-web`, temporarily remove `comingSoon` from `feature.compose` only, restore before committing). Without a local `BLOB_READ_WRITE_TOKEN` the attach control must be hidden — check that. Then:
  1. Send ▾ shows "Tomorrow 8:00 AM" and "Monday 8:00 AM" with correct dates; "Pick date & time…" lets you choose.
  2. Scheduling closes the dialog with "Scheduled — around …" and Undo cancels it.
  3. The contact page shows the scheduled row with its time, Cancel and Edit; Edit reopens Compose prefilled.
  4. With a Blob token (if available): attach a PDF, see progress, remove it, re-add; pick Outlook in From with > 3 MB attached → inline error; send with Gmail.

- [ ] **Step 3: Manual acceptance on a preview (owed by Jason):** real Gmail send with two attachments (one non-ASCII name) arrives intact; Outlook send with a 1 MB attachment arrives; a scheduled send lands within ~10 minutes of its time; the hourly sweep log (`cron_runs` for `imports.process-stalled`) shows `emailAttachmentsSwept` after 7 days (or run the sweep from a script with `now` shifted).

---

## PR notes

- Stacked on #382 (P3) → #379 → #374.
- Still behind `feature.compose` (coming-soon); nothing user-visible until Compose is released.
- New authed route: `POST /api/email/attachments/upload` (Blob client-upload tokens, user-prefixed paths, Compose-gated).
- Blob: `email-attachments/<userId>/…` (private if the store supports it — see Task 1 finding); hourly sweep deletes blobs 7 days after a send settles and uploads never sent after 2 days; account deletion clears the prefix.
- Limits: 10 files; 20 MB total from Gmail, 3 MB from Outlook (Mail.Send only).
- Scheduled sends land within ~10 minutes of the chosen time (drain cadence) and count toward the day they're created.
- No schema change.
