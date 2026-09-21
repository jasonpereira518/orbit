# What a toolbar click grants a side-panel extension

Measured September 21, 2026, on Google Chrome 153.0.8010.50 (macOS). This is the
evidence behind the permission model in `src/background/index.ts`. Re-measure if
Chrome's `activeTab` or side-panel behaviour changes.

## The question

The extension has no standing access to any site: it relies on `activeTab`, which
Chrome grants for the current tab when the user invokes the extension. The side
panel was opened by Chrome's built-in `setPanelBehavior({ openPanelOnActionClick:
true })`, and the panel could see that a tab existed but not its URL or contents.
Every site therefore started behind a "grant Orbit access to this site" wall.

The hypothesis was that the built-in handler opens the panel without granting
anything, and that handling the click ourselves would fix it. That means setting
`openPanelOnActionClick: false`, listening to `action.onClicked`, and calling
`sidePanel.open()` inside that handler.

## Method

- Two throwaway extensions, each with **exactly the production permission set**
  (`activeTab`, `scripting`, `storage`, `sidePanel`).
- Neither has the `tabs` permission, which would reveal URLs regardless and
  invalidate the test.
  - **A**: `openPanelOnActionClick: true`. This is what shipped.
  - **B**: `openPanelOnActionClick: false`, with `sidePanel.open({ windowId })`
    called in `action.onClicked` and no `await` before it.
- Real Chrome, driven over the DevTools protocol in pipe mode
  (`--remote-debugging-pipe --enable-unsafe-extension-debugging`).
- The extensions were installed with `Extensions.loadUnpacked`.
- Clicks were made with `Extensions.triggerAction`, which runs the extension's
  default action on a tab, the same way a click on the icon does.
- After each step, the extension's own worker reported what it could see of the
  active tab:
  - `tabs.query` → is `url` present?
  - `scripting.executeScript` → can it read `document.title`?
- The fixture pages were served from `localhost` and `127.0.0.1`, which count as
  two origins.

Two practical notes:

- `triggerAction` needs the **tab** target: the parent of the page target that
  `Target.createTarget` returns.
- `triggerAction` refuses to run in headless Chrome ("Action can only be
  triggered on a tab target"). Headless has no tab strip, so the run uses a
  headed window placed off-screen.

## Results

| Step | A (shipped) | B (rework) |
|---|---|---|
| Before any click | URL hidden, injection blocked | URL hidden, injection blocked |
| Click on tab T | **panel opens; URL hidden, injection blocked; `onClicked` never fires** | panel opens; **URL visible, injection OK** |
| SPA `pushState` on T | — | kept |
| Full navigation, same origin | — | kept |
| Navigation to another origin | — | **dropped** |
| Back to the first origin | — | still dropped (a grant is not restored by returning) |
| New tab U, never clicked | hidden | hidden |
| Click on U while the panel is already open | hidden | `onClicked` fires, `open()` OK, **U granted** |
| Switch to another tab and back to U | — | kept |

A reproduces the behaviour the old code comments described observing with real
clicks: the panel opens and nothing is granted. That agreement is the evidence
that `triggerAction` follows the real click path.

## What the code does with this

- `src/background/index.ts` handles the click itself (variant B).
- It hands the click to the panel through `storage.session`, because a click
  while the panel is open grants a tab without producing any event the panel
  could observe. See `src/lib/intents.ts`.
- The panel follows the **tab and its URL**, not the URL alone. When the user
  switches to a tab nobody clicked, the panel says "Click the Orbit icon to read
  this tab". The old code skipped every unreadable tab and left the previous
  person on screen.
- Standing host permissions (LinkedIn, X, Gmail, GitHub) are now an opt-in
  convenience in Settings: the panel follows the user around a site without a
  click each time. They are no longer needed to read a page.

## Guarded by

`npm --prefix extension run e2e` runs `e2e/permissions.e2e.mjs`. It builds the
real extension against an unreachable API, then checks:

- one click reads the page
- an unclicked tab shows the hint, not the previous person
- a click with the panel already open reads that tab
- same-origin browsing keeps following
- cross-origin navigation drops the grant
- a previously clicked tab is still readable

Run against the pre-change extension, the same script fails 9 of its 10 checks.

## Not covered by automation, so check by hand before a release

1. **A real mouse click on the icon.** Open a LinkedIn profile, click the Orbit
   icon, and confirm the panel shows the person with no permission prompt.
2. **The keyboard shortcut** (`_execute_action`, ⇧⌘O by default). With no popup
   it fires `onClicked` like a click. CDP cannot press browser-level
   accelerators.
3. **Context-menu clicks**, once the menus exist (sub-project 4). Chrome
   documents them as granting `activeTab` and as a valid gesture for
   `sidePanel.open()`. Not yet measured.
