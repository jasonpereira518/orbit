# Integrations dialog — the UI pass

Five pages of the Settings → Integrations dialog, simplified for someone who does not know
what an API key is. Supersedes the "AI page" section of
`docs/superpowers/specs/2026-09-22-integrations-dialog-simplification-design.md` (P1's spec)
and replaces P3's Tasks 6 and 7, which were never built.

**Branch:** `claude/integrations-ui-pass`, cut from `29af8e65` on `claude/integrations-p3-ai`
(PR #299). Stacked for the same reason P3 was: it edits files P3 just changed, so it cannot
start from `main`. It opens its own PR targeting the P3 branch and rebases onto `main` as the
stack merges.

## Where this came from

Jason dictated a batch of changes for the whole dialog. The AI page was the largest: three
providers with their logos, and a cheapest / in-between / most accurate model choice. That
redirect dropped OpenRouter from the interface entirely — P3's plumbing shipped with no
user-facing surface, deliberately.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Picking a tier stores the **model id**, exactly as today | Nothing downstream changes — the call path, the eval harness and the cost table all keep working. A tier that resolved at call time would change what `aiModel` means to every other reader. |
| 2 | The triple is **tagged on the existing `PROVIDER_MODELS` entries**, not a second table | One source of truth. Two tables drift, and the guard against drift is exactly the work the tag avoids. |
| 3 | Three cards, with a **collapsed Advanced** holding the custom model id, the saved keys and the Lifetime / dev-server copy | Non-technical users see three logos; the escape hatches survive for power users and Lifetime accounts. |
| 4 | AI usage leads with **activity, not cost** | The cost figure is an estimate from a table known to run about 5× low. A number presented as exact when it is five times under is worse than no number. |
| 5 | The calendar feed token **stays hashed** and shown once | It is a bearer credential for someone's reminders. Making it re-showable to improve a page most people touch once trades a real security property for convenience. |
| 6 | LinkedIn timeline events become **automatic, with no user-facing control** | Jason's decision, made after being told the audit made it opt-in because it spends one AI call per conversation on the user's own key. |
| 7 | The model presets are **refreshed** as part of this pass | See below — the current list offers a model that is dead for every new account. |

## A live bug this pass has to fix

`PROVIDER_MODELS.gemini` offers **`gemini-2.5-pro`**. The file's own comment records that
Google answers 404 *"no longer available to new users"* for 2.5 models on any key issued
since, and `LEGACY_MODEL_MAP` remaps `gemini-2.5-flash` and `gemini-2.5-flash-lite` for that
reason — but not `gemini-2.5-pro`. So the page currently offers a model that cannot work for
a new account, and it is the only plausible "most accurate" Gemini.

The OpenAI presets look similarly aged (`gpt-4o`, `gpt-4.1`) against what the vendors serve
today.

So tier assignment is not "pick three from what is there". Every id a tier points at is
verified against the provider's live model list before it is tagged, the way P3's OpenRouter
slugs were. Google's and Anthropic's lists are queryable without a key; OpenAI's needs one,
so that provider's ids are confirmed with Jason rather than fetched. **An id that cannot be
verified is not tagged** — shipping two tiers for a provider beats shipping a button that
404s.

## 1. The AI page

Three cards, one per provider, each carrying its mark, the provider's name, and a state line.

- **No key** → a paste affordance for that provider's key, verified on save by the existing
  `saveAiSettings` (which already returns a refusal as data rather than throwing).
- **Key saved** → the three-way model choice and a Clear.

Exactly one provider is active at a time — that is what `aiProvider` means — so the active
card is visually distinct, and choosing a model on another card switches to it.

**The model choice** is three options labelled by what they mean — Cheapest, Balanced, Most
accurate — with the model's name as small print beneath. The label answers the question; the
name is still there for anyone who wants it.

**Collapsed Advanced** holds, unchanged in behaviour: the custom model ID field, the saved
keys list with Clear, and the Lifetime / local-dev-server status copy. That prose is
**moved, not re-derived**. It carries distinct copy for a dev server on `.env.local`, for
Lifetime's included AI, for a managed model differing from the chosen one, and for the
allowance meter — none of it visible in demo, so a rewrite can delete it silently and nothing
fails.

**Structure.** `ai-settings.tsx` is 369 lines and would grow past 500. A `ProviderCard`
component is extracted — mark, state, key field, tier choice, Clear — and `ai-settings.tsx`
becomes a thin composer over three of them plus Advanced. This is the file being rewritten
anyway, not unrelated tidying.

**OpenRouter stays out.** P3 added `selectable: false` on its `AI_PROVIDERS` entry, and
`scripts/smoke-ai-providers.ts` pins the selectable list to exactly the three. The cards
render from `SELECTABLE_AI_PROVIDERS`; that smoke is what stops this pass reintroducing it.

## 2. The tier table and the marks

Each `PROVIDER_MODELS` entry gains an optional `tier: "cheapest" | "balanced" | "best"`. The
cards render the tagged entries; untagged entries remain reachable from Advanced's custom
field, so nobody currently on one loses it.

`DEFAULT_MODELS[p]` points at whatever is tagged `balanced`, so a new account lands on the
middle option.

A smoke pins: every provider has exactly one of each tier; every tiered id appears in that
provider's own preset list; `DEFAULT_MODELS[p]` equals the `balanced` id. That last check is
the anti-drift guard, and it is cheap precisely because there is one table rather than two.

**Marks.** `src/components/settings/provider-marks.tsx` holds Google, Microsoft and LinkedIn
as inline SVG. It gains Gemini, OpenAI and Anthropic for the AI cards, and Claude and ChatGPT
for the assistants page — same pattern, same `className` prop, same file. The Gemini spark is
used on that card rather than the Google "G", which already means "your Google account"
elsewhere in this dialog. Marks are taken from each vendor's published brand assets rather
than approximated; P2b's review caught Orbit's Google mark being an icons8 approximation and
replaced it for exactly this reason.

No mark for OpenRouter — it has no card.

## 3. The decision-model card

Cut the description to a sentence or two: what Jev is, that it is optional, that nothing
changes without a key. The status line and the TypeSafe key field stay exactly as they are.

**The "What Jev reads" text survives, collapsed.** It is a data disclosure — which fields of
a contact, a note, a calendar event a third-party model sees — and removing a privacy
statement to save vertical space is a bad trade even when the statement is long. Collapsed it
costs one line.

## 4. AI usage

Headline is what Orbit did, not what it cost: the number of AI calls in the last 30 days,
followed by a short plain-English list of where they went, using the labels the summary
already produces. Tokens go entirely. Per-row failure counts go; if the failure rate is worth
knowing it is one line, not a column.

Cost becomes a single approximate figure, explicitly marked an estimate, naming the
provider's own dashboard as the real number.

**This gives `cost_source` its first reader.** P3 added that column so a provider-reported
figure and an `ai-pricing.ts` estimate stop being indistinguishable, and P3's final review
noted nothing consumes it. The card reads it: when every row in the window is `reported` the
figure is real and is stated plainly; when any are `estimated` it says so. `UsageSummary`
carries the source through — a field on the existing summary query, not a new concept.

## 5. Reminders in calendar

One line explaining what this does, then destination buttons that open the right subscribe
flow directly. The raw feed URL, the reveal and copy controls, and Regenerate move into a
collapsed Advanced.

**The constraint that shapes this.** `webcalUrl` and `googleAddUrl` are non-null only when a
*fresh* token exists (`src/actions/calendar-feed.ts:30`). The token is hashed at rest, so
Orbit cannot reconstruct the URL afterwards. Therefore:

- **Turning the feed on** renders the destination buttons immediately, in that same response.
  That is when almost everyone subscribes.
- **A later visit** shows that reminders are in the calendar, with the buttons absent because
  the URL genuinely does not exist any more, and a Regenerate that warns it breaks the
  existing subscription.

This is stated in the copy rather than worked around. The alternative — encrypting the token
so it can be rebuilt — was considered and rejected (decision 5).

**Outlook has two hosts:** `outlook.live.com` for personal accounts and `outlook.office.com`
for work or school, and nothing in the feed status says which someone has. Rather than guess
and fail silently, Outlook renders as two small links under one heading — work and personal.
Google and Apple are one button each, from the URLs the status already provides.

## 6. Claude and ChatGPT

Marks beside each assistant's setup steps. No structural change.

## 7. LinkedIn

`TimelineBackfillToggle` comes out of the messages panel. Deriving timeline events becomes
part of what a messages import does.

`timeline_backfill_enabled` stays in the schema as an **operator kill switch with no UI**,
defaulting on. The column is `integer NOT NULL DEFAULT 0` with no way to distinguish "never
touched" from "explicitly declined", so honouring a past decline is not possible without a
schema change — and everyone reads as off today, because off is the default.

Existing accounts are flipped on. That is the decision recorded above: it starts spending a
person's own AI budget on import without asking them first, at one call per conversation
under the existing daily cap.

## Verification

No React harness exists in this repo, so the component work has no unit tests and the spec
says so rather than inventing one.

**Pure smokes:** the tier invariants (section 2); `UsageSummary` carrying `cost_source`;
`smoke-ai-providers`' existing selectable-list pin, which must keep passing.

**Repo-wide smokes that bind this work:** `smoke-toast-copy`, `smoke-settings-layout`,
`smoke-tap-targets`.

**In-app, at 1280×860 and 375×812** — and unlike P3, all of this is reachable in demo mode:
each provider card in both states, the tier choice changing the stored model, Advanced
holding the custom field and the saved keys, the usage card's activity headline, the
decision-model card collapsed and expanded, the assistants marks, the reminders flow from
off → on → buttons → revisit, and the LinkedIn messages panel with no toggle.

**Not verifiable here:** whether each refreshed model id actually answers for a real key.
That needs Jason's own keys, and it is the one thing that would make a tier button fail.

## Out of scope

- Correcting `ai-pricing.ts`'s ~5× low table. Real, wrong everywhere, and its own job.
- Anything OpenRouter-facing. P3's plumbing stays exactly as it is, with no UI.
- P5 (LinkedIn's one-ZIP import, the Advanced pages).
