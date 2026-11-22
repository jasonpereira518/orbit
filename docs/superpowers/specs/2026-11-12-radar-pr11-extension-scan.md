# Radar PR 11: extension Scan and your own posts' topics (design + wording, for approval)

## 1. "Scan this page for people I know"

**Where:** in the extension panel, on your LinkedIn feed (`/feed/`) and on someone's activity
page (`/in/<slug>/recent-activity/…`), when Radar's "Save LinkedIn posts from the extension"
setting is on.

**What happens when you press Scan**, in two steps, so a stranger's post never leaves your
browser:
1. The extension reads the posts already rendered on the page, at most 25. It never scrolls,
   expands "see more" or loads more. It sends Orbit **only the authors' public profile links**.
2. Orbit answers which of those links are your contacts. It matches by LinkedIn profile only,
   through the identities table, never by name, so a namesake can't be mislabelled. Orbit
   doesn't keep the links it was sent.
3. The extension then sends **only those contacts' posts**: text up to 1,000 characters and the
   post's link. Orbit keeps them as Radar activity for that contact, the same row
   "Save post to Radar" writes, deduplicated by link. Radar shows each one as a "Posted" moment
   with the post as its proof.

The panel then says "Saved 3 posts from Priya, Sam and Lee", or "No one you know posted here".

**The adapter's rule changes in one place only:** the extractor still never reads the feed when
you open the panel. Scan is a separate, click-only mode of the same injected script.

**Server:** `POST /api/extension/signals/scan` takes the profile links and returns the matches.
`POST /api/extension/signals/scan/save` takes up to 25 posts, re-checks that every author is your
contact, and stores them. Both refuse unless the Radar setting is on.

**Not mine to verify:** I can't sign in to LinkedIn as you, so the selectors are tested against
saved HTML only. Before this reaches users you'd load the unpacked extension, press Scan on your
feed and one activity page, then upload to the Chrome Web Store and wait for review (plan steps
11 and 12).

## 2. Topics from your own posts (`Shares.csv`)

When you upload your LinkedIn export, Orbit already keeps `Shares.csv` (your own posts) but
reads nothing from it. Proposed: count the **hashtags** in your posts from the last two years,
and keep those used at least twice, up to eight, as `career_profile.postTopics`. That means
hashtags only: no AI call, and no free-text keywords, which would be noisy. Radar's weekly web
search adds them to its events and people-to-meet queries as "Topics they post about".

## 3. Privacy wording this needs (re-consent once more)

**"What Orbit collects" → "The browser extension"**, a sentence added at the end:

> With Radar&rsquo;s &ldquo;Save LinkedIn posts from the extension&rdquo; setting on, you can save
> the post you have open to Radar, or press **Scan** on your LinkedIn feed or someone&rsquo;s
> activity page. A scan reads only the posts already on your screen, at most 25. It first sends
> Orbit just the authors&rsquo; profile links; Orbit answers which of them are your contacts and
> keeps none of the links. Only those contacts&rsquo; posts (their text and link) are then sent
> and kept, as Radar activity for that contact. Posts by anyone else never leave your browser.

**"Radar" → "What it reads"**, appended to the list:

> …and the goals, projects and city you give Orbit, **the LinkedIn posts you save or scan with
> the browser extension, and, if you uploaded your LinkedIn export, the hashtags you use most in
> your own posts.**

**"Radar" → "Web searches for opportunities"**, "sends your city and up to five of your goals"
becomes:

> sends your city, up to five of your goals and up to eight of the hashtags you use most, and
> nothing about your contacts.

Then `TERMS_VERSION` and `LEGAL_LAST_UPDATED` move again, and everyone re-accepts once. If #654's
re-consent hasn't gone out widely yet, the two land close together, so most people see one notice.

## If you'd rather keep this smaller

**Scan only** needs only the first privacy sentence. The topics part, with its two Radar-section
edits, can wait or be dropped.
