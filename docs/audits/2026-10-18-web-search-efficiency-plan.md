# Web search efficiency plan

**Date:** Oct 18, 2026. Follows PR #464.

PR #464 caps web search: 300 searches per account per month, 612 per day across Orbit, and an admin pause. It also stops the worst waste: the sweep no longer researches cold imports, failed checks wait 7 days instead of 1, and `pause_turn` gets one resume.

This plan covers the next step: **fewer searches for each answer, and cheaper searches when we do run one.** Steps are ordered by expected savings per hour of work.

**Rule for every step:** measure before and after with step 0. A step that doesn't lower searches per successful answer gets reverted.

## 0. Count searches per operation (do first, ~1h)

PR #464 prices searches into `estimated_cost_micros`, but nothing records how many searches each call ran. Without that count we can't rank the steps below with real data.

- Add a `usage_events.web_searches integer` column.
  - The value already reaches `withUsage` as `TokenCounts.webSearches`, so storing it is about one line in `usageRow`.
  - Bump the schema version (the current one is 175; scan branches first).
- `/admin/billing`: show searches by operation for the last 7 and 30 days. Use one grouped query, the same shape as `loadUsageSummary`.
- Metric to watch: **searches per successful answer** for each operation, with a `match: "confident"` save counting as success.

## 1. Shared public-profile cache across accounts (biggest lever for imports)

Work history depends only on the contact's public LinkedIn identity, not on who is asking. Two Orbit users with the same connection pay for the same two searches twice.

- Key the work-history answer by `linkedin_slug`. The column already exists on `contacts` and is generated.
- Store it in `ai_result_cache` (or a small `public_profile_cache`) for 30 days. A hit from another account costs no searches.
- **Blocked on a privacy call by Jason.** This is the same question #438 answered for shared LinkedIn avatars: public lookups only, a terms bump, and an opt-out. Reuse that precedent.
- Expected effect: savings grow with overlap between users' networks. In classmate-heavy cohorts (Gillings, UNC), overlap is high.

## 2. One search first, a second only if needed (person and work history)

The full work-history search and `research.person` both allow 2 searches (`MAX_SEARCHES_PER_PERSON`). Most people resolve on the first, anchored query.

- Run the first call with `maxSearches: 1` and an explicit query template: `"<name>" "<company>" site:linkedin.com/in` (or the slug when we have it).
- Escalate to a second search only when the answer comes back `unsure` or `none`. This is the same escalate-on-difference pattern the cheap re-check already uses (`checkCurrentRoleWithWebSearch`).
- Lower the ceilings:
  - `MAX_SEARCHES_PER_DISCOVERY`: 4 → 2.
  - `MAX_SEARCHES_PER_COMPANY`: 3 → 2.
- **Gate:** the work-history and research eval fixtures. The confident-match rate can't drop by more than ~3 points.

## 3. Use the free page fetch instead of search when we already have the URL

Anthropic's `web_fetch` is not metered; you pay only for the tokens of the page. Several lookups already know the page they need:

- **Company research:** Wikidata gives the official website (`wikidataOrg`). Fetch the homepage and about page, and search only when the fetch fails or comes back thin.
- **Discover and person research:** when the candidate already has a personal site or company page URL, fetch it instead of searching.
- **LinkedIn itself stays search-only.** Its pages are login-walled, and `readWebPage` already denies them.
- Wiring:
  - Add a `web_fetch_20260209` tool (or `web_fetch_20250910` for Haiku) in `webSearchJson`'s Anthropic branch, set with `allowed_domains` to the known host.
  - Other providers keep using search.

## 4. Stop re-searching people we already failed to find

Contacts that came back `not_found` or `unsure` never get a stored web profile. That means:

- Every "Refresh from LinkedIn" click searches them again.
- Every capture that mentions them searches them again.
- Each sweep pass gives them the full 2-search lookup again.

Fixes:

- `contactsNeedingWorkHistory` should skip contacts whose `work_history_due_at` is in the future. A kick should honour the schedule.
- Clear `work_history_due_at` to NULL whenever `linkedin_url` changes, so a new anchor is due at once. Do this in the one place contact updates go through (`updateContactForUser`), not in each caller.
- After two misses in a row, stop automatic checks for that contact. This needs a small `work_history_misses smallint` counter. Clicking the button still works.

## 5. Shared answers: cache-key hygiene and single-flight

- **Company cache key:** it includes the homepage text read on /find, so the same company asked from chat and from /find is two cache entries, paid twice. Key it on the normalized company plus its domain, and keep the homepage text out of the key.
- **Person cache key:** normalize the anchor so the same person asked with a company anchor and with a LinkedIn anchor hits one entry, when the slug is known.
- **Single-flight:** two tabs or a double-click can start the same lookup together. Claim the cache row before searching (insert as `pending`; a second caller waits and polls about 20s, then reads the result).

## 6. Chat: one research call per turn, and keep results that time out

- Enforce "at most one `research_*` / `find_people` call per turn" in `chat-tool-loop.ts`, not only in the prompt (`chat-gather.ts:80`). This applies inside the existing `MAX_CALLS = 6`.
- When a chat tool times out at 20s, the search usually keeps running and gets billed, but the answer is thrown away and the user is told to rerun it on /find. That rerun is a second paid search.
  - Let the call finish in the background and write the cache, so the /find rerun is a cache hit.
  - Check that the function stays alive long enough (`after()` adds no time on Vercel). If it can't, raise the tool timeout for research tools to about 40s.

## 7. Cheapest provider for search on Orbit's key (managed AI, #419)

When Orbit pays (`keyOwner = 'orbit'`), choose the cheapest search provider instead of the general provider order.

- **Gemini 3 grounding** is reported at $14 per 1,000, with a monthly free allowance. Some sources say it bills per call rather than per query. If the free tier holds for API keys, the first few thousand searches each month cost nothing. **Verify on Google's pricing page before relying on it.**
- On BYOK keys, leave the person's own provider choice alone.

## Small wins worth folding into any of the above

- **`allowed_domains`** on Anthropic search for work history (`linkedin.com`, the company's domain). This cuts result tokens and stray pages, but doesn't reduce search count.
- **OpenAI** already uses `search_context_size: "low"`. Check that Gemini isn't using a higher-cost grounding mode.

## Suggested order

| Step | Effort | Depends on |
|---|---|---|
| 0. Per-operation counts | ~1h | — |
| 4. Stop re-searching misses | ~2h | — |
| 2. One search first | ~3h + eval run | eval fixtures |
| 5. Cache keys + single-flight | ~3h | — |
| 3. Free page fetch for known URLs | ~4h | — |
| 6. Chat guardrails | ~2h | — |
| 1. Shared profile cache | ~1 day | Jason's privacy call, TERMS bump |
| 7. Managed-key provider routing | ~2h | #419 live, Gemini pricing verified |

## How to check each step

- `smoke-web-research`, `smoke-work-history-research` and `smoke-work-history-sweep` each get a fake-researcher check for the new behaviour: no search on a hit, an escalation only on `unsure`, a skip for a contact whose check isn't due.
- Live check after deploy: compare step 0's searches per successful answer over the 7 days before and after, plus the Anthropic console's daily web-search line.
