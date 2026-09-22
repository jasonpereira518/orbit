# Releasing the extension

A release is a zip uploaded to the Chrome Web Store. The store's review takes
anywhere from hours to days, and a user's Chrome picks the update up on its own
schedule after that — so a bad build is live for days, not minutes. Everything
below exists because it can't be fixed quickly afterwards.

Listing copy, permission justifications and data-use answers:
[`docs/extension/store-listing.md`](../../docs/extension/store-listing.md).

## 0. The server goes first

The extension and the app share a wire contract (`src/lib/extension/contract.ts`).
The server always ships first, and stays compatible with every build still installed:

- [ ] The app commit this build needs is **deployed to production** — check the
      deployed SHA, not the merged one (`docs/RUNBOOK.md` → Deploy).
- [ ] If the build relies on a new contract field, `EXTENSION_CONTRACT_VERSION` was
      bumped and the new behaviour is gated on `me.contractVersion`.
- [ ] Nothing a still-installed build calls was removed or changed incompatibly. Note
      that bumping `EXTENSION_CONTRACT_VERSION` shows every older build a soft "update
      available" band (`isOutdated`) — deploy that server change close to the store
      release, not weeks ahead. `MIN_SUPPORTED_CONTRACT_VERSION` is advertised in `/me`
      but enforced nowhere; nothing cuts an old build off.

## 1. Version and build

- [ ] Bump `version` in `extension/package.json` — plain `x.y.z` (Chrome refuses a
      prerelease tag, and the store refuses a version it has seen).
- [ ] `npm --prefix extension run typecheck && npm --prefix extension run lint && npm --prefix extension test`
- [ ] `npm --prefix extension run e2e` — the permission model and the web-app handshake
      in real Chrome (needs a display; CI runs it under xvfb).
- [ ] `npm --prefix extension run zip` — builds with `.env.production` and refuses:
      a dev-named manifest, a manifest or bundle carrying a dev origin
      (`localhost:<port>`), a manifest without its pinned `key`. The zip itself has
      `key` removed, because the store rejects it.

## 2. Things only a person can check

CDP can't open Chrome's context menu or press a real key, and the automated runs use a
dev build. Load `extension/dist` unpacked (`chrome://extensions` → Developer mode → Load
unpacked) in a normal Chrome profile, signed in to production Orbit with a **non-demo**
account on a paid plan, then a free one:

- [ ] **Toolbar click** on a site Orbit has no permission for (e.g. a personal blog): the
      panel opens *and* reads the page — no grant wall.
- [ ] **⇧⌘O / Ctrl+Shift+O** does the same.
- [ ] Switch to another tab: the panel shows "click the Orbit icon", never the previous
      person. Click → it reads that tab.
- [ ] **Right-click a LinkedIn `/in/` link** with the panel **closed**: "Look up in
      Orbit" opens the panel on that person. Repeat with the panel open.
- [ ] **Select text → "Save to Orbit as a note"**: the quote shows; the note lands on the
      person you pick.
- [ ] **Sign-in handshake:** sign out of the panel's session (sign out on the web app),
      reopen the panel so it shows "Sign in", then sign in on the web app — the panel
      picks the session up with no click.
- [ ] Settings → Integrations → Browser extension says **Installed · version x.y.z**;
      the notifications promo is gone.
- [ ] **Follow a site** from the panel's Settings, browse two LinkedIn profiles — it
      follows; revoke it — it stops.
- [ ] **Free plan:** Pro sections show a lock with See plans; See plans opens pricing.
- [ ] **Work history** (after its eval passes — `scripts/eval-extension-profile.ts`): on a
      real profile and its `/details/experience/` page.

The permission model rests on measured Chrome behaviour, not documentation
([`permission-spike.md`](./permission-spike.md), Chrome 153): with
`openPanelOnActionClick: true` a click grants the tab nothing; handling `onClicked` and
calling `sidePanel.open()` synchronously grants `activeTab`. The grant survives same-origin
navigation and drops on cross-origin navigation. If a Chrome release changes that, the
first three checks above are the ones that break — re-run the spike.

## 3. The first upload (once, ever)

The store assigns an item's ID from a key. Orbit's ID is already pinned
(`fejfkcfknmjojkmemacbgnddnmjgcmbo`, from `extension/key.pem`) and trusted by Clerk's
allowed origins, `EXTENSION_ORIGIN` and `NEXT_PUBLIC_EXTENSION_ID`. To keep it:

- [ ] `npm --prefix extension run zip -- --first-upload`, where `key.pem` lives. This zip
      carries the **private key** at its root — that is how the store adopts it.
- [ ] Dashboard → New item → upload that zip. **Do not publish yet.**
- [ ] **Check the item ID the dashboard shows.** It must be
      `fejfkcfknmjojkmemacbgnddnmjgcmbo`.
      - If it is: delete the `-FIRST-UPLOAD` zip. Every later upload uses plain
        `npm run zip`.
      - If it isn't: stop. Either delete the item and retry the upload, or adopt the
        store's ID — Package → View public key into `VITE_EXTENSION_KEY`, then update
        `EXTENSION_ORIGIN` and `NEXT_PUBLIC_EXTENSION_ID` in Vercel, the Clerk allowed
        origin, and rebuild. Publishing under a different ID means every signed-in
        request is rejected.
- [ ] Fill in the listing and privacy tabs from `docs/extension/store-listing.md`.

## 4. Submit, then after it's live

- [ ] Submit for review.
- [ ] Once published: set `NEXT_PUBLIC_EXTENSION_URL` in Vercel to the listing URL and
      redeploy — every "Add to Chrome" in the app points at it.
- [ ] Install from the store in a clean profile and run the toolbar-click and sign-in
      checks from section 2 once more against the store build.
- [ ] Record the release in `docs/RUNBOOK.md` → Extension releases.

## Rolling back

There is no rollback in the store: publish a new version with the previous code and a
**higher** version number. Until users update, the server keeps the old contract
working — which is exactly why section 0 never removes anything.
