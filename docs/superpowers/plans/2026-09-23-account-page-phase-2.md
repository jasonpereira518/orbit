# Account page, phase 2: Sign-in — emails, connected accounts, lockout guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/settings/account/sign-in`, where a person manages the email addresses and connected accounts they sign in with — and cannot remove their last way in.

**Architecture:** One pure module holds the lockout rules so they are unit-testable without Clerk; the screen is a client component on `useUser()` that renders emails and external accounts from the live user resource and re-reads it after every mutation. Connecting a provider leaves the app and returns through a new SSO-callback route, which is the one piece phase 1 had no precedent for.

**Tech Stack:** Next.js App Router, React 19, `@clerk/nextjs` 7.5.20 (`useUser`, `useClerk`, `useReverification`, `AuthenticateWithRedirectCallback`), Base UI primitives via `src/components/ui/*`, `tsx` smoke scripts.

**Spec:** `docs/superpowers/specs/2026-09-22-account-page-clerk-revision-design.md` (the Sign-in section)

**Predecessor:** `docs/superpowers/plans/2026-09-22-account-page-phase-1.md`, shipped as [#265](https://github.com/jasonpereira518/orbit/pull/265). **This plan must not start until #265 merges** — it adds a tab and a route to files that PR creates.

## Global Constraints

- **Branch from `main` after #265 merges**, in a fresh worktree. Run `npm ci` in it before the first `tsc`/`eslint`/`tsx` command — worktrees have no `node_modules`.
- **Read the relevant guide in `node_modules/next/dist/docs/` before writing route files.** This Next version has breaking changes from what you may remember; heed deprecation notices.
- **No schema change.** Emails and external accounts live in Clerk. Do not touch `SCHEMA_VERSION`, `src/db/schema.ts`, or any migration. If a task seems to need one, stop and ask.
- **Every Clerk hook stays below a `clerkOn` gate** (`isClerkConfigured()`), because marketing pages prerender with no `ClerkProvider`.
- **Sensitive mutations are wrapped in `useReverification`**, and a cancelled prompt is silent: guard with `isReverificationCancelledError` from `@clerk/nextjs/errors` and return without a toast. Phase 1 set this pattern in `src/components/account/devices-list.tsx` — copy it.
- **Failures reach the user through `clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed))`** from `@/lib/clerk-errors` and `@/lib/errors` — never a raw Clerk string, never `err.message`.
- **Copy voice:** no trailing period on short labels, no exclamation marks, typographic apostrophes (U+2019). `scripts/smoke-toast-copy.ts` scans the repo, and `scripts/smoke-account-routes.ts` asserts no straight apostrophe in `CLERK_ERROR_COPY`.
- **Section ids in `src/components/settings/sections.ts` are load-bearing** — `src/lib/surfaces.ts` derives stored hide-list keys from them. This phase adds no section id; the route rides `settings-profile` through the existing shell gate.
- **New routes must be registered in `ROUTE_PATTERNS`** in `src/lib/analytics-routes.ts`. `normalizeRoute` scores on exact segment count, so every route needs its own entry. Phase 1 shipped without this and `smoke-admin-analytics` caught it.
- **A client component must never import `@/db`** — it fails the build with a `node:fs` chunk error.
- **Lint baseline: 0 errors / ~44 warnings.** One accepted warning exists (`react-hooks/set-state-in-effect` in `devices-list.tsx`). Any new error is yours.
- **Never pipe `npm test` through `tail`** — it truncates the failure list you need.

## File Structure

**Create:**
- `src/lib/sign-in-methods.ts` — pure lockout rules. No React, no Clerk import; takes plain shapes so a `tsx` script can exercise every branch.
- `src/components/account/email-list.tsx` — client. Email rows, set-primary, remove.
- `src/components/account/add-email-dialog.tsx` — client. Address → code → verified.
- `src/components/account/connected-accounts.tsx` — client. Provider rows, connect, disconnect.
- `src/components/account/sso-return.tsx` — client. Mounts Clerk's redirect-callback component; the callback route's only child.
- `src/app/(clerk)/(app)/settings/account/sign-in/page.tsx` — the screen (server component, `clerkOn` gate).
- `src/app/(clerk)/(app)/settings/account/sign-in/callback/page.tsx` — the SSO return leg.
- `scripts/smoke-sign-in-methods.ts` — the lockout rules' test.

**Modify:**
- `src/components/account/account-nav.tsx` — add the Sign-in tab.
- `scripts/smoke-account-routes.ts` — add both new routes to `FILE_FOR_HREF`, and the Clerk-gate check picks them up automatically.
- `scripts/run-smoke.ts` — register `smoke-sign-in-methods`.
- `src/lib/analytics-routes.ts` — add both new routes to `ROUTE_PATTERNS`.

Phase 3 (Security: password, TOTP, passkeys) gets its own plan. After this plan, a person can add and verify an email, choose which is primary, remove one, connect and disconnect a provider — and never strand themselves without a way to sign in.

---

### Task 1: The lockout rules, as a pure module

This is the only genuinely unit-testable piece in the phase, and the one whose failure hurts most, so it goes first and gets real tests.

**Files:**
- Create: `src/lib/sign-in-methods.ts`
- Create: `scripts/smoke-sign-in-methods.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export type SignInMethods = {
  /** Every email on the account, with whether Clerk has verified it. */
  emails: ReadonlyArray<{ id: string; verified: boolean }>;
  /** Connected OAuth accounts, by their identification id. */
  externalAccountIds: ReadonlyArray<string>;
  /** Whether a password is set. */
  hasPassword: boolean;
  /** The primary email's id, or null. */
  primaryEmailId: string | null;
};
export type RemovalVerdict = { allowed: true } | { allowed: false; reason: string };
export function canRemoveEmail(methods: SignInMethods, emailId: string): RemovalVerdict;
export function canDisconnectAccount(methods: SignInMethods, identificationId: string): RemovalVerdict;
```

Tasks 3 and 5 call these and show `reason` as the disabled control's explanation.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-sign-in-methods.ts`:

```ts
/**
 * The rules that stop someone removing their last way to sign in.
 *
 * Every branch is exercised here because the UI cannot be: mounting Clerk's user resource
 * needs a browser and real keys, so these rules live in a pure module precisely so a plain
 * tsx script can prove them.
 *
 * Run: npx tsx scripts/smoke-sign-in-methods.ts
 */
import {
  canDisconnectAccount,
  canRemoveEmail,
  type SignInMethods,
} from "../src/lib/sign-in-methods";

let failures = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A password user with two verified emails — the comfortable case. */
const roomy: SignInMethods = {
  emails: [
    { id: "e1", verified: true },
    { id: "e2", verified: true },
  ],
  externalAccountIds: ["x1"],
  hasPassword: true,
  primaryEmailId: "e1",
};

console.log("\nemail removal");
check("a non-primary verified email can go when another remains", canRemoveEmail(roomy, "e2").allowed);

const primaryBlocked = canRemoveEmail(roomy, "e1");
check("the primary email cannot be removed", !primaryBlocked.allowed);
check(
  "and the reason says why",
  !primaryBlocked.allowed && primaryBlocked.reason.toLowerCase().includes("primary"),
  !primaryBlocked.allowed ? primaryBlocked.reason : ""
);

const onlyEmail: SignInMethods = {
  emails: [{ id: "e1", verified: true }],
  externalAccountIds: [],
  hasPassword: true,
  primaryEmailId: "e1",
};
check("the last verified email cannot be removed", !canRemoveEmail(onlyEmail, "e1").allowed);

const unverifiedExtra: SignInMethods = {
  emails: [
    { id: "e1", verified: true },
    { id: "e2", verified: false },
  ],
  externalAccountIds: [],
  hasPassword: true,
  primaryEmailId: "e1",
};
check(
  "an unverified email can always go — it is not a way in",
  canRemoveEmail(unverifiedExtra, "e2").allowed
);
check(
  "an unverified email does not count as the spare that frees the primary",
  !canRemoveEmail(unverifiedExtra, "e1").allowed
);
check("an unknown email id is refused", !canRemoveEmail(roomy, "nope").allowed);

console.log("\ndisconnecting an account");
check("a provider can go while a password remains", canDisconnectAccount(roomy, "x1").allowed);

const oauthOnly: SignInMethods = {
  emails: [{ id: "e1", verified: true }],
  externalAccountIds: ["x1"],
  hasPassword: false,
  primaryEmailId: "e1",
};
const lastWayIn = canDisconnectAccount(oauthOnly, "x1");
check("the only provider cannot go when there is no password", !lastWayIn.allowed);
check(
  "and the reason mentions the password",
  !lastWayIn.allowed && lastWayIn.reason.toLowerCase().includes("password"),
  !lastWayIn.allowed ? lastWayIn.reason : ""
);

const twoProviders: SignInMethods = {
  emails: [{ id: "e1", verified: true }],
  externalAccountIds: ["x1", "x2"],
  hasPassword: false,
  primaryEmailId: "e1",
};
check("one of two providers can go with no password", canDisconnectAccount(twoProviders, "x1").allowed);
check("an unknown account id is refused", !canDisconnectAccount(roomy, "nope").allowed);

console.log("\nvoice");
for (const verdict of [primaryBlocked, canRemoveEmail(onlyEmail, "e1"), lastWayIn]) {
  if (verdict.allowed) continue;
  check(`"${verdict.reason}" has no trailing period`, !verdict.reason.endsWith("."), verdict.reason);
  check(`"${verdict.reason}" does not shout`, !verdict.reason.includes("!"), verdict.reason);
  check(
    `"${verdict.reason}" uses a typographic apostrophe if any`,
    !verdict.reason.includes("'"),
    verdict.reason
  );
}

if (failures > 0) {
  console.error(`\nsmoke-sign-in-methods: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-sign-in-methods: all ok");
process.exit(0);
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npm ci
npx tsx scripts/smoke-sign-in-methods.ts
```

Expected: FAIL — cannot find module `../src/lib/sign-in-methods`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/sign-in-methods.ts`:

```ts
/**
 * Whether a sign-in method can be given up.
 *
 * The rule behind every branch: a person must keep at least one way back in. An unverified
 * email is not a way in, so it never counts on either side — it can always go, and it never
 * licenses removing something that does count.
 *
 * Deliberately free of React and of any Clerk import: the screens that call this cannot be
 * tested without a browser and live keys, so the rules live where a plain tsx script can
 * reach every branch. Callers map Clerk's resources onto `SignInMethods` at the call site.
 */
export type SignInMethods = {
  /** Every email on the account, with whether Clerk has verified it. */
  emails: ReadonlyArray<{ id: string; verified: boolean }>;
  /** Connected OAuth accounts, by their identification id. */
  externalAccountIds: ReadonlyArray<string>;
  /** Whether a password is set. */
  hasPassword: boolean;
  /** The primary email's id, or null. */
  primaryEmailId: string | null;
};

export type RemovalVerdict = { allowed: true } | { allowed: false; reason: string };

const ALLOWED: RemovalVerdict = { allowed: true };

function refuse(reason: string): RemovalVerdict {
  return { allowed: false, reason };
}

/** Can this email be removed? */
export function canRemoveEmail(methods: SignInMethods, emailId: string): RemovalVerdict {
  const email = methods.emails.find((e) => e.id === emailId);
  if (!email) return refuse("That address isn’t on your account any more");

  // An unverified address cannot be signed in with, so losing it costs nothing.
  if (!email.verified) return ALLOWED;

  if (methods.primaryEmailId === emailId) {
    return refuse("That’s your primary address — make another one primary first");
  }

  const otherVerified = methods.emails.filter((e) => e.verified && e.id !== emailId);
  if (otherVerified.length === 0) {
    return refuse("That’s your only verified address — you’d have no way to sign in");
  }

  return ALLOWED;
}

/** Can this connected account be disconnected? */
export function canDisconnectAccount(
  methods: SignInMethods,
  identificationId: string
): RemovalVerdict {
  if (!methods.externalAccountIds.includes(identificationId)) {
    return refuse("That account isn’t connected any more");
  }

  if (methods.hasPassword) return ALLOWED;
  if (methods.externalAccountIds.length > 1) return ALLOWED;

  return refuse("That’s your only way to sign in — set a password first");
}
```

- [ ] **Step 4: Run it to make sure it passes**

```bash
npx tsx scripts/smoke-sign-in-methods.ts
```

Expected: PASS — "smoke-sign-in-methods: all ok".

- [ ] **Step 5: Register the smoke**

In `scripts/run-smoke.ts`, in the map of smoke names to kinds (the one holding `"smoke-account-routes": "pure",`), add:

```ts
  "smoke-sign-in-methods": "pure",
```

- [ ] **Step 6: Confirm the harness sees it**

```bash
npx tsx scripts/run-smoke.ts smoke-sign-in-methods
```

Expected: it runs and reports ok. If it reports an unregistered smoke, Step 5 landed in the wrong map.

- [ ] **Step 7: Commit**

```bash
git add src/lib/sign-in-methods.ts scripts/smoke-sign-in-methods.ts scripts/run-smoke.ts
git commit -m "Say when a sign-in method can be given up"
```

---

### Task 2: The Sign-in route, its tab, and the analytics entries

**Files:**
- Create: `src/app/(clerk)/(app)/settings/account/sign-in/page.tsx`
- Modify: `src/components/account/account-nav.tsx`, `scripts/smoke-account-routes.ts`, `src/lib/analytics-routes.ts`
- Test: `scripts/smoke-account-routes.ts`

**Interfaces:**
- Consumes: `AccountDemoPanel({ what })` from `@/components/account/account-demo-panel`; `isClerkConfigured()` from `@/lib/auth`; `SettingsSection` from `@/components/settings/settings-section` (props: `{ title, description?, action?, className?, children? }` — no `id`).
- Produces: the route `/settings/account/sign-in`, and a third `ACCOUNT_TABS` entry `{ href: "/settings/account/sign-in", label: "Sign-in" }`. Tasks 3–5 fill the page in.

- [ ] **Step 1: Extend the route smoke first**

In `scripts/smoke-account-routes.ts`, add to `FILE_FOR_HREF`:

```ts
  "/settings/account/sign-in": "src/app/(clerk)/(app)/settings/account/sign-in/page.tsx",
```

The existing loop over `ACCOUNT_TABS` and the existing Clerk-gate loop over `Object.values(FILE_FOR_HREF)` then cover the new route with no other edit.

- [ ] **Step 2: Add the tab**

In `src/components/account/account-nav.tsx`:

```ts
export const ACCOUNT_TABS = [
  { href: "/settings/account", label: "Profile" },
  { href: "/settings/account/sign-in", label: "Sign-in" },
  { href: "/settings/account/devices", label: "Devices" },
] as const satisfies ReadonlyArray<{ href: string; label: string }>;
```

Sign-in sits between Profile and Devices: it is the middle of the story, from who you are to how you get in to where you are.

- [ ] **Step 3: Run the smoke and watch it fail**

```bash
npx tsx scripts/smoke-account-routes.ts
```

Expected: FAIL on `/settings/account/sign-in has a page` — the tab and the map now expect a file that does not exist.

- [ ] **Step 4: Write the page**

Create `src/app/(clerk)/(app)/settings/account/sign-in/page.tsx`:

```tsx
import { isClerkConfigured } from "@/lib/auth";
import { AccountDemoPanel } from "@/components/account/account-demo-panel";
import { SettingsSection } from "@/components/settings/settings-section";

/**
 * How this account gets in: the addresses it can be reached at, and the providers it can
 * arrive through. The screens themselves are client components on Clerk's user resource —
 * this page is only the gate and the frame.
 */
export default async function AccountSignInPage() {
  const clerkOn = isClerkConfigured();

  if (!clerkOn) {
    return (
      <SettingsSection title="Sign-in" description="The addresses and accounts you sign in with.">
        <AccountDemoPanel what="Your sign-in methods" />
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection
        title="Email addresses"
        description="Where Orbit reaches you, and what you can sign in with."
      >
        <p className="text-sm text-muted-foreground">Email management arrives in the next step</p>
      </SettingsSection>
      <SettingsSection
        title="Connected accounts"
        description="Providers you can sign in through."
      >
        <p className="text-sm text-muted-foreground">Connected accounts arrive in the next step</p>
      </SettingsSection>
    </>
  );
}
```

Those two placeholder lines are replaced in Tasks 3 and 5. They exist so this task ends on a route that renders and a green smoke, rather than on a half-built screen.

- [ ] **Step 5: Register both analytics routes**

In `src/lib/analytics-routes.ts`, add entries for the new route to `ROUTE_PATTERNS`, matching the shape of the `/settings/account` and `/settings/account/devices` entries already there (phase 1 added those):

```ts
  "/settings/account/sign-in",
```

Read the surrounding code first — `normalizeRoute` scores candidates on exact segment count, so the entry must be a sibling of the existing account routes, in whatever form that file uses. Add the callback route from Task 5 when that task lands, not now.

- [ ] **Step 6: Run the smokes and typecheck**

```bash
npx tsx scripts/smoke-account-routes.ts
npx tsx scripts/smoke-admin-analytics.ts
npx tsc --noEmit
```

Expected: all green. `smoke-admin-analytics` is the one that catches a missing `ROUTE_PATTERNS` entry.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(clerk)/(app)/settings/account/sign-in/page.tsx" src/components/account/account-nav.tsx scripts/smoke-account-routes.ts src/lib/analytics-routes.ts
git commit -m "Open the Sign-in screen"
```

---

### Task 3: Email addresses — list, set primary, remove

**Files:**
- Create: `src/components/account/email-list.tsx`
- Modify: `src/app/(clerk)/(app)/settings/account/sign-in/page.tsx`
- Test: manual (needs Clerk keys), plus `tsc`/eslint and the existing smokes

**Interfaces:**
- Consumes: `canRemoveEmail`, `type SignInMethods` from `@/lib/sign-in-methods`; `clerkErrorMessage` from `@/lib/clerk-errors`; `friendlyError` from `@/lib/errors`; `toast` from `@/lib/toast`; `TOAST_COPY` from `@/lib/toast-copy`; Clerk's `useUser`, `useReverification`; `isReverificationCancelledError` from `@clerk/nextjs/errors`.
- Produces: `EmailList()` — no props; it reads the user itself. Task 4 renders `AddEmailDialog` beside it.

- [ ] **Step 1: Read the pattern you are copying**

```bash
sed -n '1,120p' src/components/account/devices-list.tsx
```

Phase 1 settled the shape of a Clerk-backed list here, and this file should look like its sibling: effects keyed on **ids** not on Clerk resource objects (`useUser()`'s value changes identity on every Clerk emission, so an object dependency causes refetch churn), a reverification-wrapped mutation, a cancelled prompt that shows nothing, and truthful copy for every state. Follow it.

- [ ] **Step 2: Write the component**

Create `src/components/account/email-list.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useUser, useReverification } from "@clerk/nextjs";
import { isReverificationCancelledError } from "@clerk/nextjs/errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { canRemoveEmail, type SignInMethods } from "@/lib/sign-in-methods";
import { clerkErrorMessage } from "@/lib/clerk-errors";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

/**
 * The addresses on the account.
 *
 * Reads Clerk's user resource directly — no local copy of the list, so `user.reload()` after
 * a mutation is the whole refresh story. The lockout rules live in `@/lib/sign-in-methods`
 * so they can be tested without a browser; this file only renders their verdicts.
 */
export function EmailList() {
  const { isLoaded, user } = useUser();
  const [busy, setBusy] = useState<string | null>(null);

  const setPrimary = useReverification((emailId: string) =>
    user ? user.update({ primaryEmailAddressId: emailId }) : Promise.resolve(null)
  );
  const removeEmail = useReverification(async (emailId: string) => {
    const email = user?.emailAddresses.find((e) => e.id === emailId);
    if (!email) return false;
    await email.destroy();
    return true;
  });

  if (!isLoaded) {
    return <div className="h-20 animate-pulse rounded-lg bg-muted/40" aria-hidden />;
  }
  if (!user) return null;

  const methods: SignInMethods = {
    emails: user.emailAddresses.map((e) => ({
      id: e.id,
      verified: e.verification?.status === "verified",
    })),
    externalAccountIds: user.externalAccounts.map((a) => a.identificationId),
    hasPassword: user.passwordEnabled,
    primaryEmailId: user.primaryEmailAddressId,
  };

  const act = async (emailId: string, run: () => Promise<unknown>, done: string) => {
    setBusy(emailId);
    try {
      await run();
      await user.reload();
      toast.success(done);
    } catch (err) {
      // A person who backs out of Clerk's "confirm it's you" prompt chose to stop; that is
      // not a failure and gets no toast.
      if (isReverificationCancelledError(err)) return;
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ul className="divide-y divide-border/60">
      {user.emailAddresses.map((email) => {
        const verified = email.verification?.status === "verified";
        const isPrimary = user.primaryEmailAddressId === email.id;
        const removal = canRemoveEmail(methods, email.id);
        const working = busy === email.id;

        return (
          <li key={email.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <span className="truncate font-medium">{email.emailAddress}</span>
                {isPrimary && <Badge variant="secondary">Primary</Badge>}
                {!verified && <Badge variant="outline">Unverified</Badge>}
              </p>
            </div>
            {verified && !isPrimary && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={working}
                onClick={() =>
                  void act(email.id, () => setPrimary(email.id), "Primary address changed")
                }
              >
                {working ? "Working…" : "Make primary"}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={working || !removal.allowed}
              title={removal.allowed ? undefined : removal.reason}
              aria-label={`Remove ${email.emailAddress}`}
              onClick={() =>
                void act(email.id, () => removeEmail(email.id), "Address removed")
              }
            >
              {working ? "Working…" : "Remove"}
            </Button>
            {!removal.allowed && (
              <p className="w-full text-xs text-muted-foreground">{removal.reason}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 3: Check the two primitives and the verification field**

```bash
grep -n "variant" src/components/ui/badge.tsx | head -8
grep -rn "verification?.status\|status === \"verified\"" src --include=*.tsx | head -5
grep -n "status" /Users/jasonpereira/Projects/orbit/node_modules/@clerk/shared/dist/types/verification.d.mts | head -8
```

`Badge` must have `secondary` and `outline`; if it does not, use what it has. Confirm the verified check against the installed `VerificationResource` — if `status` is spelled differently, use what the types declare and say so in your report. **Do not guess this one**: phase 1 found that a field I asserted (`user.lastActiveSessionId`) did not exist at all.

- [ ] **Step 4: Render it on the page**

In `src/app/(clerk)/(app)/settings/account/sign-in/page.tsx`, replace the Email addresses placeholder line with `<EmailList />` and add the import:

```tsx
import { EmailList } from "@/components/account/email-list";
```

- [ ] **Step 5: Typecheck, lint, and run the smokes**

```bash
npx tsc --noEmit
npx eslint src/components/account/email-list.tsx "src/app/(clerk)/(app)/settings/account/sign-in/page.tsx"
npx tsx scripts/smoke-account-routes.ts
npx tsx scripts/smoke-sign-in-methods.ts
npx tsx scripts/smoke-toast-copy.ts
```

Expected: `tsc` clean, eslint no errors, all three smokes green.

- [ ] **Step 6: Say plainly what you could not test**

Without Clerk keys this renders the demo panel, so the list, set-primary and remove are unexercised. Do not imply otherwise in your report. If the worktree does have keys, exercise: a second address made primary, a removal blocked with its reason visible, and a removal that succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/components/account/email-list.tsx "src/app/(clerk)/(app)/settings/account/sign-in/page.tsx"
git commit -m "Show the addresses on the account, and let the spare ones go"
```

---

### Task 4: Adding an email, with its verification code

**Files:**
- Create: `src/components/account/add-email-dialog.tsx`
- Modify: `src/app/(clerk)/(app)/settings/account/sign-in/page.tsx`
- Test: manual (needs Clerk keys), plus `tsc`/eslint and the smokes

**Interfaces:**
- Consumes: the same error/toast helpers as Task 3; Clerk's `useUser`; `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle` from `@/components/ui/dialog`; `Input`, `Label`.
- Produces: `AddEmailDialog({ trigger }: { trigger: React.ReactNode })`.

- [ ] **Step 1: Read how this repo builds a two-step dialog**

```bash
sed -n '1,80p' src/components/settings/delete-account-dialog.tsx
grep -n "DialogClose\|onOpenChange" src/components/ui/dialog.tsx | head -8
```

Match its shape: controlled `open`, reset on close, and a disabled primary action until the input is usable. Note Base UI unmounts after the exit animation, so reset state on the `onOpenChange(false)` transition rather than relying on unmount.

- [ ] **Step 2: Write the dialog**

Create `src/components/account/add-email-dialog.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clerkErrorMessage } from "@/lib/clerk-errors";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

/**
 * Two steps, because Clerk's flow has two: create the address, then prove it with the code
 * Clerk mails. The created-but-unverified address is real and already on the account, so
 * abandoning step two leaves it listed as Unverified rather than losing it — which is why
 * `EmailList` renders that badge and lets an unverified address be removed freely.
 */
export function AddEmailDialog({ trigger }: { trigger: React.ReactNode }) {
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const reset = () => {
    setAddress("");
    setCode("");
    setPendingId(null);
    setWorking(false);
  };

  const sendCode = async () => {
    if (!user || !address.trim()) return;
    setWorking(true);
    try {
      const created = await user.createEmailAddress({ email: address.trim() });
      await created.prepareVerification({ strategy: "email_code" });
      setPendingId(created.id);
      toast.success("Code sent — check that inbox");
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setWorking(false);
    }
  };

  const confirm = async () => {
    if (!user || !pendingId || code.trim().length === 0) return;
    setWorking(true);
    try {
      const email = user.emailAddresses.find((e) => e.id === pendingId);
      if (!email) throw new Error("missing");
      await email.attemptVerification({ code: code.trim() });
      await user.reload();
      toast.success("Address added");
      setOpen(false);
      reset();
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      {trigger}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an email address</DialogTitle>
          <DialogDescription>
            {pendingId
              ? "Enter the six-digit code we sent, and the address is yours"
              : "We’ll send a code to make sure it’s really yours"}
          </DialogDescription>
        </DialogHeader>

        {pendingId ? (
          <div className="space-y-1.5">
            <Label htmlFor="add-email-code">Verification code</Label>
            <Input
              id="add-email-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="add-email-address">Email address</Label>
            <Input
              id="add-email-address"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {pendingId ? (
            <Button
              type="button"
              size="sm"
              disabled={working || code.trim().length === 0}
              onClick={() => void confirm()}
            >
              {working ? "Checking…" : "Confirm"}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={working || address.trim().length === 0}
              onClick={() => void sendCode()}
            >
              {working ? "Sending…" : "Send code"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Check how `trigger` is wired in this repo's dialogs**

```bash
grep -n "trigger" src/components/settings/delete-account-dialog.tsx | head -8
```

`DeleteAccountDialog` takes a `trigger` node — match however it renders that (a `DialogTrigger` wrapper, or the node placed directly). Use the same approach so both dialogs behave identically.

- [ ] **Step 4: Put it on the page**

In the Email addresses section, pass the dialog as the section's `action` so it sits beside the heading:

```tsx
      <SettingsSection
        title="Email addresses"
        description="Where Orbit reaches you, and what you can sign in with."
        action={
          <AddEmailDialog
            trigger={
              <Button type="button" size="sm" variant="outline">
                Add address
              </Button>
            }
          />
        }
      >
        <EmailList />
      </SettingsSection>
```

- [ ] **Step 5: Typecheck, lint, smokes**

```bash
npx tsc --noEmit
npx eslint src/components/account/add-email-dialog.tsx "src/app/(clerk)/(app)/settings/account/sign-in/page.tsx"
npx tsx scripts/smoke-toast-copy.ts
npx tsx scripts/smoke-account-routes.ts
```

Expected: clean, no errors, both smokes green.

- [ ] **Step 6: Commit**

```bash
git add src/components/account/add-email-dialog.tsx "src/app/(clerk)/(app)/settings/account/sign-in/page.tsx"
git commit -m "Add an address, and prove it with the code"
```

---

### Task 5: Connected accounts, and the SSO return leg

This task has the phase's one genuine unknown. Resolve it by reading the installed package, not by guessing.

**Files:**
- Create: `src/components/account/connected-accounts.tsx`, `src/app/(clerk)/(app)/settings/account/sign-in/callback/page.tsx`
- Modify: `src/app/(clerk)/(app)/settings/account/sign-in/page.tsx`, `scripts/smoke-account-routes.ts`, `src/lib/analytics-routes.ts`
- Test: manual (needs Clerk keys), plus `tsc`/eslint and the smokes

**Interfaces:**
- Consumes: `canDisconnectAccount`, `type SignInMethods` from `@/lib/sign-in-methods`; the same error/toast helpers; Clerk's `useUser`, `useReverification`, `AuthenticateWithRedirectCallback`; `isReverificationCancelledError`.
- Produces: `ConnectedAccounts()` — no props; and the route `/settings/account/sign-in/callback`.

- [ ] **Step 1: Find out which providers are connectable, and how the return leg works**

Two things this plan does **not** know. Read the installed package and decide:

```bash
grep -rn "socialProviderStrategies\|authenticatableSocialStrategies" /Users/jasonpereira/Projects/orbit/node_modules/@clerk/shared/dist/types/userSettings.d.mts
grep -rn "AuthenticateWithRedirectCallback" /Users/jasonpereira/Projects/orbit/node_modules/@clerk/nextjs/dist/types/index.d.ts | head -3
grep -rn "__internal_environment\|__unstable__environment" /Users/jasonpereira/Projects/orbit/node_modules/@clerk/shared/dist/types/clerk.d.mts | head -5
```

What is known: `socialProviderStrategies: OAuthStrategy[]` exists on `userSettings`, which is part of Clerk's environment resource — but reaching the environment from a client component may only be possible through an `__internal_`/`__unstable__` field, and this repo should not depend on one of those.

**The fallback, if no stable API exists:** render the *connected* list from `user.externalAccounts` (always correct, no discovery needed) and drive the *connect* buttons from a small constant in this file:

```ts
/**
 * The providers Orbit offers to connect. Must match what is enabled in the Clerk dashboard:
 * email, Google and LinkedIn are the three sign-in methods this instance has.
 *
 * LinkedIn is the trap. This Clerk version carries BOTH `oauth_linkedin` (legacy, deprecated)
 * and `oauth_linkedin_oidc`, and only the one actually enabled in the dashboard works — the
 * other fails at connect time. Confirm which before shipping, and keep only that entry.
 */
const CONNECTABLE = [
  { strategy: "oauth_google", label: "Google" },
  { strategy: "oauth_linkedin_oidc", label: "LinkedIn" },
] as const;
```

Do **not** annotate this with `OAuthStrategy`: there is no `@clerk/types` package installed in this repo (only `@clerk/backend`, `localizations`, `nextjs`, `react`, `shared`, `ui`), and `@clerk/nextjs` does not re-export that type. `as const` plus the `ConnectStrategy` alias below keeps it type-safe without an import that does not exist:

```ts
type ConnectStrategy = NonNullable<
  Parameters<NonNullable<ReturnType<typeof useUser>["user"]>["createExternalAccount"]>[0]["strategy"]
>;
```

If `tsc` rejects a strategy string, that is the type telling you the provider name is wrong — read `node_modules/@clerk/shared/dist/types/strategies.d.mts` for the accepted set rather than casting past it.

Email is not in this list — it is a sign-in method, but it is managed by Tasks 3 and 4, not by connecting a provider.

**If the discovery in Step 1 works, prefer it and delete the constant**: it resolves the LinkedIn spelling automatically and cannot drift from the dashboard. If you fall back to the constant, say so in your report and name which LinkedIn strategy you used and why.

Also note there is **no `/sso-callback` route in this app** — `<SignIn>` handles its own internally. That is why Step 3 creates one.

Report what you found with file:line evidence, and which approach you took.

- [ ] **Step 2: Write the component**

Create `src/components/account/connected-accounts.tsx`. Use the discovery result from Step 1 for the connectable list; everything else is fixed:

```tsx
"use client";

import { useState } from "react";
import { useUser, useReverification } from "@clerk/nextjs";
import { isReverificationCancelledError } from "@clerk/nextjs/errors";
import { Button } from "@/components/ui/button";
import { canDisconnectAccount, type SignInMethods } from "@/lib/sign-in-methods";
import { clerkErrorMessage } from "@/lib/clerk-errors";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

/** Where Clerk sends the browser back after the provider is done. */
const CALLBACK = "/settings/account/sign-in/callback";

/**
 * Providers this account can arrive through.
 *
 * Connecting leaves the app: Clerk hands back a redirect URL, the provider asks its
 * questions, and the browser returns to CALLBACK, which finishes the handshake and comes
 * back here. Disconnecting stays put, and is refused when it would be the last way in —
 * that rule lives in `@/lib/sign-in-methods`.
 */
export function ConnectedAccounts() {
  const { isLoaded, user } = useUser();
  const [busy, setBusy] = useState<string | null>(null);

  const disconnect = useReverification(async (identificationId: string) => {
    const account = user?.externalAccounts.find((a) => a.identificationId === identificationId);
    if (!account) return false;
    await account.destroy();
    return true;
  });

  if (!isLoaded) {
    return <div className="h-16 animate-pulse rounded-lg bg-muted/40" aria-hidden />;
  }
  if (!user) return null;

  const methods: SignInMethods = {
    emails: user.emailAddresses.map((e) => ({
      id: e.id,
      verified: e.verification?.status === "verified",
    })),
    externalAccountIds: user.externalAccounts.map((a) => a.identificationId),
    hasPassword: user.passwordEnabled,
    primaryEmailId: user.primaryEmailAddressId,
  };

  const connect = async (strategy: Parameters<typeof user.createExternalAccount>[0]["strategy"]) => {
    setBusy(String(strategy));
    try {
      const account = await user.createExternalAccount({ strategy, redirectUrl: CALLBACK });
      const next = account.verification?.externalVerificationRedirectURL;
      if (!next) throw new Error("no redirect");
      window.location.href = next.toString();
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
      setBusy(null);
    }
  };

  const remove = async (identificationId: string, label: string) => {
    setBusy(identificationId);
    try {
      const gone = await disconnect(identificationId);
      await user.reload();
      if (gone) toast.success(`${label} disconnected`);
    } catch (err) {
      if (isReverificationCancelledError(err)) return;
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {user.externalAccounts.length > 0 ? (
        <ul className="divide-y divide-border/60">
          {user.externalAccounts.map((account) => {
            const label = account.providerTitle();
            const verdict = canDisconnectAccount(methods, account.identificationId);
            const working = busy === account.identificationId;
            return (
              <li key={account.identificationId} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{label}</p>
                  {account.emailAddress && (
                    <p className="truncate text-xs text-muted-foreground">{account.emailAddress}</p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={working || !verdict.allowed}
                  title={verdict.allowed ? undefined : verdict.reason}
                  aria-label={`Disconnect ${label}`}
                  onClick={() => void remove(account.identificationId, label)}
                >
                  {working ? "Working…" : "Disconnect"}
                </Button>
                {!verdict.allowed && (
                  <p className="w-full text-xs text-muted-foreground">{verdict.reason}</p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No accounts connected yet</p>
      )}
      {/* Connect buttons come from Step 1's discovery result. */}
    </div>
  );
}
```

Render one connect button per connectable provider that is not already connected, calling `connect(strategy)`.

- [ ] **Step 3: Write the callback route**

Create `src/app/(clerk)/(app)/settings/account/sign-in/callback/page.tsx`:

```tsx
import { isClerkConfigured } from "@/lib/auth";
import { redirect } from "next/navigation";
import { SsoReturn } from "@/components/account/sso-return";

/**
 * The return leg of connecting a provider.
 *
 * Clerk's OAuth handshake finishes in the browser, so this route exists only to mount the
 * component that completes it and then sends the person back to the Sign-in screen. With no
 * Clerk keys there is no handshake to finish, so it just bounces.
 */
export default async function SignInCallbackPage() {
  if (!isClerkConfigured()) redirect("/settings/account/sign-in");
  return <SsoReturn />;
}
```

and the client half, `src/components/account/sso-return.tsx`:

```tsx
"use client";

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

/** Finishes Clerk's OAuth handshake, then returns to the Sign-in screen either way. */
export function SsoReturn() {
  return (
    <div className="p-6">
      <p className="text-sm text-muted-foreground">Finishing up…</p>
      <AuthenticateWithRedirectCallback
        continueSignUpUrl="/settings/account/sign-in"
        signInFallbackRedirectUrl="/settings/account/sign-in"
        signUpFallbackRedirectUrl="/settings/account/sign-in"
      />
    </div>
  );
}
```

**Verify those prop names against the installed version before trusting them** — they have changed across Clerk majors:

```bash
grep -rn "continueSignUpUrl\|signInFallbackRedirectUrl\|AuthenticateWithRedirectCallbackProps" /Users/jasonpereira/Projects/orbit/node_modules/@clerk/shared/dist/types/clerk.d.mts | head -8
```

Use what the types declare; report any difference.

- [ ] **Step 4: Register the callback route in both places**

Add to `FILE_FOR_HREF` in `scripts/smoke-account-routes.ts`:

```ts
  "/settings/account/sign-in/callback":
    "src/app/(clerk)/(app)/settings/account/sign-in/callback/page.tsx",
```

It is not an `ACCOUNT_TABS` entry — it is a machine destination, not a place a person navigates to — so the tab loop ignores it while the Clerk-gate loop still covers it. Add the matching `ROUTE_PATTERNS` entry in `src/lib/analytics-routes.ts` as in Task 2.

- [ ] **Step 5: Render it on the page**

Replace the Connected accounts placeholder line with `<ConnectedAccounts />` and add the import.

- [ ] **Step 6: Typecheck, lint, smokes**

```bash
npx tsc --noEmit
npx eslint src/components/account "src/app/(clerk)/(app)/settings/account/sign-in"
npx tsx scripts/smoke-account-routes.ts
npx tsx scripts/smoke-admin-analytics.ts
npx tsx scripts/smoke-toast-copy.ts
```

Expected: clean, no errors, all three smokes green.

- [ ] **Step 7: Commit**

```bash
git add src/components/account/connected-accounts.tsx src/components/account/sso-return.tsx "src/app/(clerk)/(app)/settings/account/sign-in" scripts/smoke-account-routes.ts src/lib/analytics-routes.ts
git commit -m "Connect and disconnect the accounts you sign in through"
```

---

### Task 6: Whole-phase verification

**Files:** none — this task runs things and reports.

- [ ] **Step 1: Typecheck and lint**

```bash
npx tsc --noEmit
npx eslint .
```

Expected: `tsc` clean; eslint 0 errors, and no new warnings beyond the accepted `react-hooks/set-state-in-effect` in `devices-list.tsx`.

- [ ] **Step 2: Full suite**

```bash
npm test
```

Do **not** pipe this through `tail` — it truncates the failure list. Expected: all green. If `smoke-admin-render` or `smoke-instrumentation` time out, re-run those two alone; they flake under machine load above ~100.

- [ ] **Step 3: Build, then clear `.next`**

```bash
npm run build
rm -rf .next
```

The `rm -rf` is mandatory before any dev server: after a production build, dev serves no `next/dynamic` chunk and the app looks wedged.

- [ ] **Step 4: Demo-mode browser pass**

Start the dev server with the preview tool from `.claude/launch.json` — never through Bash — on a free port that is not 3000. Keep the tab visible; an occluded tab never hydrates and probes pass vacuously. Confirm: the rail shows three entries, `/settings/account/sign-in` renders the demo panel, and `/settings/account/sign-in/callback` redirects to the Sign-in screen rather than erroring.

- [ ] **Step 5: Live Clerk pass — required, and not to be faked**

Needs Clerk dev keys in the worktree. Run all of it, and report each line as ran/failed:

1. Add a second email; receive the real code; enter a wrong code once (expect Orbit copy, not a Clerk string); then the right one.
2. Abandon the dialog after step one and confirm the address is listed as Unverified and can be removed.
3. Make the second address primary, then confirm the first can now be removed and the new primary cannot.
4. With a single address, confirm Remove is disabled and states the reason.
5. Connect a provider: leave the app, return through the callback, confirm the row appears.
6. Disconnect it. With no password set, confirm the only provider cannot be disconnected and the reason mentions the password.
7. Cancel Clerk's reverification prompt once during a removal — expect **no** toast at all.

**If the keys are unavailable, stop and report exactly which of steps 1-7 went unrun.** Types and smokes do not exercise any of it.

- [ ] **Step 6: Re-check `main`, then hand back**

```bash
git fetch origin
git log --oneline -3 origin/main
git log --oneline origin/main..HEAD
```

`main` moves several times a day, and other branches touch `sections.ts` and `settings/page.tsx`. If it has moved, merge and re-run Steps 1-3. Then report; the human decides whether to open the PR.

---

## What this instance has

**Sign-in methods: email, Google, LinkedIn** (confirmed by Jason, 2026-09-23).

That settles the shape of the screen: emails are managed by Tasks 3 and 4, and Connected accounts offers exactly two providers. It leaves one detail for Task 5 to pin down — **which LinkedIn Clerk is configured with**, since this version carries both `oauth_linkedin` (legacy, deprecated) and `oauth_linkedin_oidc`, and the wrong one fails at connect time.

## Open question for Jason

**Is a password set on your own account?** It decides which lockout branches the live pass can reach. With Google or LinkedIn connected and no password, disconnecting the last provider must be refused (Task 6, step 6) — and if you have no password, that is the branch you will actually see. With a password set, you will need a second account or a throwaway to exercise it at all.
