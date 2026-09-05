# Manual verification: LinkedIn profile capture

> ## ⚠️ Shipped unverified — this needs correcting
>
> The extension capture path was merged **before it was ever run against a real,
> signed-in LinkedIn page.** The DOM readers in `src/inject/adapters/linkedin-profile.ts`
> were written without any real markup to test against (see the `WRITTEN BLIND` banner in
> that file). Everything testable without a browser was tested — the date parser, the
> click bounds, the failure modes, the containment of the click exception — but whether
> the selectors match LinkedIn's actual DOM is unknown.
>
> **Five behaviors are unverified:** role extraction, current-role detection, education
> classification, About extraction, and the `/details/experience` subpage path.
>
> **Two of them are expected to fail**, per the branch review that shipped this:
> - `readEntry` builds its candidate lines from `querySelectorAll("span, div")` in
>   document order. The outermost container's `visibleText` is the *entire entry*, so the
>   first/second lines are probably whole-entry blobs rather than a title/employer pair.
>   Expect to rewrite the heuristic, not tune it.
> - `sectionFor` has exactly one strategy (the `#experience` anchor, with a
>   `section[data-section=…]` fallback). The `/details/experience` subpage does not render
>   that anchor, so the documented degradation fallback is likely non-functional. Expect to
>   add a second reader strategy.
>
> Also unbounded on the client: the adapter clamps only `description` (2000 chars) while
> the server bounds every field strictly, so one over-long string 400s the **whole**
> capture with a generic `invalid_request` — no partial save, no degrade. Consider
> clamping in the reader, the way `text.blob` already does.
>
> **To close this out:**
> 1. Capture the two fixtures described in `scripts/fixtures/README.md`.
> 2. Run `ORBIT_REQUIRE_FIXTURES=1 npx tsx scripts/smoke-contact-profile-format.ts` — it
>    exits non-zero until they exist, and its assertions are the specification.
> 3. Fix what it exposes.
> 4. Run the checklist below.
>
> Until then the Apollo source works and the extension source is a best-effort draft.
> The server side of the capture — the identity guard, precedence, the atomic write — was
> reviewed and tested thoroughly and is not what this warning is about.

`src/inject/dom/expand.ts` is the one place in this extension that acts on a page instead
of reading it — the one exception to the adapter's "never navigate, click, scroll, or
paginate" rule (see that file's own header for the full argument and its bounds). Nothing
that clicks on a live, third-party page can be exercised by an automated test the way a
pure function can: `scripts/smoke-contact-profile-format.ts` proves the click-scoping and
label-matching *logic* against synthetic and (once captured) fixture markup, but it cannot
prove that a real, signed-in LinkedIn page behaves the way that logic assumes. That gap is
what this checklist covers, and it is the **only** verification for the properties below —
if it goes stale or unread, those properties go unverified. Re-run it whenever
`expand.ts`, the LinkedIn adapter (`src/inject/adapters/linkedin.ts`,
`linkedin-profile.ts`), or the capture band in `src/panel/views/KnownContactView.tsx`
changes.

Load `dist/` as an unpacked extension (`npm run build` first — see the main
[README](./README.md)), sign in, and work through these against a real, signed-in LinkedIn
session.

## Checklist

1. **Basic capture.** Open a LinkedIn profile with more than four roles, for someone
   already resolved as a known contact in the panel. Press "Capture experience". Expect the
   button text to move "Capture experience" → "Expanding sections…" → "Saving…" →
   "Saved N roles".
2. **Expansion actually happened.** While the button reads "Expanding sections…", confirm
   the collapsed sections visibly expand on the page, and that N in "Saved N roles" matches
   the role count actually visible in the page's Experience section.
3. **The write matches the page.** Open the contact in Orbit (the panel's "Open" quick
   action) and confirm the roles, dates, and About text match what's on the LinkedIn page.
4. **Slug mismatch (the conflict UI).** With a different contact resolved in the panel than
   the one the current tab's profile is about (e.g. start a note draft to keep the panel
   pinned to contact B, then navigate the tab to person A's profile — see `usePanel.ts`'s
   `dirtyRef`/`pendingUrl`), press "Capture experience". Confirm:
   - the conflict prompt appears — "This page is `<A's slug>`, but this contact is
     `<B's slug>`. Save anyway?" — with both labels fully readable and not overflowing the
     panel's width (this is what the `break-words` fix on the conflict `Meta` covers);
   - pressing **Cancel** writes nothing — recheck B's stored experience in Orbit is
     unchanged;
   - pressing "Capture experience" again and then **Save anyway** does write, and B's
     stored experience now reflects A's page.

   (The server half of this guard — the refusal itself, case sensitivity, malformed stored
   URLs, etc. — is covered by `scripts/smoke-contact-profile.ts`. This step is the panel UI
   half, which has no automated coverage.)
5. **Containment: nothing outside the subject's own sections should move.** On a profile
   page with a visible "People also viewed" carousel, a "More profiles for you" strip, or
   any nav/promoted element on screen, press "Capture experience" and watch that region
   specifically while the button reads "Expanding sections…". Nothing outside the subject's
   own Experience/Education/etc. sections should visibly change. This is the containment
   property the click exception was granted on — the automated `<nav>`- and
   denylisted-section-scoping checks in `smoke-contact-profile-format.ts` prove the code
   excludes those regions, but only a human watching a real page proves LinkedIn's actual
   DOM shape doesn't route around that.
6. **A capture that finds nothing must never erase what was already stored.** Pick a
   contact already captured with stored experience. Make the *current tab's* profile page
   yield no readable Experience section — e.g. in DevTools' Elements panel, rename the
   `#experience` anchor (or its section) for that one page load, so `readProfileSections`
   finds nothing. Press "Capture experience". Two outcomes are both correct, depending on
   whether the account has a working AI key (the server's fallback may recover the roles
   from the page text and save for real):
   - the "Couldn't read this profile…" degraded prompt, with the contact's previously
     stored roles unchanged in Orbit; **or**
   - a successful save whose roles match what the (still-rendered, pre-your-edit) page
     actually shows.

   What must **never** happen, under either path: "Saved 0 roles", or fewer experience rows
   stored afterward than before you pressed the button. (The zero-roles-degrades-without-
   writing half of this is the Critical from the prior review round, and is covered
   end-to-end by `scripts/smoke-contact-profile.ts`'s "a capture that reads zero roles…"
   block — this step is the live-page case that script can't reach, where the AI fallback
   is a real possibility instead of a guaranteed no-op.)
7. **`schemaVersion` is observable without editing source.** From the panel's own DevTools
   console, run once:
   ```js
   chrome.storage.local.set({ "orbit:debugCapture": true })
   ```
   Then:
   - open a LinkedIn profile in the panel **without** pressing "Capture experience" — the
     console should log `[orbit] page read` with `schemaVersion: 1, hasProfile: false`;
   - press "Capture experience" — a second log should show `schemaVersion: 2, hasProfile:
     true`.

   This is `extension/src/lib/page.ts`'s `debugLogSchemaVersion`, called from both
   `readActivePage()` and `captureActiveProfile()`, gated on that storage flag so verifying
   the single most important property in this task — that an ordinary panel open never
   clicks anything and always emits `schemaVersion: 1` — never requires a temporary source
   edit. It logs via `console.info`, which shows at DevTools' default console level (unlike
   `console.debug`, which is hidden unless the level filter is set to Verbose). Clear the
   flag afterward, since it's meant for verification, not left-on debugging:
   ```js
   chrome.storage.local.remove("orbit:debugCapture")
   ```

## Known limitations (deferred by decision, not oversight)

- `excludedRegions` (in `src/inject/dom/text.ts`) pulls `[aria-hidden="true"]` into the
  click path's exclusion list, where it exists for the read path's screen-reader-duplicate
  problem. A consequence: a control sitting inside an `aria-hidden="true"` wrapper is never
  clicked, even if it's a legitimate expander. This fails safe (an unrecognized/excluded
  control is left alone, never guessed at) and is unverifiable against real markup until
  the LinkedIn profile fixtures (see `scripts/fixtures/README.md`) land.
- `visibleText` (also in `dom/text.ts`) narrows an element's label to its first
  `[aria-hidden="true"]` *descendant*, not the element's full text. A hypothetical control
  shaped like `<button><span aria-hidden="true">See more</span> about Jane</button>` would
  match on "See more" alone, where a sighted user reads the whole string as one label. This
  is intentional for LinkedIn's actual duplicated-label shape (see `isExpandControl`'s
  header) but is a narrowing, not a general-purpose "get the visible text" implementation.
- `excludedRegions(root)` is recomputed from scratch on every `expandProfileSections` loop
  pass (up to `MAX_CLICKS` times), since the DOM can change between clicks. On a very heavy
  profile page that's a non-trivial number of `Element.contains()` calls per pass. This is
  almost certainly still well under the 250ms `SETTLE_MS` sleep between clicks, but has not
  been measured against a real heavy profile.
