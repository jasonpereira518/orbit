# LinkedIn profile fixtures — PENDING

This directory is where two real, rendered LinkedIn profile pages need to live so
`scripts/smoke-contact-profile-format.ts` can verify `readProfileSections()` against actual
markup instead of an invented approximation of it. Neither file exists yet — capturing them
requires a signed-in human in a browser, which cannot be done from this environment.

Until both files exist, the smoke test prints a loud PENDING banner and skips the
fixture-dependent assertions (exit 0). Set `ORBIT_REQUIRE_FIXTURES=1` to make that same
condition fail the build instead.

**That gate was deliberately overridden once.** The LinkedIn experience-extraction feature
shipped with these fixtures still missing, as a considered call by the repo owner: the
server half was reviewed and tested thoroughly, and the extension half was merged as a
best-effort draft rather than held back. That is a debt, not a precedent — see the warning
at the top of `extension/MANUAL-VERIFICATION.md` for exactly which behaviors are unverified
and which two are expected to need rewriting. Capturing these two files is the first step
in paying it off.

## Files needed

- `linkedin-profile-expanded.html`
- `linkedin-profile-details-experience.html`

## How to capture them

1. Load the extension and sign in to LinkedIn.
2. Open a profile with at least four roles. Expand every collapsed section ("Show all N
   experiences", "…see more" on About, etc.) so the DOM actually contains everything.
3. In devtools console, on the profile page:

   ```js
   copy(document.querySelector("main").outerHTML)
   ```

   Paste the clipboard contents into `linkedin-profile-expanded.html`.
4. Navigate to `/in/<slug>/details/experience` on the same profile, repeat the same
   `copy(...)` snippet, and save as `linkedin-profile-details-experience.html`.

## Redact before committing

These are real profiles. Before committing:

- Replace the person's name with a placeholder (e.g. "Jordan Example") everywhere it
  appears, including in `alt` attributes, `aria-label`s, and any inline JSON blobs.
- Replace photo URLs with a placeholder or strip the `img` `src`/`srcset`.
- Remove any contact details (email, phone) if present.
- **Keep** company names, job titles, dates, and section structure — those are exactly what
  the smoke test asserts on, and redacting them would defeat the fixture's purpose.

## What the smoke test checks once these exist

See the "adapter section readers over saved markup" block in
`scripts/smoke-contact-profile-format.ts`:

- at least four roles read from the expanded page
- every experience entry has a non-empty organization
- at least one role has a parsed start year
- exactly one role is marked `isCurrent`
- at least one entry is classified `kind: "education"`
- `about` is populated with more than 20 characters
- a complete read leaves `parseIncomplete === false`
- the `/details/experience` subpage independently yields at least four roles
