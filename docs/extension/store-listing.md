# Chrome Web Store listing — Orbit

Everything the Developer Dashboard asks for, in the order it asks. Each answer below
was checked against the code on the branch that ships it (sub-projects 0–7 of
`docs/superpowers/specs/2026-09-19-extension-revision-design.md`). If the extension
changes what it reads or asks for, this file, the privacy policy's `#extension`
section and `extension/README.md` ("What it deliberately does not do") change in the
same PR.

## Store listing tab

**Name:** Orbit

**Summary** (the manifest `description`, 132 characters max):

> See who you already know — and what to say next — on the pages you're already reading.

**Category:** Productivity → Workflow & planning

**Language:** English (United States)

**Description:**

> Orbit is a personal CRM for the people in your professional life. The extension puts it
> beside the pages you already read.
>
> KNOW WHO YOU ALREADY KNOW
> Open someone's LinkedIn, GitHub or X profile — or their own site — and click the Orbit icon.
> If they're in your network, Orbit shows what you last talked about, what you said you'd do,
> and what to say next. If they're new, their name, title and company come straight off the
> page: add a note and a follow-up, and save them in one click.
>
> EVERY LIST, MARKED
> On a LinkedIn search, a company's People tab or a team page, Orbit marks who you already
> know and who's new. Pick one at a time — it never adds a whole page at once.
>
> WHO YOU KNOW AT ANY COMPANY
> On a company page, see how many people you know there now, and how many used to work there.
>
> BESIDE EVERYTHING ELSE
> On any other page: what's due today, search your network, and a quick note about anyone.
> Right-click a profile link to look that person up, or selected text to save it as a note.
>
> IT READS A PAGE ONLY WHEN YOU CLICK
> Orbit reads the tab you clicked, when you click — nothing runs in the background, it adds
> nothing to the pages you visit, and it never clicks, scrolls or expands anything. You can
> let it follow you on LinkedIn, X, Gmail or GitHub if you want; that's off until you turn it
> on.
>
> FREE, WITH PRO DEPTH
> Recognizing, saving, notes, follow-ups and search are free on every plan. Orbit Pro adds
> AI-written opening lines (with your own AI key), smart search, work history read from
> LinkedIn, and who you know at any company.
>
> Requires a free Orbit account at orbit.jasonpereira.live.

**Graphics** — generate with `extension/scripts/store-screenshots.mjs` (header has the
command). They are composed from the design harness, so they show the real panel against
fixture people only:

| Asset | Size | File |
|---|---|---|
| Icon | 128×128 | `extension/public/icons/128.png` (also in the zip) |
| Screenshot 1 — Know who you already know | 1280×800 | `release/store/1-know-who-you-know.png` |
| Screenshot 2 — Someone new? One click | 1280×800 | `release/store/2-save-in-one-click.png` |
| Screenshot 3 — Every list, marked | 1280×800 | `release/store/3-every-list.png` |
| Screenshot 4 — Who you know at any company | 1280×800 | `release/store/4-who-you-know-there.png` |
| Screenshot 5 — Beside everything you read | 1280×800 | `release/store/5-beside-everything.png` |
| Small promo tile | 440×280 | `release/store/promo-tile.png` |

The store also accepts real-browser captures. If you replace these with screenshots of the
panel on live LinkedIn, use your own profile or a fixture account — never a real third
party's page.

**Official URL / homepage:** https://orbit.jasonpereira.live
**Support URL:** https://orbit.jasonpereira.live/contact

## Privacy practices tab

### Single purpose

> Orbit shows the user's own Orbit network — whether they already know the person or
> organization on the page they're viewing, and what they've recorded about them — and lets
> them add to it, beside that page.

### Permission justifications

| Permission | Justification |
|---|---|
| `activeTab` | Orbit reads the page the user is viewing only when they click its toolbar icon, press its shortcut, or choose one of its right-click items. `activeTab` grants access to that one tab at that moment, so the extension holds no standing access to any site. |
| `scripting` | Used with `activeTab` (and with the optional per-site permissions below) to run Orbit's page reader in the clicked tab once, on demand. There is no declared content script: nothing runs on any page until the user asks. |
| `sidePanel` | The extension's whole interface is a side panel beside the page. |
| `storage` | Keeps the user's Orbit sign-in state (managed by our authentication provider's extension SDK) and hands a click or right-click from the background worker to the side panel through session storage, which is memory-only and deleted as soon as the panel acts on it. |
| `cookies` | Signs the user in with their existing Orbit web session ("sign in once"), by reading Orbit's own session cookie. Scoped by host permissions to Orbit's own domains; it grants nothing on any other site. |
| `contextMenus` | Two right-click items: "Look up in Orbit" on LinkedIn, X and GitHub profile links (looks the person up by the link alone; the linked page is never opened or fetched), and "Save to Orbit as a note" on selected text. |
| Host: `https://orbit.jasonpereira.live/*` | Orbit's own API, which the panel calls to look people up and save them, and the session cookie above. |
| Host: `https://clerk.orbit.jasonpereira.live/*`, `https://*.clerk.accounts.dev/*` | Orbit's authentication provider (Clerk), which the panel talks to directly to sign the user in. |
| Optional host: LinkedIn, X, Gmail, GitHub | Off by default and never needed to read a page — the click does that. Requested only if the user turns on "follow me on this site" in the extension's settings, so the panel updates as they browse that site without a click. Revocable from the same list. |

`externally_connectable` (not a permission, listed for completeness): only
`https://orbit.jasonpereira.live/*` may message the extension, to ask whether it is installed
(the answer is the version and which sites it follows) and to say the user signed in.

**Remote code:** No. All code ships in the package; the extension pages' CSP is
`script-src 'self'`.

### Data usage

What the form calls "collects" means data that leaves the user's browser for Orbit.

| Category | Collected? | What, exactly |
|---|---|---|
| Personally identifiable information | **Yes** | Names, titles, companies, locations, profile links and, on Gmail, email addresses of the people on the page the user clicked; the signed-in user's own account identity. |
| Health information | No | |
| Financial and payment information | No | Payment happens on the web app, through Stripe, never in the extension. |
| Authentication information | **Yes** | The user's Orbit session token, used to authenticate the extension's requests to Orbit. No passwords. |
| Personal communications | **Yes** | Only text the user explicitly selects and saves as a note, and notes they write in the panel. The Gmail reader takes the names and addresses of a thread's participants, never the email itself. |
| Location | No | A profile's stated city is part of PII above, not the user's location. |
| Web history | No | Only the page the user clicked, at that moment — never a list of pages visited. |
| User activity | No | No clicks, scrolls, keystrokes or network monitoring. Orbit counts API requests per user for rate limiting and records which locked Pro section a user clicked. |
| Website content | **Yes** | The visible text of the clicked page's main content (up to 10,000 characters, or 40,000 when the user presses "Save work history"), with sections about other people removed. |

**Certifications** (all three are true):

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

"Approved use cases" covers the one transfer that happens: page text sent to the AI provider
the user chose in Orbit, on the user's own API key, to fill in details, suggest opening
lines, or read work history.

**Privacy policy URL:** https://orbit.jasonpereira.live/privacy#extension

## Distribution tab

- Visibility: **Public** (or **Unlisted** for a soft launch — the listing works the same by
  direct link, and `NEXT_PUBLIC_EXTENSION_URL` can point at it either way).
- Regions: all.
- Pricing: free. (Pro features are billed on the web app, not through the store.)
