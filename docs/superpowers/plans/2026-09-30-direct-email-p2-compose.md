# Direct Email P2 — Compose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person write and send an email to anyone from inside Orbit — from a contact's page or the ⌘K palette — through the P1 outbox, with To/CC/BCC, an AI first draft, a signature, a 10-second undo, a saved local draft, and scheduled/failed sends visible on the contact page. Shipped behind a coming-soon gate.

**Architecture:** One client `ComposeDialog`, mounted once in `AppShell` by a `ComposeHost` that listens for an `orbit:compose` window event, so every entry point opens the same dialog. The dialog talks to four server actions in `src/actions/email-compose.ts`, which wrap request-free lib functions in `src/lib/email/compose.ts`. Sending is `enqueueEmail(origin: "compose")` + `scheduleDispatch` from P1. A new `feature` surface kind makes `feature.compose` coming-soon (today only pages can be), which hides every entry point and refuses the actions for non-previewers.

**Tech Stack:** Next.js App Router (server actions), React client components on `@base-ui/react` primitives (`src/components/ui/*`), Drizzle on Neon/PGlite, tsx smoke scripts.

**Spec:** `docs/superpowers/specs/2026-09-29-direct-email-design.md` (§5 Compose; §3 "Failure surfaces" for the contact-page items). P1 plan for context: `docs/superpowers/plans/2026-09-29-direct-email-p1-engine.md`.

## Global Constraints

- **Branch:** P1 is open as PR #374 (`claude/orbit-direct-email-cc0746`). Cut `claude/direct-email-p2-compose` from P1's HEAD. Open its PR against the P1 branch while #374 is open; retarget to `main` once #374 merges.
- **No schema change.** Every column P2 needs exists (P1, schema v140). Do not bump `SCHEMA_VERSION`.
- Read `AGENTS.md`: check `node_modules/next/dist/docs/` before using any Next API not already used in this repo.
- Sending goes only through `enqueueEmail` (`src/lib/email/outbox.ts`) + `scheduleDispatch` (`src/lib/email/schedule.ts`) with `delayMs: UNDO_DELAY_MS`. Never call a provider directly. `smoke-email-no-resend` must stay green.
- Gate: surface key **`feature.compose`**, `comingSoon: true`. Every Compose entry point hides when `useHiddenSurfaces().has("feature.compose")`; every Compose action starts with `requireUserForSurface("feature.compose")`.
- Recipients: at most 20 across To/CC/BCC (`MAX_RECIPIENTS`), validated by `normalizeRecipients`. Subject ≤ 200 chars (`SEND_SUBJECT_MAX`), body ≤ `DRAFT_MAX_CHARS` (5000) after `sanitizeDraft`.
- Signature: **plain text only**, ≤ 600 characters, appended as `\n\n-- \n<signature>` to Compose sends only.
- Toast copy follows the house voice: no trailing periods (`smoke-toast-copy`). User-facing errors via `friendlyError` / returned `message`, never raw `err.message`.
- Client components never import `@/db` or server-only modules (`import type` is fine).
- Mobile layout is CSS (`sm:`/`max-sm:`), not `useIsMobile` (it renders nothing until hydration).
- Every new `scripts/smoke-*.ts` is registered in `MANIFEST` in `scripts/run-smoke.ts`; `pglite` ones start with `import "./smoke/_env";`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions made while planning (record in the spec in Task 1)

1. **Gate via a new `feature` surface kind.** `comingSoon` only works on `page` surfaces today (`COMING_SOON_KEYS` is built from pages). P2 adds `kind: "feature"` whose coming-soon keys land in `hidden` for non-previewers, so the existing client hook (`useHiddenSurfaces`) and server guard (`requireUserForSurface`) both apply unchanged. `settings.email` is its companion.
2. **Signature is plain text in P2.** The repo has no HTML sanitizer; adding one for a signature isn't worth the dependency. `email_signature_html` stays unused until a later phase asks for rich signatures.
3. **"Default sending mailbox" is read-only in P2** ("Sending from me@…"). With only Gmail connected there is nothing to choose; P3 (Outlook) turns it into a picker.
4. **The signature applies to Compose only.** Chat and follow-up drafts are AI-written with their own sign-off.
5. **A Compose send clears a due follow-up** for every matched contact, the same as a Chat send.
6. **The AI draft is body-only** (`generateContactFollowUpDraft` returns no subject). An empty subject becomes `Following up` when the AI draft is inserted.
7. **The palette verb is typed:** `email maya` / `mail maya` turns People rows into "Email Maya" rows. No new row appears for ordinary searches.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/surfaces.ts` | `feature` kind, `FEATURES` list with `feature.compose`, coming-soon keys across pages + features, companion |
| `src/lib/surface-visibility.ts` | coming-soon non-page keys go into `hidden` |
| `src/app/(clerk)/(admin)/admin/product/page.tsx` | "Features" toggle panel |
| `src/lib/email/signature.ts` | `cleanSignature`, `appendSignature` (pure) |
| `src/lib/email/settings.ts` | `loadEmailSettings`, `saveEmailSignature` (request-free) |
| `src/actions/settings.ts` | `getEmailSettings`, `saveEmailSignatureAction` |
| `src/components/settings/sections.ts`, `email-settings.tsx`, settings `page.tsx` | "Email" settings section |
| `src/lib/email/compose.ts` | `getComposeContext`, `searchRecipients`, `sendComposed`, `listContactPendingSends`, `retryFailedSend`, `dismissFailedSend` (request-free) |
| `src/lib/email/origin-hooks/compose.ts` | compose origin: clear due follow-ups on send |
| `src/actions/email-compose.ts` | the `"use server"` wrappers the UI calls |
| `src/lib/compose-draft.ts` | localStorage draft read/write (pure, Storage-injected) |
| `src/lib/compose-events.ts` | `openCompose(detail)`, `COMPOSE_EVENT` (client-safe) |
| `src/components/email/recipient-field.tsx` | chip input with suggestions |
| `src/components/email/compose-dialog.tsx` | the composer |
| `src/components/email/compose-host.tsx` | listens for the event, lazy-mounts the dialog |
| `src/components/email/compose-button.tsx` | "Email" button for the contact page |
| `src/components/email/pending-sends.tsx` | scheduled/failed sends card on the contact page |
| `src/lib/command-palette.ts`, `src/components/layout/command-palette-dialog.tsx` | the `email <name>` verb |
| Smokes: `smoke-email-signature`, `smoke-compose-draft`, `smoke-email-compose`, `smoke-surface-visibility` (updated), `smoke-command-palette` (updated) | |

---

### Task 1: The `feature` surface kind and `feature.compose`

**Files:**
- Modify: `src/lib/surfaces.ts` (`SurfaceKind` ~17, `SURFACES` ~240, `COMING_SOON_KEYS` ~279, `COMING_SOON_COMPANIONS` ~288)
- Modify: `src/lib/surface-visibility.ts` (`resolveSurfaceVisibility` ~158)
- Modify: `src/app/(clerk)/(admin)/admin/product/page.tsx` (~91)
- Modify: `scripts/smoke-surface-visibility.ts`
- Modify: `docs/superpowers/specs/2026-09-29-direct-email-design.md` (append the seven planning decisions above under `## Planning amendments (P2 plan)`)

**Interfaces:**
- Produces: `SurfaceKind` includes `"feature"`; `COMPOSE_SURFACE_KEY = "feature.compose"` exported from `src/lib/surfaces.ts`; for a non-previewing viewer, `resolveSurfaceVisibility(...).hidden` contains `"feature.compose"` and `"settings.email"`.

- [ ] **Step 1: Write the failing checks** in `scripts/smoke-surface-visibility.ts`. In `registryChecks()` add:

```ts
  const features = surfacesOfKind("feature");
  check("compose is registered as a feature surface", features.some((s) => s.key === COMPOSE_SURFACE_KEY));
  check("a feature surface declares no href", features.every((s) => s.href === undefined));
  check("compose ships coming-soon", COMING_SOON_KEYS.has(COMPOSE_SURFACE_KEY));
```

In the coming-soon block (next to "an ordinary user gets the coming-soon screen…"), add:

```ts
      check(
        "a coming-soon feature is hidden outright for an ordinary user and a default admin",
        forUser.hidden.has(COMPOSE_SURFACE_KEY) && forAdmin.hidden.has(COMPOSE_SURFACE_KEY)
      );
      check("compose's settings section is hidden with it", forUser.hidden.has("settings.email"));
```

Change the existing "every coming-soon page…" check that iterates `COMING_SOON_KEYS` so it only expects `forUser.comingSoon` to contain **page** keys: `[...COMING_SOON_KEYS].filter((k) => getSurface(k)?.kind === "page").every((k) => forUser.comingSoon.has(k))`. Import `COMPOSE_SURFACE_KEY`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-surface-visibility.ts`
Expected: FAIL — `COMPOSE_SURFACE_KEY` not exported (or "compose is registered…" fails).

- [ ] **Step 3: Implement.** In `src/lib/surfaces.ts`:

```ts
export type SurfaceKind = "page" | "dashboard" | "settings" | "widget" | "feature";
```

Update the `comingSoon` doc comment on `Surface` to: `/** Pages and features: not released yet. A page shows the coming-soon screen; a feature is hidden outright. Releasing it is deleting this line. */`

Add after `WIDGETS`:

```ts
/**
 * Capabilities that live inside other pages rather than being pages themselves. Hiding one
 * removes every entry point to it and makes its server actions refuse. A coming-soon feature
 * is simply hidden for everyone not previewing unreleased work.
 */
export const COMPOSE_SURFACE_KEY = "feature.compose";
const FEATURES: Surface[] = [
  {
    key: COMPOSE_SURFACE_KEY,
    kind: "feature",
    label: "Compose email",
    description: "Write and send email to anyone from a contact's page or ⌘K, from your own mailbox.",
    comingSoon: true,
  },
];
```

Change `SURFACES` to `[...PAGES, ...DASHBOARD_CARDS, ...WIDGETS, ...FEATURES, ...SETTINGS]` (keep whatever order the file uses, inserting `FEATURES` before `SETTINGS`).

Replace `COMING_SOON_KEYS`:

```ts
/** Page and feature surfaces that are announced but not released. */
export const COMING_SOON_KEYS: ReadonlySet<string> = new Set(
  SURFACES.filter((s) => s.comingSoon).map((s) => s.key)
);
```

Add to `COMING_SOON_COMPANIONS`: `[COMPOSE_SURFACE_KEY]: ["settings.email"],` (the `settings.email` surface is created in Task 2; until then the companion check will fail, so do Task 2 Step 3's `sections.ts` edit in this task too — one line: `{ id: "settings-email", label: "Email", group: "preferences" },` after `settings-goals`).

In `src/lib/surface-visibility.ts` `resolveSurfaceVisibility`, replace the coming-soon loop:

```ts
  if (!previewingUnreleased) {
    for (const key of COMING_SOON_KEYS) {
      // A page gets the coming-soon screen; anything else has no screen of its own to show,
      // so it is simply hidden, which every entry point and guard already respects.
      if (getSurface(key)?.kind === "page") comingSoon.add(key);
      else hidden.add(key);
      for (const companion of COMING_SOON_COMPANIONS[key] ?? []) hidden.add(companion);
    }
  }
```

(import `getSurface` from `@/lib/surfaces`).

In the admin product page, after the Widgets panel:

```tsx
        <AdminPanel title="Features">
          <SurfaceToggles surfaces={surfacesOfKind("feature")} hidden={hiddenKeys} />
        </AdminPanel>
```

Grep for any `Record<SurfaceKind, …>` or `switch (surface.kind)` (`grep -rn "SurfaceKind\|\.kind === \"widget\"" src scripts`) and add the `feature` case where the type checker demands it.

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit -p . && npx tsx scripts/run-smoke.ts --only smoke-surface-visibility smoke-command-palette smoke-settings-sections`
Expected: PASS. (If `smoke-settings-sections` does not exist, run `ls scripts | grep -i "settings\|surface"` and run those instead — the new `settings-email` id must satisfy every settings-structure smoke.)

- [ ] **Step 5: Record the planning decisions** in the spec (append `## Planning amendments (P2 plan)` with decisions 1–7 verbatim from this plan).

- [ ] **Step 6: Commit**

```bash
git add src/lib/surfaces.ts src/lib/surface-visibility.ts "src/app/(clerk)/(admin)/admin/product/page.tsx" src/components/settings/sections.ts scripts/smoke-surface-visibility.ts docs/superpowers/specs/2026-09-29-direct-email-design.md
git commit -m "feat(surfaces): feature surface kind, with Compose shipping coming-soon

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Signature and the Email settings section

**Files:**
- Create: `src/lib/email/signature.ts`, `src/lib/email/settings.ts`, `src/components/settings/email-settings.tsx`
- Modify: `src/actions/settings.ts` (near `getWritingInstructions` ~281), `src/app/(clerk)/(app)/settings/page.tsx` (Section list ~199)
- Test: `scripts/smoke-email-signature.ts` (tier `pglite`)

**Interfaces:**
- Consumes: `getSendCapability` (`src/lib/email/sender.ts`), `sanitizeDraft`-style cleaning.
- Produces:
  - `SIGNATURE_MAX = 600`; `cleanSignature(raw: unknown): string | null`; `appendSignature(body: string, signature: string | null): string`
  - `loadEmailSettings(userId): Promise<{ signature: string | null }>`; `saveEmailSignature(userId, raw: string): Promise<string | null>`
  - Actions: `getEmailSettings(): Promise<{ signature: string | null; capability: SendCapability }>`, `saveEmailSignatureAction(text: string): Promise<{ ok: true; signature: string | null }>`

- [ ] **Step 1: Write the failing test** `scripts/smoke-email-signature.ts`:

```ts
/**
 * Email signatures: cleaning, the "-- " delimiter, and storage.
 * Run: npx tsx scripts/smoke-email-signature.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { appendSignature, cleanSignature, SIGNATURE_MAX } from "../src/lib/email/signature";
import { loadEmailSettings, saveEmailSignature } from "../src/lib/email/settings";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-signature-user";
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  check("blank is null", cleanSignature("  \n ") === null);
  check("non-string is null", cleanSignature(42) === null);
  check("trimmed, CRLF normalized", cleanSignature("  Jason\r\nOrbit  ") === "Jason\nOrbit");
  check("control and zero-width characters stripped", cleanSignature(`Ja${String.fromCharCode(0x200b, 0)}son`) === "Jason");
  check("markup is kept as text, never interpreted", cleanSignature("<b>Jason</b>") === "<b>Jason</b>");
  check("capped", (cleanSignature("x".repeat(SIGNATURE_MAX + 50)) ?? "").length === SIGNATURE_MAX);

  check("append uses the standard delimiter", appendSignature("Hi Maya", "Jason") === "Hi Maya\n\n-- \nJason");
  check("no signature, body unchanged", appendSignature("Hi Maya", null) === "Hi Maya");
  check("already signed body is not signed twice", appendSignature("Hi Maya\n\n-- \nJason", "Jason") === "Hi Maya\n\n-- \nJason");

  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  try {
    check("nothing stored yet", (await loadEmailSettings(USER)).signature === null);
    check("save returns the cleaned value", (await saveEmailSignature(USER, "  Jason P\r\n")) === "Jason P");
    check("load reads it back", (await loadEmailSettings(USER)).signature === "Jason P");
    check("saving blank clears it", (await saveEmailSignature(USER, "   ")) === null && (await loadEmailSettings(USER)).signature === null);
  } finally {
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  console.log("\nAll email-signature checks passed.");
}

run(main);
```

Register `"smoke-email-signature": "pglite",`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-email-signature.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** `src/lib/email/signature.ts`:

```ts
import { sanitizeDraft } from "@/lib/chat-draft";

export const SIGNATURE_MAX = 600;
const DELIMITER = "\n\n-- \n";

/**
 * A signature as stored and sent: plain text only (markup is kept as literal text — nothing
 * renders it), invisible and control characters stripped by the same cleaner drafts use,
 * capped at SIGNATURE_MAX. Null means no signature.
 */
export function cleanSignature(raw: unknown): string | null {
  const cleaned = sanitizeDraft(raw);
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, SIGNATURE_MAX).join("").trim() || null;
}

/** Appends with the standard `-- ` delimiter, once. */
export function appendSignature(body: string, signature: string | null): string {
  if (!signature) return body;
  if (body.endsWith(`${DELIMITER}${signature}`)) return body;
  return `${body}${DELIMITER}${signature}`;
}
```

`src/lib/email/settings.ts`:

```ts
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { cleanSignature } from "@/lib/email/signature";

/** Read directly, not through the cached `ensureUserSettings`, so a save is visible at once. */
export async function loadEmailSettings(userId: string): Promise<{ signature: string | null }> {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { emailSignatureText: true },
  });
  return { signature: row?.emailSignatureText ?? null };
}

export async function saveEmailSignature(userId: string, raw: string): Promise<string | null> {
  const signature = cleanSignature(raw);
  const db = await getDb();
  await db
    .insert(userSettings)
    .values({ userId, emailSignatureText: signature })
    .onConflictDoUpdate({ target: userSettings.userId, set: { emailSignatureText: signature } });
  return signature;
}
```

In `src/actions/settings.ts`, beside the writing-instructions actions:

```ts
export async function getEmailSettings(): Promise<{ signature: string | null; capability: SendCapability }> {
  const userId = await requireUserForSurface("settings.email");
  const [{ signature }, capability] = await Promise.all([loadEmailSettings(userId), getSendCapability(userId)]);
  return { signature, capability };
}

export async function saveEmailSignatureAction(text: string): Promise<{ ok: true; signature: string | null }> {
  const userId = await requireUserForSurface("settings.email");
  if (typeof text !== "string") throw new UserFacingError("That signature can’t be saved");
  return { ok: true, signature: await saveEmailSignature(userId, text) };
}
```

(imports: `loadEmailSettings`, `saveEmailSignature`, `getSendCapability`, `type SendCapability`, `requireUserForSurface`, `UserFacingError` — reuse any already imported.)

`src/components/settings/email-settings.tsx` — follow `WritingInstructionsField`'s load-then-save shape inside the settings card chrome:

```tsx
"use client";

import { useEffect, useState, useTransition } from "react";
import { getEmailSettings, saveEmailSignatureAction } from "@/actions/settings";
import { SettingsRow, SettingsSection } from "@/components/settings/settings-section";
import { ConnectMailboxButton } from "@/components/email/connect-mailbox-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { SIGNATURE_MAX } from "@/lib/email/signature";
import type { SendCapability } from "@/lib/email/sender";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

/** Signature and sending account for email sent from Orbit. */
export function EmailSettings() {
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState("");
  const [text, setText] = useState("");
  const [capability, setCapability] = useState<SendCapability | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let cancelled = false;
    getEmailSettings()
      .then(({ signature, capability: cap }) => {
        if (cancelled) return;
        setSaved(signature ?? "");
        setText(signature ?? "");
        setCapability(cap);
        setLoaded(true);
      })
      .catch(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  function save() {
    start(async () => {
      try {
        const res = await saveEmailSignatureAction(text);
        setSaved(res.signature ?? "");
        setText(res.signature ?? "");
        toast.success(res.signature ? "Signature saved" : "Signature cleared");
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t save your signature — try again?"));
      }
    });
  }

  return (
    <SettingsSection title="Email" description="How email you send from Orbit is signed and sent.">
      <SettingsRow title="Sending from" description="Email you send from Orbit leaves from this address and lands in its Sent folder.">
        {!capability ? (
          <Skeleton className="h-4 w-44" />
        ) : capability.ok ? (
          <div className="text-sm">
            <span className="font-medium">{capability.fromEmail}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {capability.usedToday} of {capability.dailyCap} sent today
            </span>
          </div>
        ) : capability.reason === "cap_reached" ? (
          <p className="text-sm text-muted-foreground">You’ve reached today’s email limit ({capability.dailyCap})</p>
        ) : (
          <ConnectMailboxButton reason={capability.reason} returnTo="/settings#settings-email" />
        )}
      </SettingsRow>
      <SettingsRow title="Signature" description="Added under emails you write in Compose. Plain text.">
        {!loaded ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <div className="flex w-full flex-col gap-2">
            <Textarea
              rows={4}
              value={text}
              maxLength={SIGNATURE_MAX}
              onChange={(e) => setText(e.target.value)}
              placeholder={"Jason Pereira\nFounder, Orbit"}
              disabled={pending}
            />
            <div className="flex justify-end">
              <Button type="button" size="sm" onClick={save} disabled={pending || text === saved}>
                Save signature
              </Button>
            </div>
          </div>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
```

Check `SettingsSection`/`SettingsRow` prop names in `src/components/settings/settings-section.tsx` and adjust. In the settings `page.tsx`, add under the Preferences group, after the Goals section, following the existing pattern:

```tsx
<Section id="settings-email" hidden={hidden}><EmailSettings /></Section>
```

(`sections.ts` already has the `settings-email` entry from Task 1.)

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/smoke-email-signature.ts && npx tsc --noEmit -p . && npx tsx scripts/run-smoke.ts --only smoke-surface-visibility smoke-toast-copy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/signature.ts src/lib/email/settings.ts src/actions/settings.ts src/components/settings/email-settings.tsx "src/app/(clerk)/(app)/settings/page.tsx" scripts/smoke-email-signature.ts scripts/run-smoke.ts
git commit -m "feat(email): signature and sending-account settings section

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Compose server side

**Files:**
- Create: `src/lib/email/compose.ts`, `src/lib/email/origin-hooks/compose.ts`, `src/actions/email-compose.ts`
- Modify: `src/lib/email/origin-registrations.ts`
- Test: `scripts/smoke-email-compose.ts` (tier `pglite`)

**Interfaces:**
- Consumes: `enqueueEmail`, `ENQUEUE_COPY`, `EnqueueRefusal` (`outbox.ts`); `scheduleDispatch`; `getSendCapability`; `loadEmailSettings`; `appendSignature`; `sanitizeDraft`, `DRAFT_MAX_CHARS` (`chat-draft.ts`); `SEND_SUBJECT_MAX` (`chat-send.ts`); `clearContactFollowUpForUser` (`reminder-writes.ts`); `contactSearchCondition` (`src/lib/contact-search-rank.ts`); `clientAvatarUrlSql` (`src/lib/contact-avatar-sql.ts`); `generateContactFollowUpDraft`, `loadWritingInstructions`, `listActiveGoalTexts`.
- Produces (lib, request-free):
  - `type ComposeRecipient = { email: string; contactId: string | null; name: string | null; avatarUrl: string | null }`
  - `type ComposeContext = { capability: SendCapability; signature: string | null; contact: { id: string; name: string; firstName: string | null; avatarUrl: string | null; emails: string[] } | null }`
  - `getComposeContext(userId, contactId: string | null): Promise<ComposeContext | null>` (null when `contactId` isn't this user's)
  - `searchRecipients(userId, q: string, limit = 8): Promise<ComposeRecipient[]>` (one row per address: primary email + identity emails)
  - `type ComposeInput = { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; contactId: string | null; fromName: string | null }`
  - `type ComposeResult = { ok: true; sendId: string; sendAt: string; to: string[] } | { ok: false; reason: EnqueueRefusal | "empty_body" | "too_long" | "not_retryable"; message: string }`
  - `sendComposed(userId, input: ComposeInput): Promise<ComposeResult>`
- Produces (actions, `src/actions/email-compose.ts`): `getComposeContextAction(contactId: string | null)`, `searchRecipientsAction(q: string)`, `sendComposedEmail(input: Omit<ComposeInput, "fromName">)`, `draftComposeWithAi(contactId: string): Promise<{ ok: true; body: string } | { ok: false; message: string }>` — all start with `requireUserForSurface(COMPOSE_SURFACE_KEY)`.

- [ ] **Step 1: Write the failing test** `scripts/smoke-email-compose.ts`:

```ts
/**
 * Compose: context, recipient search, sending (signature, CC/BCC, contact matching, the
 * follow-up it answers) — through the real outbox with a fake Gmail provider.
 * Run: npx tsx scripts/smoke-email-compose.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import "../src/lib/email/origin-registrations";
import { getComposeContext, searchRecipients, sendComposed } from "../src/lib/email/compose";
import { dispatchEmailSend } from "../src/lib/email/outbox";
import { setProviderOverride } from "../src/lib/email/providers";
import type { MailProvider, OutboundMessage } from "../src/lib/email/providers/types";
import { saveEmailSignature } from "../src/lib/email/settings";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-compose-user";
const OTHER = "smoke-email-compose-other";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sent: OutboundMessage[] = [];
const fake: MailProvider = {
  id: "gmail",
  async identity() { return { email: "me@acme-corp.io" }; },
  async send(_u, msg) { sent.push(msg); return { providerMessageId: `pm-${sent.length}`, providerThreadId: "pt" }; },
  async findSent() { return null; },
};
async function flush() {
  const db = await getDb();
  await db.execute(sql`UPDATE email_sends SET send_at = now() - interval '1 second' WHERE user_id = ${USER} AND status = 'queued'`);
  const rows = await db.select({ id: schema.emailSends.id }).from(schema.emailSends).where(sql`user_id = ${USER} AND status = 'queued'`);
  for (const r of rows) await dispatchEmailSend(r.id);
}

async function main() {
  const db = await getDb();
  for (const u of [USER, OTHER]) await purgeUserData(u, { keepSettings: false }).catch(() => {});
  setProviderOverride("gmail", fake);
  try {
    const [maya] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Maya Lin", firstName: "Maya", email: "maya@work.io", followUpStatus: "due", nextFollowUpAt: new Date() }).returning();
    await db.insert(schema.contactIdentities).values({ userId: USER, contactId: maya!.id, kind: "email", value: "maya@home.io" });
    const [sam] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Sam Ortiz", email: "sam@work.io" }).returning();
    const [foreign] = await db.insert(schema.contacts).values({ userId: OTHER, fullName: "Maya Other", email: "maya@else.io" }).returning();

    console.log("context");
    const noConn = await getComposeContext(USER, maya!.id);
    check("not connected is reported, not thrown", noConn?.capability.ok === false);
    check("the contact's addresses, primary first", JSON.stringify(noConn?.contact?.emails) === JSON.stringify(["maya@work.io", "maya@home.io"]), JSON.stringify(noConn?.contact?.emails));
    check("someone else's contact gives no context", (await getComposeContext(USER, foreign!.id)) === null);
    check("compose without a contact works", (await getComposeContext(USER, null))?.contact === null);

    await db.insert(schema.gmailConnections).values({
      userId: USER, emailAddress: "me@acme-corp.io", accessTokenEncrypted: encrypt("t"), refreshTokenEncrypted: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000), scopes: GOOGLE_SCOPES.gmailSend, status: "active",
    });
    await saveEmailSignature(USER, "Jason\nOrbit");
    const ctx = await getComposeContext(USER, maya!.id);
    check("connected capability and signature", ctx?.capability.ok === true && ctx.signature === "Jason\nOrbit");

    console.log("recipient search");
    const byName = await searchRecipients(USER, "maya");
    check("a name finds every address of that person", byName.map((r) => r.email).sort().join() === "maya@home.io,maya@work.io", JSON.stringify(byName));
    check("never another user's contacts", !byName.some((r) => r.email === "maya@else.io"));
    const byEmail = await searchRecipients(USER, "sam@");
    check("an address fragment finds it", byEmail.length === 1 && byEmail[0]!.contactId === sam!.id);

    console.log("send");
    const bad = await sendComposed(USER, { to: ["not an address"], cc: [], bcc: [], subject: "Hi", body: "Hello", contactId: maya!.id, fromName: "Jason" });
    check("a bad address is refused with copy", !bad.ok && bad.reason === "invalid_recipient" && !bad.message.endsWith("."));
    const empty = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "Hi", body: "  ", contactId: maya!.id, fromName: "Jason" });
    check("an empty body is refused", !empty.ok && empty.reason === "empty_body");

    const ok = await sendComposed(USER, {
      to: ["maya@work.io"], cc: ["sam@work.io"], bcc: ["boss@acme-corp.io"],
      subject: "Coffee next week?", body: "Hi Maya,\n\nCoffee next week?", contactId: maya!.id, fromName: "Jason",
    });
    check("queued", ok.ok, JSON.stringify(ok));
    check("nothing goes out during the undo window", sent.length === 0);
    await flush();
    const msg = sent[0];
    check("sent once", sent.length === 1);
    check("signature appended with the delimiter", msg?.bodyText === "Hi Maya,\n\nCoffee next week?\n\n-- \nJason\nOrbit", JSON.stringify(msg?.bodyText));
    check("cc and bcc carried", msg?.cc.join() === "sam@work.io" && msg.bcc.join() === "boss@acme-corp.io");
    check("from name carried", msg?.from.name === "Jason");
    const mayaLog = await db.select().from(schema.interactions).where(eq(schema.interactions.contactId, maya!.id));
    const samLog = await db.select().from(schema.interactions).where(eq(schema.interactions.contactId, sam!.id));
    check("logged on the To contact and the CC contact", mayaLog.length === 1 && samLog.length === 1 && mayaLog[0]!.source === "email_send");
    const after = await db.query.contacts.findFirst({ where: eq(schema.contacts.id, maya!.id) });
    check("emailing someone answers their due follow-up", after?.followUpStatus === "none");

    const long = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "x".repeat(201), body: "Hi", contactId: null, fromName: null });
    check("an over-long subject is refused", !long.ok && long.reason === "too_long");
  } finally {
    setProviderOverride("gmail", null);
    for (const u of [USER, OTHER]) await purgeUserData(u, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll compose checks passed.");
}

run(main);
```

Register `"smoke-email-compose": "pglite",`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-email-compose.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/lib/email/compose.ts`:

```ts
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contactIdentities, contacts } from "@/db/schema";
import { DRAFT_MAX_CHARS, sanitizeDraft } from "@/lib/chat-draft";
import { SEND_SUBJECT_MAX } from "@/lib/chat-send";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";
import { contactSearchCondition } from "@/lib/contact-search-rank";
import { UNDO_DELAY_MS } from "@/lib/email/config";
import { ENQUEUE_COPY, enqueueEmail, type EnqueueRefusal } from "@/lib/email/outbox";
import { getSendCapability, type SendCapability } from "@/lib/email/sender";
import { loadEmailSettings } from "@/lib/email/settings";
import { appendSignature } from "@/lib/email/signature";

export type ComposeRecipient = { email: string; contactId: string | null; name: string | null; avatarUrl: string | null };

export type ComposeContext = {
  capability: SendCapability;
  signature: string | null;
  contact: { id: string; name: string; firstName: string | null; avatarUrl: string | null; emails: string[] } | null;
};

/** What the composer needs before anything is typed. Null for a contact that isn't this user's. */
export async function getComposeContext(userId: string, contactId: string | null): Promise<ComposeContext | null> {
  const db = await getDb();
  const [capability, { signature }] = await Promise.all([getSendCapability(userId), loadEmailSettings(userId)]);
  if (!contactId) return { capability, signature, contact: null };
  const [row] = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      preferredName: contacts.preferredName,
      firstName: contacts.firstName,
      email: contacts.email,
      avatarUrl: clientAvatarUrlSql.as("avatar_url"),
    })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
  if (!row) return null;
  const identities = await db
    .select({ value: contactIdentities.value })
    .from(contactIdentities)
    .where(and(eq(contactIdentities.userId, userId), eq(contactIdentities.contactId, contactId), eq(contactIdentities.kind, "email")));
  const emails: string[] = [];
  for (const e of [row.email, ...identities.map((i) => i.value)]) {
    const v = e?.trim().toLowerCase();
    if (v && !emails.includes(v)) emails.push(v);
  }
  return {
    capability,
    signature,
    contact: { id: row.id, name: row.preferredName || row.fullName, firstName: row.firstName, avatarUrl: row.avatarUrl, emails },
  };
}

/** Recipient suggestions: one row per address — a contact's primary email and identity emails. */
export async function searchRecipients(userId: string, q: string, limit = 8): Promise<ComposeRecipient[]> {
  const term = q.trim();
  if (!term) return [];
  const db = await getDb();
  const like = `%${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const matched = await db
    .select({
      id: contacts.id,
      name: sql<string>`coalesce(${contacts.preferredName}, ${contacts.fullName})`,
      email: contacts.email,
      avatarUrl: clientAvatarUrlSql.as("avatar_url"),
    })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), or(contactSearchCondition(term), sql`lower(${contacts.email}) like ${like}`)))
    .limit(limit);
  const ids = matched.map((m) => m.id);
  const identities = ids.length
    ? await db
        .select({ contactId: contactIdentities.contactId, value: contactIdentities.value })
        .from(contactIdentities)
        .where(and(eq(contactIdentities.userId, userId), eq(contactIdentities.kind, "email"), inArray(contactIdentities.contactId, ids)))
    : [];
  const out: ComposeRecipient[] = [];
  const seen = new Set<string>();
  for (const m of matched) {
    const addresses = [m.email, ...identities.filter((i) => i.contactId === m.id).map((i) => i.value)];
    for (const a of addresses) {
      const email = a?.trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      out.push({ email, contactId: m.id, name: m.name, avatarUrl: m.avatarUrl });
    }
  }
  return out.slice(0, limit);
}

export type ComposeInput = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  contactId: string | null;
  fromName: string | null;
};

export type ComposeResult =
  | { ok: true; sendId: string; sendAt: string; to: string[] }
  | { ok: false; reason: EnqueueRefusal | "empty_body" | "too_long" | "not_retryable"; message: string };

/** Queue a composed email: cleaned, signed, sent after the undo window. */
export async function sendComposed(userId: string, input: ComposeInput): Promise<ComposeResult> {
  const body = sanitizeDraft(input.body);
  if (!body) return { ok: false, reason: "empty_body", message: ENQUEUE_COPY.empty_body };
  if (Array.from(body).length > DRAFT_MAX_CHARS) return { ok: false, reason: "too_long", message: "That message is too long to send" };
  const subject = (sanitizeDraft(input.subject) ?? "").replace(/\s+/g, " ").trim();
  if (Array.from(subject).length > SEND_SUBJECT_MAX) return { ok: false, reason: "too_long", message: "That subject is too long" };
  const { signature } = await loadEmailSettings(userId);
  const queued = await enqueueEmail(userId, {
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject,
    bodyText: appendSignature(body, signature),
    fromName: input.fromName,
    origin: "compose",
    originRef: input.contactId,
    delayMs: UNDO_DELAY_MS,
  });
  if (!queued.ok) return queued;
  return { ok: true, sendId: queued.id, sendAt: queued.sendAt.toISOString(), to: queued.to };
}
```

Note: `sendComposed` doesn't call `scheduleDispatch` (lib stays free of `next/server`); the action does.

`src/lib/email/origin-hooks/compose.ts`:

```ts
import { registerOriginHooks } from "@/lib/email/origins";
import { clearContactFollowUpForUser } from "@/lib/reminder-writes";

// Emailing someone from Compose answers their follow-up, the same as a Chat send. Every
// matched contact counts — the CC'd colleague you owed a reply is answered too.
registerOriginHooks("compose", {
  async onSent(send) {
    for (const contactId of send.contactIds) await clearContactFollowUpForUser(send.userId, contactId);
  },
});
```

Append `import "@/lib/email/origin-hooks/compose";` to `origin-registrations.ts`.

`src/actions/email-compose.ts`:

```ts
"use server";

import { listActiveGoalTexts } from "@/actions/goals";
import { getCurrentUserProfile } from "@/lib/auth";
import {
  getComposeContext,
  searchRecipients,
  sendComposed,
  type ComposeContext,
  type ComposeInput,
  type ComposeRecipient,
  type ComposeResult,
} from "@/lib/email/compose";
import { scheduleDispatch } from "@/lib/email/schedule";
import { friendlyError } from "@/lib/errors";
import { generateContactFollowUpDraft } from "@/lib/follow-up-drafts";
import { requireUserForSurface } from "@/lib/plan-guards";
import { COMPOSE_SURFACE_KEY } from "@/lib/surfaces";
import { loadWritingInstructions } from "@/lib/writing-instructions-store";

export async function getComposeContextAction(contactId: string | null): Promise<ComposeContext | null> {
  const userId = await requireUserForSurface(COMPOSE_SURFACE_KEY);
  return getComposeContext(userId, contactId);
}

export async function searchRecipientsAction(q: string): Promise<ComposeRecipient[]> {
  const userId = await requireUserForSurface(COMPOSE_SURFACE_KEY);
  return searchRecipients(userId, typeof q === "string" ? q.slice(0, 100) : "");
}

export async function sendComposedEmail(input: Omit<ComposeInput, "fromName">): Promise<ComposeResult> {
  const userId = await requireUserForSurface(COMPOSE_SURFACE_KEY);
  const profile = await getCurrentUserProfile().catch(() => null);
  const result = await sendComposed(userId, {
    to: Array.isArray(input.to) ? input.to.map(String) : [],
    cc: Array.isArray(input.cc) ? input.cc.map(String) : [],
    bcc: Array.isArray(input.bcc) ? input.bcc.map(String) : [],
    subject: String(input.subject ?? ""),
    body: String(input.body ?? ""),
    contactId: typeof input.contactId === "string" ? input.contactId : null,
    fromName: profile?.name?.trim() || null,
  });
  if (result.ok) scheduleDispatch(result.sendId, new Date(result.sendAt));
  return result;
}

export async function draftComposeWithAi(contactId: string): Promise<{ ok: true; body: string } | { ok: false; message: string }> {
  const userId = await requireUserForSurface(COMPOSE_SURFACE_KEY);
  try {
    const [goals, writingInstructions] = await Promise.all([listActiveGoalTexts(), loadWritingInstructions(userId)]);
    const draft = await generateContactFollowUpDraft(userId, contactId, goals, { channel: "email", writingInstructions });
    return { ok: true, body: draft.body };
  } catch (err) {
    return { ok: false, message: friendlyError(err, "Couldn’t draft that — write it yourself or try again?") };
  }
}
```

Check `generateContactFollowUpDraft` verifies contact ownership (it loads by `userId` + `contactId`); if it doesn't, add `const ctx = await getComposeContext(userId, contactId); if (!ctx?.contact) return { ok: false, message: "That contact isn’t available" };` first.

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/smoke-email-compose.ts && npx tsc --noEmit -p . && npx tsx scripts/run-smoke.ts --only smoke-action-user-scope smoke-email-actions smoke-email-no-resend smoke-toast-copy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/compose.ts src/lib/email/origin-hooks/compose.ts src/lib/email/origin-registrations.ts src/actions/email-compose.ts scripts/smoke-email-compose.ts scripts/run-smoke.ts
git commit -m "feat(email): compose context, recipient search and sending

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Local compose drafts

**Files:**
- Create: `src/lib/compose-draft.ts`
- Test: `scripts/smoke-compose-draft.ts` (tier `pure`)

**Interfaces:**
- Produces: `type ComposeDraft = { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string }`; `COMPOSE_DRAFT_TTL_MS = 7 days`; `composeDraftKey(userId: string, contactId: string | null): string`; `readComposeDraft(storage, key, now?): ComposeDraft | null`; `writeComposeDraft(storage, key, draft, now?): void`; `clearComposeDraft(storage, key): void`.

- [ ] **Step 1: Write the failing test** `scripts/smoke-compose-draft.ts`:

```ts
/**
 * Compose drafts in localStorage: account-scoped keys, TTL, shape validation, and storage
 * that throws. Run: npx tsx scripts/smoke-compose-draft.ts
 */
import { clearComposeDraft, composeDraftKey, COMPOSE_DRAFT_TTL_MS, readComposeDraft, writeComposeDraft } from "../src/lib/compose-draft";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}
function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k),
  };
}

const s = memory();
const key = composeDraftKey("u1", "c1");
check("keys are per account and per contact", key !== composeDraftKey("u2", "c1") && key !== composeDraftKey("u1", null));
const draft = { to: ["maya@work.io"], cc: [], bcc: [], subject: "Hi", body: "Coffee?" };
writeComposeDraft(s, key, draft, 1_000);
check("round-trips", JSON.stringify(readComposeDraft(s, key, 2_000)) === JSON.stringify(draft));
check("expires after the TTL", readComposeDraft(s, key, 1_000 + COMPOSE_DRAFT_TTL_MS + 1) === null);
check("and the expired entry is removed", s.getItem(key) === null);
writeComposeDraft(s, key, { ...draft, subject: "", body: "  " }, 1_000);
check("an empty draft is not stored", s.getItem(key) === null);
s.setItem(key, "{not json");
check("junk reads as nothing", readComposeDraft(s, key) === null && s.getItem(key) === null);
s.setItem(key, JSON.stringify({ to: "nope", body: 5, savedAt: Date.now() }));
check("a wrong shape reads as nothing", readComposeDraft(s, key) === null);
writeComposeDraft(s, key, draft);
clearComposeDraft(s, key);
check("clear removes it", s.getItem(key) === null);
const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("full"); }, removeItem() { throw new Error("denied"); } } as unknown as Storage;
check("storage that throws never throws out", (() => { writeComposeDraft(broken, key, draft); clearComposeDraft(broken, key); return readComposeDraft(broken, key) === null; })());
console.log("\nAll compose-draft checks passed.");
```

Register `"smoke-compose-draft": "pure",`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-compose-draft.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/lib/compose-draft.ts` (same shape as `src/lib/capture-draft.ts`):

```ts
/**
 * An unsent Compose draft, kept in this browser so closing the dialog doesn't lose it.
 * Never on the server (spec §5: no server-side drafts in v1). Storage is injected so smoke
 * scripts can pass an in-memory one; every access is guarded, because storage can be full,
 * disabled, or throw in a private window.
 */
export type ComposeDraft = { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string };

const KEY_PREFIX = "orbit:compose-draft:v1";
export const COMPOSE_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function composeDraftKey(userId: string, contactId: string | null): string {
  return `${KEY_PREFIX}:${userId}:${contactId ?? "general"}`;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function safeRemove(storage: Pick<Storage, "removeItem">, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // nothing to do
  }
}

export function readComposeDraft(
  storage: Pick<Storage, "getItem" | "removeItem">,
  key: string,
  now = Date.now()
): ComposeDraft | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeRemove(storage, key);
    return null;
  }
  const d = parsed as Partial<ComposeDraft> & { savedAt?: unknown };
  const valid =
    isStrings(d.to) && isStrings(d.cc) && isStrings(d.bcc) && typeof d.subject === "string" && typeof d.body === "string" && typeof d.savedAt === "number";
  if (!valid || now - (d.savedAt as number) > COMPOSE_DRAFT_TTL_MS) {
    safeRemove(storage, key);
    return null;
  }
  return { to: d.to!, cc: d.cc!, bcc: d.bcc!, subject: d.subject!, body: d.body! };
}

export function writeComposeDraft(
  storage: Pick<Storage, "setItem" | "removeItem">,
  key: string,
  draft: ComposeDraft,
  now = Date.now()
): void {
  if (!draft.subject.trim() && !draft.body.trim()) {
    safeRemove(storage, key);
    return;
  }
  try {
    storage.setItem(key, JSON.stringify({ ...draft, savedAt: now }));
  } catch {
    // Full or disabled storage: the draft simply isn't kept.
  }
}

export function clearComposeDraft(storage: Pick<Storage, "removeItem">, key: string): void {
  safeRemove(storage, key);
}
```

- [ ] **Step 4: Run test**

Run: `npx tsx scripts/smoke-compose-draft.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/compose-draft.ts scripts/smoke-compose-draft.ts scripts/run-smoke.ts
git commit -m "feat(email): local compose drafts with TTL

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Recipient field

**Files:**
- Create: `src/components/email/recipient-field.tsx`

**Interfaces:**
- Consumes: `searchRecipientsAction` (Task 3), `ContactAvatar` (`src/components/contacts/contact-avatar.tsx`), `normalizeRecipients` is NOT imported client-side (it imports `chat-send`, which is client-safe — confirm with `grep -n "^import" src/lib/chat-send.ts src/lib/email/recipients.ts`; if any import is server-only, use the simple `EMAIL_SHAPE` regex below for chip validation and leave the authoritative check to the server).
- Produces: `RecipientField({ label, value, onChange, suggestions?, autoFocus?, id })` where `value: string[]`, `suggestions: ComposeRecipient[]` (shown when the input is empty and focused, e.g. the contact's own addresses).

No smoke (a client widget); verified in the browser in Task 9. Keep behavior simple and keyboard-complete.

- [ ] **Step 1: Implement**

```tsx
"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { searchRecipientsAction } from "@/actions/email-compose";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import type { ComposeRecipient } from "@/lib/email/compose";
import { cn } from "@/lib/utils";

/** Shape only — the server's `normalizeRecipients` is the authority. */
const EMAIL_SHAPE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * An address list as chips. Enter, comma, Tab or blur turns what was typed into a chip;
 * Backspace on an empty input removes the last one. Suggestions come from the user's
 * contacts (every address a person has), or from `suggestions` when nothing is typed.
 */
export function RecipientField({
  id,
  label,
  value,
  onChange,
  suggestions = [],
  autoFocus,
}: {
  id: string;
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: ComposeRecipient[];
  autoFocus?: boolean;
}) {
  const listId = useId();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [results, setResults] = useState<ComposeRecipient[]>([]);
  const [active, setActive] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const term = text.trim();
    if (!term) {
      setResults([]);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      searchRecipientsAction(term)
        .then((r) => mine === seq.current && setResults(r))
        .catch(() => mine === seq.current && setResults([]));
    }, 140);
    return () => clearTimeout(t);
  }, [text]);

  const options = (text.trim() ? results : suggestions).filter((r) => !value.includes(r.email));
  const open = focused && options.length > 0;

  function add(raw: string) {
    const parts = raw.split(/[,;\s]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
    const next = [...value];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setText("");
    setActive(0);
  }

  return (
    <div className="flex items-start gap-2 border-b border-border/60 py-1.5">
      <label htmlFor={id} className="w-10 shrink-0 pt-1 text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.map((email) => {
          const bad = !EMAIL_SHAPE.test(email);
          return (
            <span
              key={email}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                bad ? "border-destructive/60 text-destructive" : "border-border bg-muted/50"
              )}
              title={bad ? "This doesn’t look like an email address" : undefined}
            >
              <span className="truncate">{email}</span>
              <button
                type="button"
                aria-label={`Remove ${email}`}
                className="rounded-full p-0.5 hover:bg-foreground/10"
                onClick={() => onChange(value.filter((v) => v !== email))}
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            // Let a click on a suggestion land first.
            setTimeout(() => setFocused(false), 120);
            if (text.trim()) add(text);
          }}
          onKeyDown={(e) => {
            if (open && e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, options.length - 1)); return; }
            if (open && e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); return; }
            if (e.key === "Enter" || e.key === "," || e.key === ";" || (e.key === "Tab" && text.trim())) {
              if (open && options[active] && e.key !== ",") { e.preventDefault(); add(options[active]!.email); return; }
              if (text.trim()) { e.preventDefault(); add(text); }
              return;
            }
            if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (/[,;\s]/.test(pasted.trim())) { e.preventDefault(); add(pasted); }
          }}
          className="min-w-[8rem] flex-1 bg-transparent py-1 text-sm outline-none"
        />
        {open && (
          <ul id={listId} role="listbox" className="absolute left-0 top-full z-50 mt-1 w-full max-w-sm overflow-hidden rounded-lg border bg-popover p-1 shadow-md">
            {options.map((r, i) => (
              <li
                key={r.email}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); add(r.email); }}
                onMouseEnter={() => setActive(i)}
                className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm", i === active && "bg-accent")}
              >
                {r.contactId ? (
                  <ContactAvatar contactId={r.contactId} fullName={r.name ?? r.email} profileImageUrl={r.avatarUrl} size="sm" className="size-6" />
                ) : null}
                <span className="min-w-0 truncate">
                  {r.name ? <span className="font-medium">{r.name} </span> : null}
                  <span className="text-muted-foreground">{r.email}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
```

(`import type { ComposeRecipient } from "@/lib/email/compose"` is erased at build; confirm the client bundle doesn't pull `@/db` — `npm run build` in Task 9 catches it via the `node:fs` chunk error.)

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit -p . && npx eslint src/components/email/recipient-field.tsx`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/email/recipient-field.tsx
git commit -m "feat(email): recipient chip field with contact suggestions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The Compose dialog, host and open event

**Files:**
- Create: `src/lib/compose-events.ts`, `src/components/email/compose-dialog.tsx`, `src/components/email/compose-host.tsx`
- Modify: `src/components/layout/app-shell.tsx` (mount the host next to `<CommandPalette … />` ~155)

**Interfaces:**
- Produces:
  - `COMPOSE_EVENT = "orbit:compose"`; `type ComposeRequest = { contactId: string | null; to?: string[]; subject?: string; body?: string }`; `openCompose(req: ComposeRequest): void` (dispatches a `CustomEvent` on `window`).
  - `ComposeHost({ userId })` — mounted once; renders nothing until the first event; hidden when `feature.compose` is hidden.
  - `ComposeDialog({ request, userId, open, onOpenChange })`.

- [ ] **Step 1: Implement** `src/lib/compose-events.ts`:

```ts
/**
 * Every Compose entry point (contact page, ⌘K, the pending-sends card's Edit) opens the one
 * dialog `ComposeHost` mounts, by event. Client-safe: no imports.
 */
export const COMPOSE_EVENT = "orbit:compose";

export type ComposeRequest = { contactId: string | null; to?: string[]; subject?: string; body?: string };

export function openCompose(req: ComposeRequest): void {
  window.dispatchEvent(new CustomEvent<ComposeRequest>(COMPOSE_EVENT, { detail: req }));
}
```

`src/components/email/compose-host.tsx`:

```tsx
"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useHiddenSurfaces } from "@/components/layout/hidden-surfaces";
import { COMPOSE_EVENT, type ComposeRequest } from "@/lib/compose-events";
import { COMPOSE_SURFACE_KEY } from "@/lib/surfaces";

const ComposeDialog = dynamic(() => import("@/components/email/compose-dialog").then((m) => m.ComposeDialog));

/** Mounted once in the app shell. Loads the composer only when something asks for it. */
export function ComposeHost({ userId }: { userId: string }) {
  const hidden = useHiddenSurfaces();
  const [request, setRequest] = useState<ComposeRequest | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onCompose = (e: Event) => {
      setRequest((e as CustomEvent<ComposeRequest>).detail);
      setOpen(true);
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, []);

  if (hidden.has(COMPOSE_SURFACE_KEY) || !request) return null;
  return <ComposeDialog key={`${request.contactId ?? "general"}`} request={request} userId={userId} open={open} onOpenChange={setOpen} />;
}
```

In `app-shell.tsx`, render `<ComposeHost userId={…} />` **inside** `HiddenSurfacesProvider` (the hook reads that context). Find how the shell knows the user id (`grep -n "userId" src/components/layout/app-shell.tsx`); if it doesn't, add a `userId` prop threaded from `(clerk)/(app)/layout.tsx` where `AppShell` is rendered. The id is only used to scope the localStorage draft key.

`src/components/email/compose-dialog.tsx`:

```tsx
"use client";

import { Loader2, Send, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { draftComposeWithAi, getComposeContextAction, sendComposedEmail } from "@/actions/email-compose";
import { ConnectMailboxButton } from "@/components/email/connect-mailbox-button";
import { RecipientField } from "@/components/email/recipient-field";
import { showUndoSendToast } from "@/components/email/undo-send-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { clearComposeDraft, composeDraftKey, readComposeDraft, writeComposeDraft } from "@/lib/compose-draft";
import type { ComposeRequest } from "@/lib/compose-events";
import type { ComposeContext } from "@/lib/email/compose";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

/**
 * Write an email and send it from the user's own mailbox. It goes out after a 10-second
 * undo window (the outbox), is logged on every matched contact, and answers their due
 * follow-up. An unsent draft is kept in this browser per contact.
 *
 * One dialog for every screen size: centered from `sm` up, a bottom sheet below it (CSS,
 * so it renders the same on the server and the first client paint).
 */
export function ComposeDialog({
  request,
  userId,
  open,
  onOpenChange,
}: {
  request: ComposeRequest;
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const key = composeDraftKey(userId, request.contactId);
  const [ctx, setCtx] = useState<ComposeContext | null | "unavailable">(null);
  const [to, setTo] = useState<string[]>(request.to ?? []);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCopies, setShowCopies] = useState(false);
  const [subject, setSubject] = useState(request.subject ?? "");
  const [body, setBody] = useState(request.body ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, startSend] = useTransition();
  const [drafting, startDraft] = useTransition();

  // Context, then a saved draft (unless the opener handed in content), then the contact's
  // primary address when To is still empty.
  useEffect(() => {
    let cancelled = false;
    getComposeContextAction(request.contactId)
      .then((c) => {
        if (cancelled) return;
        setCtx(c ?? "unavailable");
        const handed = Boolean(request.to?.length || request.subject || request.body);
        const saved = handed ? null : readComposeDraft(window.localStorage, key);
        if (saved) {
          setTo(saved.to);
          setCc(saved.cc);
          setBcc(saved.bcc);
          setShowCopies(saved.cc.length + saved.bcc.length > 0);
          setSubject(saved.subject);
          setBody(saved.body);
        } else if (!request.to?.length && c?.contact?.emails[0]) {
          setTo([c.contact.emails[0]]);
        }
      })
      .catch(() => !cancelled && setCtx("unavailable"));
    return () => {
      cancelled = true;
    };
    // Opened once per request; `key` follows `request`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // Keep the draft as it's typed.
  useEffect(() => {
    if (ctx === null) return;
    writeComposeDraft(window.localStorage, key, { to, cc, bcc, subject, body });
  }, [ctx, key, to, cc, bcc, subject, body]);

  const suggestions = useMemo(
    () =>
      ctx && ctx !== "unavailable" && ctx.contact
        ? ctx.contact.emails.map((email) => ({ email, contactId: ctx.contact!.id, name: ctx.contact!.name, avatarUrl: ctx.contact!.avatarUrl }))
        : [],
    [ctx]
  );

  const capability = ctx && ctx !== "unavailable" ? ctx.capability : null;
  const canSend = Boolean(capability?.ok) && to.length > 0 && body.trim().length > 0 && !sending;

  function draftWithAi() {
    if (!request.contactId) return;
    startDraft(async () => {
      const res = await draftComposeWithAi(request.contactId!);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      setBody(res.body);
      if (!subject.trim()) setSubject("Following up");
    });
  }

  function send() {
    setProblem(null);
    startSend(async () => {
      try {
        const res = await sendComposedEmail({ to, cc, bcc, subject, body, contactId: request.contactId });
        if (!res.ok) {
          setProblem(res.message);
          return;
        }
        clearComposeDraft(window.localStorage, key);
        onOpenChange(false);
        const label = ctx && ctx !== "unavailable" && ctx.contact ? ctx.contact.name : res.to[0] ?? "them";
        showUndoSendToast({
          sendId: res.sendId,
          recipientLabel: res.to.length > 1 ? `${label} and ${res.to.length - 1} more` : label,
          onUndone: () => {
            // Nothing went out: put the draft back so it can be fixed and resent.
            writeComposeDraft(window.localStorage, key, { to, cc, bcc, subject, body });
            router.refresh();
          },
        });
        router.refresh();
      } catch (err) {
        setProblem(friendlyError(err, "Couldn’t send that — nothing was sent. Try again?"));
      }
    });
  }

  const title = ctx && ctx !== "unavailable" && ctx.contact ? `Email ${ctx.contact.name}` : "New email";

  return (
    <Dialog open={open} onOpenChange={(next) => (sending && !next ? undefined : onOpenChange(next))}>
      <DialogContent className="gap-3 sm:max-w-xl max-sm:top-auto max-sm:bottom-3 max-sm:translate-y-0 max-sm:max-h-[85dvh] max-sm:overflow-y-auto max-sm:rounded-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Sends from your own email after a 10-second undo window.</DialogDescription>
        </DialogHeader>

        {ctx === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Getting ready…
          </p>
        ) : ctx === "unavailable" ? (
          <p className="text-sm text-muted-foreground" role="alert">Couldn’t open the composer. Close it and try again.</p>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2 border-b border-border/60 py-1.5">
              <span className="w-10 shrink-0 text-xs font-medium text-muted-foreground">From</span>
              {capability?.ok ? (
                <span className="min-w-0 truncate font-medium">{capability.fromEmail}</span>
              ) : capability && capability.reason !== "cap_reached" ? (
                <ConnectMailboxButton reason={capability.reason} returnTo={window.location.pathname} />
              ) : (
                <span className="text-muted-foreground">You’ve reached today’s email limit</span>
              )}
            </div>
            <div className="flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <RecipientField id="compose-to" label="To" value={to} onChange={setTo} suggestions={suggestions} autoFocus={!to.length} />
              </div>
              {!showCopies && (
                <button type="button" className="shrink-0 px-1 pt-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowCopies(true)}>
                  Cc/Bcc
                </button>
              )}
            </div>
            {showCopies && (
              <>
                <RecipientField id="compose-cc" label="Cc" value={cc} onChange={setCc} />
                <RecipientField id="compose-bcc" label="Bcc" value={bcc} onChange={setBcc} />
              </>
            )}
            <Input
              aria-label="Subject"
              placeholder="Subject"
              value={subject}
              maxLength={200}
              onChange={(e) => setSubject(e.target.value)}
              className="border-0 border-b border-border/60 px-0 shadow-none focus-visible:ring-0"
            />
            <Textarea
              aria-label="Message"
              rows={10}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message…"
              className="resize-y border-0 px-0 shadow-none focus-visible:ring-0"
            />
            {ctx.signature && (
              <p className="whitespace-pre-wrap text-xs text-muted-foreground" aria-label="Signature">
                {`-- \n${ctx.signature}`}
              </p>
            )}
            {problem && <p className="text-sm text-destructive" role="alert">{problem}</p>}
            <div className="flex items-center justify-between gap-2 pt-1">
              <div>
                {request.contactId && (
                  <Button type="button" variant="outline" size="sm" onClick={draftWithAi} disabled={drafting || sending}>
                    {drafting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                    Draft with AI
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {capability?.ok && capability.remainingToday <= Math.ceil(capability.dailyCap / 4) && (
                  <span className="text-xs text-muted-foreground">{capability.remainingToday} left today</span>
                )}
                <Button type="button" size="sm" onClick={send} disabled={!canSend}>
                  {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                  Send
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

Notes for the implementer:
- "Draft with AI" is always shown for a contact compose; when AI isn't available the action returns the friendly "Add your AI API key…" message as a toast (the same contract `ContactFollowUpSection` uses). Hiding it would need the settings read threaded through the host — not worth it for P2.
- `window.location.pathname` in render is fine inside a client-only dialog (it's mounted after interaction); if lint objects, compute it in an effect.
- Check `Input`/`Textarea` accept those classes without fighting their defaults; adjust spacing in the browser pass (Task 9).

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit -p . && npx eslint src/components/email src/lib/compose-events.ts src/components/layout/app-shell.tsx`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/compose-events.ts src/components/email/compose-dialog.tsx src/components/email/compose-host.tsx src/components/layout/app-shell.tsx "src/app/(clerk)/(app)/layout.tsx"
git commit -m "feat(email): compose dialog, mounted once and opened by event

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Entry points — contact page and ⌘K

**Files:**
- Create: `src/components/email/compose-button.tsx`
- Modify: `src/components/contacts/contact-profile-hero.tsx` (actions ~350-381 and `StickyMiniBar` ~128-207)
- Modify: `src/lib/command-palette.ts` (+ `emailVerbTerm`), `src/components/layout/command-palette-dialog.tsx` (people rows ~349-370)
- Modify: `scripts/smoke-command-palette.ts`

**Interfaces:**
- Consumes: `openCompose`, `COMPOSE_SURFACE_KEY`, `useHiddenSurfaces`.
- Produces: `ComposeButton({ contactId, size? })`; `emailVerbTerm(query: string): string | null` — returns the name term after a leading `email ` / `mail ` (case-insensitive), else null.

- [ ] **Step 1: Write the failing test** — add to `scripts/smoke-command-palette.ts`:

```ts
import { emailVerbTerm } from "../src/lib/command-palette";
check("'email maya' is the email verb for maya", emailVerbTerm("email maya") === "maya");
check("'Mail  Sam Ortiz' too, trimmed", emailVerbTerm("Mail  Sam Ortiz") === "Sam Ortiz");
check("'email' alone has no name yet", emailVerbTerm("email") === null && emailVerbTerm("email ") === null);
check("'emailing notes' is not the verb", emailVerbTerm("emailing notes") === null);
check("an ordinary search is not the verb", emailVerbTerm("maya") === null);
```

(adapt to the file's `check` helper and section style).

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-command-palette.ts`
Expected: FAIL — `emailVerbTerm` not exported.

- [ ] **Step 3: Implement.** In `src/lib/command-palette.ts`:

```ts
/**
 * "email maya" / "mail maya": the palette's one typed verb. Returns the name to search for,
 * or null when the query isn't the verb. The people rows it produces open Compose.
 */
export function emailVerbTerm(query: string): string | null {
  const m = /^\s*(?:e-?mail|mail)\s+(.+?)\s*$/i.exec(query);
  return m ? m[1]!.replace(/\s+/g, " ") : null;
}
```

In `command-palette-dialog.tsx`:
- Compute `const composeVisible = !hidden.has(COMPOSE_SURFACE_KEY);` and `const emailTerm = composeVisible ? emailVerbTerm(query) : null;`.
- When `emailTerm` is set, run the people search with `emailTerm` instead of the raw term (same debounced `searchContactsForPicker(term, 8, "recent")` call — pass the stripped term).
- Map people rows differently when `emailTerm` is set:

```tsx
people.map((p) => ({
  id: `email:${p.id}`,
  group: "Email",
  label: `Email ${p.preferredName || p.fullName}`,
  hint: p.company ?? undefined,
  hintAlways: true,
  icon: <ContactAvatar contactId={p.id} firstName={p.firstName} fullName={p.fullName} profileImageUrl={p.avatarUrl} size="sm" className="size-7" />,
  run: () => {
    close();
    openCompose({ contactId: p.id });
  },
}))
```

Use the dialog's existing close function name (look at how `go()` closes the palette) and import `openCompose`, `emailVerbTerm`, `COMPOSE_SURFACE_KEY`. Add a static `ACTIONS` entry only if the palette supports non-href commands cleanly; otherwise skip it — the typed verb plus the contact button cover P2.

`src/components/email/compose-button.tsx`:

```tsx
"use client";

import { Mail } from "lucide-react";
import { useHiddenSurfaces } from "@/components/layout/hidden-surfaces";
import { Button } from "@/components/ui/button";
import { openCompose } from "@/lib/compose-events";
import { COMPOSE_SURFACE_KEY } from "@/lib/surfaces";

/** "Email" on a contact's page. Renders nothing while Compose is hidden or unreleased. */
export function ComposeButton({ contactId }: { contactId: string }) {
  const hidden = useHiddenSurfaces();
  if (hidden.has(COMPOSE_SURFACE_KEY)) return null;
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => openCompose({ contactId })}>
      <Mail className="size-3.5" /> Email
    </Button>
  );
}
```

In `contact-profile-hero.tsx`, render `<ComposeButton contactId={contactId} />` immediately before `<ContactEditSheet …>` in both the hero actions and `StickyMiniBar`. (It sits alongside the existing `mailto:` channel icon; leaving that icon is deliberate — it still opens the user's own mail app.)

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/smoke-command-palette.ts && npx tsc --noEmit -p . && npx eslint src/components/email src/components/contacts/contact-profile-hero.tsx src/components/layout/command-palette-dialog.tsx src/lib/command-palette.ts`
Expected: PASS / 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/email/compose-button.tsx src/components/contacts/contact-profile-hero.tsx src/lib/command-palette.ts src/components/layout/command-palette-dialog.tsx scripts/smoke-command-palette.ts
git commit -m "feat(email): open Compose from a contact's page or by typing 'email <name>'

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Scheduled and failed sends on the contact page

**Files:**
- Modify: `src/lib/email/compose.ts` (+ `listContactPendingSends`, `retryFailedSend`, `dismissFailedSend`)
- Modify: `src/actions/email-compose.ts` (+ three wrappers)
- Create: `src/components/email/pending-sends.tsx`
- Modify: `src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx` (render above the Timeline ~401-424)
- Test: extend `scripts/smoke-email-compose.ts`

**Interfaces:**
- Produces (lib):
  - `type PendingSend = { id: string; status: "queued" | "sending" | "failed"; subject: string; to: string[]; sendAt: string; failureKind: EmailFailureKind | null; origin: EmailOrigin; bodyText: string }`
  - `listContactPendingSends(userId, contactId): Promise<PendingSend[]>` — this contact's `queued`/`sending` rows plus `failed` rows not dismissed from the last 7 days, newest first, at most 10.
  - `retryFailedSend(userId, sendId, fromName): Promise<ComposeResult>` — re-enqueues a copy of a failed, non-ambiguous send (same origin, originRef, recipients, subject, body, contactIds, idempotencyKey) with the undo delay, then marks the old row dismissed.
  - `dismissFailedSend(userId, sendId): Promise<boolean>` — sets `dismissed_at` on a failed row owned by the user.
- Produces (actions): `listContactPendingSendsAction(contactId)`, `retryFailedSendAction(sendId)` (calls `scheduleDispatch`), `dismissFailedSendAction(sendId)`.
- **These three actions gate on the user only (`requireUserId`), not on `feature.compose`**: failed Chat/follow-up sends are P1 behavior and must be visible without Compose. Retry is only allowed for `origin` in `compose | follow_up | chat`; agent and recruiter failures are managed on their own screens.

- [ ] **Step 1: Write the failing checks** — append to `main()` in `scripts/smoke-email-compose.ts` before `finally`:

```ts
    console.log("pending on the contact page");
    const q = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "Queued one", body: "Later", contactId: maya!.id, fromName: null });
    const pending = await listContactPendingSends(USER, maya!.id);
    check("a queued send shows on the contact", q.ok && pending.some((p) => p.id === q.sendId && p.status === "queued"));
    check("not on another contact", !(await listContactPendingSends(USER, sam!.id)).some((p) => q.ok && p.id === q.sendId));
    check("not for another user", (await listContactPendingSends(OTHER, maya!.id)).length === 0);

    await db.execute(sql`UPDATE email_sends SET status = 'failed', failure_kind = 'permanent' WHERE id = ${q.ok ? q.sendId : ""}::uuid`);
    const failed = await listContactPendingSends(USER, maya!.id);
    check("a failed send shows as failed", failed.some((p) => q.ok && p.id === q.sendId && p.status === "failed"));
    const retried = await retryFailedSend(USER, q.ok ? q.sendId : "", "Jason");
    check("retry queues a fresh copy", retried.ok && retried.sendId !== (q.ok ? q.sendId : ""));
    const afterRetry = await listContactPendingSends(USER, maya!.id);
    check("and the failed one leaves the list", !afterRetry.some((p) => q.ok && p.id === q.sendId));

    await db.execute(sql`UPDATE email_sends SET status = 'failed', failure_kind = 'ambiguous' WHERE id = ${retried.ok ? retried.sendId : ""}::uuid`);
    const amb = await retryFailedSend(USER, retried.ok ? retried.sendId : "", "Jason");
    check("a possibly-sent email cannot be retried", !amb.ok);
    check("but it can be dismissed", await dismissFailedSend(USER, retried.ok ? retried.sendId : ""));
    check("dismissed rows leave the list", !(await listContactPendingSends(USER, maya!.id)).some((p) => retried.ok && p.id === retried.sendId));
    check("another user cannot dismiss it", !(await dismissFailedSend(OTHER, retried.ok ? retried.sendId : "")));
```

Import `listContactPendingSends`, `retryFailedSend`, `dismissFailedSend`. The burst bucket (10 / 10 min) is shared across this whole smoke — add a `resetBucket()` (as in `smoke-email-origins.ts`) before this section.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-email-compose.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** in `src/lib/email/compose.ts`:

```ts
export type PendingSend = {
  id: string;
  status: "queued" | "sending" | "failed";
  subject: string;
  to: string[];
  sendAt: string;
  failureKind: EmailFailureKind | null;
  origin: EmailOrigin;
  bodyText: string;
};

const RETRYABLE_ORIGINS: ReadonlySet<EmailOrigin> = new Set(["compose", "follow_up", "chat"]);

/** What's waiting or went wrong for this contact — the outbox rows the timeline doesn't show yet. */
export async function listContactPendingSends(userId: string, contactId: string): Promise<PendingSend[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(emailSends)
    .where(
      and(
        eq(emailSends.userId, userId),
        sql`${emailSends.contactIds} @> ${JSON.stringify([contactId])}::jsonb`,
        or(
          inArray(emailSends.status, ["queued", "sending"]),
          and(eq(emailSends.status, "failed"), isNull(emailSends.dismissedAt), gte(emailSends.updatedAt, sql`now() - interval '7 days'`))
        )
      )
    )
    .orderBy(desc(emailSends.createdAt))
    .limit(10);
  return rows.map((r) => ({
    id: r.id,
    status: r.status as PendingSend["status"],
    subject: r.subject,
    to: r.to,
    sendAt: r.sendAt.toISOString(),
    failureKind: r.failureKind,
    origin: r.origin,
    bodyText: r.bodyText,
  }));
}

/** Send a definitely-failed email again, as a fresh row with its own undo window. */
export async function retryFailedSend(userId: string, sendId: string, fromName: string | null): Promise<ComposeResult> {
  const db = await getDb();
  const old = await db.query.emailSends.findFirst({ where: and(eq(emailSends.id, sendId), eq(emailSends.userId, userId)) });
  if (!old || old.status !== "failed") return { ok: false, reason: "not_retryable", message: "That email isn’t waiting to be retried" };
  if (old.failureKind === "ambiguous") return { ok: false, reason: "not_retryable", message: "That may have sent — check your Sent folder first" };
  if (!RETRYABLE_ORIGINS.has(old.origin)) return { ok: false, reason: "not_retryable", message: "Retry that from where you sent it" };
  const queued = await enqueueEmail(userId, {
    to: old.to,
    cc: old.cc,
    bcc: old.bcc,
    subject: old.subject,
    bodyText: old.bodyText,
    fromName: fromName ?? old.fromName,
    origin: old.origin,
    originRef: old.originRef,
    idempotencyKey: old.idempotencyKey,
    contactIds: old.contactIds,
    threadId: old.providerThreadId,
    delayMs: UNDO_DELAY_MS,
  });
  if (!queued.ok) return queued;
  await db.update(emailSends).set({ dismissedAt: new Date() }).where(eq(emailSends.id, old.id));
  return { ok: true, sendId: queued.id, sendAt: queued.sendAt.toISOString(), to: queued.to };
}

export async function dismissFailedSend(userId: string, sendId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(emailSends)
    .set({ dismissedAt: new Date() })
    .where(and(eq(emailSends.id, sendId), eq(emailSends.userId, userId), eq(emailSends.status, "failed")))
    .returning();
  return rows.length > 0;
}
```

(extend imports: `emailSends`, `type EmailFailureKind`, `type EmailOrigin` from schema; `desc`, `gte`, `isNull` from drizzle-orm.) The retry reuses `idempotencyKey`: the old row is `failed` and not ambiguous, so the partial unique index no longer covers it.

Actions in `src/actions/email-compose.ts`:

```ts
export async function listContactPendingSendsAction(contactId: string): Promise<PendingSend[]> {
  const userId = await requireUserId();
  return listContactPendingSends(userId, String(contactId));
}

export async function retryFailedSendAction(sendId: string): Promise<ComposeResult> {
  const userId = await requireUserId();
  const profile = await getCurrentUserProfile().catch(() => null);
  const result = await retryFailedSend(userId, String(sendId), profile?.name?.trim() || null);
  if (result.ok) scheduleDispatch(result.sendId, new Date(result.sendAt));
  return result;
}

export async function dismissFailedSendAction(sendId: string): Promise<{ dismissed: boolean }> {
  const userId = await requireUserId();
  return { dismissed: await dismissFailedSend(userId, String(sendId)) };
}
```

`src/components/email/pending-sends.tsx`:

```tsx
"use client";

import { AlertTriangle, Clock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { dismissFailedSendAction, retryFailedSendAction } from "@/actions/email-compose";
import { cancelEmailSendAction } from "@/actions/email-sends";
import { showUndoSendToast } from "@/components/email/undo-send-toast";
import { useHiddenSurfaces } from "@/components/layout/hidden-surfaces";
import { Button } from "@/components/ui/button";
import { openCompose } from "@/lib/compose-events";
import type { PendingSend } from "@/lib/email/compose";
import { friendlyError } from "@/lib/errors";
import { COMPOSE_SURFACE_KEY } from "@/lib/surfaces";
import { toast } from "@/lib/toast";

/** Emails to this contact that are still on their way or didn't make it. Nothing when empty. */
export function PendingSends({ contactId, contactName, sends }: { contactId: string; contactName: string; sends: PendingSend[] }) {
  const router = useRouter();
  const hidden = useHiddenSurfaces();
  const [pending, start] = useTransition();
  if (!sends.length) return null;
  const canEdit = !hidden.has(COMPOSE_SURFACE_KEY);

  const act = (fn: () => Promise<void>) =>
    start(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "That didn’t work — try again?"));
      }
    });

  return (
    <section aria-label="Emails in progress" className="flex flex-col gap-2 rounded-xl border border-border/70 p-3">
      {sends.map((s) => {
        const failed = s.status === "failed";
        const maybeSent = failed && s.failureKind === "ambiguous";
        return (
          <div key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
            {failed ? <AlertTriangle className="size-4 text-destructive" aria-hidden /> : <Clock className="size-4 text-muted-foreground" aria-hidden />}
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{s.subject || "(no subject)"}</p>
              <p className="text-xs text-muted-foreground">
                {maybeSent
                  ? "May have sent — check your Sent folder"
                  : failed
                    ? "Didn’t send"
                    : s.status === "sending"
                      ? "Sending now"
                      : `Sending ${new Date(s.sendAt) > new Date() ? "shortly" : "now"}`}
              </p>
            </div>
            {s.status === "queued" && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(async () => {
                const { result } = await cancelEmailSendAction(s.id);
                toast.message(result === "canceled" ? "Canceled — nothing went out" : "Already sent");
              })}>
                Cancel
              </Button>
            )}
            {failed && !maybeSent && s.origin !== "agent" && s.origin !== "recruiter" && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => act(async () => {
                const res = await retryFailedSendAction(s.id);
                if (!res.ok) { toast.error(res.message); return; }
                showUndoSendToast({ sendId: res.sendId, recipientLabel: contactName, onUndone: () => router.refresh() });
              })}>
                Retry
              </Button>
            )}
            {failed && canEdit && !maybeSent && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(async () => {
                await dismissFailedSendAction(s.id);
                openCompose({ contactId, to: s.to, subject: s.subject, body: s.bodyText });
              })}>
                Edit
              </Button>
            )}
            {failed && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(async () => { await dismissFailedSendAction(s.id); })}>
                Dismiss
              </Button>
            )}
          </div>
        );
      })}
    </section>
  );
}
```

Edit strips nothing from `bodyText`; if the original had the Compose signature appended, the reopened draft will show it once in the body and the send appends it again — `appendSignature` skips a body that already ends with the same signature, so it isn't doubled.

In the contact page, start `const pendingSendsPromise = listContactPendingSendsAction(id).catch(() => [])` beside the other eager reads, and render above the timeline section:

```tsx
<Suspense fallback={null}>
  <StreamedPendingSends contactId={id} contactName={displayName} sendsPromise={pendingSendsPromise} />
</Suspense>
```

with a small async server component in the page file:

```tsx
async function StreamedPendingSends({ contactId, contactName, sendsPromise }: { contactId: string; contactName: string; sendsPromise: Promise<PendingSend[]> }) {
  const sends = await sendsPromise;
  return <PendingSends contactId={contactId} contactName={contactName} sends={sends} />;
}
```

Use the page's existing variable for the display name (read the file for it) and follow its existing `Streamed*` pattern.

- [ ] **Step 4: Run tests**

Run: `npx tsx scripts/smoke-email-compose.ts && npx tsc --noEmit -p . && npx tsx scripts/run-smoke.ts --only smoke-action-user-scope smoke-toast-copy smoke-behavior-golden`
Expected: PASS. (If the behavior golden records the contact page's reads and now differs only by the new pending-sends read, re-record with `--update` after inspecting the diff.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/compose.ts src/actions/email-compose.ts src/components/email/pending-sends.tsx "src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx" scripts/smoke-email-compose.ts scripts/fixtures/behavior-golden.json
git commit -m "feat(email): scheduled and failed sends on the contact page, with retry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Verification

**Files:** none new (fixes only, if the pass finds anything).

- [ ] **Step 1: Full suite and build**

Stop any dev server using this worktree's `.next` first (resolve listening ports to cwd: `for p in $(lsof -tiTCP -sTCP:LISTEN); do lsof -a -p $p -d cwd -Fn | grep ^n; done`).

```bash
npm run test:check
npm test > /tmp/p2-smoke.log 2>&1; echo "exit=$?"; grep "passed in" /tmp/p2-smoke.log
npx tsc --noEmit -p .
npm run lint
npm run build
```

Expected: `exit=0`, N/N passed, 0 type errors, 0 lint errors, build compiles. Do NOT pipe `npm test` through `tail` — it hides the exit code. A client component reaching `@/db` shows up as a build error mentioning `node:fs`; fix by making that import `import type`.

- [ ] **Step 2: Browser pass (local demo)**

`rm -rf .next` (a build leaves dev unable to serve `next/dynamic` chunks), then start the `orbit-web` preview. The local demo account isn't an admin, so it can't use "Preview unreleased": for this pass only, **temporarily** delete `comingSoon: true` from `feature.compose` in `src/lib/surfaces.ts`, and restore it before committing anything (`git diff src/lib/surfaces.ts` must be empty at the end).

Check, at desktop width and at 375×812 (`resize_window` preset mobile, then reset to desktop):
1. A contact's page shows **Email** next to Edit (and in the sticky bar after scrolling).
2. Clicking it opens "Email <name>" with To prefilled with their primary address; typing another name in To suggests every address that person has; Cc/Bcc reveals two more fields.
3. Without Gmail connected, From shows **Connect Gmail** and Send is disabled.
4. Typing a subject/body, closing, reopening restores the draft.
5. ⌘K → `email ben` shows "Email Ben Carter"; Enter opens Compose for Ben.
6. Settings shows an **Email** section with "Sending from" (Connect Gmail when not connected) and a signature box that saves and reloads.
7. On mobile the dialog sits at the bottom, scrolls, and nothing overflows horizontally.
8. With `comingSoon: true` restored: no Email button, no ⌘K verb, no Settings section.

Take a screenshot of the open composer (desktop and mobile) for the PR.

- [ ] **Step 3: Commit any fixes**, then confirm `git status` is clean and `comingSoon: true` is back.

- [ ] **Step 4: Manual acceptance on a preview (real Gmail, never the demo account) — owed by Jason, listed in the PR:** send to yourself with a CC; undo one; confirm signature, CC, and that the contact's timeline logs it and the follow-up clears; force a failure (revoke access) and Retry from the contact page.

---

## PR notes

- Stacked on #374 (P1). Base: `claude/orbit-direct-email-cc0746` until #374 merges.
- **Ships dark:** `feature.compose` is coming-soon. Admins preview via "Preview unreleased"; releasing is deleting one line in `src/lib/surfaces.ts`.
- New `feature` surface kind (admin console has a "Features" panel).
- The pending/failed sends card on the contact page is **not** gated (it surfaces P1 failures from Chat and follow-ups too).
- No schema change.
