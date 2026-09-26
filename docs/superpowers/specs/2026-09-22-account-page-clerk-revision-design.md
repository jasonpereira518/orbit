# Orbit's own account page, in place of Clerk's

**Date:** 2026-09-22
**Branch:** `claude/account-page-clerk-revision-32b87a`, reset onto `origin/main` at `5e892e2d`
**Status:** design approved, implementation plan not yet written

## The problem

Everything a signed-in person can do with their own identity happens inside Clerk's
"Manage account" modal. Orbit reaches it from three places, all of them Clerk's
`UserButton`:

- `src/components/layout/app-sidebar.tsx:236`
- `src/components/layout/mobile-nav.tsx:619`
- `src/components/settings/profile-settings.tsx:68` (the same button, sized up to stand
  in as the profile portrait)

The only styling is `src/lib/clerk-appearance.ts`: Clerk's shadcn theme plus five element
overrides. Nothing in the modal is Orbit's — not the layout, not the copy, not the
motion. It is the one surface in the product that looks like someone else's software, and
it sits directly beside `/settings`, which is entirely ours. A person managing their
account crosses that seam constantly.

## The decision

Replace Clerk's account UI with Orbit's own screens, built on Clerk's hooks. Keep Clerk
as the identity provider and keep its reverification prompt. Everything else is ours.

Three choices, settled during design:

1. **Full parity, not a subset.** Profile, emails and sign-in methods, password and 2FA,
   and active devices. A partial replacement would leave people bouncing between our
   page and Clerk's modal, which is worse than either alone.
2. **`/settings/account` with real sub-routes**, reached from an Orbit avatar menu that
   replaces Clerk's popover.
3. **Clerk's own reverification prompt** (approach A of three considered). Custom screens
   everywhere, but when Clerk decides a session is too old to change something sensitive,
   its compact "confirm it's you" prompt appears, styled by `clerkAppearance`, and then
   the call retries.

Approach B (a custom reverification dialog per method) was rejected for v1: roughly 30-40%
more work on the riskiest part of the surface, four re-check methods to build and test,
and a new Clerk method silently breaks it. It stays available later — the custom dialog
attaches through one `onNeedsReverification` callback without touching the screens.
Approach C (embedding Clerk's `<UserProfile>` for the Security tab) was rejected as
contrary to the goal: the Security tab would be the one screen that still looked foreign.

## What this does not touch

Verified against `origin/main` before designing:

- **Gmail, Outlook and Eventbrite use Orbit's own OAuth**, not Clerk's connected accounts
  (`src/actions/gmail.ts`, `outlook.ts`, `events.ts` each carry their own state cookie).
- **The MCP connector** only *verifies* Clerk OAuth tokens
  (`src/lib/mcp/oauth.ts`, `auth({ acceptsToken: "oauth_token" })`).

So no integration depends on Clerk's account modal. The replacement is confined to
sign-in identity and security.

There is **no schema change**. Every field here lives in Clerk. No table, no
`SCHEMA_VERSION` bump, no migration gate.

## Architecture

### Routes

```
src/app/(clerk)/(app)/settings/account/
  layout.tsx          shell: heading, nav rail, Suspense boundary
  page.tsx            Profile (name, photo) + danger zone
  sign-in/page.tsx    emails + connected accounts
  security/page.tsx   password, two-step, passkeys
  devices/page.tsx    active sessions
```

Real routes rather than a client-side tab component, for three reasons:

1. There is no `tabs` primitive in `src/components/ui` (the directory holds avatar, badge,
   button, card, checkbox, date-picker, dialog, dropdown-menu, expandable-text, input,
   label, popover, select, sheet, skeleton, sonner, textarea, tooltip). A tab component
   would have to be built. The nav rail follows the existing `SettingsSectionNav` pattern
   instead.
2. Tab switching that rewrites the URL is the exact shape of a known hazard in this repo:
   a server action queued during a `history.replaceState` restore hangs. These screens
   fire actions on nearly every interaction.
3. Deep links (`/settings/account/security`) work for account alerts and reminder mail,
   which already link into settings.

### Server/client split

Each `page.tsx` is a server component calling `requireUserId()` and `isClerkConfigured()`,
rendering a client component with `clerkOn` passed down. Every Clerk hook sits below that
gate, following the rule that keeps marketing pages from calling Clerk hooks with no
provider above them. With Clerk off (local demo mode), each screen renders a short
explanatory panel instead of empty forms, so `next dev` stays a working demo account.

### Visibility

The account routes reuse the existing `settings-profile` surface key. An operator hiding
`settings.profile` keeps hiding it, and the routes redirect to `/settings` rather than
rendering. No new surface key and no rename — section ids in
`src/components/settings/sections.ts` are load-bearing, since `src/lib/surfaces.ts`
derives stored hide-list keys from them.

### What `/settings` keeps

The Profile card stays in place but shrinks to a summary: avatar, name, email, and a
"Manage account" link. **Your socials stay on it** — those are Orbit data, not Clerk's,
and `saveSocialLinks` is unchanged. This is a single edit to `profile-settings.tsx`.

## The screens

### Profile — `/settings/account`

- Avatar with upload and remove: `user.setProfileImage({ file })`, and `{ file: null }`
  to clear.
- First name, last name, and username if enabled, saved through `user.update()`.
- Save disabled until something changes; toast on success. No reverification needed.
- **Danger zone** at the bottom: Orbit's existing `DeleteAccountDialog`, unchanged. It
  keeps calling `deleteMyAccount` with the typed confirmation, so deletion stays on
  `account-deletion.ts` — Orbit data first, then the Clerk user.

### Sign-in — `/settings/account/sign-in`

- **Emails.** Each row shows primary and verified badges. Adding one runs
  `createEmailAddress()` → `prepareVerification({ strategy: "email_code" })` → six-digit
  code → `attemptVerification({ code })`. Primary set via
  `user.update({ primaryEmailAddressId })`. Removal via `emailAddress.destroy()`, blocked
  for the primary and for the last verified address.
- **Connected accounts.** Connect via
  `user.createExternalAccount({ strategy, redirectUrl })`, which navigates away and
  returns to this route. Disconnect via `externalAccount.destroy()`. The screen renders
  exactly the strategies enabled in the Clerk dashboard.
- **Lockout guard.** Never allow removing the last way to sign in. With no password and a
  single connected account, that account cannot be disconnected, and the disabled button
  says why.

### Security — `/settings/account/security`

- **Password.** Set, change, or remove via
  `user.updatePassword({ currentPassword, newPassword, signOutOfOtherSessions })`. The
  "sign out of other devices" checkbox defaults to on, matching Clerk's own behaviour.
- **Two-step (authenticator app).** `createTOTP()` returns the URI; the QR is rendered
  with the `qrcode` package, already a dependency. Then `verifyTOTP({ code })`. On
  success, backup codes are shown once with copy and download-as-`.txt`. Turning it off
  is `disableTOTP()`. SMS is deliberately excluded: it would have to be enabled in Clerk
  and is the weakest factor available.
- **Passkeys.** List, add (`user.createPasskey()`), rename, delete. There is no
  `usePasskeys` hook; passkeys come off `user.passkeys`.

### Devices — `/settings/account/devices`

`user.getSessions()` rendered as rows: browser and OS, IP city and country, last active,
and a "This device" badge for the current session. Per-row "Sign out" via
`session.revoke()`, plus "Sign out everywhere else". The cheapest screen to build and the
most reassuring to have, which is why it ships in phase 1.

## Reverification

Every sensitive call is wrapped once, at its call site:

```ts
const changePassword = useReverification(() =>
  user.updatePassword({ currentPassword, newPassword, signOutOfOtherSessions: true })
);
```

Clerk shows its own prompt when the session is too old, then retries the call. No re-check
UI is written here, and the check cannot be skipped by accident.

Wrapped: password set/change/remove, TOTP enable/disable, backup code regeneration,
passkey create/delete, email add/remove, connected account disconnect, session revoke.

## Errors

Clerk throws `ClerkAPIResponseError` carrying `errors[].code`. Raw Clerk strings are not
Orbit's voice, so a small mapper — `src/lib/clerk-errors.ts` — translates the codes we
actually hit:

| Clerk code | Orbit copy |
|---|---|
| `form_password_pwned` | That password has shown up in a breach — pick another |
| `form_code_incorrect` | That code didn't match — check and try again |
| `form_identifier_exists` | That email is already on your account |
| `form_password_incorrect` | That password wasn't right — try again |
| `form_password_validation_failed` | That password is too weak — make it longer |

Anything unmapped falls through to the existing `friendlyError(err, TOAST_COPY.saveFailed)`,
so no raw provider text ever reaches a toast. Copy is written to pass `smoke-toast-copy`,
which scans the whole repo for voice.

## The avatar menu

One new `AccountMenu`, built on the existing `ui/dropdown-menu` (Base UI) and `ui/avatar`,
replaces `UserButton` in all three call sites. Items: a header with name and email,
**Account**, **Settings**, and **Sign out** (Clerk's `SignOutButton`).

It takes name, email and image as props from the server, so the sidebar paints a face
without waiting on Clerk JS — matching the staged-arrival approach used elsewhere.

`clerk-appearance.ts` stays, since sign-in, sign-up and the reverification prompt still
use it. Only the `userButton*` element overrides are dropped, along with
`profileAvatarAppearance` in `profile-settings.tsx`.

**Consequence worth stating plainly:** Clerk's popover is currently the only path to
"Manage account". The menu and the routes must ship in the same PR, or people lose the
way into their own settings.

## Phases

Each phase is its own PR, stacked:

1. **Shell + menu + Profile + Devices.** Routes, `AccountMenu` in all three places,
   Profile screen, Devices screen, danger zone, `/settings` Profile card reduced to a
   summary. Ships as a working replacement.
2. **Sign-in.** Emails with code verification, connected accounts, the lockout guard.
3. **Security.** Password, TOTP with QR and backup codes, passkeys.

Cheapest and least risky first; the reverification-heavy work lands last and holds up
nothing before it.

## Verification, and its limits

**Without Clerk keys** (this worktree has no `.env`, so it runs in demo mode and every
screen renders the demo panel): `tsc --noEmit`, eslint against the zero-error baseline,
`smoke-toast-copy`, and a new `smoke-account-routes.ts` covering surface-key gating and
the error mapper's code-to-copy table. The smoke **must** be registered in
`scripts/run-smoke.ts` — an unregistered smoke kills the suite.

A browser pass in demo mode proves routing and gating. It proves nothing about Clerk
behaviour.

**With Clerk dev keys in the worktree**, a live pass is required before any phase is
called done: add an email and enter the real code, enable TOTP with a real authenticator,
revoke a device from another browser, and trigger the reverification prompt at least once.
When running the browser pane, keep the tab visible — an occluded tab never hydrates and
probes pass vacuously.

**Open question for Jason:** drop a `.env.local` with Clerk dev keys into this worktree,
or verify the live flows himself against a preview deploy?

## Manual steps (dashboard, not code)

1. **Turn off "users can delete their account" in the Clerk dashboard.** Until it is off,
   a person can delete their Clerk user directly, leaving Orbit to clean up through the
   `user.deleted` webhook or, later, the orphan sweep. Orbit's own flow deletes Orbit data
   first and is the only path that should exist.
2. **Confirm which sign-in methods are enabled** (password, Google, anything else). The
   Sign-in screen renders exactly what is turned on.

## Risks

- **Branch freshness.** The worktree sat 94 commits behind and was reset onto
  `origin/main` at `5e892e2d` on 2026-09-22. `main` moves several times a day, so re-check
  it before opening each phase's PR — a rival implementation can appear mid-task.
- **`claude/settings-popup-redesign-0ed30d`** (the Integrations dialog work, PR #257)
  rewrites `sections.ts` and `settings/page.tsx` but never touches
  `profile-settings.tsx`. Whichever merges second rebases; our footprint in the shared
  files is one card.
- **Clerk upgrades occasionally rename user methods.** Every method named here was
  verified against the installed `@clerk/nextjs` 7.5.20 (`createEmailAddress`,
  `setProfileImage`, `createTOTP`, `verifyTOTP`, `disableTOTP`, `createBackupCode`,
  `getSessions`, `updatePassword`, `createExternalAccount`, `createPasskey`,
  `useReverification`, `useSessionList`). Re-check on any Clerk bump.
- **Lockout bugs are the failure mode that hurts most.** The guard against removing the
  last sign-in method needs explicit test cases in the live pass, not just types.
