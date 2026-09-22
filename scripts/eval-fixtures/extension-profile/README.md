# Work-history eval fixtures

Real LinkedIn page text, used by `scripts/eval-extension-profile.ts` to gate the
extension's work-history capture. **Everything in this folder except this README
and `*.synthetic.json` is gitignored.** It is other people's data, so it stays
on your machine.

## Saving one

For each profile, in your browser, signed in:

1. Open the page.
2. Click once inside it, then **⌘A, ⌘C**.
3. In this repo:

```bash
npx tsx scripts/save-profile-fixture.ts \
  --url "https://www.linkedin.com/in/<slug>/" \
  --name "Their Name" \
  --expect "Every employer and school the page lists, comma separated"
```

It reads your clipboard, cleans the text the way the extension cleans a page
(LinkedIn prints most lines twice; the trailing "People also viewed" block is
other people's jobs and is cut), and writes `<slug>.json` here. `--expect` is
optional — without it the eval still checks that nothing was invented, but it
can't measure how much was found. `--file <path>` or `--stdin` work instead of
the clipboard.

### The five to save

Each one exercises a different branch of `profile-capture.ts`:

| # | Page | Why |
|---|---|---|
| 1 | A profile whose experience list is shortened ("Show all 9 experiences") | The case that must write nothing when Orbit already holds more |
| 2 | That same person's `/in/<slug>/details/experience/` | The full list, which replaces only that section |
| 3 | Someone with several roles grouped under one employer | One entry per role, all with that employer |
| 4 | A sparse profile — one role, few or no dates | Missing dates must stay missing, not be guessed |
| 5 | Any `/in/<slug>/details/education/` | Education, alone |

A sixth: your own profile, where you can check every date by eye.

### Checking them

```bash
npx tsx scripts/eval-extension-profile.ts --dry-run
```

Costs nothing, calls no model, and prints nothing from inside a page — just
sizes, sections and what's still missing.

## The gate

```bash
ORBIT_EVAL_GEMINI_KEY=… npx tsx scripts/eval-extension-profile.ts
```

It passes when **at least 5** real fixtures ran, the model's raw output named
**zero** employers or schools that aren't on the page (before Orbit's own
grounding filter removes them), and, where you gave `expect`, it found at least
90% of them. Work history doesn't merge until this passes.
