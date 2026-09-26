# Account page, phase 1: shell, menu, Profile, Devices — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Clerk's `UserButton` popover with an Orbit avatar menu, and stand up `/settings/account` with a working Profile screen, Devices screen, and danger zone.

**Architecture:** Four nested routes under `src/app/(clerk)/(app)/settings/account/`, each a server component that gates on `clerkOn` and surface visibility, then renders a client component holding Clerk hooks. A new `AccountMenu` client component replaces `UserButton` in the sidebar, the mobile nav, and the Settings profile card; the viewer's name, email and image are threaded from `(app)/layout.tsx` through `AppShell` so the avatar paints without waiting on Clerk JS.

**Tech Stack:** Next.js App Router, React 19, `@clerk/nextjs` 7.5.20 (`useUser`, `useClerk`, `useReverification`, `SignOutButton`), Base UI primitives via `src/components/ui/*`, Tailwind, `tsx` smoke scripts.

**Spec:** `docs/superpowers/specs/2026-09-22-account-page-clerk-revision-design.md`

## Global Constraints

- **Branch base:** `claude/account-page-clerk-revision-32b87a`, reset onto `origin/main` at `5e892e2d`. Re-check `origin/main` before opening the PR — it moves several times a day.
- **Worktree has no `node_modules`.** Run `npm ci` in the worktree before the first `tsc`/`eslint`/`tsx` command.
- **No schema change.** Do not touch `SCHEMA_VERSION`, `src/db/schema.ts`, or any migration file. If a task seems to need one, stop and ask.
- **Read the Next.js docs in `node_modules/next/dist/docs/` before writing route files.** This repo's Next version has breaking changes from what you may remember; heed deprecation notices.
- **Surface ids are load-bearing.** Do not rename anything in `SETTINGS_SECTIONS`; `src/lib/surfaces.ts` derives stored hide-list keys from those ids. Phase 1 adds no new section id — the account routes reuse `settings-profile`.
- **Never surface a raw provider error string.** User-facing failures go through `friendlyError(err, TOAST_COPY.saveFailed)` from `@/lib/errors` and `@/lib/toast-copy`. Orbit voice: lowercase after an em dash, no exclamation marks, no "Error:" prefix. `scripts/smoke-toast-copy.ts` scans the whole repo for this.
- **Every Clerk hook must sit below a `clerkOn` gate.** Marketing pages prerender without a `ClerkProvider`; a hook above the gate breaks the build.
- **Lint baseline is 0 errors / ~44 warnings.** Any new error is yours.
- **Register every new smoke in `scripts/run-smoke.ts`.** An unregistered smoke kills the whole suite.
- **A new client component must not import `@/db`** — it fails the build with a `node:fs` chunk error.

## File Structure

**Create:**
- `src/lib/clerk-errors.ts` — Clerk error code → Orbit copy. Pure, no React, no Clerk import.
- `src/components/account/account-menu.tsx` — client. The avatar dropdown replacing `UserButton`.
- `src/components/account/account-nav.tsx` — client. The rail linking the four account routes.
- `src/components/account/profile-form.tsx` — client. Name + photo, on Clerk hooks.
- `src/components/account/devices-list.tsx` — client. Active sessions, on Clerk hooks.
- `src/components/account/account-demo-panel.tsx` — client-free. The "demo mode" panel each screen shows when `clerkOn` is false.
- `src/app/(clerk)/(app)/settings/account/layout.tsx` — shell + visibility gate.
- `src/app/(clerk)/(app)/settings/account/page.tsx` — Profile + danger zone.
- `src/app/(clerk)/(app)/settings/account/devices/page.tsx` — Devices.
- `scripts/smoke-account-routes.ts` — route/gating/error-map smoke.

**Modify:**
- `src/app/(clerk)/(app)/layout.tsx` — pass the display profile into `AppShell`.
- `src/components/layout/app-shell.tsx:47-69` (props), `:161-168` and `:264-268` (render) — thread `profile` to sidebar and mobile nav.
- `src/components/layout/app-sidebar.tsx:98-113` (props), `:234-245` (footer) — `AccountMenu` replaces `UserButton`.
- `src/components/layout/mobile-nav.tsx:38-47` (props), `:615-628` — same.
- `src/components/settings/profile-settings.tsx:1-105` — card becomes a summary linking to `/settings/account`; drop `profileAvatarAppearance`; keep the socials form untouched.
- `scripts/run-smoke.ts:176` area — register `smoke-account-routes` as `"pure"`.

Phases 2 (Sign-in) and 3 (Security) get their own plans. This plan must leave the product in a working state on its own: after it, a person can reach their account, edit their profile, manage devices, delete their account, and sign out — and no Clerk-owned account UI remains reachable except the reverification prompt.

---

### Task 1: Clerk error copy mapper

**Files:**
- Create: `src/lib/clerk-errors.ts`
- Test: `scripts/smoke-account-routes.ts` (created here, extended in Task 5)
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `clerkErrorMessage(err: unknown, fallback: string): string` and `CLERK_ERROR_COPY: Readonly<Record<string, string>>`. Every later task calls `clerkErrorMessage` in its catch blocks.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-account-routes.ts`:

```ts
/**
 * The account page's contract: the error map's codes and voice, and the fact that every
 * account route gates on Clerk and on the settings-profile surface key.
 *
 * What it guards against is a raw Clerk string reaching a toast, and a route that forgets
 * its gate — neither of which fails a type check.
 *
 * Run: npx tsx scripts/smoke-account-routes.ts
 */
import { CLERK_ERROR_COPY, clerkErrorMessage } from "../src/lib/clerk-errors";

let failures = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nerror copy");
const REQUIRED_CODES = [
  "form_password_pwned",
  "form_code_incorrect",
  "form_identifier_exists",
  "form_password_incorrect",
  "form_password_validation_failed",
];
for (const code of REQUIRED_CODES) {
  check(`${code} has copy`, Boolean(CLERK_ERROR_COPY[code]), "missing");
}
for (const [code, copy] of Object.entries(CLERK_ERROR_COPY)) {
  check(`${code} copy has no trailing period`, !copy.endsWith("."), copy);
  check(`${code} copy does not shout`, !copy.includes("!"), copy);
  check(`${code} copy is not a raw code`, !copy.includes("_"), copy);
}

console.log("\nmapping");
check(
  "a Clerk error shape maps to its copy",
  clerkErrorMessage({ errors: [{ code: "form_code_incorrect" }] }, "fallback") ===
    CLERK_ERROR_COPY.form_code_incorrect
);
check(
  "an unknown code falls back",
  clerkErrorMessage({ errors: [{ code: "something_new" }] }, "fallback") === "fallback"
);
check("a plain Error falls back", clerkErrorMessage(new Error("boom"), "fallback") === "fallback");
check("null falls back", clerkErrorMessage(null, "fallback") === "fallback");
check(
  "the first known code wins over a later unknown one",
  clerkErrorMessage(
    { errors: [{ code: "form_password_pwned" }, { code: "whatever" }] },
    "fallback"
  ) === CLERK_ERROR_COPY.form_password_pwned
);

if (failures > 0) {
  console.error(`\nsmoke-account-routes: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-account-routes: all ok");
process.exit(0);
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npm ci
npx tsx scripts/smoke-account-routes.ts
```

Expected: FAIL — cannot find module `../src/lib/clerk-errors`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/clerk-errors.ts`:

```ts
/**
 * Clerk's error codes, in Orbit's voice.
 *
 * Clerk throws `ClerkAPIResponseError`, whose `errors[]` carry a stable `code` and a
 * message written by Clerk. The messages are fine English and the wrong voice, so the
 * account screens show ours for the codes people actually hit and fall back to
 * `TOAST_COPY.saveFailed` for everything else.
 *
 * Deliberately free of any Clerk import: this is shape-matching, so it stays testable
 * from a plain tsx script with no browser and no provider.
 */
export const CLERK_ERROR_COPY: Readonly<Record<string, string>> = {
  form_password_pwned: "That password has shown up in a breach — pick another",
  form_code_incorrect: "That code didn’t match — check and try again",
  form_identifier_exists: "That email is already on your account",
  form_password_incorrect: "That password wasn’t right — try again",
  form_password_validation_failed: "That password is too weak — make it longer",
  form_param_format_invalid: "That doesn’t look like an email address",
  form_identifier_not_allowed: "That address can’t be used here",
  session_exists: "You’re already signed in on this device",
};

/** Narrow, without importing Clerk, to `{ errors: [{ code }] }`. */
function codesOf(err: unknown): string[] {
  if (!err || typeof err !== "object") return [];
  const errors = (err as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((e) => (e && typeof e === "object" ? (e as { code?: unknown }).code : null))
    .filter((c): c is string => typeof c === "string");
}

/**
 * Orbit copy for a Clerk failure, or `fallback` when the code is one we have not written
 * for. Callers pass `TOAST_COPY.saveFailed` (or a closer line) as the fallback, so no raw
 * provider text ever reaches a toast.
 */
export function clerkErrorMessage(err: unknown, fallback: string): string {
  for (const code of codesOf(err)) {
    const copy = CLERK_ERROR_COPY[code];
    if (copy) return copy;
  }
  return fallback;
}
```

- [ ] **Step 4: Run it to make sure it passes**

```bash
npx tsx scripts/smoke-account-routes.ts
```

Expected: PASS — "smoke-account-routes: all ok".

- [ ] **Step 5: Register the smoke**

In `scripts/run-smoke.ts`, in the alphabetical-ish map of smoke names to kinds (see `"smoke-settings-layout": "pure",` near line 176), add:

```ts
  "smoke-account-routes": "pure",
```

- [ ] **Step 6: Verify the suite still recognises it**

```bash
npx tsx scripts/run-smoke.ts smoke-account-routes
```

Expected: the harness runs it and reports ok. If it reports an unregistered smoke, Step 5 landed in the wrong map.

- [ ] **Step 7: Commit**

```bash
git add src/lib/clerk-errors.ts scripts/smoke-account-routes.ts scripts/run-smoke.ts
git commit -m "Say what a Clerk failure means in Orbit's voice"
```

---

### Task 2: Thread the viewer's profile to the nav

**Files:**
- Modify: `src/app/(clerk)/(app)/layout.tsx`, `src/components/layout/app-shell.tsx:47-69`, `:161-168`, `:264-268`
- Test: manual, plus `tsc`

**Interfaces:**
- Consumes: `getDisplayProfile(): Promise<UserProfile | null>` from `@/lib/auth`, where `UserProfile = { id: string; name: string; email: string; imageUrl?: string }` (`src/lib/auth.ts:116`).
- Produces: a new `profile: AccountMenuProfile | null` prop on `AppShell`, `AppSidebar` and `MobileNav`, where

```ts
export type AccountMenuProfile = { name: string; email: string; imageUrl?: string };
```

Task 3 defines that type in `account-menu.tsx` and both nav components import it.

- [ ] **Step 1: Read the layout you are changing**

```bash
sed -n '1,60p' "src/app/(clerk)/(app)/layout.tsx"
sed -n '40,75p' src/components/layout/app-shell.tsx
```

Note that the layout already computes `clerkOn`, `demoMode`, `plan` and the visibility sets, and that `AppShell` re-exposes them to `AppSidebar` and `MobileNav`. You are adding one more prop along the same path — no new data source, no client-side fetch.

- [ ] **Step 2: Add the prop to `AppShell`**

In `src/components/layout/app-shell.tsx`, add `profile` to the destructured params and to the type (keep the existing ordering and comment style):

```tsx
export function AppShell({
  children,
  clerkOn,
  demoMode,
  theme,
  plan,
  profile,
  hidden,
  hiddenForUsers,
  viewingAsUser,
  previewingUnreleased,
}: {
  children: React.ReactNode;
  clerkOn: boolean;
  demoMode: boolean;
  theme: ThemePreference | null;
  plan: Plan;
  /**
   * The viewer's own name, email and picture, resolved on the server so the sidebar paints
   * a face without waiting on Clerk JS. Null in demo mode and when nobody is signed in.
   */
  profile: AccountMenuProfile | null;
  /** Surface keys hidden from THIS viewer. Empty for an exempt operator. */
  hidden: string[];
```

and import the type at the top:

```tsx
import type { AccountMenuProfile } from "@/components/account/account-menu";
```

- [ ] **Step 3: Pass it down to both navs**

At the `AppSidebar` render site (around line 161) and the `MobileNav` one (around line 264), add `profile={profile}`:

```tsx
            <AppSidebar
              pathname={pathname}
              clerkOn={clerkOn}
              demoMode={demoMode}
              plan={plan}
              profile={profile}
              hidden={hiddenSet}
              hiddenForUsers={hiddenForUsersSet}
            />
```

```tsx
            <MobileNav
              clerkOn={clerkOn}
              demoMode={demoMode}
              profile={profile}
              hidden={hiddenSet}
            />
```

- [ ] **Step 4: Supply it from the layout**

In `src/app/(clerk)/(app)/layout.tsx`, import `getDisplayProfile` alongside the existing auth imports, resolve it next to the other server reads, and pass it to `<AppShell>`:

```tsx
  const displayProfile = await getDisplayProfile();
```

```tsx
      <AppShell
      clerkOn={clerkOn}
      demoMode={demoMode}
      plan={plan}
      profile={
        displayProfile
          ? {
              name: displayProfile.name,
              email: displayProfile.email,
              imageUrl: displayProfile.imageUrl,
            }
          : null
      }
```

Map the fields explicitly rather than spreading `displayProfile`: `UserProfile` also carries `id`, and the menu has no business with it.

- [ ] **Step 5: Let the types tell you Task 3 is missing**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: errors only about the not-yet-existing `@/components/account/account-menu`, plus `AppSidebar`/`MobileNav` not accepting `profile`. That is the correct intermediate state; Task 3 closes it. Do not commit yet — this task's commit happens at the end of Task 3, so no commit leaves `main` un-compilable.

---

### Task 3: The `AccountMenu`, replacing `UserButton`

**Files:**
- Create: `src/components/account/account-menu.tsx`
- Modify: `src/components/layout/app-sidebar.tsx:98-113`, `:234-245`; `src/components/layout/mobile-nav.tsx:38-47`, `:615-628`
- Test: manual in the browser pane, plus `tsc` and eslint

**Interfaces:**
- Consumes: `AccountMenuProfile` (defined here), the `profile` prop threaded in Task 2, `DropdownMenu*` from `@/components/ui/dropdown-menu`, `Avatar`/`AvatarImage`/`AvatarFallback` from `@/components/ui/avatar`.
- Produces: `AccountMenu({ profile }: { profile: AccountMenuProfile | null })` and the exported `AccountMenuProfile` type.

- [ ] **Step 1: Read the primitives before using them**

```bash
sed -n '1,60p' src/components/ui/dropdown-menu.tsx
sed -n '1,60p' src/components/ui/avatar.tsx
```

These wrap Base UI, not Radix. `DropdownMenuContent` takes `align`/`side`/`sideOffset` and portals itself. `Avatar` takes `size` of `"default" | "sm" | "lg"`.

- [ ] **Step 2: Write the component**

Create `src/components/account/account-menu.tsx`:

```tsx
"use client";

import Link from "next/link";
import { SignOutButton } from "@clerk/nextjs";
import { LogOut, Settings, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

/** What the menu needs about the viewer. Deliberately not `UserProfile`: no id. */
export type AccountMenuProfile = {
  name: string;
  email: string;
  imageUrl?: string;
};

/** First letter of the name, for the avatar fallback. Never empty. */
function initial(name: string) {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

/**
 * The account menu, in place of Clerk's `UserButton` popover.
 *
 * The face comes from server-resolved props, so it paints on the first frame instead of
 * after Clerk JS loads. Only `SignOutButton` needs Clerk, and every caller already renders
 * this component behind a `clerkOn` gate — so no Clerk hook runs where there is no
 * provider.
 */
export function AccountMenu({ profile }: { profile: AccountMenuProfile | null }) {
  const name = profile?.name ?? "Your account";
  const email = profile?.email ?? "";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Your account"
        className="rounded-full ring-1 ring-border/60 transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Avatar>
          {profile?.imageUrl && <AvatarImage src={profile.imageUrl} alt="" />}
          <AvatarFallback>{initial(name)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate font-medium text-ink">{name}</span>
          {email && (
            <span className="truncate text-xs font-normal text-muted-foreground">
              {email}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/settings/account" />}>
          <UserRound className="size-4" aria-hidden />
          Account
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link href="/settings" />}>
          <Settings className="size-4" aria-hidden />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <SignOutButton>
          <DropdownMenuItem>
            <LogOut className="size-4" aria-hidden />
            Sign out
          </DropdownMenuItem>
        </SignOutButton>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 3: Confirm the `render` prop is how this repo composes Base UI items**

```bash
grep -rn "DropdownMenuItem render=" src/components | head -5
```

Expected: existing call sites using `render={<Link … />}`. **If there are none**, check `src/components/ui/dropdown-menu.tsx` for how `DropdownMenuItem` forwards props and follow whatever the file's other consumers do (`grep -rn "DropdownMenuItem" src/components | head`). Do not invent an API: match the repo.

- [ ] **Step 4: Swap it into the sidebar**

In `src/components/layout/app-sidebar.tsx`: delete the `UserButton` import, add `import { AccountMenu, type AccountMenuProfile } from "@/components/account/account-menu";`, add `profile` to the props block:

```tsx
  profile,
```
```tsx
  /** The viewer's name, email and picture for the account menu. Null without a session. */
  profile: AccountMenuProfile | null;
```

and replace the footer's `clerkOn` branch (around line 234):

```tsx
        {clerkOn ? (
          <div className="flex items-center justify-center gap-3 lg:justify-start">
            <AccountMenu profile={profile} />
            <span className="hidden text-xs text-muted-foreground lg:inline">
              Account
            </span>
          </div>
        ) : demoMode ? (
```

Leave the `demoMode` and "Sign in required" branches exactly as they are. If `clerkAppearance` is now unused in this file, drop its import — eslint will tell you.

- [ ] **Step 5: Swap it into the mobile nav**

Same three edits in `src/components/layout/mobile-nav.tsx` (props around line 38, footer around line 615):

```tsx
              {clerkOn ? (
                <>
                  <AccountMenu profile={profile} />
                  <span className="text-sm text-muted-foreground">Account</span>
                </>
              ) : demoMode ? (
```

- [ ] **Step 6: Typecheck and lint**

```bash
npx tsc --noEmit
npx eslint src/components/account src/components/layout/app-shell.tsx src/components/layout/app-sidebar.tsx src/components/layout/mobile-nav.tsx "src/app/(clerk)/(app)/layout.tsx"
```

Expected: `tsc` clean (Task 2's intermediate errors are now closed), eslint with no **errors**.

- [ ] **Step 7: See it in the browser**

The worktree runs in demo mode with no `.env`, so `clerkOn` is false and the footer shows the demo note — the menu will not render. To exercise it you need Clerk keys (see this plan's Verification section). With keys present:

Start the dev server with the preview tool (never `npm run dev` through Bash), on a port that is not 3000 — another server may be running there. Then open the app, click the avatar in the sidebar, and confirm: the name and email are correct, "Account" goes to `/settings/account`, "Settings" goes to `/settings`, "Sign out" ends the session. Keep the browser tab visible while probing; an occluded tab never hydrates and every probe passes vacuously.

Without keys, verify only that the demo footer still renders and the page compiles.

- [ ] **Step 8: Commit Tasks 2 and 3 together**

```bash
git add src/components/account/account-menu.tsx src/components/layout/app-shell.tsx src/components/layout/app-sidebar.tsx src/components/layout/mobile-nav.tsx "src/app/(clerk)/(app)/layout.tsx"
git commit -m "Give the avatar menu to Orbit, and the face to the server"
```

---

### Task 4: Account shell, nav rail, and the demo panel

**Files:**
- Create: `src/app/(clerk)/(app)/settings/account/layout.tsx`, `src/components/account/account-nav.tsx`, `src/components/account/account-demo-panel.tsx`
- Test: `scripts/smoke-account-routes.ts` (extended in Task 5), manual

**Interfaces:**
- Consumes: `requireUserId()`, `isClerkConfigured()` from `@/lib/auth`; `resolveSurfaceVisibility(userId)` from `@/lib/surface-visibility`; `surfaceKeyForSettingsId` from `@/lib/surfaces`.
- Produces: `ACCOUNT_TABS: ReadonlyArray<{ href: string; label: string }>` exported from `account-nav.tsx`, `AccountNav({ pathname })`, and `AccountDemoPanel({ what }: { what: string })`. Tasks 5 and 6 render `AccountDemoPanel`; Task 5's smoke reads `ACCOUNT_TABS`.

- [ ] **Step 1: Read the Next.js routing docs for this version**

```bash
ls node_modules/next/dist/docs/
```

Read the App Router routing and layout pages before creating route files. This Next differs from what you remember; if a doc contradicts this plan's code, follow the doc and say so in your report.

- [ ] **Step 2: Write the nav rail**

Create `src/components/account/account-nav.tsx`:

```tsx
"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The four account routes, in order. One list so the rail and
 * `scripts/smoke-account-routes.ts` cannot drift: the smoke asserts a page file exists for
 * every entry here.
 *
 * `/settings/account/sign-in` and `/settings/account/security` arrive in phases 2 and 3;
 * their entries are added with their pages, not before, so the rail never offers a 404.
 */
export const ACCOUNT_TABS = [
  { href: "/settings/account", label: "Profile" },
  { href: "/settings/account/devices", label: "Devices" },
] as const satisfies ReadonlyArray<{ href: string; label: string }>;

export function AccountNav({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Account sections" className="flex gap-1 overflow-x-auto sm:flex-col sm:gap-0.5">
      {ACCOUNT_TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-muted font-medium text-ink"
                : "text-muted-foreground hover:bg-muted/60 hover:text-ink"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 3: Write the demo panel**

Create `src/components/account/account-demo-panel.tsx`:

```tsx
/**
 * What an account screen shows with no Clerk keys configured — which is every local
 * `next dev`. A server component on purpose: it must be renderable above the `clerkOn`
 * gate, where no Clerk hook may run.
 */
export function AccountDemoPanel({ what }: { what: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-6">
      <p className="text-sm text-muted-foreground">
        {what} lives in Clerk, and this is a local demo account with no Clerk keys — so
        there’s nothing here to change. Add Clerk keys to your environment to manage it.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Write the shell with its gate**

Create `src/app/(clerk)/(app)/settings/account/layout.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requireUserId } from "@/lib/auth";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { surfaceKeyForSettingsId } from "@/lib/surfaces";
import { AccountNav } from "@/components/account/account-nav";

/**
 * Shell for the account screens, and the one place their visibility is decided.
 *
 * These routes are the Profile section's own page, so they ride its surface key rather than
 * introducing one: an operator who has hidden `settings.profile` has hidden this too. A
 * hidden viewer goes back to /settings, which still exists, instead of getting a dead end.
 *
 * The nav rail needs the pathname, and a layout is not re-rendered on navigation between
 * its children, so the rail reads it on the client via `usePathname()` inside `AccountNav`.
 */
export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const userId = await requireUserId();
  const { hidden } = await resolveSurfaceVisibility(userId);
  if (hidden.has(surfaceKeyForSettingsId("settings-profile"))) {
    redirect("/settings");
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="font-[family-name:var(--font-display)] text-2xl text-primary">
          Your account
        </h1>
        <p className="text-sm text-muted-foreground">
          Your identity and how you sign in to Orbit.
        </p>
      </header>
      <div className="grid gap-6 sm:grid-cols-[10rem_1fr]">
        <AccountNavSlot />
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </div>
  );
}
```

`AccountNavSlot` is a one-line client wrapper so the layout itself stays a server component. Add it to `account-nav.tsx`:

```tsx
"use client";
// …existing imports plus:
import { usePathname } from "next/navigation";

/** Reads the pathname on the client, so the shell can stay a server component. */
export function AccountNavSlot() {
  return <AccountNav pathname={usePathname()} />;
}
```

and import it in the layout:

```tsx
import { AccountNav, AccountNavSlot } from "@/components/account/account-nav";
```

Then drop the now-unused `AccountNav` import from the layout if eslint flags it — the layout renders only `AccountNavSlot`.

- [ ] **Step 5: Check the heading and layout conventions you just used**

```bash
grep -rn "font-\[family-name:var(--font-display)\]" src/app --include=*.tsx | head -5
grep -rn "data-fill-route" src/app --include=*.tsx | head -5
```

Match whichever page-shell convention `/settings` itself uses (`sed -n '1,40p' "src/app/(clerk)/(app)/settings/page.tsx"` for the wrapper). If `/settings` opts into `data-fill-route`, do the same here; a template div otherwise breaks the flex chain.

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean. There is no page under the new layout yet, so nothing renders — that is Task 5.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(clerk)/(app)/settings/account/layout.tsx" src/components/account/account-nav.tsx src/components/account/account-demo-panel.tsx
git commit -m "Open a place for the account screens to live"
```

---

### Task 5: Profile screen and danger zone

**Files:**
- Create: `src/app/(clerk)/(app)/settings/account/page.tsx`, `src/components/account/profile-form.tsx`
- Modify: `scripts/smoke-account-routes.ts`
- Test: `scripts/smoke-account-routes.ts`, manual with Clerk keys

**Interfaces:**
- Consumes: `AccountDemoPanel`, `ACCOUNT_TABS`, `clerkErrorMessage`, `TOAST_COPY`, `friendlyError`, `toast` from `@/lib/toast`, `DeleteAccountDialog` from `@/components/settings/delete-account-dialog`, Clerk's `useUser`.
- Produces: the route `/settings/account`. Nothing later depends on its internals.

- [ ] **Step 1: Extend the smoke with the route contract**

In `scripts/smoke-account-routes.ts`, add before the exit block:

```ts
import { existsSync, readFileSync } from "node:fs";
import { ACCOUNT_TABS } from "../src/components/account/account-nav";

console.log("\nroutes");
const FILE_FOR_HREF: Readonly<Record<string, string>> = {
  "/settings/account": "src/app/(clerk)/(app)/settings/account/page.tsx",
  "/settings/account/devices": "src/app/(clerk)/(app)/settings/account/devices/page.tsx",
};
for (const tab of ACCOUNT_TABS) {
  const file = FILE_FOR_HREF[tab.href];
  check(`${tab.href} is mapped to a file`, Boolean(file), "add it to FILE_FOR_HREF");
  if (file) check(`${tab.href} has a page`, existsSync(file), file);
}

console.log("\ngating");
const layout = readFileSync("src/app/(clerk)/(app)/settings/account/layout.tsx", "utf8");
check("the shell requires a user", layout.includes("requireUserId"));
check("the shell resolves surface visibility", layout.includes("resolveSurfaceVisibility"));
check(
  "the shell rides the settings-profile key",
  layout.includes('surfaceKeyForSettingsId("settings-profile")')
);
for (const file of Object.values(FILE_FOR_HREF)) {
  if (!existsSync(file)) continue;
  const src = readFileSync(file, "utf8");
  check(`${file} gates on Clerk being configured`, src.includes("isClerkConfigured"));
}
```

Move the two `node:fs` imports up with the other imports rather than leaving them mid-file.

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx tsx scripts/smoke-account-routes.ts
```

Expected: FAIL — `/settings/account has a page` (and the devices one), since neither file exists yet.

- [ ] **Step 3: Write the profile form**

Create `src/components/account/profile-form.tsx`:

```tsx
"use client";

import { useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { clerkErrorMessage } from "@/lib/clerk-errors";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

/**
 * Name and picture, straight onto the Clerk user.
 *
 * Mounted only where `clerkOn` is true, so `useUser()` always has a provider above it.
 * Neither change needs reverification — Clerk asks for that on credentials, not on a
 * display name.
 */
export function ProfileForm() {
  const { isLoaded, user } = useUser();
  const fileInput = useRef<HTMLInputElement>(null);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Seed once, after Clerk loads. Re-seeding on every render would fight the typist.
  if (isLoaded && user && !seeded) {
    setFirst(user.firstName ?? "");
    setLast(user.lastName ?? "");
    setSeeded(true);
  }

  if (!isLoaded) {
    return <div className="h-32 animate-pulse rounded-lg bg-muted/40" aria-hidden />;
  }
  if (!user) return null;

  const dirty = first !== (user.firstName ?? "") || last !== (user.lastName ?? "");
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "You";

  const save = async () => {
    setSaving(true);
    try {
      await user.update({ firstName: first.trim(), lastName: last.trim() });
      toast.success("Name saved");
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setSaving(false);
    }
  };

  const changePhoto = async (file: File | null) => {
    setUploading(true);
    try {
      await user.setProfileImage({ file });
      toast.success(file ? "Photo updated" : "Photo removed");
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar size="lg">
          {user.imageUrl && <AvatarImage src={user.imageUrl} alt="" />}
          <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void changePhoto(file);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            {uploading ? "Working…" : "Change photo"}
          </Button>
          {user.hasImage && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={uploading}
              onClick={() => void changePhoto(null)}
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="account-first">First name</Label>
          <Input
            id="account-first"
            value={first}
            onChange={(e) => setFirst(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="account-last">Last name</Label>
          <Input id="account-last" value={last} onChange={(e) => setLast(e.target.value)} />
        </div>
      </div>

      <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save name"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Confirm `Button` has the variants used**

```bash
grep -n "variant\|size" src/components/ui/button.tsx | head -12
```

`outline` and `ghost`, and size `sm`, must exist. If a name differs, use the repo's.

- [ ] **Step 5: Write the page**

Create `src/app/(clerk)/(app)/settings/account/page.tsx`:

```tsx
import { isClerkConfigured } from "@/lib/auth";
import { AccountDemoPanel } from "@/components/account/account-demo-panel";
import { ProfileForm } from "@/components/account/profile-form";
import { DeleteAccountDialog } from "@/components/settings/delete-account-dialog";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/settings-section";

/**
 * Profile, and the account's end.
 *
 * Deleting stays on Orbit's own path (`deleteMyAccount` → `account-deletion.ts`), which
 * clears Orbit's data before the Clerk user. Clerk's own delete is switched off in the
 * dashboard precisely so this is the only way out.
 */
export default async function AccountProfilePage() {
  const clerkOn = isClerkConfigured();

  return (
    <>
      <SettingsSection title="Profile" description="Your name and picture.">
        {clerkOn ? <ProfileForm /> : <AccountDemoPanel what="Your profile" />}
      </SettingsSection>

      <SettingsSection
        title="Delete account"
        description="Your data and your sign-in, erased. There is no undo."
      >
        <DeleteAccountDialog
          trigger={
            <Button type="button" variant="destructive" size="sm">
              Delete account
            </Button>
          }
        />
      </SettingsSection>
    </>
  );
}
```

- [ ] **Step 6: Check `SettingsSection`'s props and the destructive variant**

```bash
sed -n '1,60p' src/components/settings/settings-section.tsx
grep -n "destructive" src/components/ui/button.tsx | head -3
```

Use the real prop names. If `SettingsSection` requires an `id`, pass one; if the heading level matters, note that `CardTitle`'s `as` defaults to `div`, and headings must stay in the outline.

- [ ] **Step 7: Run the smoke and the typecheck**

```bash
npx tsx scripts/smoke-account-routes.ts
npx tsc --noEmit
```

Expected: the smoke's `/settings/account has a page` and gating checks pass; the devices checks still fail until Task 6. `tsc` clean.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(clerk)/(app)/settings/account/page.tsx" src/components/account/profile-form.tsx scripts/smoke-account-routes.ts
git commit -m "Let people change their own name and face, and end the account"
```

---

### Task 6: Devices screen

**Files:**
- Create: `src/app/(clerk)/(app)/settings/account/devices/page.tsx`, `src/components/account/devices-list.tsx`
- Modify: `src/components/account/account-nav.tsx` (the Devices entry is already there from Task 4 — verify, don't duplicate)
- Test: `scripts/smoke-account-routes.ts`, manual with Clerk keys

**Interfaces:**
- Consumes: Clerk's `useUser` and `useReverification`; `SessionWithActivitiesResource` as returned by `user.getSessions()`; `clerkErrorMessage`.
- Produces: the route `/settings/account/devices`.

- [ ] **Step 1: Write the list**

Create `src/components/account/devices-list.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useUser, useReverification } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { clerkErrorMessage } from "@/lib/clerk-errors";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

type Row = {
  id: string;
  browser: string;
  os: string;
  place: string;
  lastActive: string;
  current: boolean;
};

/** "Chrome on macOS · Toronto, CA · active 2 hours ago", from whatever Clerk gives us. */
function describe(
  session: Awaited<ReturnType<NonNullable<ReturnType<typeof useUser>["user"]>["getSessions"]>>[number],
  currentSessionId: string | null
): Row {
  const a = session.latestActivity;
  const city = [a?.city, a?.country].filter(Boolean).join(", ");
  return {
    id: session.id,
    browser: a?.browserName ? `${a.browserName} ${a.browserVersion ?? ""}`.trim() : "Unknown browser",
    os: a?.deviceType ?? "Unknown device",
    place: city || "Location unknown",
    lastActive: session.lastActiveAt
      ? new Date(session.lastActiveAt).toLocaleString()
      : "Unknown",
    current: session.id === currentSessionId,
  };
}

/**
 * Every session on the account, and a way to end the ones that are not this one.
 *
 * Revoking is reverification-wrapped: Clerk decides whether to ask "confirm it's you"
 * first, shows its own prompt, and then retries the call.
 */
export function DevicesList() {
  const { isLoaded, user } = useUser();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const sessions = await user.getSessions();
      const currentId = user.lastActiveSessionId ?? null;
      setRows(sessions.map((s) => describe(s, currentId)));
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, "Couldn’t load your devices — try again?")));
      setRows([]);
    }
  }, [user]);

  useEffect(() => {
    if (isLoaded && user) void load();
  }, [isLoaded, user, load]);

  const revoke = useReverification(async (sessionId: string) => {
    if (!user) return;
    const sessions = await user.getSessions();
    const target = sessions.find((s) => s.id === sessionId);
    if (target) await target.revoke();
  });

  const signOutOne = async (sessionId: string) => {
    setBusy(sessionId);
    try {
      await revoke(sessionId);
      toast.success("Signed that device out");
      await load();
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setBusy(null);
    }
  };

  if (!isLoaded || rows === null) {
    return <div className="h-24 animate-pulse rounded-lg bg-muted/40" aria-hidden />;
  }
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No other devices are signed in.</p>;
  }

  return (
    <ul className="divide-y divide-border/60">
      {rows.map((row) => (
        <li key={row.id} className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-medium text-ink">
              <span className="truncate">
                {row.browser} on {row.os}
              </span>
              {row.current && <Badge variant="secondary">This device</Badge>}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {row.place} · active {row.lastActive}
            </p>
          </div>
          {!row.current && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy === row.id}
              onClick={() => void signOutOne(row.id)}
            >
              {busy === row.id ? "Signing out…" : "Sign out"}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Verify the Clerk session shape before trusting the `describe` types**

```bash
grep -rn "latestActivity\|lastActiveSessionId\|SessionWithActivities" /Users/jasonpereira/Projects/orbit/node_modules/@clerk/shared/dist/*.d.mts | head -10
```

The `Awaited<ReturnType<…>>` gymnastics in `describe` exist only to avoid importing a Clerk type that may be named differently across versions. **If a clean exported type exists** (e.g. `SessionWithActivitiesResource` from `@clerk/types`), import it and simplify the signature — clearer is better. If `latestActivity` fields differ (`deviceType`, `browserName`, `city`, `country`), adjust to what the installed version actually declares. Also confirm `user.lastActiveSessionId` exists; if not, compare against `useSession().session?.id` instead and note the change.

- [ ] **Step 3: Write the page**

Create `src/app/(clerk)/(app)/settings/account/devices/page.tsx`:

```tsx
import { isClerkConfigured } from "@/lib/auth";
import { AccountDemoPanel } from "@/components/account/account-demo-panel";
import { DevicesList } from "@/components/account/devices-list";
import { SettingsSection } from "@/components/settings/settings-section";

/** Where this account is signed in, and how to end any of it but here. */
export default async function AccountDevicesPage() {
  const clerkOn = isClerkConfigured();

  return (
    <SettingsSection
      title="Devices"
      description="Everywhere you’re signed in. Sign out anything you don’t recognise."
    >
      {clerkOn ? <DevicesList /> : <AccountDemoPanel what="Your signed-in devices" />}
    </SettingsSection>
  );
}
```

- [ ] **Step 4: Run the smoke and typecheck**

```bash
npx tsx scripts/smoke-account-routes.ts
npx tsc --noEmit
```

Expected: every smoke check passes, including both route files and both Clerk gates. `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(clerk)/(app)/settings/account/devices/page.tsx" src/components/account/devices-list.tsx
git commit -m "Show every device on the account, and let any of them go"
```

---

### Task 7: Shrink the Settings profile card

**Files:**
- Modify: `src/components/settings/profile-settings.tsx`
- Test: `npx tsx scripts/smoke-settings-layout.ts`, `npx tsx scripts/smoke-toast-copy.ts`, manual

**Interfaces:**
- Consumes: `AccountMenuProfile` is not needed here; the card keeps its existing `profile`, `clerkEnabled`, `initialSocialLinks` props and its `saveSocialLinks` call.
- Produces: no new exports. `ProfileSettings`'s signature is unchanged, so `settings/page.tsx` needs no edit — which is what keeps this clear of the Integrations branch.

- [ ] **Step 1: Read the file as it stands**

```bash
cat src/components/settings/profile-settings.tsx
```

Two things change: the `UserButton` (and `profileAvatarAppearance`) give way to a plain avatar plus a "Manage account" link, and the `SignOutButton` goes, since signing out now lives in the account menu. **The socials form stays exactly as it is.**

- [ ] **Step 2: Replace the identity block**

Delete the `profileAvatarAppearance` constant and the `SignOutButton`/`UserButton`/`clerkAppearance` imports. Add:

```tsx
import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
```

Replace the `profile ? (…) : (…)` identity block with:

```tsx
      {profile ? (
        <div className="flex flex-wrap items-center gap-4">
          <Avatar size="lg">
            {profile.imageUrl && <AvatarImage src={profile.imageUrl} alt="" />}
            <AvatarFallback>{profile.name.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink">{profile.name}</p>
            {profile.email && (
              <p className="text-sm text-muted-foreground">{profile.email}</p>
            )}
          </div>
          {clerkEnabled && (
            <Button type="button" variant="outline" size="sm" render={<Link href="/settings/account" />}>
              Manage account
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {clerkEnabled
              ? "Sign in to manage your profile."
              : "Running in local demo mode without Clerk."}
          </p>
        </div>
      )}
```

- [ ] **Step 3: Confirm how `Button` composes a link in this repo**

```bash
grep -rn "Button.*render={<Link" src/components | head -5
grep -n "render" src/components/ui/button.tsx | head -5
```

If `Button` does not take `render`, wrap it the way the repo already does (often `<Link className={buttonVariants(...)}>` or a `asChild`-style prop). Match existing call sites; do not invent one.

- [ ] **Step 4: Verify nothing else referenced what you deleted**

```bash
grep -rn "profileAvatarAppearance" src/ || echo "clean"
grep -rn "SignOutButton" src/ | grep -v account-menu
```

The second command should show only places that legitimately still sign out (if any). The account menu is now the product's sign-out.

- [ ] **Step 5: Run the affected smokes, typecheck and lint**

```bash
npx tsx scripts/smoke-settings-layout.ts
npx tsx scripts/smoke-toast-copy.ts
npx tsx scripts/smoke-account-routes.ts
npx tsc --noEmit
npx eslint src/components/settings/profile-settings.tsx src/components/account
```

Expected: all smokes ok, `tsc` clean, eslint with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/profile-settings.tsx
git commit -m "Point the Settings profile card at the account page"
```

---

### Task 8: Whole-phase verification

**Files:** none — this task only runs things and reports.

- [ ] **Step 1: Full typecheck and lint**

```bash
npx tsc --noEmit
npx eslint . 2>&1 | tail -5
```

Expected: `tsc` clean; eslint at 0 errors and roughly 44 warnings. Any new **error** is from this phase.

- [ ] **Step 2: Full smoke suite**

```bash
npx tsx scripts/run-smoke.ts 2>&1 | tail -30
```

Expected: all green. If `smoke-admin-render` or `smoke-instrumentation` time out, re-run those two alone — they flake under machine load above ~100.

- [ ] **Step 3: Production build**

```bash
npm run build 2>&1 | tail -20
```

Expected: success. A `node:fs` chunk error means a client component reached `@/db`. **Then delete `.next` before running a dev server** — after a build, dev serves no `next/dynamic` chunk and the app appears wedged:

```bash
rm -rf .next
```

- [ ] **Step 4: Demo-mode browser pass**

Start the dev server with the preview tool (`.claude/launch.json`), not Bash, on a port that is free — several worktrees recycle 3000-3010, and port 3000 is likely someone else's server. Confirm, with the tab visible:

- `/settings` renders, the Profile card shows name and email, and with Clerk off there is no "Manage account" button.
- `/settings/account` and `/settings/account/devices` render the shell, the rail, and the demo panel.
- The rail marks the current route with `aria-current="page"`.
- The sidebar footer shows the demo note, not a broken avatar.

This proves routing, gating and the demo path. It proves nothing about Clerk.

- [ ] **Step 5: Live Clerk pass — required before calling the phase done**

Needs Clerk dev keys in the worktree (`.env.local`). With them:

1. Sign in. The sidebar avatar shows your real picture on the first paint.
2. Open the menu: name and email correct; "Account" and "Settings" both navigate; "Sign out" ends the session.
3. `/settings/account`: change your first name, save, reload — it persisted. Upload a photo, then remove it.
4. `/settings/account/devices`: sign in from a second browser, confirm two rows appear with "This device" on the right one, sign the other out, and confirm it is gone after the list reloads.
5. Trigger reverification at least once (revoking a device on an older session) and confirm Clerk's prompt appears styled, not raw.
6. Force one failure — remove a photo with the network disabled — and confirm the toast is Orbit copy, never a Clerk string.

**If the keys are not available, stop and report exactly which of steps 1-6 went unrun.** Do not describe this phase as verified on the strength of types and smokes; say plainly what was and was not exercised.

- [ ] **Step 6: Re-check main, then open the PR**

```bash
git fetch origin
git log --oneline -3 origin/main
git log --oneline origin/main..HEAD
```

If `origin/main` has moved, merge it and re-run Steps 1-3. Then open the PR describing: the four routes, the menu swap, what phase 1 covers, what phases 2-3 will add, and — honestly — which live checks ran. End the PR body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Phases 2 and 3 (not this plan)

- **Phase 2, Sign-in:** emails with `email_code` verification, connected accounts, the lockout guard. Adds `/settings/account/sign-in` and its `ACCOUNT_TABS` entry.
- **Phase 3, Security:** password, TOTP with QR and backup codes, passkeys. Adds `/settings/account/security` and its entry.

Each gets its own plan written from the same spec, after its predecessor merges.

## Open items carried from the spec

1. **Clerk dev keys in this worktree, or live verification on a preview deploy?** Jason's call; Task 8 Step 5 depends on it.
2. **Which sign-in methods are enabled in the Clerk dashboard?** Needed for phase 2, not for this one.
3. **Turn off "users can delete their account" in the Clerk dashboard.** Should happen before phase 1 ships, since `/settings/account` now advertises Orbit's delete as *the* way out.
