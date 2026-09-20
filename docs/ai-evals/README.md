# AI evals

`scripts/eval-ai.ts` runs Orbit's real AI features over synthetic fixtures, scores them, and
records what each case cost. It is the gate for anything that changes which model runs, how
hard it thinks, or what it is asked.

## Running one

Tasks are run as separate processes — one per task, in parallel, each with its own throwaway
database — so a run is a *directory* of reports:

```bash
for t in capture recruiter extension ocr transcribe chat digest; do
  npx tsx scripts/eval-ai.ts --keys-from .env.local --provider gemini \
    --task "$t" --runs 2 --out "runs/mine/$t.json" &
done; wait

npx tsx scripts/eval-ai-report.ts docs/ai-evals/2026-09-19-gemini-baseline runs/mine
```

The report prints accuracy and cost per case side by side and applies
`scripts/eval-fixtures/ai-eval-thresholds.json`. A candidate ships only on `GATE: PASS`.

Candidates are JSON files under `scripts/eval-fixtures/candidates/`, applied to the operation
registry and tier maps before the run — the same values production reads, so a candidate that
passes ships by editing those values.

## What is recorded here

`2026-09-19-gemini-baseline/` is Gemini as Orbit shipped it before the cost work:
`gemini-3.5-flash` for user-facing work, `gemini-3.1-flash-lite` for the fast tier, and every
model left on its default thinking level. One pass over the fixtures cost **$2.06**.

Two things in it are worth remembering. Default thinking was not buying accuracy on
extraction work — turning it down made several tasks *better*, not worse. And the numbers to
beat are per task, not overall: the baseline's perfect precision on some tasks came with
recall so low (recruiter 56%, digest attendees 33%) that the task was barely working.

`2026-09-19-gemini-candidate/` is what shipped: minimal thinking on extraction and
classification, the cheap tier for recruiter scanning, profile reading, date extraction and
import enrichment, and `gemini-3.8-flash` as the default and vision model. One pass over the
fixtures cost **$0.19** — 91% less — and it was more accurate almost everywhere.

The recruiter, extension, OCR, transcription and digest reports in it are two runs per case.
Capture and chat are one: a second pass hit the Gemini project's spending cap part-way
through, and a run with failed calls in it measures the cap, not the model.

Two things are still owed here:

- **The meeting digest's thinking level.** Turning it down took action-item recall from 100%
  to 92% while taking attendee recall from 33% to 100%. The digest is left on its provider
  default until a run settles whether "low" keeps both.
- **OpenAI and Anthropic.** Every number here is Gemini. The other two providers' defaults
  (notably Anthropic's Sonnet 4.5 at $3/$15, against Sonnet 5 at $2/$10) are unmeasured, so
  they are unchanged.

