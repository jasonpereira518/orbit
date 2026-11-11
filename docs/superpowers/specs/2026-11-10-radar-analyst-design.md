# Radar revision: your network's analyst

## Context

Radar is meant to be Orbit's flagship: the thing that tells you who to reach out to and why. It has been built four times and has not held up.

| Revision | When | What it was | Why it fell short |
|---|---|---|---|
| 1. Recommendation engine | Sep 27-29 | A scorer over in-app signals with a one-line AI reason | Any signal could create a card; reasons were generic |
| 2. Flagship | Sep 29 - Oct 1 | Added rerank, learning, drafts, autopilot, news feeds, Bluesky/Mastodon, Monday email. Released Sep 30, pulled back Oct 1 (#387) | Wrong people, 12 cards, cost, unfinished UX |
| 3. "Your Week" | Oct 25 | Approved rethink: frozen weekly plan, only people who matter, "no hook, no card" | Only its first phase was built, on a branch never pushed |
| 4. #611 | Nov 10 | Daily 5am run, "active projects", arXiv/GitHub discovery, calendar invites | No spec; inserts strangers into contacts; ignores revision 3 |

You said all four problems still apply: picks feel generic, Radar is blind to the outside world, it does not use your notes, and it does not reach you. This plan designs the ideal Radar first and reuses old code only where it fits. `page.radar` is still "coming soon", so nothing here is visible to users until the launch step.

**Two live defects found while planning (fixed first, in PR 0):**
- #611's discovery inserts arXiv authors and GitHub usernames into `contacts` (`src/lib/radar/signals/discovery.ts:179`). The hourly cron runs it for paid accounts that opened Radar on its one live day, even while Radar is coming soon.
- The Events page's Recommended tab (live on every plan) shows six invented events with made-up links (`src/lib/events/recommendations.ts:115`).

## What Radar is

**Radar is your network's analyst.** It reads what you have told Orbit and what it can confirm on the open web, and gives you a short list of *moves*. Every move has four parts:

1. **Who or what**: a person you know, or an opportunity.
2. **Why now**: one specific sentence.
3. **Proof**: a quote from your own notes or messages, a link you can open, or an Orbit record (a meeting, a job move).
4. **One action**: draft, introduce, schedule, save, add to calendar.

### Three lanes

| Lane | What it finds | Proof |
|---|---|---|
| **Follow up** | People you have met where something is open: they asked you something, you owe them something, you met two weeks ago, your keep-in-touch rhythm is due, they changed jobs or posted something | Your notes, messages and reminders; the web check on that person |
| **Connect** | Links between your notes and your people. *Intro*: Priya is hiring a designer, Sam is looking. *Ask*: a goal or project matches someone you have not asked. *Share*: something relevant to a person | Two quotes from your own notes, one per side |
| **Opportunities** | Events near you, new people to meet (only with someone who can introduce you), openings where you know someone, programs and deadlines | A link the search actually returned, opened and checked where the site allows |

### Six rules

1. **No proof, no card.** Code, not the AI, checks that each quote really appears in the cited note and each link was really returned by the search. Unproven cards are dropped.
2. **The web is asked, not followed.** Radar asks specific questions about your closest people and your goals, on a budget. No news feeds.
3. **Nothing enters your contacts without you.** New people and events stay in Radar until you save them.
4. **Small and stable.** A weekly plan that is never padded, plus a "Today" strip for things that expire.
5. **It reaches you.** Dashboard briefing, bell, Monday email, a same-day email when something expires, and push notifications.
6. **It learns.** Dismissing asks why (wrong person, wrong reason, already handled, not now), and that changes future picks.

### Rhythm

- **Monday about 5am your time:** the week's plan is built, then frozen. People do not vanish mid-week.
- **Every morning:** a light pass with no AI may add a Today item (a reply you owe, an event tomorrow, a job move spotted) and clears cards you have already handled. Only Today items may alert you, at most two alerts a day, once per card.

### The outside world

- **People check.** One web search per person, rotating monthly through your closest people: current role, recent public posts, talks, articles, company news. It widens the job-change re-check Orbit already runs, so it costs no extra searches, and results for a public profile are shared across accounts the way work history already is.
- **LinkedIn posts, honestly.** LinkedIn gives apps no way to read other people's posts (that permission is closed; checked Nov 10). Posts arrive three ways: the people check (only what search engines index, so partial), a new extension button "Scan this page for people I know" that you click on your feed or someone's activity page, and the existing "Save post" button. No passive reading and no paid data vendors.
- **Events near you.** A search by your city and goals. An event becomes a card only if its link was returned by the search and its date is in the future; where the site allows, Orbit also opens the page and reads the date and place from it. Shown with who you know there. This replaces the invented events on the Events page.
- **People to meet.** People outside your network who fit a goal or project, shown only when someone you know can introduce you.
- **Openings.** Roles from the job feed Orbit already keeps, at your target companies or where a contact works, paired with the person to ask. (Known limit: that feed is mostly internships and new-grad roles.)
- **Programs and deadlines.** Fellowships, competitions and speaking calls that match a goal, with the deadline.

### Who gets what, per month

| | Free | Pro | Max |
|---|---|---|---|
| People in the weekly plan | 3 | 7 | 10 |
| Today strip, at most | 2 | 3 | 3 |
| Connect cards a week | 1 | 2 | 3 |
| People checks (web) | 2 | 20 | 48 |
| Event searches | 1 | 4 | 8 |
| People-to-meet searches | 0 | 4 | 4 |
| Program searches | 0 | 2 | 4 |
| Overnight drafts a week | 0 (on demand) | 3 | 5 |
| Estimated cost on Orbit's key | about $0.10 | about $0.77 | about $1.53 |

Accounts on their own AI key cost Orbit nothing. All tiers fit the existing caps (300 searches per account per month, half of that for background work). The Orbit-wide cap of 306 searches a day covers roughly 300 Free, 100 Pro and 20 Max accounts alongside every other search feature; past that it needs raising.

### Removed and kept

- **Removed:** arXiv/GitHub discovery; the HN/TechCrunch/Verge/Ars news sweep and Bluesky/Mastodon polling (your Oct 25 call; the people check replaces them); the invented events catalogue; #609's separate "Smart Opportunities" card (Connect does that job).
- **Kept:** the learned model; rerank and why-lines, merged into one "editor" step; drafts; autopilot; Schedule; focus mode; What-changed; the bell row; the Monday email; the dashboard briefing. From #611: active projects (shown and editable, prompt made safe) and the calendar invite (prepared only when you click, with a neutral agenda and your time zone).

## Decisions

**Yours (Nov 10):** design the ideal first · weekly plan plus daily Today moments · LinkedIn via web search plus extension on click · all four opportunity types · every plan gets the web side, with a small Free taste · fold #609's Smart Opportunities into Radar · Monday email, same-day email and push notifications.

**Still standing from Oct 25:** cut news feeds and Bluesky/Mastodon · only people who matter can be candidates · weak ties need a real hook · keep the flagship extras · measure, then release.

**Reversed from Oct 25, by your answers:** "no mid-week additions" (Today strip) and "Free spends no background AI" (Free taste).

**My calls, veto any:**
1. Plan sizes Free 3 / Pro 7 / Max 10 (#611 had 3/10/25).
2. Lifetime gets Pro's Radar limits; its credit allowance cannot carry Max's web budget.
3. The per-plan people-check cap applies to searches Orbit pays for; own-key accounts keep today's pacing, so nobody loses the job-change checks they have now.
4. A new person is shown only with an introducer. Fewer results, far better ones.
5. Luma events are proven by the search's own citation, not by opening the page, because Orbit deliberately never fetches lu.ma.
6. While Radar is coming soon, the scheduled run serves admin accounts only, so you can test the real schedule without anyone else's account spending.
7. #609's goal-progress fields ride with its reminders half.
8. Web push uses the standard `web-push` package (the one new dependency).

## How it works

| Step | What it does | Built on |
|---|---|---|
| Candidate gate | Only people who matter and whom you have met can get a Follow up or Connect card | `loadCandidates` (`src/lib/radar/signals/internal.ts:264`), `src/lib/met-contact.ts` |
| Inside read | Hooks from your own data | `produceInternalSignals` (same file) plus `relationship_digests.open_threads`, `action_items.owed_by`, last real encounter |
| Connect | For each new note, find other people it bears on; an AI judge returns a type and one quote per side | `searchMemories` (`src/lib/memory-search.ts:172`) with a new exclude option, stored chunk embeddings, new `src/lib/radar/connect.ts` |
| People check | One search per person per month | Widen `checkCurrentRoleWithWebSearch` (`src/lib/work-history-research.ts:189`); share via `public_work_history`; `recordJobChanges`; `storePosts` (`src/lib/radar/signals/activity.ts:44`) |
| Opportunity search | Events, people, programs, on a separate scheduled route | `webSearchJson` (`src/lib/ai.ts:2757`), `fetchEventPage` (`src/lib/events/fetch-page.ts:97`), `discoverPeople` (`src/lib/web-research.ts:955`), `findWarmPaths`, `job_posting_matches` |
| Proof check | Drops any card whose proof fails | New pure `src/lib/radar/verify.ts`, `containsVerbatim` (`src/lib/verbatim.ts:34`) |
| Editor | One AI call picks and words the final plan; the scorer is the fallback | Merges `rerank.ts` and `explain.ts`; `rankPicks` and `model.ts` stay |
| Deliver | Page, briefing, bell, emails, push | Existing surfaces; Resend path in `src/lib/radar/digest.ts`; `/orbit-sw.js` |
| Learn | Dismiss reasons feed the model | `recommendation_feedback.reason` (exists, unused), `src/lib/radar/model.ts` |

**Schema: one bump (v220, or the next free number at merge).** New table `radar_opportunities` (user, kind, title, url, why, starts_at, expires_at, evidence, related_contact_ids, score, status, dismiss_reason, dedupe_key); new table `push_subscriptions`; `user_settings.radar_web_next_at` and `radar_moment_last_day`. Everything else needs none: proof fields live in the existing `evidence` json, new card kinds are plain text, weekly versus daily is a new `radar_runs.trigger` value, and your city is the existing `career_profile.profile.location`, made editable.

## Build sequence

Each PR leaves main releasable and Radar dark until PR 10. After approval, this document is committed as `docs/superpowers/specs/2026-11-10-radar-analyst-design.md`, and each PR gets its own task-level plan, tests first.

| PR | Goal | Main changes | Check |
|---|---|---|---|
| **0 Hotfix (tonight)** | Stop the harm | Delete the discovery call (`src/lib/radar/run.ts:407-419`) and `signals/discovery.ts`; run and news-sweep routes stand down while coming soon; fence the projects prompt (`src/lib/projects/extract.ts`); Recommended events returns nothing (`src/actions/events.ts:966`); a list-first script for the stranger contacts | `smoke-radar-run` asserts the contact count is unchanged |
| **1 Removal** | Cut the noise | `src/lib/radar/feeds/*`, `signals/news.ts`, `signals/social.ts`, their scorer branches, the Bluesky/Mastodon candidate clause, the news cron step | Radar smokes; What-changed and metrics no longer read removed codes |
| **2 Schema and types** | Foundations | The schema above; kinds `introduce`, `ask`, `share`; lane map; new `RadarPlanLimits` fields (`src/lib/plans/plan-config.ts:332`); purge list | `npm run db:check`, `smoke-purge`, `smoke-plan-rules` |
| **3 Proof and Follow up** | No proof, no card | `verify.ts`; evidence tied to its reason (`src/lib/radar/score.ts:346,709`); new hooks; tighter dormancy; candidate gate | New `smoke-radar-verify`; extended `smoke-radar-score` |
| **4 Weekly and Today** | The rhythm | Weekly/daily mode in `writeRunResult` (`src/lib/radar/store.ts:184`); claim and `finishRun`; page-open refresh forced to daily; model fix; time zone saved from any page | New `smoke-radar-lifecycle`: Monday build, six daily passes, plan unchanged |
| **5 Editor** | Sharper picks, real reasons | New `editor.ts`; drafts and project extraction weekly and plan-gated | New eval `radar-editor` in `scripts/lib/eval-ai-tasks.ts` |
| **6 Connect** | Notes to people | `connect.ts`; `searchMemories` exclude option; operation `radar.connect`; fixed draft intents so a message to B never quotes A's note | New eval `radar-connect`; smoke with an injected judge |
| **7 People check** | LinkedIn, posts, job moves | Widened checker keeps its sources; per-plan cap; signals only for met contacts; gated on Radar being released | Extended work-history sweep smoke |
| **8 Opportunities** | Events, people, openings, programs | `src/lib/radar/opportunities/*`; `/api/radar/web` route reusing the 300s limit and the freed cron slot; Events tab reads the table; city field; background-share check moved into `src/lib/web-search-budget.ts` | Smoke with injected search and fetch |
| **9a Page** | What you see | Today strip, lanes, proof chips, Opportunities, dismiss reasons, cold-start guidance, chat tools | Playwright check in demo mode, desktop and 375px |
| **9b Reach** | It comes to you | Bell marks Today items due; same-day email via Resend; web push | Smokes for the daily cap and once-per-card rule |
| **10 Legal and launch** | Release | Privacy and terms edits, `TERMS_VERSION`, `scripts/legal-pages.lock.json`, then the flip | `smoke-legal-pages`; two-week dogfood bar met |
| **11 Extension** | Better LinkedIn coverage | "Scan this page" (lifts the adapter's feed refusal for clicks only, `extension/src/inject/adapters/linkedin.ts:323`); batch endpoint; read your own Shares.csv for topics | Adapter smoke; your real-LinkedIn check |
| **12 Cleanup** | Drop dead tables | `external_sources`, `external_items`, `external_item_companies`, `recommendations.discovered_person`, `radar_discovery_enabled` | `npm run db:check` |

**Side task:** a reminders-only PR cut from #609 (schema renumbered above 220), so #609 can be closed.

## Your manual steps

**Tonight**
1. Hide Radar in `/admin/product`. That stands the cron down and stops strangers being added until PR 0 merges.
2. Review and merge PR 0.
3. Run the cleanup script in list mode, read the names it found in production, and approve the delete.

**This week**
4. **Set up QStash (#457).** GitHub fires only about 10% of scheduled runs, so "Monday 5am" and same-day emails would arrive at random hours without it. Vercel Marketplace → Upstash → QStash, Pay as You Go (about $0.30 a month); add `QSTASH_TOKEN` and `QSTASH_URL` to `.env.local`; run `npx tsx scripts/qstash-schedules.ts --dry-run`, then for real; merge #457 once I rebase it.
5. Approve the reminders-only PR, then close #609.
6. Put a paid Gemini key in `.env.local` as `ORBIT_EVAL_GEMINI_KEY` and raise that project's spend cap. The free key allows 20 requests a day, and the editor and Connect prompts cannot be tested without it.
7. Approve mockups of the Radar page, the briefing and both emails before PR 9a.

**During the build**
8. Review and merge each PR in order. Radar takes schema v220; the open PRs with older numbers (#553, #556, #579, #584) renumber above it.
9. Before PR 9b: run `npx web-push generate-vapid-keys` and add `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` to Vercel (production and preview) and `.env.local`. On iPhone, push only works after Orbit is added to the Home Screen.
10. Dogfood for two weeks from PR 4 on: set your city in Settings → Profile, confirm your goals and projects, open Radar daily, and give a reason whenever you dismiss.
11. Before PR 11 ships: load the extension on real LinkedIn and click Scan on your feed and on one person's activity page (I cannot sign in as you), then upload to the Chrome Web Store and wait for review.

**Launch**
12. Read and approve the privacy and terms wording. Approving it makes every user re-accept the terms once.
13. Check the Anthropic balance and decide whether to raise the Orbit-wide search cap. The web-search pause switch on `/admin/billing` is the kill switch.
14. Flip Radar live in `/admin/product`.
15. A week after launch, approve PR 12. Dropping tables cannot be undone.

## Verification

- **Every PR:** `tsc --noEmit`, eslint with 0 errors, `npm run db:check` when the schema moves, the Radar smokes named above, then the full suite through `scripts/run-smoke.ts` (new smokes registered in its MANIFEST).
- **AI steps:** the `radar-editor` and `radar-connect` evals must pass the `scripts/eval-ai.ts` gate before their prompts ship. Fixtures include adversarial cases: a quote that is not in the note, a namesake, an event in the past.
- **In the browser:** demo-mode preview driven by Playwright with system Chrome, because a hidden pane never hydrates. Desktop and 375px; light and dark.
- **Release bar after two weeks of your own use:** no card with false proof; you act on at least half of each weekly plan; the proof-check drop rate and cost per account on `/admin/growth/radar` match the estimates above.

## Risks

| Risk | How the plan contains it |
|---|---|
| The proof check empties the list, or passes invented proof | One pure checker; quotes are copied from rows by code, not by the AI; adversarial smoke; drop-rate metric |
| Web spend starves searches people click for | Monthly per-plan buckets; background-share check moved into the shared budget; runs spread across the week; inactive accounts skipped; pause switch |
| A lifecycle bug reshuffles or wipes the week | One mode switch in one write function; page-open refreshes forced to daily; the lifecycle smoke |
| Wrong person, or one contact's private note leaking to another | People checks need a confident match on the LinkedIn profile; links must be cited by the search; intro drafts use fixed wording; all outside text is fenced in prompts |
| Scheduler unreliability and deploy limits | QStash before launch; no new function-duration value (the deploy is at its 12-function cap); one schema bump; legal changes batched into launch |
