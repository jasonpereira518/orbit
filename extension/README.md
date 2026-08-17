# Orbit browser extension

Click the Orbit icon on someone's profile and the panel answers three questions:
**do I already know this person, what do I know about them, and what should I
say?**

This is a separate project from the Next app — its own `package.json` and
lockfile, deliberately not an npm workspace, so `npm ci` at the repo root (which
is what Vercel runs) never pulls Vite and `@crxjs` into the deployment.

## Setup

```bash
cp .env.example .env      # then fill in the values below
npm install
npm run build
```

Load `dist/` via `chrome://extensions` → Developer mode → **Load unpacked**.

### `dev` and `build` write to the same `dist/`

This trips everyone once. `npm run dev` does **not** bundle the popup — it
writes a `dist/` whose popup page loads from the Vite dev server, so the panel
only works while that server is running. Stop the server (or run `dev` and then
walk away) and clicking the icon gives:

> Cannot connect to http://localhost:5173/src/popup/index.html. Make sure Vite
> is running, then reload the extension.

That is not a broken build — it's the dev shim with nothing behind it. Fix:

```bash
npm run build     # overwrite dist/ with a real, self-contained bundle
```

then hit **Reload** on the extension card in `chrome://extensions`.

So: `npm run dev` while you're iterating on the popup (keep it running),
`npm run build` whenever you actually want to *use* the extension.

### Environment

| Variable | Purpose |
| --- | --- |
| `VITE_ORBIT_APP_URL` | The Orbit deployment to talk to. Also becomes the extension's only site host permission. |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk key for that same deployment — the extension shares the web app's session via `syncHost`. |
| `VITE_ORBIT_DEV_SECRET` | Local dev only. Sent as `x-orbit-dev-secret` so the popup can talk to a dev server that has no Clerk session. Must match `EXTENSION_DEV_SECRET` in the app. |
| `VITE_EXTENSION_KEY` | Base64 public key that pins the extension ID (see below). |

The app side needs `EXTENSION_ORIGIN=chrome-extension://<id>` so Clerk will
accept a session presented from the extension.

### Pinning the extension ID

Chrome derives the extension ID from a public key, and an unpacked load
generates a fresh one each time — so the ID drifts, and `EXTENSION_ORIGIN` is an
exact-match allowlist entry. Generate a keypair once, put the base64 public key
in `VITE_EXTENSION_KEY`, and keep the `.pem` out of git (already gitignored):

```bash
openssl genrsa 2048 > key.pem
openssl rsa -in key.pem -pubout -outform DER | base64 | tr -d '\n'
```

## Architecture

```
popup (React + Clerk) ──fetch──► <app>/api/extension/*
  └─ chrome.scripting.executeScript
       └─ inject/extract.js (IIFE, no deps)
            └─ site adapter → PageContext
```

**Two phases per open.** Identity first: canonical URL → `/resolve` → a slug
lookup, no AI, no parsing. That alone powers the known-contact state, which is
the common case for an established user. Only when that finds nothing does the
page text matter, and it rode along in the same request so there's no second
round trip.

**The URL is more durable than any DOM node.** If every selector in the LinkedIn
adapter breaks, `/in/<slug>` still resolves a known contact and the panel
degrades to "we know who this is, we just can't show their headline."

### Permissions

`activeTab` + on-demand injection, not declared content scripts. `activeTab`
grants access to the current tab only, and only after a toolbar click, so
installing shows **no** "read your data on linkedin.com" warning — and the
extension structurally cannot fetch any site in the background, because it holds
no host permission for one.

`optional_host_permissions` are declared but never requested. Declaring costs no
install-time warning and lets a future always-on mode ask at runtime rather than
shipping a permission bump that re-prompts every existing user.

### What it deliberately does not do

No navigation, no programmatic clicks, no expanding "see more", no auto-scroll,
no pagination, no "add all" on list pages, no background fetching, and never any
injected UI on the host page. Every extraction is one read of what the user's own
browser already rendered, because they clicked the icon.

Page text is never persisted — it's model input only. The raw blob is never
cached locally either.

## Keeping in sync with the app

Two files mirror app logic and will fail silently if they drift:

- `src/inject/dom/url.ts` — `linkedinSlug` and `xHandle` must stay
  byte-identical to `src/lib/duplicates.ts`. If they diverge, the extension
  reports "new to your orbit" for someone the user has known for years.
- `src/styles/tokens.css` — generated from the app's `globals.css`.
  `npm run tokens:sync` regenerates; `npm run check:tokens` runs on every build
  and fails on drift.

The wire contract is imported directly from the app as types only
(`@contract` → `src/lib/extension/contract.ts`), so it erases at build time and
nothing from the Next app reaches the bundle.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Vite dev server with popup HMR |
| `npm run build` | Token drift check, then the injected IIFE, then the popup |
| `npm run typecheck` / `npm run lint` | The usual |
| `npm run tokens:sync` | Regenerate `tokens.css` from the app |
| `npm run zip` | Build and package `release/orbit-<version>.zip` |
