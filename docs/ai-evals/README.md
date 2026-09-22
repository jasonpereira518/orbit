# AI evals

`scripts/eval-ai.ts` runs Orbit's real AI features over synthetic fixtures, scores them, and
records what each case cost. It is the gate for anything that changes which model runs, how
hard it thinks, or what it is asked.

## Running one

Tasks are run as separate processes — one per task, in parallel, each with its own throwaway
database — so a run is a *directory* of reports:

```bash
for t in capture recruiter extension ocr transcribe chat research digest; do
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

## The research task

`research` scores whole answers to questions one retrieval cannot answer — the job of chat's
research step (`src/lib/chat-gather.ts`). It runs the production path in order: retrieval,
the depth decision, the research loop, the answer, the recommendation filter.

Every fact a case requires lives **only in a note**, never on a contact card, so a case passes
only if the research step found the note and the answer used it. It gates on `mentionRecall`,
`factRecall`, `routingAccuracy` (the rule-based router may not drop at all),
`forbiddenHits` and `inventedContactIds` (never). `meanLookups`, `meanRounds` and
`filteredRecommendations` are reported for cost and are not gated.

Its baseline is `2026-09-21-gemini-research-baseline/` — Gemini 3.8 Flash, 10 cases, 2 runs:

| metric | value |
|---|---|
| mentionRecall | 100% |
| factRecall | 92.9% (13/14 — one miss, `research-date-scoped`, run 2 only) |
| routingAccuracy | 100% |
| forbiddenHits / inventedContactIds | 0 / 0 |
| meanLookups / meanRounds | 2.75 / 2.5 |
| cost | $0.0122 per case, p50 9.8s |

What it says about the research step's cost: the gather rounds cost about as much as writing
the answer ($0.104 vs $0.106 across the run), because every round re-sends the conversation —
so a question routed to research costs roughly twice a single-pass one. `research-intro-path`
hits the six-lookup cap on every run; it is the most expensive case and the first place to
look when tuning. The one miss predates the per-case miss detail (the log now says which
person or fact was missing and prints the answer), so the next run will say why.

Compare against it with the directory form:

```bash
npx tsx scripts/eval-ai-report.ts docs/ai-evals/2026-09-21-gemini-research-baseline runs/mine
```

Its plumbing is also checked without a key by `scripts/smoke-eval-research-task.ts`.

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


## The decision model (Jev)

Jev is TypeSafe's decision model: typed questions in, calibrated probabilities out, at
$0.042 per million input tokens with output free. It runs only on a person's own TypeSafe
key (Settings → AI → Decision model), in two places so far, each with its pre-Jev path as
the fallback:

- **The recruiter scan.** A *prefilter* in discovery wins back senders the keyword test
  drops, and a *gate* in front of the LLM settles senders Jev is confident are not
  recruiters without an LLM call.
- **The chat rerank.** One ordered-score question per candidate replaces the flash-model
  rerank, whose cost was mostly output tokens spent *writing* 0–10 scores.

Questions and thresholds live together in `src/lib/decisions/catalog.ts`, tuned against one
pinned version (`JEV_MODEL`). Values marked START there have not been through a tuned run.

**The number to beat.** On the recruiter fixture, reading only what discovery has (the From
line, the subject and a 200-character snippet), the keyword prefilter admits **7 of 18**
recruiters — 39% recall, 88% precision. All three hiring managers are among the 11 it drops,
and a sender it drops is never looked at again. Measured Sep 21 2026 with the
`recruiter-prefilter` task and no decider.

**Measured Sep 22 2026** (`2026-09-22-jev-spike.json`, `2026-09-22-jev/`, `jev-1.13.0`):

- *Spike.* Answers parse as `decisions/jev.ts` expects. The state is billed once per call:
  over 60 contact cards, 1 question cost 4,498 input tokens and 60 cost 10,811 (about 107 per
  extra four-level score question), so a 60-candidate rerank is ≈ $0.00045 against ≈ $0.0025
  for the flash-lite rerank. Chunks of 15 cost about the same as one call and answer faster in
  parallel, so `chunkSize` stays 15. Latency p50 ≈ 190–200ms (1–13 questions), 348ms for 60.
  Not fully deterministic: identical calls drifted by up to 0.19 of a level on a 0–3 scale.
- *Prefilter* (`recruiter-prefilter`, keywords vs keywords + Jev): recall **38.9% → 100%**
  (18/18, every hiring manager among the 11 won back, each at P ≥ 0.86), precision 87.5% →
  78.3%, for $0.0007 across 40 senders. The false admissions are automated hiring-shaped mail
  (two ATS notices, a job board, a background check at P 0.47–0.88) — what the gate and the LLM
  behind it exist to reject.
- *Gate* (`recruiter-gate`, no LLM needed): **0** recruiters ruled out (lowest recruiter P 0.83;
  everything ruled out was ≤ 0.07); 16 of 22 non-recruiters (73%) settled without the LLM, 40%
  of all senders. At the fixture's measured flash-lite cost ($0.000335 per sender) against
  Jev's ($0.00003), that is ≈ 31% less per sender judged.
- *Still owed:* the end-to-end `recruiter` and `chat` tasks with `--decisions jev`, which need a
  paid Gemini key beside the TypeSafe one.

**Running it.** First the spike, which measures what TypeSafe's docs leave open: whether
real answers parse, whether a call with many questions bills its state once, latency, and
whether identical calls give identical answers:

    ORBIT_EVAL_TYPESAFE_KEY=… npx tsx scripts/spike-jev.ts

Then, in separate processes (one per task), a baseline without the decision model and the
same tasks with it. The run with `--decisions jev` adds each decision's calibration table
(claimed probability against observed rate, band by band) to the report:

    ORBIT_EVAL_GEMINI_KEY=… npx tsx scripts/eval-ai.ts --task recruiter --out docs/ai-evals/<date>-base/recruiter.json
    ORBIT_EVAL_GEMINI_KEY=… ORBIT_EVAL_TYPESAFE_KEY=… npx tsx scripts/eval-ai.ts --task recruiter --decisions jev --out docs/ai-evals/<date>-jev/recruiter.json
    # the same for --task chat; recruiter-prefilter and recruiter-gate run no LLM, so they
    # need only ORBIT_EVAL_TYPESAFE_KEY
    npx tsx scripts/eval-ai-report.ts docs/ai-evals/<date>-base docs/ai-evals/<date>-jev

What must hold: `recruiter-prefilter` recall may not drop (it should rise a long way),
`recruiter.gateWrongSkips` stays 0 (a real recruiter ruled out before the LLM is a recruiter
lost), and the chat task's `retrievalRecall` / `mentionRecall` stay within their thresholds.
The rerank's chunk size (`RERANK_TUNING.chunkSize`) comes from the spike's billing answer.
