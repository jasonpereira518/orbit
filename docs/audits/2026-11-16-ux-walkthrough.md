# Orbit UX walkthrough — user's-eye audit

**Date:** 2026-11-16
**Account:** jnpdude@gmail.com on production (myorbitnetwork.com), Orbit Pro, 2,544 contacts
**Method:** Clicked through the app in Chrome at desktop width (1512px) and mobile width (390px), reading each page the way a user would. Read-only: nothing was saved, sent, deleted or accepted.
**Goal:** Make Orbit easy and intuitive, and make it obvious where everything is. This file is raw findings; it is meant to be turned into an implementation plan.

Severity key: **P0** = broken or blocks a core action. **P1** = confusing enough that a new user will get stuck or distrust the app. **P2** = friction or polish.

---

## Top 10 (if you only fix ten things)

1. **P0 — Capture opens on a stale, unsaved meeting review instead of the capture form** (C-1). The primary button in the sidebar leads to a dead end.
2. **P0 — One click on the unlabeled orb starts a live voice call** (G-1). It uses the mic and the voice-minutes quota with no confirmation.
3. **P1 — The same numbers disagree across the app** (G-3). Due follow-ups 34, Reminders 67 or 68, bell and chip 92, Today 61.
4. **P1 — The reminders backlog is a wall of overdue items** (R-1). Dozens of auto-made, vague, 39-to-47-days-overdue reminders drown the real ones.
5. **P1 — Four different closeness vocabularies** (G-2). Close/Warm/Cool, Inner/Mid/Outer Orbit, a percentage, and a "Your rating" that is "Not rated yet".
6. **P1 — Three ways to talk to the AI, none explained** (G-4). Sidebar Chat, the bottom "Ask your network" bar, and the orb.
7. **P1 — Floating UI covers content** (G-5). The Ask bar and the "92 things due" chip sit on top of buttons and text, including Radar's "Turn on Radar" button.
8. **P1 — The Dashboard is too long and has no clear "do this first"** (D-1).
9. **P1 — Knowledge is mostly empty** (K-1). Nearly every one of the 300 rows says "No summary yet", and those rows are listed first.
10. **P2 — Jargon throughout** (G-6). Cosmo, Radar, Orbit tiers, "Scraper: Live", "Create feed", "Health —".

---

## Global (every page)

### G-1 (P0) The orb starts a live voice call on a single click
- The gradient orb at bottom right has no visible label (it does carry a "Talk to Cosmo" hover tooltip and screen-reader label). One click showed "Connecting…" and began a live voice session; it had to be ended with the small X. The "N things due" chip beside it is also a button that starts a call.
- A user poking at a pretty orb can start recording audio and spend voice minutes (Settings shows 17 h/month, with "Cosmo 57 min" already used).
- **Fix idea:** label it ("Talk to Cosmo"), open a small panel first with a "Start call" button, show the mic permission state, and explain that it uses voice minutes.
- *Note:* I clicked it once while testing and ended it immediately.

### G-2 (P1) Closeness is described four different ways
- Dashboard: Close / Warm / Cool buckets.
- Contacts and the dashboard cards: Inner / Mid / Outer Orbit.
- Contacts rows and the contact page: a percentage (32%, "Closeness 30%").
- Contact page: "Your rating — Not rated yet", plus a "Health —" chip.
- A new contact with zero interactions shows "Closeness 30%". Nothing says what the number means or how to change it.
- **Fix idea:** pick one vocabulary for the main UI, explain the percentage in a tooltip ("based on recency, how often you talk, goal fit"), and hide Health until it has a value.

### G-3 (P1) Counts don't reconcile
- Dashboard: Due follow-ups **34**, Reminders **67**.
- Reminders page: All **68**, Today **61** (all overdue), Upcoming **7**.
- Bell panel and floating chip: **92** things due.
- The bell panel also says "Waiting on you — **0 people ready to review**" while counting it as 1 item.
- A user cannot tell what "92" is made of or which number to trust.
- **Fix idea:** one definition of "due", used everywhere, and show the breakdown on hover or in the bell header (for example "61 reminders + 31 follow-ups").

### G-4 (P1) Three ways to ask the AI, with no explanation
- Sidebar **Chat** (a full page with history), the bottom **"Ask your network" bar** (⌘J), and the **orb** (voice).
- Not obvious that they are the same assistant, or how they differ. "Cosmo" only appears in Settings → usage ("Cosmo 57 min"), so the name means nothing to a user.
- **Fix idea:** name it once where it first appears, make the bar and orb visibly one control, and explain Chat versus the bar in a single line.

### G-5 (P1) Floating elements overlap page content
- *Caveat:* observed at first paint without scrolling. Pages already reserve bottom padding, so scrolling may clear it; the plan verifies this before fixing.
- The "Ask your network" bar covers content at the bottom of almost every page: the last card on the dashboard, the Radar "Turn on Radar" button (half hidden behind it), the first action item on Capture, the "Key facts" card on contact pages.
- The "92 things due" chip and the orb sit over the right edge. On mobile they collide with the bottom nav and cover the Reminders stat card.
- **Fix idea:** reserve bottom padding on every page so the last element can scroll clear, and collapse the bar to an icon on pages where it covers a primary action.

### G-6 (P2) Jargon and unlabeled controls
- "Scraper: Live" (Outreach), "Create feed" (Settings → Reminders in your calendar), "Calendar" button next to Remind 1d/3d/7d on contact pages, "Health —", "Re-engage" (Constellation), "Peer links / Avg links", "Strong ties", "Skipped 1 unverified" (Capture).
- Icon-only buttons on contact rows (LinkedIn, reminder, trash) show no visible labels. The trash icon sits in each row, one click from a destructive action.
- Settings has a column of unlabeled dashes on the right edge (section jump links) that read as decoration.
- **Fix idea:** plain-language copy pass, tooltips on every icon-only button, and move delete out of the row into the contact page or a menu.

### G-7 (P2) Navigation structure
- The sidebar has 10 items plus a "Special features" group (Events, Outreach). Nothing says why Events and Outreach are "special".
- **Recruiters** is not in the sidebar; it hides behind a Contacts | Recruiters toggle on /contacts.
- **Constellation** lives at `/graph`; `/constellation` is a 404. Anyone who guesses or bookmarks the label's URL lands on "Page not found".
- On mobile, the bottom nav shows Dashboard, Contacts, Capture, Chat, More. Reminders, Meetings and Radar are two taps away under More.
- **Fix idea:** add a redirect for `/constellation`, group the sidebar by purpose (Today / People / Insights), and put Reminders in the mobile bar.

### G-8 (P2) Dense and gray secondary text
- Many labels use very small light-gray text (stat captions, "Last touch 178d ago", helper text). Hard to read, and on the constellation map the star labels are nearly unreadable at the default zoom.

---

## Dashboard

### D-1 (P1) Too long, no clear first action
- The page runs through: setup card → 4 stat tiles → Network depth → Constellation preview → Suggested outreach → People to meet → Reminders → Due follow-ups → Recently updated → Goals → "Your orbit in numbers". There is no "start here".
- Reminders and Due follow-ups are two side-by-side lists of nearly the same thing (both full of "Overdue 43 days" rows), each with its own "See more (17)" and "See more (31)".
- **Fix idea:** a single ranked "Today" list at the top, and collapse the analytics below the fold.

### D-2 (P1) "People to meet" suggests celebrities
- Michael Jordan and Andy Griffith, "Notable alumni of University of North Carolina at Chapel Hill", with Save and Brief buttons. This reads as filler, not as people the user could realistically meet, and erodes trust in the other suggestions.
- **Fix idea:** only show people Orbit can tie to an actual shared event, company or goal, or hide the section until it has real candidates.

### D-3 (P2) Setup nudge wording and state
- "Finish setting up — One thing left from onboarding" with "Tell Orbit what you're going for" (goals). It is dismissible, but Goals also appears as an empty card lower down ("Add goals to surface people…"). Two prompts for the same thing.

### D-4 (P2) Suggested outreach cards are uneven
- Some cards show a company line (Meta, Amazon Web Services), others have none (Ophir Avsian). Company names are colored differently (red, orange, blue, green) with no legend.
- "Schedule 7d" here versus "Remind in 3d 7d 14d" below for the same action.
- "Capture →" in the header of this section is ambiguous (does it add a contact? open Capture?).

### D-5 (P2) Network depth charts
- "Close 7 (0%)" next to "Strong ties 117" is correct (Close + Warm) but looks wrong at a glance; 7 of 2,544 rounds to 0%.
- "Peer connections: across your closest 750" changes the denominator without saying why (2,544 above, 750 here).

---

## Capture

### C-1 (P0) /capture opens on a stale review and hides the capture inputs
- Opening Capture (sidebar button, or `/capture`) shows an old, unsaved meeting review from **Nov 12 — "Video Editing Discussion"**, with "Ready to save · 0 kept", "Start over" and "Save meeting". It is four days old.
- The page subtitle promises "Notes, a voice memo, docs from your drive, or your exports", but none of those inputs was visible on the page. The only way forward seemed to be "Start over", which implies discarding the draft (I did not click it).
- The same meeting is also listed under Meetings → Past meetings, so it looks both saved and unsaved.
- A new capture is the app's headline action; it should never land on someone's leftover draft.
- **Fix idea:** open Capture on the input form; show pending drafts as a small "Unfinished: Video Editing Discussion — Resume / Discard" card above or beside it. Auto-expire or clearly date stale drafts.

### C-2 (P1) Meeting review wording
- "No people to save from this meeting — its summary will still be saved." plus "Skipped 1 unverified. Orbit only schedules dates it can verify or resolve with confidence." is hard to parse.
- Speakers appear as "Speaker 1 / Speaker 2" with action-item owner "Speaker 2", which can't be turned into a person.
- "Ignored people · 36" is a collapsed link with no explanation of what was ignored or why.

---

## Contacts

### CT-1 (P1) Raw data quality is visible to the user
- Junk contacts appear in the list: "ScoutBook @DoNotReply", "essarr@gmail.com", "Zoom er", "CHMS PTO", "Bored Warrior", "EpicProBeast". Your own name ("Jason Pereira") is also a contact.
- Many rows say "No role yet".
- Names with maiden names in parentheses ("Briana (Simmons) Medley", "Carleigh (Twillmann) Jones", "Kailee (Zeltner) Webb") sort into a "#" group at the top, ahead of A.
- **Fix idea:** a "Likely not a person" filter or review queue (no-reply addresses, bare emails), exclude yourself, and ignore leading parentheses when sorting.

### CT-2 (P1) List controls are cryptic
- "Company", "Closeness", "Sort: Name", "Gone quiet", "School" are a mix of filters and sorts, all styled the same; "Gone quiet" and "School" don't say whether they are filters or groupings.
- The % on each row has no visible label.
- "Last touch 905d ago" is hard to read; "2 yrs ago" would be.
- Pagination is "Load more" at the bottom of a 2,544-person list plus an A–Z rail, so jumping to a letter beyond the loaded rows is unreliable (not tested; inferred from the layout).

### CT-3 (P1) The contact page is long and mostly empty for typical contacts
- Kailee Webb's page has six "Nothing yet" cards (Key facts, Shared interests, Activity, Timeline, Reminders, Opportunities), and the same fact appears three times (header, "Who they are", "How you met").
- "Where things stand" reads awkwardly: "You have not owed anything or are waiting on a response."
- Three overlapping follow-up controls: Remind (1d/3d/7d + Calendar), Keep in touch (Monthly/Quarterly/…), Draft for (Email/LinkedIn/Text).
- "Opportunities" is unexplained for a networking tool; "Find work history" is a button with no description of what it does or costs.
- Name is inconsistent inside the page ("Kailee (Zeltner) Webb" in the title, "Kailee Zeltner Webb" in the summary).
- **Fix idea:** hide empty sections behind one "Add details" row, and put one primary action ("Reach out") at the top.

### CT-4 (P2) Add contact form
- Placeholders look like real filled-in values (Jason Pereira, Amazon Web Services, "Solutions Architect Intern", Columbia University, New York). They don't match your account (UNC, Charlotte) and are easy to mistake for prefilled data.
- Bluesky and Mastodon fields sit at the same level as Company and Role. The page says "Prefer AI capture for messy notes", but Capture is currently blocked by C-1.

### CT-5 (P2) Duplicates
- "59 duplicates" is a good feature. Cards say "Same full name · Not certain" and show "0 interactions" on both sides, which gives the user little to decide with. "Merge into X" is the strongest button even when Orbit says it isn't certain.

---

## Reminders

### R-1 (P1) A wall of overdue, low-quality auto reminders
- "Today" is 61 reminders, all overdue, with an "OVERDUE 50+" header. Most are 39–47 days old, created "FROM NOTES", and many are too vague to act on: "chat", "text", "Schedule meeting", "confirm chat time", "Check in with Todd: chat".
- Duplicates for the same person: Wes Melville ×2, Mason Drabik ×2, Andrew B. Harmon ×2.
- I saw no bulk action (clear all from this note, snooze all, "this is junk"), so a user faces 60+ manual checkboxes.
- The "Today" view being a graveyard of old items makes the page feel failed on day one.
- **Fix idea:** age-out or auto-snooze notes-derived reminders older than N days, merge duplicates per person, add bulk snooze / dismiss, and have "Today" show only today's items with an "Overdue (61)" collapsed section.

### R-2 (P2) Sidebar of lists
- "Inbox 68" and "All 68" are the same number; "New list" with "+" is the only hint lists exist. "Calendar sync — Off" is a status row, not clearly clickable.

---

## Meetings

### M-1 (P1) Opens mid-review
- Same stale unsaved review as Capture (see C-1) appears first on /meetings, with "Past meetings" far below. A user who just wants to see past meetings, or start a recording, has to scroll past a leftover draft.
- Transcript quality shows through in the "Key points" (verbatim filler such as "Like, they're very, like, not, like, natural"). Key points should be paraphrased.

### M-2 (P2) Recording entry point
- The Record button wasn't visible at the top. The dashboard has Record / Join / Prep on the next calendar meeting, but Meetings doesn't make "Start recording" the obvious first action.

---

## Chat

### CH-1 (P2) Mostly good, small gaps
- The empty state suggests useful questions, but the suggestion chips are cut off on the right.
- "Context" button (top right) isn't explained.
- Chat titles like "Information about individuals" and "Expanding my network" aren't distinguishable in a long history; search exists, which helps.

---

## Radar

### RD-1 (P1) Off by default, but the page doesn't say what turning it on does
- The empty state says Radar "reads your notes, checks who's moved, and builds a short plan each week", but doesn't say what data it reads, whether it emails you, or what it costs. The "Turn on Radar" button is partly covered by the Ask bar (see G-5).
- Radar is the second item in the sidebar yet does nothing until turned on, so a new user's first look at a top-level page is an empty animation.
- *Not tested:* the turned-on state (left off on purpose to avoid changing your account).

---

## Constellation (`/graph`)

### CN-1 (P2)
- Tiny, low-contrast star labels; most stars are unlabeled until zoomed. "Clusters 8", "Re-engage" (orange, unexplained), "Key", and a two-icon view toggle top right have no visible explanation at rest.
- Settings says "Your socials: Shown when you click the sun in Constellation", so a setting depends on discovering that the sun is clickable.
- The dashboard preview says "Open full constellation", but the sidebar label is just "Constellation" and the URL is `/graph`.

---

## Knowledge

### K-1 (P1) Listed people are mostly empty
- "Recent" shows 300 people; nearly all say "No summary yet", and the empty ones come first (Anita Madani, Soumyadip Ghosh, Adam Klintworth…). The people with real summaries are scattered further down.
- The page has two panes and the right pane says "Pick someone" until you click.
- Junk and family entries appear (Mom, Dad, CHMS PTO, "Zoom er"), and the footer ("Showing your 300 most recently active people of 2544. Search reaches everyone.") is easy to miss.
- It is not clear how this page differs from Contacts. The one-line subtitle ("what Orbit knows about them") is the only hint.
- **Fix idea:** sort people who have a summary first, hide "No summary yet" rows (or offer one-click "Generate"), and say how Knowledge differs from Contacts.

---

## Events

### E-1 (P2)
- Four zero stat tiles (Events Tracked, People In Rooms, Network Added, Upcoming RSVPs) above an empty state. The one useful action ("Connect your calendar") sits in a secondary card below. "More sources: Luma, Partiful, Eventbrite" is collapsed.
- **Fix idea:** hide the stat tiles until there is data, and make "Connect your calendar" the main button.

---

## Outreach

### O-1 (P2)
- "Quota 50/50 left", "Scraper: Live", and Person / Company / Role & Location tabs are not explained (what costs a quota unit? what is the scraper?).
- Tabs "Find People", "Campaigns", "Email & Sending" mix a search, a workflow and a settings area at the same level.
- *Not tested:* running a search, building a campaign, or sending (those use quota or send real email).

---

## Recruiters

### RC-1 (P1) Permission state contradicts itself
- The page says Gmail is "Connected as jnpdude@gmail.com, without permission to read mail", while Settings → Connections says Google is "Connected as jnpdude@gmail.com". Both are true, but a user sees "connected" and still can't scan.
- "Your list is private — 0/5 logged to unlock — Need 5 recruiters (0/5)" introduces a community-sharing mechanic before the user has done anything, with a long "Shared while you share / Never shared" explainer. It is accurate, but heavy for a first view.
- The Gmail and Outlook cards are above the actual list ("My recruiters (0)").

---

## Settings

### S-1 (P2)
- A very long single page: Account, Plan and usage, About you, Goals, Target companies and schools, Socials, Appearance, Motion, Notifications (6 toggles), Email, Connections, Data and privacy, Help, Feedback.
- "AI: On · OpenAI" and "Claude and ChatGPT: Works on every plan" don't say what they mean.
- Notification rows each have a different verb (Turn on / Play / Mute / Turn off / Create feed).
- "Voice minutes 16 h 50 min left of 17 h" and "AI credits 650 left" are two separate meters with different resets and units; the difference isn't explained.
- The Plan card says "Granted to you directly — no billing attached", which will look odd to anyone who isn't the owner.

---

## Mobile (390px)

### MB-1 (P1)
- Bottom nav: Dashboard, Contacts, Capture, Chat, More. Reminders, Meetings and Radar are under More.
- The "92 things due" chip and the orb overlap the bottom nav and content (they covered the Reminders stat card).
- The A–Z rail on Contacts crowds the right edge of the list; per-row icons are dropped but the score pill and a status dot remain with no label.
- *Not tested:* contact page, Capture, Reminders and Chat on mobile.

---

## Things that worked well (keep these)
- ⌘K palette is clear: recent people, then actions (New capture, Record a voice note, Add a contact, New reminder), with key hints.
- Mobile "More" sheet is tidy and complete.
- Duplicates page explains the safety model well ("Every merge can be undone").
- Settings → Data and privacy: export and delete are clearly separated and explained.
- Chat empty state suggests concrete questions about real people in your network.

---

## Not covered (needs a second pass)
- **First-run experience.** This account is fully populated, so empty states, onboarding, the guided tour and "Quick setup" were not seen. The demo account or a fresh test user is needed for that.
- Capture inputs (blocked by C-1), recording a meeting, Radar turned on, Compose/sending email, Outreach search and campaigns, Constellation interaction (click/zoom/filters), the Terms banner flow (it did not appear on this account), billing/plans pages, Chrome extension.
- Accessibility (keyboard order, focus rings, screen reader) beyond what was visible.
- Performance: pages loaded in 3–5 s on the first hit, which looked normal, but I didn't measure.

---

## Suggested order for the implementation plan
1. **Stop the harm:** C-1 (Capture/Meetings stale draft), G-1 (orb starts a call), G-5 (overlaps hiding buttons).
2. **Make the numbers honest:** G-3 (one definition of "due"), G-2 (one closeness vocabulary).
3. **Make day one feel good:** R-1 (backlog), D-1/D-2 (dashboard first screen), CT-1 (junk contacts), K-1 (Knowledge ordering).
4. **Wayfinding:** G-4 (one assistant), G-7 (nav, `/constellation` redirect, mobile nav), G-6 (labels and tooltips).
5. **Polish:** the P2 items by page.
