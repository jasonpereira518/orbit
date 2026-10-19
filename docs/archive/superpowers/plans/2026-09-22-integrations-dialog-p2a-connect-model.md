# Integrations P2a — Connect model, plan gates and connection fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one "Connect" ask Google (and Microsoft) for contacts and calendar together, take the paid-plan gate off connecting and calendar sync while keeping the recruiter inbox scan on Pro, let meetings be switched off and back on, and fix the four connection bugs the audits found — all server-side, with no UI change.

**Architecture:** The OAuth start actions and their callbacks learn to carry a *list* of purposes (state field 4 becomes `contacts+calendar`), and a partial grant becomes a successful connect. The upserts stop arming calendar sync for grants that never included calendar, and stop inheriting the previous account's scopes and cursor when someone connects a different account. `requireSyncUser` comes off connecting; the recruiter scan moves to the recruiters entitlement; `friendlyError` learns to show paywall messages. `provider-connections.ts` gains an explicit user pause, and `ConnectionHealth` gains a `paused` state so the UI can tell "you turned it off" from "it broke". P2b then builds the account pages on top.

**Tech Stack:** Next.js 16 App Router (server actions + route handlers), TypeScript, Drizzle + Postgres/PGlite, `tsx` smoke scripts, the `typescript` compiler API for source-level guards.

**Spec:** `docs/superpowers/specs/2026-09-22-integrations-dialog-simplification-design.md` — this is the first half of its P2 row. The second half (the account pages that render these capabilities) is P2b, planned separately once this lands.

## Global Constraints

- Branch `claude/integrations-p2-accounts`, stacked on P1 (`claude/settings-popup-redesign-0ed30d`, PR #257). Do not merge or rebase P1; do not touch `docs/superpowers/plans/2026-09-22-integrations-dialog-p1-shell.md`.
- **No UI change in this plan.** `/imports`, `/recruiters`, `/events` and the Settings dialog must behave exactly as they do today, except: a free user's Connect now works, and a contacts-only grant no longer reports "Calendar sync paused". Component edits are limited to what a changed function signature forces.
- Spec decisions that bind every task: Connect asks for contacts + calendar; mail features ask on first use; **everything Google/Microsoft is free except the recruiter inbox scan**, which stays Pro/Lifetime; a partial grant is a successful connect.
- `"use server"` files export only async functions and inline `export type X = …` — never `export type { … }` re-exports, never non-async values.
- `src/lib/connection-status.ts` and `src/lib/integration-status.ts` stay pure and client-safe: no DB, no `next/*`, no server-only imports.
- Never name `gmail_connections` / `outlook_connections` in new code outside `provider-connections.ts` and the existing `gmail.ts` / `outlook.ts` modules — go through `PROVIDER_TABLES` (see that file's header).
- Scope tokens are compared with the existing helpers (`grantCovers`, `hasScope`, `normalizeScope`), never with `includes()` on the raw string.
- Callback URLs never carry a provider's raw error text — only codes (`missing_scope`, `oauth_failed`, the provider's own error code).
- Every new smoke script is registered in `scripts/run-smoke.ts` `MANIFEST`; database-tier scripts start with `import "./smoke/_env";` and never set `SMOKE_ALLOW_REMOTE`.
- Copy rules: curly apostrophes (’) in user-facing strings; toasts follow `scripts/smoke-toast-copy.ts`; plan/pricing copy is edited only where a task says so.
- Baselines: `npx tsc --noEmit` clean; `npx eslint` 0 errors (3 pre-existing warnings in untouched settings files are the baseline).
- Per `AGENTS.md`, read the relevant guide in `node_modules/next/dist/docs/` before using any Next API not already used in the file you're editing.

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/google-scopes.ts` | modify | Purpose lists: scopes for many purposes, serialise/parse, `missingPurposes`, `CONNECT_PURPOSES` |
| `src/lib/microsoft-scopes.ts` | modify | Same for Graph, keeping the carry-forward of already-granted scopes |
| `src/lib/gmail.ts` | modify | `buildGmailAuthUrl(state, purposes)`; upsert: arm-only-with-calendar, account-switch reset, returns `switchedFrom` |
| `src/lib/outlook.ts` | modify | Same three changes for Microsoft |
| `src/actions/gmail.ts` | modify | `startGmailOAuth({purposes})`, state with purpose list, gate → `requireUserId`, scan actions → recruiters gate, `setCalendarSync`, disconnect cleanup |
| `src/actions/outlook.ts` | modify | Same, minus `send` |
| `src/app/api/gmail/callback/route.ts` | modify | Validate a list of purposes; partial grant = success; `switched` param |
| `src/app/api/outlook/callback/route.ts` | modify | Same |
| `src/lib/provider-connections.ts` | modify | `pauseSync` / `resumeSync` |
| `src/lib/connection-status.ts` | modify | `ConnectionHealth` gains `"paused"`; derivation reads `syncStatus` |
| `src/lib/integration-status.ts` | modify | Meetings capability: `off` (user) vs `paused` (broken) |
| `src/lib/errors.ts` | modify | `friendlyError` shows paywall messages |
| `src/actions/imports.ts` | modify | Outlook contacts preview/confirm check `Contacts.Read` |
| `src/lib/contact-avatar-connectors.ts` | modify | Outlook avatar index checks `Contacts.Read` |
| `src/lib/env.ts` | modify | `MICROSOFT_*` in `EXPECTED_IN_PRODUCTION` |
| `scripts/smoke-google-scopes.ts`, `smoke-microsoft-scopes.ts`, `smoke-connection-status.ts`, `smoke-integration-status.ts`, `smoke-gmail-scope-storage.ts`, `smoke-outlook-scope-storage.ts`, `smoke-provider-connections.ts` | modify | Extend for the new behaviour |
| `scripts/smoke-connect-gates.ts` | create | Source-level guard: which gate each action uses, plus `friendlyError` on a paywall |
| `scripts/run-smoke.ts` | modify | Register the new smoke |

---

### Task 1: Ask for several purposes in one consent screen

**Files:**
- Modify: `src/lib/google-scopes.ts`, `src/lib/microsoft-scopes.ts`
- Modify: `src/lib/gmail.ts` (`buildGmailAuthUrl`), `src/lib/outlook.ts` (`buildMicrosoftAuthUrl`)
- Modify: `src/actions/gmail.ts` (`startGmailOAuth`, `consumeGmailOAuthState`), `src/actions/outlook.ts` (same pair)
- Test: `scripts/smoke-google-scopes.ts`, `scripts/smoke-microsoft-scopes.ts`

**Interfaces:**
- Consumes: existing `GooglePurpose`, `MicrosoftPurpose`, `PURPOSE_SCOPE`, `IDENTITY_SCOPES`, `grantCovers`, `hasScope`.
- Produces (used by Tasks 2–4):
  - `googleScopesFor(purposes: readonly GooglePurpose[]): GoogleScope[]`
  - `GOOGLE_CONNECT_PURPOSES: readonly GooglePurpose[]` = `["contacts", "calendar"]`
  - `missingGooglePurposes(purposes: readonly GooglePurpose[], scopes: string | null | undefined): GooglePurpose[]`
  - `serializeGooglePurposes(purposes: readonly GooglePurpose[]): string`, `parseGooglePurposes(raw: string | null | undefined): GooglePurpose[]`
  - Microsoft twins: `microsoftScopesFor(purposes: readonly MicrosoftPurpose[], alreadyGranted?: string | null)`, `MICROSOFT_CONNECT_PURPOSES`, `missingMicrosoftPurposes`, `serializeMicrosoftPurposes`, `parseMicrosoftPurposes`
  - `startGmailOAuth(input: { purpose?: GooglePurpose; purposes?: readonly GooglePurpose[]; returnTo?: string }): Promise<{ url: string }>` (same for Outlook with `MicrosoftPurpose`)
  - `consumeGmailOAuthState(state)` → `{ userId: string; returnTo: string; purposes: GooglePurpose[] }` (same for Outlook)

- [ ] **Step 1: Write the failing scope checks**

In `scripts/smoke-google-scopes.ts`, add before its final failure summary (keep the existing checks; they must keep passing):

```ts
console.log("\nconnecting to several features at once");
const connect = googleScopesFor(GOOGLE_CONNECT_PURPOSES);
check("one connect asks for contacts and calendar", connect.includes(GOOGLE_SCOPES.contacts) && connect.includes(GOOGLE_SCOPES.calendar));
check("and never for mail", !connect.includes(GOOGLE_SCOPES.gmailRead) && !connect.includes(GOOGLE_SCOPES.gmailSend));
check("identity scopes ride along once", connect.filter((s) => s === GOOGLE_SCOPES.openid).length === 1);
check("a repeated purpose asks once", googleScopesFor(["contacts", "contacts"]).filter((s) => s === GOOGLE_SCOPES.contacts).length === 1);
check("one purpose still works", googleScopesFor(["recruiter_scan"]).includes(GOOGLE_SCOPES.gmailRead));

console.log("\nwhat the consent screen came back with");
const both = `${GOOGLE_SCOPES.contacts} ${GOOGLE_SCOPES.calendar}`;
check("nothing missing when both were granted", missingGooglePurposes(GOOGLE_CONNECT_PURPOSES, both).length === 0);
check(
  "calendar unticked is reported, contacts is not",
  missingGooglePurposes(GOOGLE_CONNECT_PURPOSES, GOOGLE_SCOPES.contacts).join(",") === "calendar"
);
check("nothing granted reports both", missingGooglePurposes(GOOGLE_CONNECT_PURPOSES, "").length === 2);

console.log("\ncarrying the purposes through the consent round trip");
check("a list round-trips", parseGooglePurposes(serializeGooglePurposes(GOOGLE_CONNECT_PURPOSES)).join(",") === "contacts,calendar");
check("a consent screen already in flight still parses", parseGooglePurposes("recruiter_scan").join(",") === "recruiter_scan");
check("junk is dropped, not trusted", parseGooglePurposes("contacts+nonsense").join(",") === "contacts");
check("empty is empty", parseGooglePurposes("").length === 0 && parseGooglePurposes(null).length === 0);
```

Add the new names to that file's import list. Mirror the same block in `scripts/smoke-microsoft-scopes.ts` using `MICROSOFT_SCOPES.contacts` / `.calendar` / `.mail`, `MICROSOFT_CONNECT_PURPOSES`, `missingMicrosoftPurposes`, `parseMicrosoftPurposes`, `serializeMicrosoftPurposes`, plus one Graph-specific check:

```ts
check(
  "a grant stored in Graph's other spelling still counts",
  missingMicrosoftPurposes(MICROSOFT_CONNECT_PURPOSES, "contacts.read https://graph.microsoft.com/Calendars.Read").length === 0
);
check(
  "connecting keeps a mail scope the account already had",
  microsoftScopesFor(MICROSOFT_CONNECT_PURPOSES, MICROSOFT_SCOPES.mail).includes(MICROSOFT_SCOPES.mail)
);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx scripts/smoke-google-scopes.ts`
Expected: FAIL — `googleScopesFor` is not exported with that signature / `GOOGLE_CONNECT_PURPOSES` undefined.

- [ ] **Step 3: Teach the scope modules about lists**

In `src/lib/google-scopes.ts`, replace `googleScopesFor` and add the helpers below it:

```ts
/** What one Connect asks for: the everyday features, never mail (see the spec's consent decision). */
export const GOOGLE_CONNECT_PURPOSES: readonly GooglePurpose[] = ["contacts", "calendar"];

/** The scopes one consent screen should ask for, identity included, each listed once. */
export function googleScopesFor(purposes: readonly GooglePurpose[]): GoogleScope[] {
  return [...new Set<GoogleScope>([...IDENTITY_SCOPES, ...purposes.map((p) => PURPOSE_SCOPE[p])])];
}

/**
 * Which of the requested purposes the grant does not cover. Google's granular consent lets
 * people untick boxes, so a connect can come back covering some of what it asked for.
 */
export function missingGooglePurposes(
  purposes: readonly GooglePurpose[],
  scopes: string | null | undefined
): GooglePurpose[] {
  return purposes.filter((purpose) => !grantCovers(purpose, scopes));
}

/** How the purpose list rides in the OAuth state and comes back on the URL. */
export function serializeGooglePurposes(purposes: readonly GooglePurpose[]): string {
  return purposes.join("+");
}

/** Tolerates a single purpose — a consent screen opened before this shipped says just `contacts`. */
export function parseGooglePurposes(raw: string | null | undefined): GooglePurpose[] {
  return (raw ?? "").split("+").filter(isGooglePurpose);
}
```

Keep `googleScopesFor`'s old single-purpose callers compiling by updating them (next step). Make the same edit in `src/lib/microsoft-scopes.ts`, where the function keeps its carry-forward behaviour:

```ts
/** What one Connect asks for. Microsoft has no mail-free equivalent of `event_mail`. */
export const MICROSOFT_CONNECT_PURPOSES: readonly MicrosoftPurpose[] = ["contacts", "calendar"];

/**
 * The scopes one consent screen should ask for. Microsoft has no `include_granted_scopes`, so
 * every Orbit scope the account already granted is re-requested alongside the new ones —
 * otherwise consenting to one feature drops the others.
 */
export function microsoftScopesFor(
  purposes: readonly MicrosoftPurpose[],
  alreadyGranted?: string | null
): MicrosoftScope[] {
  const wanted = new Set<MicrosoftScope>([...IDENTITY_SCOPES, ...purposes.map((p) => PURPOSE_SCOPE[p])]);
  for (const purpose of MICROSOFT_PURPOSES) {
    if (hasScope(alreadyGranted, PURPOSE_SCOPE[purpose])) wanted.add(PURPOSE_SCOPE[purpose]);
  }
  return [...wanted];
}

export function missingMicrosoftPurposes(
  purposes: readonly MicrosoftPurpose[],
  scopes: string | null | undefined
): MicrosoftPurpose[] {
  return purposes.filter((purpose) => !grantCovers(purpose, scopes));
}

export function serializeMicrosoftPurposes(purposes: readonly MicrosoftPurpose[]): string {
  return purposes.join("+");
}

export function parseMicrosoftPurposes(raw: string | null | undefined): MicrosoftPurpose[] {
  return (raw ?? "").split("+").filter(isMicrosoftPurpose);
}
```

Run: `npx tsx scripts/smoke-google-scopes.ts && npx tsx scripts/smoke-microsoft-scopes.ts` — Expected: all ok.

- [ ] **Step 4: Carry the list through the auth URL and the state**

In `src/lib/gmail.ts`, change `buildGmailAuthUrl(state: string, purpose: GooglePurpose)` to take `purposes: readonly GooglePurpose[]` and pass them to `googleScopesFor`. Same for `buildMicrosoftAuthUrl(state, purposes, alreadyGranted)` in `src/lib/outlook.ts`.

In `src/actions/gmail.ts`, replace the head of `startGmailOAuth` and the state line:

```ts
export async function startGmailOAuth(input: {
  /** One purpose — the way every feature button asks. */
  purpose?: GooglePurpose;
  /** Several at once — what Connect sends (`GOOGLE_CONNECT_PURPOSES`). */
  purposes?: readonly GooglePurpose[];
  returnTo?: string;
}): Promise<{ url: string }> {
  const purposes = input.purposes ?? (input.purpose ? [input.purpose] : []);
  if (purposes.length === 0 || !purposes.every(isGooglePurpose)) {
    throw new Error("Unknown Google connection purpose");
  }
```

and, where the state string is built:

```ts
  const state = `${userId}:${crypto.randomUUID()}:${encodeURIComponent(safeReturnTo)}:${serializeGooglePurposes(purposes)}`;
```

with the URL built as `buildGmailAuthUrl(state, purposes)`.

In `consumeGmailOAuthState`, replace the purpose field with the list:

```ts
  return { userId, returnTo, purposes: parseGooglePurposes(rawPurpose) };
```

Make the same four edits in `src/actions/outlook.ts` (its auth URL call also passes `existing?.scopes`).

- [ ] **Step 5: Fix the callers the signature broke**

Run: `npx tsc --noEmit`. Every error is a call site reading `.purpose` off the consumed state, or passing a single purpose to a builder. Fix each by using the list: the two callbacks are Task 3's subject, so for now make them compile with `const [purpose] = purposes;` and their existing logic. Do not change component call sites — `startGmailOAuth({ purpose: … })` still typechecks.

- [ ] **Step 6: Typecheck, lint, smoke, commit**

Run: `npx tsc --noEmit`; `npx eslint src/lib src/actions`; `npx tsx scripts/smoke-google-scopes.ts`; `npx tsx scripts/smoke-microsoft-scopes.ts`; `npx tsx scripts/smoke-gmail-scope-storage.ts`; `npx tsx scripts/smoke-outlook-scope-storage.ts`.
Expected: clean, 0 errors, all ok.

```bash
git add src/lib/google-scopes.ts src/lib/microsoft-scopes.ts src/lib/gmail.ts src/lib/outlook.ts src/actions/gmail.ts src/actions/outlook.ts scripts/smoke-google-scopes.ts scripts/smoke-microsoft-scopes.ts
git commit -m "Ask Google and Microsoft for several features in one consent screen"
```

---

### Task 2: Arm calendar sync only when calendar was granted, and don't inherit another account

**Files:**
- Modify: `src/lib/gmail.ts` (`upsertGmailConnection`), `src/lib/outlook.ts` (`upsertOutlookConnection`)
- Modify: `src/app/api/gmail/callback/route.ts`, `src/app/api/outlook/callback/route.ts` (they consume the upsert's return)
- Test: `scripts/smoke-gmail-scope-storage.ts`, `scripts/smoke-outlook-scope-storage.ts`

**Interfaces:**
- Consumes: `unionScopes`, `hasCalendarScope` (both providers), the connection rows.
- Produces (used by Task 3): `upsertGmailConnection(userId, tokens, emailAddress)` → `Promise<{ row: GmailConnectionRow; switchedFrom: string | null }>`; Outlook twin identical in shape.

Two defects are fixed here. **Arming:** every connect sets `next_sync_at = now()` whatever it asked for, so a contacts-only grant gets claimed by the scheduler, which disarms it with "Calendar access not granted…", and the UI then tells someone who never asked for calendar that their calendar sync is paused. **Inheriting:** the upsert keys on `user_id` only, so connecting a *different* Google account overwrites the email while keeping the old account's scope union and sync cursor.

- [ ] **Step 1: Write the failing storage checks**

In `scripts/smoke-gmail-scope-storage.ts`, add (adapting the file's existing helpers for building token responses and reading the row back):

```ts
console.log("\narming calendar sync");
await resetConnection();
await upsertGmailConnection(USER, tokensWithScope(GOOGLE_SCOPES.contacts), "jo@gmail.com");
check("a contacts-only connect is not queued for calendar sync", (await readRow())?.nextSyncAt === null);
await upsertGmailConnection(USER, tokensWithScope(`${GOOGLE_SCOPES.contacts} ${GOOGLE_SCOPES.calendar}`), "jo@gmail.com");
check("granting calendar queues it", (await readRow())?.nextSyncAt !== null);
await upsertGmailConnection(USER, tokensWithScope(GOOGLE_SCOPES.gmailRead), "jo@gmail.com");
check("a later mail-only connect leaves calendar queued", (await readRow())?.nextSyncAt !== null);

console.log("\nconnecting a different account");
await resetConnection();
await upsertGmailConnection(USER, tokensWithScope(`${GOOGLE_SCOPES.contacts} ${GOOGLE_SCOPES.calendar}`), "jo@gmail.com");
await db.update(gmailConnections).set({ syncCursor: { calendar: { syncToken: "old" } } }).where(eq(gmailConnections.userId, USER));
const switched = await upsertGmailConnection(USER, tokensWithScope(GOOGLE_SCOPES.contacts), "someone-else@gmail.com");
check("the switch is reported", switched.switchedFrom === "jo@gmail.com");
const after = await readRow();
check("the new account's email is stored", after?.emailAddress === "someone-else@gmail.com");
check("the old account's scopes are dropped", !hasCalendarScope(after?.scopes));
check("the old account's cursor is dropped", after?.syncCursor === null);
check("the same account keeps its scopes", (await upsertGmailConnection(USER, tokensWithScope(GOOGLE_SCOPES.calendar), "someone-else@gmail.com")).switchedFrom === null);
check("case and spacing don't count as a switch", (await upsertGmailConnection(USER, tokensWithScope(GOOGLE_SCOPES.calendar), " Someone-Else@Gmail.com ")).switchedFrom === null);
```

Mirror it in `scripts/smoke-outlook-scope-storage.ts` with `MICROSOFT_SCOPES` and `outlookConnections`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx scripts/smoke-gmail-scope-storage.ts`
Expected: FAIL — the contacts-only row is queued (`nextSyncAt` is a date), and `upsertGmailConnection` returns a row, not `{ row, switchedFrom }`.

- [ ] **Step 3: Rewrite the upserts**

In `src/lib/gmail.ts`, inside `upsertGmailConnection`, before the update/insert:

```ts
  const normalized = emailAddress?.trim().toLowerCase() ?? null;
  const previous = existing?.emailAddress?.trim().toLowerCase() ?? null;
  // A different Google account is a different mailbox and a different calendar: its grant
  // cannot inherit the last account's scopes, and its cursor would resume a sync that never
  // happened here. The row is keyed by Orbit's user, so this is the only place to notice.
  const switchedFrom = previous && normalized && previous !== normalized ? existing!.emailAddress : null;
  const scopes = switchedFrom ? unionScopes(null, tokens.scope) : unionScopes(existing?.scopes, tokens.scope);
  // Only a grant that covers calendar belongs in the sync queue. Arming a contacts-only grant
  // made the scheduler claim it once, disarm it for a missing scope, and leave the UI saying
  // "Calendar sync paused" to someone who never asked for calendar.
  const armed = hasCalendarScope(scopes);
```

Then, on the existing-row update, replace the scope and sync columns with:

```ts
      scopes,
      status: "active",
      nextSyncAt: armed ? new Date() : switchedFrom ? null : (existing?.nextSyncAt ?? null),
      syncFailures: 0,
      syncError: null,
      ...(switchedFrom ? { syncCursor: null, syncStatus: null, syncStartedAt: null, lastSyncedAt: null } : {}),
      updatedAt: new Date(),
```

and on the insert path use `scopes` and `nextSyncAt: armed ? new Date() : null`.

Return both values:

```ts
  return { row, switchedFrom };
```

Update the function's doc comment to say what it now decides. Make the same change in `src/lib/outlook.ts` (same field names; `hasCalendarScope` there comes from `microsoft-scopes.ts`).

- [ ] **Step 4: Fix the callbacks' use of the return value**

In both callback routes, change `const connection = await upsertGmailConnection(...)` to:

```ts
    const { row: connection, switchedFrom } = await upsertGmailConnection(sessionUserId, tokens, email);
```

and leave the rest of their logic alone for now (Task 3 uses `switchedFrom`).

- [ ] **Step 5: Run the smokes, typecheck, lint, commit**

Run: `npx tsx scripts/smoke-gmail-scope-storage.ts`; `npx tsx scripts/smoke-outlook-scope-storage.ts`; `npx tsx scripts/smoke-provider-connections.ts`; `npx tsx scripts/smoke-sync-scheduler.ts`; `npx tsc --noEmit`; `npx eslint src/lib src/app/api`.
Expected: all ok, clean, 0 errors.

```bash
git add src/lib/gmail.ts src/lib/outlook.ts src/app/api/gmail/callback/route.ts src/app/api/outlook/callback/route.ts scripts/smoke-gmail-scope-storage.ts scripts/smoke-outlook-scope-storage.ts
git commit -m "Queue calendar sync only for grants that include calendar, and never inherit another account"
```

---

### Task 3: A partial grant is a successful connect

**Files:**
- Modify: `src/app/api/gmail/callback/route.ts`, `src/app/api/outlook/callback/route.ts`
- Test: `scripts/smoke-oauth-return.ts` (extend), plus the callback's own reasoning verified by Task 6's manual checklist

**Interfaces:**
- Consumes: Task 1's `missingGooglePurposes` / `missingMicrosoftPurposes`, `serialize*Purposes`; Task 2's `switchedFrom`.
- Produces: callback URL contract — `google`/`gmail` (or `outlook`) ∈ `connected|error`; `reason` ∈ `missing_scope|oauth_failed|<provider code>`; `purpose` = the purpose the copy should talk about; **new** `switched=1` when the account changed. P2b's pages read these.

Today the callback fails the whole connect when *any* requested purpose is missing. With two purposes that is wrong: Google's granular consent lets someone allow contacts and untick calendar, and that is a connected account with one feature to turn on later.

- [ ] **Step 1: Replace the missing-scope branch (Gmail)**

In `src/app/api/gmail/callback/route.ts`, replace the `if (purpose && !grantCovers(purpose, connection?.scopes))` block with:

```ts
    // Google's granular consent lets people untick a box. Only a grant that covers none of
    // what was asked is a failed connect; a partial one is connected, and the feature whose
    // scope is missing offers its own Allow button on the account page.
    const missing = missingGooglePurposes(purposes, connection?.scopes);
    if (purposes.length > 0 && missing.length === purposes.length) {
      await recordErrorEvent({
        source: ERROR_SOURCES.oauthGmailCallback,
        kind: "missing_scope",
        message: serializeGooglePurposes(missing),
      });
      redirectBase.searchParams.set("purpose", missing[0]);
      redirectBase.searchParams.set("gmail", "error");
      redirectBase.searchParams.set("google", "error");
      redirectBase.searchParams.set("reason", "missing_scope");
      return NextResponse.redirect(redirectBase);
    }
```

and in the success branch, after setting `gmail`/`google` to `connected`:

```ts
    if (switchedFrom) redirectBase.searchParams.set("switched", "1");
```

Where the route sets `purpose` from the state (step 2 of its flow), use the first requested purpose: `if (purposes.length > 0) redirectBase.searchParams.set("purpose", purposes[0]);`.

- [ ] **Step 2: Same for Outlook**

Mirror both edits in `src/app/api/outlook/callback/route.ts` with `missingMicrosoftPurposes`, `serializeMicrosoftPurposes` and the single `outlook` param.

- [ ] **Step 3: Pin the URL contract**

In `scripts/smoke-oauth-return.ts`, add checks that `readOAuthReturn` leaves the new param alone and that a partial connect reads as success:

```ts
const partial = readOAuthReturn("?google=connected&purpose=contacts&switched=1", {
  param: "google",
  provider: "Google",
  connectedText: "Google connected",
});
check("a connect with a switched account is still a success", partial?.tone === "success");
check("the switch survives the cleanup for the page to read", partial?.nextSearch.includes("switched=1") === true);
```

Run: `npx tsx scripts/smoke-oauth-return.ts` — Expected: all ok (add the import if the file does not already import `readOAuthReturn`).

- [ ] **Step 4: Typecheck, lint, commit**

Run: `npx tsc --noEmit`; `npx eslint src/app/api scripts/smoke-oauth-return.ts`.

```bash
git add src/app/api/gmail/callback/route.ts src/app/api/outlook/callback/route.ts scripts/smoke-oauth-return.ts
git commit -m "Treat a partly allowed consent screen as connected, and say when the account changed"
```

---

### Task 4: Free to connect, Pro to scan the inbox

**Files:**
- Modify: `src/actions/gmail.ts`, `src/actions/outlook.ts` (gates)
- Modify: `src/lib/errors.ts` (`friendlyError`)
- Create: `scripts/smoke-connect-gates.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `requireUserId`, `requireRecruitersUser` (`src/lib/plan-guards.ts:41-46`), `PaywallError` (`src/lib/entitlements.ts:84-102`).
- Produces: `startGmailOAuth` / `startOutlookOAuth` need only a signed-in user; `start*RecruiterScan` / `cancel*RecruiterScan` need the recruiters entitlement; `friendlyError` returns a `PaywallError`'s own message.

Per the spec: Google and Microsoft are free, except the recruiter inbox scan. Today `requireSyncUser` guards *connecting*, so a free user's Connect throws — and the message never arrives, because `friendlyError` has no paywall branch and Next reduces a thrown action error to a digest in production.

- [ ] **Step 1: Write the failing guard smoke**

Create `scripts/smoke-connect-gates.ts`:

```ts
/**
 * Which plan gate each connect and scan action uses, read from the source with the TypeScript
 * compiler rather than by calling them (they need a request and a signed-in user).
 *
 * The spec makes Google and Microsoft free and keeps the recruiter inbox scan on Pro, so a
 * `requireSyncUser` creeping back into a connect action is a paywall nobody meant to ship —
 * and a scan action losing its gate gives the feature away.
 *
 * Run: npx tsx scripts/smoke-connect-gates.ts
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { friendlyError } from "../src/lib/errors";
import { PaywallError } from "../src/lib/entitlements";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Every identifier called inside the named exported function. */
function callsIn(file: string, fn: string): Set<string> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const calls = new Set<string>();
  let found = false;
  const walk = (node: ts.Node, inside: boolean) => {
    const here =
      inside ||
      (ts.isFunctionDeclaration(node) && node.name?.text === fn) ||
      ((ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === fn));
    if (here && !inside) found = true;
    if (here && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.add(node.expression.text);
    ts.forEachChild(node, (child) => walk(child, here));
  };
  ts.forEachChild(source, (node) => walk(node, false));
  if (!found) throw new Error(`${fn} not found in ${file}`);
  return calls;
}

const GMAIL = "src/actions/gmail.ts";
const OUTLOOK = "src/actions/outlook.ts";

console.log("connecting is free");
for (const [file, fn] of [[GMAIL, "startGmailOAuth"], [OUTLOOK, "startOutlookOAuth"]] as const) {
  const calls = callsIn(file, fn);
  check(`${fn} asks only for a signed-in user`, calls.has("requireUserId"));
  check(`${fn} has no paid-plan gate`, !calls.has("requireSyncUser"));
}

console.log("\nthe inbox scan stays paid");
for (const [file, fn] of [
  [GMAIL, "startGmailRecruiterScan"],
  [GMAIL, "cancelGmailRecruiterScan"],
  [OUTLOOK, "startOutlookRecruiterScan"],
  [OUTLOOK, "cancelOutlookRecruiterScan"],
] as const) {
  const calls = callsIn(file, fn);
  check(`${fn} requires the recruiters plan`, calls.has("requireRecruitersUser"));
  check(`${fn} no longer uses the sync gate`, !calls.has("requireSyncUser"));
}

console.log("\nthe paywall message reaches the person");
const denial = new PaywallError("recruiters", "free", "Recruiter tracking is available on Orbit Pro and Orbit Lifetime.");
check("friendlyError shows it verbatim", friendlyError(denial, "Couldn’t do that — try again?") === denial.message);
check("an ordinary error still falls back", friendlyError(new Error("ECONNRESET"), "Couldn’t do that — try again?") === "Couldn’t do that — try again?");

if (failures > 0) {
  console.error(`\nsmoke-connect-gates: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-connect-gates: all ok");
process.exit(0);
```

Check `PaywallError`'s real constructor signature in `src/lib/entitlements.ts:84-98` and match it; if it derives its message from the feature, construct it the way the class does and compare against `denial.message`.

Register it in `scripts/run-smoke.ts` `MANIFEST` next to `"smoke-connection-status": "pure",`:

```ts
  "smoke-connect-gates": "pure",
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/smoke-connect-gates.ts`
Expected: FAIL — the connect actions still call `requireSyncUser`, the scan actions don't call `requireRecruitersUser`, and `friendlyError` returns the fallback for a paywall.

- [ ] **Step 3: Move the gates**

In `src/actions/gmail.ts`: in `startGmailOAuth` replace `const userId = await requireSyncUser();` with `const userId = await requireUserId();`; in `startGmailRecruiterScan` and `cancelGmailRecruiterScan` replace it with `const userId = await requireRecruitersUser();`. Import `requireRecruitersUser` from `@/lib/plan-guards` and drop the `requireSyncUser` import if nothing else in the file uses it. Add one comment above the connect action:

```ts
  // Connecting Google is free: the spec puts contacts, meetings and sending on every plan, and
  // the one paid feature (the recruiter inbox scan) is gated where it runs, not here.
```

Make the same three edits in `src/actions/outlook.ts`.

- [ ] **Step 4: Let the paywall speak**

In `src/lib/errors.ts`, inside `friendlyError`, before the `OWN_WORDS` check:

```ts
  // A plan denial is already written for the person who hit it (`FEATURE_DENIAL`), and it is
  // the one server-thrown message worth showing verbatim. Matched by name, not `instanceof`:
  // a second module instance would break the class check, and this file imports nothing.
  if (err instanceof Error && err.name === "PaywallError" && err.message) return err.message;
```

- [ ] **Step 5: Run the smokes, typecheck, lint, commit**

Run: `npx tsx scripts/smoke-connect-gates.ts`; `npx tsx scripts/smoke-friendly-error.ts`; `npx tsx scripts/smoke-entitlements.ts`; `npx tsx scripts/run-smoke.ts --check`; `npx tsc --noEmit`; `npx eslint src/actions src/lib/errors.ts scripts/smoke-connect-gates.ts`.
Expected: all ok, clean, 0 errors.

```bash
git add src/actions/gmail.ts src/actions/outlook.ts src/lib/errors.ts scripts/smoke-connect-gates.ts scripts/run-smoke.ts
git commit -m "Make connecting Google and Microsoft free, keep the inbox scan on Pro, and show the paywall's own words"
```

---

### Task 5: Turning meetings off, and telling that apart from meetings breaking

**Files:**
- Modify: `src/lib/provider-connections.ts` (`pauseSync`, `resumeSync`)
- Modify: `src/lib/connection-status.ts` (`ConnectionHealth`, `deriveConnectionHealth`, `connectionSummary`)
- Modify: `src/lib/integration-status.ts` (meetings capability)
- Modify: `src/actions/gmail.ts`, `src/actions/outlook.ts` (`setCalendarSync`), and their status actions to pass `syncStatus`
- Test: `scripts/smoke-provider-connections.ts`, `scripts/smoke-connection-status.ts`, `scripts/smoke-integration-status.ts`

**Interfaces:**
- Produces (used by P2b's Meetings switch):
  - `pauseSync(provider: ProviderKey, userId: string, now?: Date): Promise<void>` / `resumeSync(provider, userId, now?)`
  - `setCalendarSync(enabled: boolean): Promise<void>` in each actions file
  - `ConnectionHealth = "active" | "needs_reauth" | "disarmed" | "paused"`
  - `CapabilityState` gains `"off"`; meetings reads `off` when the person turned it off, `paused` when it broke
  - `GmailConnectionStatus` / `OutlookConnectionStatus` gain `syncPaused: boolean`

`sync_status` is plain `text` with no CHECK constraint (`src/db/index.ts:680,700,1295,3153`), so `'paused'` needs no migration. Pausing must also null `next_sync_at`: the claim predicate only excludes `'syncing'`.

- [ ] **Step 1: Write the failing checks**

In `scripts/smoke-provider-connections.ts`, add:

```ts
console.log("\npausing and resuming on purpose");
const claimDue = () => claimDueConnections("google", 10);
await armConnection();
await pauseSync("google", USER);
const paused = await readRow();
check("a paused connection is not queued", paused?.nextSyncAt === null);
check("and is marked paused, not failed", paused?.syncStatus === "paused" && paused?.syncError === null);
check("the scheduler does not claim it", (await claimDue()).length === 0);
await resumeSync("google", USER);
const resumed = await readRow();
check("resuming queues it again", resumed?.nextSyncAt !== null && resumed?.syncStatus === null);
check("the scheduler claims it once more", (await claimDue()).length === 1);
```

In `scripts/smoke-connection-status.ts`:

```ts
check("a connection the person paused reads paused", deriveConnectionHealth(row({ syncStatus: "paused", nextSyncAt: null })) === "paused");
check("paused wins over a stale error", deriveConnectionHealth(row({ syncStatus: "paused", nextSyncAt: null, syncError: "old" })) === "paused");
check("a failure is still disarmed", deriveConnectionHealth(row({ nextSyncAt: null, syncError: "Google Calendar 403" })) === "disarmed");
check("needs_reauth still wins over everything", deriveConnectionHealth(row({ status: "needs_reauth", syncStatus: "paused", nextSyncAt: null })) === "needs_reauth");
check("a paused connection is not a problem on the card", connectionSummary({ configured: true, connected: true, status: "paused" }).state === "on");
```

(Extend that file's `row()` helper with `syncStatus: null` in its defaults.)

In `scripts/smoke-integration-status.ts`:

```ts
console.log("\nmeetings, off versus broken");
const off = googleAccountStatus(google({ status: "paused" }), pro).capabilities.meetings;
check("turned off reads off", off?.state === "off");
check("and says so plainly", off?.detail === "Off");
const broke = googleAccountStatus(google({ status: "disarmed", syncError: "x" }), pro).capabilities.meetings;
check("broken still reads paused", broke?.state === "paused");
check("only the broken one is worth flagging", attentionItems({ accounts: { google: googleAccountStatus(google({ status: "paused" }), pro) }, ai: { ready: true } }).length === 0);
check("the page reads connected while meetings are off", accountPageStatus(googleAccountStatus(google({ status: "paused" }), pro)).state === "on");
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx scripts/smoke-connection-status.ts`
Expected: FAIL — `deriveConnectionHealth` ignores `syncStatus`, and `"paused"` is not a `ConnectionHealth`.

- [ ] **Step 3: Add the pause to the connection store**

In `src/lib/provider-connections.ts`, next to `disarmSync` and following its exact SQL style (it writes through `PROVIDER_TABLES`; match it):

```ts
/**
 * The person switched meetings off. Distinct from `disarmSync`, which is the scheduler giving
 * up: no error is recorded, and the row is taken out of the queue rather than marked broken,
 * because the claim predicate only skips rows that are already syncing.
 *
 * Keyed by user, not connection id: the switch lives on an account page, which knows who is
 * signed in and not which row id backs it.
 */
export async function pauseSync(provider: SyncProvider, userId: string, now = new Date()): Promise<void>;

/** Back into the queue, starting now, with the failure counters cleared. */
export async function resumeSync(provider: SyncProvider, userId: string, now = new Date()): Promise<void>;
```

Write both the way `disarmSync` (`src/lib/provider-connections.ts:218`) does: resolve the table with `sql.raw(PROVIDER_TABLES[provider])` and run one statement. `SyncProvider` is the provider type this file already uses (`"google" | "microsoft"`); `disarmSync` keys by connection id, but these key by `user_id`. The column values are:

```
pauseSync:   sync_status = 'paused',  next_sync_at = NULL, sync_started_at = NULL,
             sync_error = NULL,       sync_failures = 0,   updated_at = now
resumeSync:  sync_status = NULL,      next_sync_at = now,  sync_started_at = NULL,
             sync_error = NULL,       sync_failures = 0,   updated_at = now
```

Both key on `user_id` (not the connection id — the callers have the user). Leave `status` untouched: pausing meetings says nothing about whether the grant is alive.

- [ ] **Step 4: Teach the health derivation about it**

In `src/lib/connection-status.ts`:

```ts
export type ConnectionHealth = "active" | "needs_reauth" | "disarmed" | "paused";

export function deriveConnectionHealth(row: {
  status: string;
  nextSyncAt: Date | null;
  syncError: string | null;
  /** `'paused'` means the person switched meetings off; see `pauseSync`. */
  syncStatus?: string | null;
  calendarScopeGranted: boolean;
}): ConnectionHealth {
  if (row.status !== "active") return "needs_reauth";
  if (row.syncStatus === "paused") return "paused";
  if (row.calendarScopeGranted && row.nextSyncAt === null && row.syncError) return "disarmed";
  return "active";
}
```

In `connectionSummary`, treat `"paused"` like `active` (a paused calendar is not a broken account): add `if (c.status === "paused" && c.connected) return { state: "on", detail: "Connected" };` above the `disarmed` branch, or fold it into the connected branch — whichever reads cleaner in that function.

- [ ] **Step 5: Split the meetings capability**

In `src/lib/integration-status.ts`, add `"off"` to `CapabilityState` (doc it: "the person switched it off") and rewrite `meetingsStatus`:

```ts
function meetingsStatus(
  granted: boolean,
  health: ConnectionHealth | null,
  syncError: string | null,
  provider: ProviderName
): CapabilityStatus {
  if (!granted) return { state: "not_allowed" };
  if (health === "paused") return { state: "off", detail: "Off" };
  if (health !== "disarmed") return { state: "on" };
  const scopeMissing = Boolean(syncError && /not granted|insufficient|scope/i.test(syncError));
  return {
    state: "paused",
    detail: `Meetings stopped coming in. Sign in to ${provider} again${scopeMissing ? " and allow calendar access" : ""}.`,
  };
}
```

`accountPageStatus` and `attentionItems` already key on `state === "paused"`, so an `off` meeting row stops being reported as a problem with no further change — confirm by reading both functions.

- [ ] **Step 6: Expose it through the actions**

In `src/actions/gmail.ts`: pass `syncStatus: conn.syncStatus` into `deriveConnectionHealth`, add `syncPaused: Boolean(conn && conn.syncStatus === "paused")` to `GmailConnectionStatus` (and `false` on the unconfigured path), and add:

```ts
/** The Meetings switch on the Google account page. Off leaves the grant alone. */
export async function setCalendarSync(enabled: boolean): Promise<void> {
  const userId = await requireUserId();
  if (enabled) await resumeSync("google", userId);
  else await pauseSync("google", userId);
  revalidatePath("/settings");
}
```

Mirror it in `src/actions/outlook.ts` with `"microsoft"`. Both files already import `revalidatePath`; check before adding.

- [ ] **Step 7: Run everything, typecheck, lint, commit**

Run: `npx tsx scripts/smoke-provider-connections.ts`; `npx tsx scripts/smoke-connection-status.ts`; `npx tsx scripts/smoke-integration-status.ts`; `npx tsx scripts/smoke-sync-scheduler.ts`; `npx tsx scripts/smoke-account-alerts.ts`; `npx tsc --noEmit`; `npx eslint src/lib src/actions`.
Expected: all ok, clean, 0 errors. If `smoke-account-alerts` fails, a paused connection is reaching an alert predicate — fix the predicate, not the test.

```bash
git add src/lib/provider-connections.ts src/lib/connection-status.ts src/lib/integration-status.ts src/actions/gmail.ts src/actions/outlook.ts scripts/smoke-provider-connections.ts scripts/smoke-connection-status.ts scripts/smoke-integration-status.ts
git commit -m "Let meetings be switched off, and tell that apart from meetings breaking"
```

---

### Task 6: The four leftover connection defects

**Files:**
- Modify: `src/actions/gmail.ts` (`disconnectGmail`), `src/actions/outlook.ts` (`disconnectOutlook`)
- Modify: `src/actions/imports.ts` (`previewOutlookContacts`, `confirmOutlookContactsImport`)
- Modify: `src/lib/contact-avatar-connectors.ts` (`buildOutlookContactIndex`)
- Modify: `src/lib/env.ts`
- Test: `scripts/smoke-outlook-disconnect-purge.ts` (extend), `scripts/smoke-env-documented.ts` (if it asserts the lists)

**Interfaces:**
- Consumes: `deleteEventConnection` (`src/lib/events/connections.ts:334-342`), `hasContactsScope` (`src/lib/outlook.ts:23-25`).
- Produces: `previewOutlookContacts()` → `{ connected: boolean; contactsScopeGranted: boolean; people: OutlookContactPerson[] }` — the same shape `previewGoogleContacts` returns, which P2b's Contacts row relies on.

Four small defects, each independently verified:
1. `disconnectGmail` leaves the `event_provider_connections` row with `provider='gmail'` behind; the scheduler then claims it every pass, fails `"Gmail is not connected"`, and walks a six-step backoff while reporting a warning each time.
2. `previewOutlookContacts`, `confirmOutlookContactsImport` and `buildOutlookContactIndex` never check `Contacts.Read`, so a calendar-only grant produces a raw Graph failure toast instead of "allow contacts access".
3. `disconnectGmail` revalidates only `/recruiters`.
4. `MICROSOFT_*` is absent from `env.ts`, so a production deploy with Microsoft unconfigured passes the env check silently.

- [ ] **Step 1: Write the failing checks**

In `scripts/smoke-outlook-disconnect-purge.ts` (or a new `scripts/smoke-disconnect-cleanup.ts` registered as `pglite` if that file's shape doesn't fit), add a Google case:

```ts
console.log("\ndisconnecting Google takes its event scan with it");
await upsertGmailConnection(USER, tokensWithScope(GOOGLE_SCOPES.gmailRead), "jo@gmail.com");
await upsertEventConnection(USER, { provider: "gmail", authKind: "google_grant", secret: "", label: "jo@gmail.com" });
await disconnectGmail({});
check("the sign-in is gone", (await readGmailRow()) === undefined);
check(
  "and the confirmation-email scan it fed is gone too",
  (await listEventConnections(USER)).every((c) => c.provider !== "gmail")
);
```

For the scope guards, add to a pure or pglite smoke that can reach the action's return shape (`scripts/smoke-import-engine.ts` has the closest harness; otherwise extend `smoke-outlook-scope-storage.ts`):

```ts
check(
  "a calendar-only Outlook grant reports contacts as not allowed, rather than failing",
  (await previewOutlookContacts()).contactsScopeGranted === false
);
```

If reaching the action needs a request context the script cannot build, assert the guard at the source level instead, with `callsIn` from `scripts/smoke-connect-gates.ts` (export the helper from there and import it):

```ts
check("previewOutlookContacts checks the contacts scope", callsIn("src/actions/imports.ts", "previewOutlookContacts").has("hasContactsScope"));
check("confirmOutlookContactsImport checks it too", callsIn("src/actions/imports.ts", "confirmOutlookContactsImport").has("hasContactsScope"));
check("the Outlook avatar index checks it", callsIn("src/lib/contact-avatar-connectors.ts", "buildOutlookContactIndex").has("hasContactsScope"));
```

- [ ] **Step 2: Run them to verify they fail**

Run the smoke you extended. Expected: FAIL — the event row survives the disconnect, and the Outlook paths have no scope check.

- [ ] **Step 3: Clean up on disconnect**

In `src/actions/gmail.ts`'s `disconnectGmail`, after the row delete and revoke:

```ts
  // The confirmation-email scan is an opt-in row that carries no token of its own — it borrows
  // this connection's. Left behind, the scheduler claims it every pass and fails on a mailbox
  // that is no longer connected.
  await deleteEventConnection(userId, "gmail");
```

and extend the revalidation to the pages that show this connection:

```ts
  revalidatePath("/recruiters");
  revalidatePath("/settings");
  revalidatePath("/imports");
  revalidatePath("/events");
```

In `disconnectOutlook`, add `revalidatePath("/imports")` alongside its existing two.

- [ ] **Step 4: Check the Outlook contacts scope server-side**

In `src/actions/imports.ts`, make `previewOutlookContacts` mirror its Google twin:

```ts
  if (!conn) return { connected: false, contactsScopeGranted: false, people: [] };
  if (!hasContactsScope(conn.scopes)) return { connected: true, contactsScopeGranted: false, people: [] };
```

and widen its declared return type to include `contactsScopeGranted: boolean` (add `contactsScopeGranted: true` to the success return). In `confirmOutlookContactsImport`, load the connection row the same way `previewOutlookContacts` does and throw the repo's user-facing error when the scope is missing, matching how the Google path words it:

```ts
  if (!hasContactsScope(conn?.scopes)) {
    throw new UserFacingError("Allow Orbit to read your contacts first — reconnect Outlook and tick contacts access");
  }
```

(Use the file's existing error class and wording style; check what `confirmGoogleContactsImport` does first and stay consistent.)

In `src/lib/contact-avatar-connectors.ts`, `buildOutlookContactIndex`: `if (!conn || conn.status !== "active" || !hasContactsScope(conn.scopes)) return new Map();`

`outlook-contacts-import.tsx` already renders an "Allow contacts access" button from `status.hasContactsScope`, so no component change is needed — but run the page once in Task 7's verification to be sure the new return field didn't break its preview handler.

- [ ] **Step 5: Stop selling what is now free**

The moment Task 4's gate comes off, three places tell people to pay for something they already have. Edit:

- `src/lib/plan-copy.ts:127` and `:147` — replace the bullet `"Gmail, Outlook, and calendar sync"` in both the Pro and Lifetime lists with `"Recruiter scanning across Gmail and Outlook"` (recruiters is the paid part that remains). If that duplicates the existing `"Recruiter tracking"` bullet in the same list, drop the sync bullet instead of replacing it, and say which you did in your report.
- `src/components/pricing/plan-comparison.tsx:59` — the row `{ label: "Gmail, Outlook, calendar sync", cells: [false, true, true] }` becomes `{ label: "Contacts, calendar and meetings from Google and Outlook", cells: [true, true, true] }`.
- `src/components/pricing/plan-comparison.tsx:24-41` — the header comment tells editors every row is checked against `entitlements.ts` and names `canUseSync` as `plan !== "free"`. Amend that sentence so it no longer claims sync is paid: connecting Google and Microsoft is free, and `canUseSync` now gates only the pasted-ICS calendar subscriptions.
- `src/components/pricing/pricing-faq.tsx:24` — drop "mailbox and calendar sync" from the list of what both paid plans include, keeping the sentence natural.
- `src/components/landing/landing-scenes.tsx:233` — the comment "Gmail sync and sending are Pro (plan-copy.ts)" is now false; correct it.

Leave `import-hub.tsx:319-329` (`LockedFeature "Calendar sync"`) alone: that card is the pasted-ICS subscription, which `canUseSync` still gates. Run `npx tsx scripts/smoke-plan-card-copy.ts` after the edits.

- [ ] **Step 6: Document the Microsoft env vars**

In `src/lib/env.ts`, in `EXPECTED_IN_PRODUCTION`, below the Google trio:

```ts
  // Outlook contacts, calendar and mail all ride this one OAuth client.
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "MICROSOFT_REDIRECT_URI",
```

(`MICROSOFT_TENANT_ID` stays optional — it defaults to `common`.)

- [ ] **Step 7: Run the smokes, typecheck, lint, commit**

Run the smokes you touched, plus `npx tsx scripts/smoke-env-documented.ts`, `npx tsx scripts/smoke-plan-card-copy.ts`, `npx tsx scripts/smoke-import-engine.ts`, `npx tsx scripts/smoke-toast-copy.ts`, `npx tsc --noEmit`, `npx eslint src/actions src/lib src/components/pricing`.

```bash
git add src/actions/gmail.ts src/actions/outlook.ts src/actions/imports.ts src/lib/contact-avatar-connectors.ts src/lib/env.ts src/lib/plan-copy.ts src/components/pricing src/components/landing/landing-scenes.tsx scripts/
git commit -m "Clean up the event scan on disconnect, check Outlook's contacts scope, stop selling what is now free"
```

---

### Task 7: Verify the whole model, then open the PR

- [ ] **Step 1: Static checks**

Run and confirm: `npx tsc --noEmit` (silent); `npx eslint` (`0 errors`, ~3 warnings); `npx tsx scripts/run-smoke.ts --check` (exit 0); `npm test` (the full suite; rerun `smoke-admin-render` / `smoke-instrumentation` alone if they time out under load).

- [ ] **Step 2: Prove the behaviour on a local database**

Write a throwaway script under the session scratchpad (never in `scripts/`) that runs against the smoke PGlite (`import "./smoke/_env"` semantics — copy the preamble import from any pglite smoke) and prints, for a single fake user:

1. a contacts-only connect → row has `next_sync_at = NULL`, and `deriveConnectionHealth` says `active` (not `disarmed`);
2. a contacts+calendar connect → `next_sync_at` set, scheduler claim returns the row;
3. `pauseSync` → claim returns nothing, health is `paused`, `integration-status` meetings reads `off`;
4. `resumeSync` → claimed again;
5. a connect with a different email → `switchedFrom` is the old address, `sync_cursor` is null, calendar scope gone.

Paste its output into your report. Delete the script afterwards.

- [ ] **Step 3: Check the app still runs**

The dialog is unchanged in this plan, but the actions it calls are not. Start the demo preview (`preview_start` `{ name: "orbit-demo" }`), front the tab (`tabs_select`; confirm the page hydrated — the Settings "Manage" button must have a `__reactFiber…` key), then open `/settings?integration=google`, `?integration=microsoft` and `/imports`, and confirm: the panels render, no console errors, and Google/Microsoft still read "Unavailable" (demo has no OAuth client configured). Stop the preview and reset the viewport when done.

- [ ] **Step 4: Manual acceptance checklist for Jason (put it in the PR body)**

Needs real client IDs; demo mode cannot reach Google or Microsoft:
- On a **free** account, Connect Google completes instead of erroring.
- The consent screen lists contacts and calendar together, and nothing about mail.
- Untick calendar on Google's screen → Orbit shows connected, and meetings reads "not allowed".
- A contacts-only connect never shows "Calendar sync paused" afterwards.
- Connect a second Google account → the page shows the new address, and the old account's calendar cursor is gone (a full sync re-runs).
- A free account pressing "Scan inbox" sees "Recruiter tracking is available on Orbit Pro and Orbit Lifetime.", not a generic retry toast.
- Disconnect Google, then check /events no longer lists a Gmail scan row.

- [ ] **Step 5: Re-check main, push, open the PR (ask Jason first)**

```bash
git fetch origin main -q && git log --oneline HEAD..origin/main | head -20
```

If main moved into these files, merge it and re-run Step 1. Then ask Jason before pushing. With his go-ahead, push `claude/integrations-p2-accounts` and open a PR **based on `claude/settings-popup-redesign-0ed30d`** (P1), not on main — this is stacked work. Body: what changed, the checks above, the manual checklist, and a line saying P2b (the account pages) follows and that neither should reach production before both land. End with the Claude Code attribution line.

---

## Next plan (P2b — the account pages)

Written once this lands, against this code:

- Extract three hooks from the four existing panels, so `/imports` and `/recruiters` keep working while the dialog gets a new shape: `useProviderConnection` (status, OAuth return, connect, disconnect), `useContactsImport` (preview, review, import job), `useRecruiterScan` (start, poll, cancel).
- Build the account page shell (header with account identity and a ⋯ menu; one row per capability) and the Google page: Contacts, Meetings (the switch this plan added), Recruiters in inbox (Pro-locked), Send from your email, Reminders.
- The Microsoft page, which brings the Outlook recruiter scan into the dialog for the first time.
- Overview's "Connect Google/Microsoft" starts the consent screen directly, with `GOOGLE_CONNECT_PURPOSES`.
- The "Switched to …" toast from this plan's `switched=1`.
- Plan and pricing copy: `plan-copy.ts:127,147`, `plan-comparison.tsx:58-60` and its stale header comment, `pricing-faq.tsx:24`, `import-hub.tsx:319-329` (the ICS subscription stays paid), `landing-scenes.tsx:233`.
- The P1 review's deferred minors that live in these files: arrow-key index, the Advanced disclosure while selected, the hash-effect guard, sign-in attention when `getSettings` times out, running-import signal on phones, command-palette labels, card `aria-describedby`, the Google mark's colours.
