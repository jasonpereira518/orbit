# Radar: proposed privacy and terms wording (PR 10 draft)

For approval before PR 10 changes `/privacy`, `/terms` and `TERMS_VERSION`. Approving it means
every user re-accepts the terms once, at their next visit. Radar itself stays "coming soon" until
you flip it in `/admin/product`; this PR only makes the documents match what the code does.

Every sentence below was checked against the code on 2026-11-12. Where a sentence needs a small
code change to be true, it is marked **[code]** and that change ships in the same PR.

---

## 1. Privacy: a new section, "Radar" (after "The recruiter scan and the shared directory")

> **Radar**
>
> Radar suggests who to reach out to and why. It is off until you turn it on, and while it is
> off it reads nothing and runs no searches. With it on:
>
> - **What it reads.** Your contacts, notes, meetings, reminders, the email insights you turned
>   on, and the goals, projects and city you give Orbit. Every suggestion shows what it rests on:
>   a quote from your own notes or messages, a record in Orbit such as a meeting or a job change,
>   or a link a web search returned. A suggestion whose proof doesn't check out is dropped.
> - **Links between people you know.** To suggest an introduction or an ask, Radar compares a
>   recent note about one person with notes about other people you have met, and sends the
>   matching passages to your AI provider to judge whether the link is real. A draft
>   introduction never quotes one person's note to the other.
> - **Web searches about people you know.** When Orbit re-checks where a contact works (see
>   *Contact work history*), Radar also asks the same search for that person's recent public
>   posts, talks and news. This happens only for people you have met, at most a set number of
>   times a month for your plan, and costs no extra search. The search sends the person's name
>   and the details Orbit uses to recognize them: LinkedIn URL, title, company, location and
>   school. Orbit keeps a result only if the search itself returned its link. It keeps it as a
>   short excerpt and that link, in your account only. Unlike work history, it is never shared
>   with other Orbit users.
> - **Web searches for opportunities.** About once a week Radar searches the web for events in
>   your city, people who could help with your goals, and programs with deadlines. The search
>   sends your city and up to five of your goals, and nothing about your contacts. To check an
>   event's date and place, Orbit's server may open the event's public page; it never opens
>   lu.ma pages. A person it finds is shown only when someone you know works or used to work where they work,
>   and stays in Radar until you choose **Save person**: nothing is added to your contacts on
>   its own. Finds you don't save are deleted 30 days after they end or expire. **[code]**
> - **Alerts.** When something on Radar's Today list won't keep, Radar can send a push
>   notification to each device where you turned push on, and an email, at most one a day. A
>   push travels through your browser's push service (Google, Apple or Mozilla, depending on the
>   browser), encrypted so that service can't read it, and never includes anyone's name.
>   Radar's emails (the Monday email and the same-day email) do name the people on your list.
>   They are sent through Resend, and each has its own one-click unsubscribe.
> - **Learning.** When you hide a suggestion and say why, Radar uses your answer to adjust
>   future suggestions for your account. It is not used for anyone else's.
>
> You can turn Radar off, and each of its emails and push, in Radar's settings at any time.
> Deleting your data or your account deletes everything Radar keeps.

## 2. Privacy: "Who else touches your data" (processor list)

- **Remove** "Bluesky and Mastodon". Orbit no longer reads them (removed in Radar PR 1).
- **Add**: *Web push services (Google, Apple, Mozilla)*, Optional: "Deliver Radar's push
  notifications to devices where you turned push on. Each receives the device's push address
  and an encrypted message it cannot read."
- **Add**: *Event websites*, Optional: "With Radar on, Orbit's server may open the public page
  of an event a search found, to check its date and place. The site sees a request from Orbit,
  with nothing about you."
- **Change** Resend's entry from "the waitlist confirmation and outreach campaigns" to "the
  waitlist confirmation, Radar's Monday and same-day emails, and outreach campaigns".

## 3. Privacy: "AI processing", one new paragraph

> With Radar on, some of its work runs in the background on your plan's monthly allowance:
> a weekly pass that picks and words your plan, the check for links between people you know,
> drafts written ahead, and the web searches described under *Radar*. Web searches run through
> your AI provider's own search, so the provider sees the text of each search. Background work
> on Orbit's accounts pauses once half a month's credits or fewer remain.

## 4. Privacy: "How long data is kept", one new line

> Radar's suggestions you acted on, hid or let expire are kept as history while your account
> exists. Finds you didn't save (events, people and programs from its web searches) are deleted
> 30 days after they end or expire. A push subscription is deleted when you turn push off or
> the push service reports it gone.

## 5. Privacy: "Cookies, local storage", one new line

> If you turn on push, Orbit stores your browser's push address and keys so it can reach that
> device. They are deleted when you turn push off.

## 6. Terms: "AI features", one new paragraph

> Radar's suggestions can be wrong, including the people and events it finds on the web: a
> person may not be who Radar thinks, and an event may move or be cancelled. Check before you
> act on one. Radar never contacts anyone for you. It suggests and drafts, and it only schedules
> reminders when you ask or turn on autopilot. You are responsible for any introduction or
> message you send.

## 7. Version

`TERMS_VERSION` `2026-11-12.2` → `2026-11-13.1` (or the date it merges), and
`scripts/legal-pages.lock.json` re-recorded.

---

## The one code change the wording needs

**Finds retention [code].** Unsaved finds are deleted 30 days after they end or expire. Today
they are only marked expired and kept forever, which matters because some of them are people
outside your network. It's one `DELETE` in the weekly web pass, where expiry is already handled.
