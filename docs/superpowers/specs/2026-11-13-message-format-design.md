# Email vs LinkedIn: strict formats + your voice

## Context

Orbit writes outbound messages in nine places, and each one has its own prompt. They disagree on the basics:

- The LinkedIn limit is 280 characters in outreach and 300 in chat, Radar and browser-use. LinkedIn's real limit is **200 on free accounts** and 300 on Premium, so notes from most users get cut off.
- Warm follow-up emails are told "No subject line".
- Sign-offs: chat uses your full name, follow-ups use your first name, and outreach has no rule.
- Five prompts each ban "slop" in different words, and nothing strips em dashes.
- Voice comes only from your free-text writing instructions.

The goal: every draft follows one strict format per channel and sounds like you. It should read better than a typical human email without turning formal or AI-sounding.

## What you decided

| Topic | Your call |
|---|---|
| Voice | **Mirror me.** Learn from your recent sent mail (Gmail/Outlook, already connected) and keep a short, editable style profile. |
| Voice before any sent mail | **Warm professional.** Friendly, polite, a little context, no fluff. |
| Hard bans (removed in code) | **Em dashes**, **flattery and hype words**, **exclamation marks**. |
| Soft rules (prompt only) | Stock openers ("I hope this finds you well", "I wanted to reach out") and filler asks ("just checking in", "pick your brain") are discouraged, not stripped. |
| First sentence of a cold message | **Who I am.** |
| Email sign-off | **Full name:** `Best,\nJason Pereira`. |
| Email ask | **Offer times:** "Would Tue or Thu afternoon work for 20 minutes?" |
| LinkedIn connection note | **Light ask** at the end. |
| Sequence follow-ups | **Same thread:** `Re: <subject>`, 2–4 sentences, one new reason. The last step offers an easy out. |
| Outreach tone picker | **Kept as a nudge** that shifts your voice for one campaign. |

## The formats

Each channel's format lives in one place, `src/lib/message-format.ts`, and every generator imports it.

**Email, cold** (outreach, recruiter, chat to someone with no history)
1. Subject: 3–7 words, specific, in sentence case. Never "Following up", "Quick question" or "Hello".
2. `Hi {First},`
3. Who I am, in one sentence, tied to why it matters to *them*.
4. Why them plus what I want: one short paragraph with one concrete detail about them.
5. The ask, offering two time windows (taken from the calendar, see PR 3).
6. `Best,` or `Thanks,` (Thanks when asking for something), then the full name on its own line.
- Length: 60–120 words. At most 3 short paragraphs. No links unless the user gave one.

**Email, warm** (follow-ups, Compose, reminders, Radar)
- Same shell, with a subject. That fixes today's "No subject line".
- *My call:* skip the who-I-am line, because they know you. Open with the shared context ("Good seeing you at…").
- Length: 40–90 words. The ask still offers times when it asks for a meeting.

**Email, sequence follow-up**
- Subject `Re: <original>`, sent in the same thread. 2–4 sentences, one new reason, no recap of email 1, same sign-off.
- The last step closes with an easy out ("If now's not the time, no worries").

**LinkedIn connection note**
- 200 characters at most, one hard limit for everyone. No subject, greeting name optional, no sign-off.
- Who I am, then why connecting, then a light question.

**LinkedIn DM** (already connected)
- 2–4 short lines with no subject or sign-off, ending in one question. Up to 600 characters.
- *My call:* skip who-I-am when there's history.

**Applies to every channel**
- Hard bans are enforced in code (below), not just asked for in the prompt.
- Soft rules and the tone nudge go in the prompt only.
- Your voice profile and writing instructions shape word choice and rhythm. They never override the format, the length or the bans.

### Example (fallback voice, cold email)

```
Subject: Your recruiter-pipeline talk at Collision

Hi Priya,

I'm Jason, a founder building Orbit, a networking tool for students and early-career folks. Your
point on the panel about ATS mail being the real hiring signal is close to what we found in our
own data.

I'd like to show you what we saw and hear where you think it breaks. Would Tuesday or Thursday
afternoon next week work for 20 minutes?

Thanks,
Jason Pereira
```

LinkedIn note, 186 characters:
`Hi Priya, I'm Jason, building Orbit (networking for early-career folks). Your Collision point on ATS mail matched our data. Open to swapping notes sometime?`

## Approaches considered

1. **A shared format module that every generator imports (picked).** Each prompt keeps its job-specific context but takes its channel rules, voice block and ban list from one place, and one scrub function runs on every output. This is the smallest change that makes the nine places agree, and the existing goldens snapshot test catches drift.
2. **Post-processing only.** Leave the prompts alone and clean up the output. Rejected: it can't add a subject, change the opener or offer times.
3. **One unified draft generator that replaces all nine.** Rejected for now: it's a big rewrite with no eval to catch regressions. Approach 1 gets most of the consistency.

## Build: 3 PRs

### PR 1: Format module and hard bans

**New file `src/lib/message-format.ts`.** It's pure, with no DB.
- `type MessageKind = "email_cold" | "email_warm" | "email_followup" | "linkedin_note" | "linkedin_dm" | "sms"`
- `formatRules(kind, { senderFullName, isLastStep? })` returns the prompt lines above.
- `FALLBACK_VOICE` holds the warm-professional description. It is used only when no style profile exists.
- `softRules` holds the discouraged openers and filler asks as prompt text.
- `toneNudge(tone)`: "Shift the user's voice slightly toward {tone}."
- `scrubDraft(text, kind)` is deterministic:
  - Em and en dashes become a comma or a period, depending on context.
  - `!` becomes `.`.
  - Characters past the kind's hard limit are trimmed at a word boundary.
  - It returns `{ text, hypeHits }`.
- `HYPE_WORDS`: amazing, incredible, thrilled, passionate, game-changer, "really impressed", "huge fan", and similar.
  - When `hypeHits` is non-empty, the generator regenerates once with a "remove: …" note. If the second draft still has hits, it keeps it and `outreach-quality` flags it.
- `LINKEDIN_NOTE_MAX = 200` lives here.
  - `src/lib/chat-draft-block.ts` (300) and `sanitizeLinkedInNote` in `src/lib/browser-use.ts` (297) import it instead of their own numbers.

**Wire into the generators.** Each one replaces its own channel, length, sign-off and slop lines with `formatRules` and runs `scrubDraft` on the output.
- `src/lib/outreach-drafts.ts`: `channelRules()` goes away. Sequence steps 2 and later use `email_followup`. The tone picker becomes `toneNudge`.
- `src/lib/follow-up-drafts.ts` (`draftFromContext`): email gets `email_warm` *with a subject*. The schema becomes `{ purpose, subject?, body }`, and the callers (`actions/contacts.ts`, `actions/reminders.ts`, `actions/email-compose.ts`, `lib/radar/drafts.ts`) use the subject where they have a subject field. Sign-off switches to the full name.
- `src/lib/recruiter-drafts.ts`: `email_cold`.
- `src/lib/ai.ts`, `CHAT_STREAM_TAIL` and the draft_message rule near L2648: the format lines come from the module. The chat draft-block parser's scrub happens where blocks are parsed.
- `src/lib/chat-refine.ts`: scrub output. The "formal" rewrite keeps its no-contractions rule.
- `draft_email` tool (`src/lib/tools/chat-writes-features.ts`), conversation starters (`src/lib/conversation-starters.ts`) and Radar openers: these get `scrubDraft` only. They are one-liners or free-form, so no format is enforced.

Reuse what exists: `withWritingPreferences` / `renderWritingPreferences` (`src/lib/writing-instructions.ts`), `senderProfileBlock` (`src/lib/sender-profile.ts`), `guardDraftOutput` (`src/lib/draft-output.ts`), `scrubPlaceholders`, and `assessOutreachQuality` (`src/lib/outreach-quality.ts`, which gains the hype-word flag).

**Tests**
- `scripts/smoke-message-format.ts` asserts scrub behaviour: dashes, `!`, the 200-character cut at a word boundary, and hype hits.
- `scripts/smoke-draft-prompts.ts` goldens are regenerated, with the diff reviewed by hand.
- Each new smoke is registered in `scripts/run-smoke.ts`.

### PR 2: Style profile learned from sent mail ("Mirror me")

**New file `src/lib/writing-style-profile.ts`.** The name is chosen so it doesn't clash with Cosmo's `src/lib/voice`.
1. Fetch about 20 recent sent messages:
   - Gmail: an `in:sent` search, via the existing helper in `src/lib/gmail.ts` near L710.
   - Outlook: Sent Items, via `src/lib/email/providers/outlook.ts` near L157.
2. Strip quoted replies, signatures and forwarded blocks. Skip messages under 25 words.
3. One cheap model call distills a profile of at most 800 characters: sentence length, greeting and sign-off habits, contractions, words used and never used, formality. **No names, no content, no facts.** Only the profile is stored. The raw mail is never kept.
4. Store it in `user_settings.writing_style_profile` plus `..._updated_at`. This is a new column, so it needs DDL plus a schema bump to the next free version (check `origin/main` first; collisions have happened).

**Feeding the drafts:** the profile goes into the same `renderWritingPreferences` block, below your explicit instructions, which win on conflict. With no profile, `FALLBACK_VOICE` is used.

**When it builds:** lazily on the first draft if the profile is missing and a mailbox is connected, and only after that draft returns. There's also a "Refresh from my sent mail" button. It has no cron job.

**UI:** next to `components/chat/writing-instructions-field.tsx`, a read-only "How Orbit thinks you write" card with Edit, Refresh and Clear. Edit turns it into the user's own text.

**Legal and cost:**
- Add a line to /privacy on reading sent mail to learn writing style, and bump TERMS per the repo's usual pattern.
- The model call goes through `ai-access.ts`, which is the only path to a provider key.

**Test:** `scripts/smoke-writing-style-profile.ts` checks the stripping on fixture emails and that empty input gives no profile (so the prompt bytes stay identical).

### PR 3: Offer times from the calendar, and same-thread follow-ups

**Offer times**
- New `freeWindows(userId, now)` in `src/lib/calendar-events.ts`. It reads the existing `calendar_events` mirror and returns two weekday windows in the next 2–8 business days, 30+ minutes, inside 10:00–17:00 local time.
- Drafts get "Offer these windows: …" in the prompt.
- With no calendar connected, the prompt says to offer "two windows early next week" with no specific times. The model never invents a date.

**Same thread**
- Outreach sends go through Resend (`src/lib/outreach-send.ts`), not your mailbox.
- Step 1 sets its own `Message-ID` header and stores it on the send row.
- Steps 2 and later send `Subject: Re: <step-1 subject>` with `In-Reply-To` and `References` pointing to that ID.
- **This needs checking:** confirm that Resend passes a custom `Message-ID` through, and that Gmail threads the reply. If Resend won't, fall back to `Re:` plus `References` only.

**Test:** add `freeWindows` cases (busy day, weekend, time zone) to an existing calendar smoke, plus a payload test that step 2 carries the headers.

## Not doing (yet)

- **SMS:** it keeps its current 160-character rule and just runs `scrubDraft`.
- **Learning voice from LinkedIn messages:** Orbit has no way to read them.
- **Double signature in Compose:** the model's `Best, Jason Pereira` plus the mailbox signature added after `-- ` is normal email practice. If it reads badly in the app, the model sign-off gets dropped when a signature is set.

## Verification

1. Run `npx tsc --noEmit`, `npm run lint`, and the new and regenerated smokes (`smoke-message-format`, `smoke-draft-prompts`, `smoke-writing-instructions`, `smoke-writing-style-profile`, `smoke-outreach-guards`, `smoke-compose-draft`).
2. **Real-model format eval:** a new `scripts/eval-draft-format.ts` drafts about 10 fixture cases per kind through the real generators. It checks the hard rules on actual output:
   - subject present and 3–7 words
   - no em dash or `!`
   - LinkedIn note at most 200 characters
   - email ends with the full name
   - cold opener mentions the sender
   - word counts in range
   - no hype hits after the retry

   The target is 100% on the hard rules. The output gets printed so you can read samples for tone.
3. **In the app (preview):**
   - Draft a cold outreach email, a LinkedIn note and a contact follow-up.
   - Use the chat to "draft an email to X" and "draft a LinkedIn note to X".
   - Check the format, the 200-character gate and the sign-off.
4. PR 2: connect a mailbox, generate the profile, and confirm it contains no names or content, and that drafts change rhythm with it while keeping the format.
5. PR 3: send a 2-step test sequence to your own Gmail and confirm step 2 lands in the same thread.
