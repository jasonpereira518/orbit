# Outreach + Find people: reach people you don't know yet, from your own mailbox

**Date:** 2026-10-25
**Status:** Calls made by Claude at Jason's request ("skip the questions, make the calls"). Jason reviews this doc and the plan before anything is built.
**Plan:** `docs/superpowers/plans/2026-10-25-outreach-find-people.md`
**Supersedes:** `docs/superpowers/specs/2026-09-13-outreach-campaigns-design.md` (on the stale branch `claude/outreach-redesign-campaigns-48b9fc`, PR #183) and the codex rival PR #186.

## 1. Intent

Help one person reach 10–50 people they don't know yet, with personal messages, and see who answered. The user might be a student looking for informational chats, or someone asking for referrals or advice.

A mail merge can't do what Orbit can do here:

1. **Find from a sentence.** "UNC alumni doing health-economics consulting in RTP" becomes cited candidates, each with the page that shows the match.
2. **Know who you already know.** Every candidate's company is checked against your network: "You know 2 people who worked at ZS".
3. **Write from real details.** Drafts use the candidate's cited "why they fit" and, when you ask, a researched brief. Nothing is invented.
4. **Turn replies into relationships.** Everyone you send to becomes a contact, and the send goes on their timeline.

## 2. What's on main today (Oct 25 2026)

| Piece | State | This project |
|---|---|---|
| `/find` Find people (#440) | coming-soon. Brief a named person or company. A description returns ≤10 cited candidates (`discoverPeople`). Save makes a contact. | Keep. It's the discovery engine, and gains "Add to campaign". |
| `/outreach` v1 | coming-soon, never released. Apollo search, Resend from Orbit's address, Twilio SMS, placeholder follow-up rows, outcomes logged by hand. | Replace in place. Same tables, same URLs. |
| Direct email engine (#374–#391) | Merged. Durable outbox, own Gmail/Outlook, daily recipient cap, origin hooks, reply-in-thread. | Campaign mail goes through it as origin `outreach`. |
| `warm-paths.ts` | Merged, no caller. The `listed_there` arm never matches punctuated company names. | Wire into People, fix the key. |
| Outreach v2 (#183, #186) | Six weeks stale, schema 56 vs 181. Built on Apollo + Brave, plus a browser "Runner" extension. | Close both. |

## 3. The user's path

1. **Describe** (`/outreach/new`). Fill one form:
   - Who you want to reach. This is the search, 3–300 chars.
   - Why you're reaching out. This drives every draft.
   - The ask: a short chat, a referral, advice on a question, exploring working together, or other.
   - Channel: Email or LinkedIn.
   - Tone, and an optional name.

   Submitting creates the campaign and opens it.
2. **Find** (People tab).
   - "Find people" runs `discoverPeople` on the audience text. Each candidate shows name, title, company, why they fit, a source link, and a warm-path note when you know someone there. Add or Skip each one.
   - "Find more" searches again, excluding everyone already added or skipped.
   - "Add someone" takes a name, plus a company or LinkedIn URL, and optionally an email.
   - `/find` can also add a candidate or a briefed person to a campaign.
3. **Get ready** (People tab). Each person shows what the channel still needs: an email address for Email, a LinkedIn URL for LinkedIn.
   - An address comes from a matching existing contact or from the user typing it. Never from a guess.
   - "Research" runs the person brief. It counts against the same 30/day limit as `/find`, and its talking points feed the draft.
4. **Draft** (Messages tab). "Write drafts" writes up to 10 at a time from the campaign's why, ask, tone and channel, plus each person's cited details. Every draft can be edited. A sent message is never rewritten.
5. **Send** (Messages tab).
   - **Email:** "Send selected" sends from the user's own Gmail or Outlook through the outbox. One batch is one burst; each email counts toward the daily recipient cap.
   - **LinkedIn:** "Copy & open" copies the note and opens the profile, then "I sent it" records the send.
   - On the first send the person becomes a contact (source `outreach`), and the send lands on their timeline.
6. **Track** (Messages tab, Sent view). Each person is Waiting, Replied, Follow-up due, Failed, or Unsure. Unsure means the provider timed out and the message may have sent, so it is never retried automatically.
   - Email replies are detected by looking in the user's mailbox for a message from that address since the send. This reads metadata only.
   - LinkedIn replies, and email replies when the mailbox can't be read, are marked by hand.
   - One follow-up is offered seven days after a send with no reply. It's drafted on request and sent in the same thread.
   - The campaign card shows sent, replied, and reply rate.

## 4. Decisions (Claude's calls; Jason can overturn any)

| # | Decision | Why |
|---|---|---|
| D1 | Build on main's pieces. Close #183/#186. No `generation` flag, no legacy migration. | Outreach never shipped (coming-soon since #211), so there is no user history to preserve. Two campaign models during a gate is what stalled v2. |
| D2 | Discovery uses Find people's web search only. No Apollo, no paid vendors, no email guessing. | Jason's Oct 13 call for research. A guessed address bounces from the user's own mailbox and hurts their sender reputation. Apollo stays only for contact refresh, untouched. |
| D3 | Email addresses come from an existing contact or the user. | Without a verified source, a model-cited address could be a hallucination. Known ceiling: email campaigns to strangers need typed addresses. Upgrade path: a cited public address the user confirms. |
| D4 | Campaign email goes only through the direct-email outbox, from the user's mailbox. Resend and Twilio leave Outreach. SMS is dropped. | Replies reach the user. One cap, one engine, one set of guards. `smoke-email-no-resend` becomes total. |
| D5 | LinkedIn is copy-and-open plus a manual "I sent it". No automation. | v2's Runner extension was the most expensive, riskiest part, and LinkedIn bans automation. |
| D6 | At most one follow-up, offered at 7 days, never sent without the user pressing Send. | Networking etiquette. v1's placeholder rows tripped an ops alert whenever users ignored them. |
| D7 | Reply check runs on demand: on opening the Sent view and from a button. ≤25 lookups a pass, throttled to once per 10 min per campaign. Only `replied_at` is stored. | The scopes are already granted for the recruiter scan and reply-in-thread. No new cron and no new table. |
| D8 | A prospect becomes a contact only when it's sent (or saved from `/find`). | Unsent research never touches the contact list or the contact limit. |
| D9 | Zero schema changes. New per-person facts live in `outreach_prospects.enrichment` (jsonb). New statuses are TS unions on text columns. | Avoids `SCHEMA_VERSION` collisions with the many open branches. Every table is already in purge and export. |
| D10 | Outreach stays a paid feature (`features.outreach`). Find people stays on every plan. | Unchanged from main. |
| D11 | Two pages remain: `/find` for one-off lookups, `/outreach` for campaigns. The People tab reuses `/find`'s discovery. They release together. | `/api/research` gates on `page.find`, so Outreach's Find step needs `/find` released. One release, one privacy update. |
| D12 | Reply rate counts any reply (`replied`, positive, negative or neutral) over sent minus bounced. Detected replies are `replied`; the user may refine them to positive or negative. | For networking, a reply is the win. Metadata can't tell tone. |
| D13 | ≤100 people per campaign. ≤10 drafts per click. ≤25 sends per click. | Matches "10–50 people" with headroom. Keeps each server action inside 60s. |

## 5. Non-goals

- Automatic sending of anything, follow-ups included.
- Sequences longer than one follow-up. Open or click tracking. HTML email. Attachments in campaigns.
- LinkedIn automation, InMail, SMS.
- Apollo or any paid data source in Outreach. Email-pattern guessing.
- Intro-request drafts to a warm connector. The warm path shows who you know and links to them; drafting the ask is a follow-up.
- A chat tool for campaigns.
- Migrating v1 campaign rows. Admin test campaigns, if any, keep rendering because the tables and columns are unchanged.

## 6. Invariants

1. **Tenancy.** Every read and write of `outreach_prospects` and `outreach_messages` joins `outreach_campaigns.user_id`; neither table has its own `user_id`. Every action starts with `requireOutreachUser()`: entitlement plus released surface.
2. **Untrusted text is data.** Candidate `whyMatches`, titles, companies, and brief talking points are web-derived. They enter prompts only inside `fenceUntrusted(...)` blocks.
3. **A message is sent at most once.** A send first claims the row with one conditional UPDATE (`status in ('draft','failed')` → `'queued'`). The outbox idempotency key is `outreach:<messageId>`.
4. **Sent content is immutable.** Draft generation and editing touch only `status = 'draft'` rows.
5. **Nothing is invented.** No address that the user or a contact didn't supply. No sample prospects outside explicit demo mode.
6. **Gates first.** `pageVisibilityGate("page.outreach")` is the first await in every Outreach page. Server actions use `requireOutreachUser`.

## 7. Release blockers (Jason's)

1. **Privacy copy, then a `TERMS_VERSION` + `LEGAL_LAST_UPDATED` bump** (re-consent; `smoke-legal-pages` lock). Three changes:
   - Campaigns send from your own Gmail/Outlook. Remove the Resend "outreach campaigns" line and the Twilio row.
   - Orbit checks your mailbox for replies from people you emailed in a campaign: sender and date only.
   - Describing people on Find people runs a web search on your AI provider, and results are kept 14 days. This is the copy pulled from #440.
2. **Live acceptance** on a preview with a real Gmail (not the demo account) and then an Outlook. Walk the whole path in §3, with a reply from a test address.
3. **Release.** Delete `comingSoon: true` on `page.find` and `page.outreach`, or release first through `/admin/product` live overrides.
4. **Close #183 and #186** with a link to this doc.
