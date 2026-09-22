# Work-history eval fixtures

Real LinkedIn page text, used by `scripts/eval-extension-profile.ts` to gate the
extension's work-history capture. **Everything in this folder except this README
and `*.synthetic.json` is gitignored.** It is other people's data, so it stays
on your machine.

## Saving one

1. Open a profile on LinkedIn while signed in. Include at least one of each:
   - a profile page (`/in/<slug>/`) with a shortened list ("Show all 9 experiences")
   - its `/in/<slug>/details/experience/` page
   - someone with several roles grouped under one employer
   - a sparse profile (one role, no dates)
   - a `/details/education/` page
2. Select all the text in the main column (⌘A inside the page works) and copy it.
3. Create `<anything>.json` here:

```json
{
  "url": "https://www.linkedin.com/in/<slug>/details/experience/",
  "name": "Their Name",
  "text": "…the pasted page text…",
  "expect": {
    "employers": ["Every employer the page lists, as written"],
    "schools": ["Every school the page lists"]
  }
}
```

`url` decides the section: a `/details/experience/` or `/details/education/`
URL is that section in full; anything else is the profile. `expect` is
optional. Without it the eval still checks that nothing was invented, and
prints what it read for you to check by eye.

Plain `.txt` files work too (page text only, no expectations). Name one
`…details-experience.txt` or `…details-education.txt` to mark its section.

## The gate

```bash
ORBIT_EVAL_GEMINI_KEY=… npx tsx scripts/eval-extension-profile.ts
```

It passes when **at least 5** real fixtures ran, the model's raw output named
**zero** employers or schools that aren't on the page (before Orbit's own
grounding filter removes them), and, where you gave `expect`, it found at least
90% of them. Work history doesn't merge until this passes.
