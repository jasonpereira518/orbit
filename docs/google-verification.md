# Google OAuth verification: submission package

Project `orbit-507100` ("Orbit"), one client ("Orbit Web"), External, **In production**.
Console state read Nov 12 2026. Console: <https://console.cloud.google.com/auth/overview?project=orbit-507100>

## Where it stands

A submission has been in review since Sep 27–28. Google's four checks passed: homepage, privacy policy, branding, minimum scopes. **One check failed, App functionality**, with two findings:

1. The demo video does not show the OAuth consent flow.
2. The demo video does not sufficiently demonstrate the functionality of the app.

Google's progress panel says to reply to the email thread with its Trust and Safety team once the issues are fixed. That thread is the channel, not the console. The audience page shows 3 of 100 users used, so any unverified scope still shows the warning screen and counts against the cap.

## Gap: declared scopes vs scopes the code requests

Data Access declares only `drive.file` and `calendar.readonly`. `src/lib/google-scopes.ts` can request five more. The default Connect (`GOOGLE_CONNECT_PURPOSES`) asks for `contacts.readonly`, which is **not declared**.

| Scope | Tier | Declared | Feature (askedWhen, from `GOOGLE_SCOPE_DISCLOSURES`) |
|---|---|---|---|
| `openid`, `userinfo.email` | none | n/a | every connection |
| `drive.file` | non-sensitive | yes | Imports → Google Drive (Picker) |
| `calendar.readonly` | sensitive | yes | Events → Connect Google Calendar |
| `contacts.readonly` | sensitive | **no** | Imports → Google Contacts |
| `calendar.events` | sensitive | **no** | Chat → "Add to calendar" on a meeting |
| `gmail.send` | sensitive | **no** | Compose, Settings → Email, recruiter composer, Chat drafts |
| `gmail.readonly` | **restricted** | **no** | Recruiters scan, Events confirmation emails, Settings → Email insights |
| `drive.readonly` | **restricted** | **no** | Capture → Drive & OneDrive (Cloud notes) |

Decision (Jason, Nov 12): submit all of them. Restricted scopes need CASA. Adding them to the in-flight review can hold the sensitive scopes behind CASA. If speed matters, the alternative is to fix the video, get calendar and contacts approved, then add the restricted scopes as a second submission.

## Console justification (Data Access, 1000-character limit, one field for all scopes)

```
Orbit is a personal networking CRM. Each scope is requested only when the user turns that feature on. calendar.readonly: reads events (title, time, location, description, attendee emails; past 90 days, next 60) from the calendars the user selects, matches attendees to their contacts, shows meetings on contact timelines and suggests follow-ups. calendar.events: adds a meeting the user sets up in Chat to their calendar; Undo removes it; no other event is changed. contacts.readonly: user picks contacts to import. gmail.send: sends emails the user writes and sends. gmail.readonly: opt-in recruiter scan, event-confirmation detection, Email insights and reply threading; bodies are not stored. drive.readonly: lists recent Docs to find meeting notes. drive.file: Picker import. Data stays in the user's account and is never sold, shared, or used for ads or model training. Disconnect anytime in Settings → Integrations. Follows the Google API Services User Data Policy, including Limited Use.
```

Check the length before pasting. It must be 1000 characters or fewer.

## Demo video (the actual blocker)

Google's two findings map to these rules. One YouTube link (unlisted is fine), English or subtitled, screen recording with narration.

1. **Consent flow first.** Start with no Google connection. Click Connect. Show the browser address bar so the **client ID** (`368910954513-87cn…`, Orbit Web, the only client) is visible. Show the unverified-app screen if it appears; Google says it is expected and must be shown. Show the full list of requested scopes, tick them, and continue.
2. **Then each scope in use**, one short clip each, on the real UI:
   1. Contacts: Imports → Google Contacts, pick people, import.
   2. Calendar read: Events → connect calendar, meetings appear on a contact's timeline and in prep.
   3. Calendar write: Chat → "Add to calendar" on a meeting, event appears in Google Calendar, Undo removes it.
   4. Gmail send: Compose on a contact, Send, show the 10-second undo, show it in Gmail Sent.
   5. Gmail read: recruiter scan, event confirmations on Events, Email insights toggle in Settings.
   6. Drive picker: Imports → Google Drive.
   7. Drive read: Capture → Drive & OneDrive, recent Docs listed, extract one.
3. Say what is stored and what is not (message bodies are not stored) as each clip plays.

**Traps for the recording:**
- Several surfaces ship `comingSoon` in `src/lib/surfaces.ts` (Compose, reply-to-inbox, Cloud notes, Radar). They must be reachable in the account you record. Use an admin account with the preview cookie, or flip them on first. Google's reviewers will also look for these features in the live app, so a scope with no reachable feature gets rejected.
- Do not record on prod with unverified scopes while traffic is live. The console itself warns about the user cap. Record on a preview deployment using the same client, or a test account.
- Use a throwaway Google account with realistic contacts, mail and calendar. Keep personal mail out of frame.

## Recording prep: how to reach the coming-soon surfaces

**Use production, signed in as an admin, with the preview cookie.** No flag change, no deploy.

- `/admin` → "Preview unreleased pages" (`surface-toggles.tsx`, `setPreviewUnreleasedAction`) sets `orbit_preview_unreleased=1` on that browser only. With it on, `resolveSurfaceVisibility` skips the whole coming-soon block, so **pages and features** both open: Radar, Compose, reply-to-inbox, Cloud notes. Admins are also exempt from plan gates.
- Do **not** use the demo workspace: it shows unreleased pages but keeps unreleased *features* hidden.
- Do **not** flip `live:<key>` in `/admin/product`. That releases the surface to every user.
- Localhost would also unlock everything, but its `.env.local` points at the shared Neon DB and has no Google client, and the video should show the production client ID anyway.

**Found Nov 12, prod env (Vercel project `orbit`, production target), names only:**

| Variable | Needed for | In prod? |
|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_REDIRECT_URI` | every connect | yes |
| `GOOGLE_CLIENT_SECRET` | token exchange (`env.ts` requires it in prod) | yes (confirmed via the Vercel API) |
| `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY`, `NEXT_PUBLIC_GOOGLE_APP_ID` | the Drive Picker clip (`drive.file`) | **missing**; both default to `null`, so the Picker cannot open |

The Picker matters beyond the video: `drive.file` is already in Google's review and a reviewer cannot see it work.

**Picker fix, checked against the Cloud project (Nov 12):** the Google Picker API is enabled and a "Browser API Key" exists (restricted to the Picker API). Three things stand between that and a working Picker:

1. **Vercel prod env:** add `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY` (the key, via "Show key" in Credentials) and `NEXT_PUBLIC_GOOGLE_APP_ID` = `368910954513` (the Cloud project number, which is the prefix of the client ID). Both are `NEXT_PUBLIC_*`, so redeploy afterwards.
2. **API key referrers** currently allow only `http://localhost:3000/*` and `https://orbit.jasonpereira.live/*`. Add `https://myorbitnetwork.com/*` (and `https://www.myorbitnetwork.com/*` if that host serves the app). The key rejects the production domain until you do.
3. **OAuth client "Orbit Web" has no Authorized JavaScript origins.** The Picker mints its `drive.file` token in the browser through Google Identity Services, which needs the page origin listed. Add `https://myorbitnetwork.com` (and `www` if used). Redirect URIs are already there for `orbit.jasonpereira.live`, `localhost:3000`, `myorbitnetwork.com`, and `clerk.myorbitnetwork.com` (Clerk's Google sign-in uses this same client).

The Picker's token popup is a second consent window with its own client ID. Record it in the Drive Picker clip. Google sign-in through Clerk shares the client too, so show both entry points in the consent-flow opening.

Console edits take up to five minutes to apply.

**Throwaway Google account, seeded before recording:**
- Contacts: 5–10 people with company, title, email, phone.
- Calendar: 2–3 meetings in the next two weeks with guests who are in those contacts.
- Gmail: two recruiter threads, one confirmation each from Luma and Eventbrite, one job-related thread for Email insights, and a Sent message to a contact.
- Drive: a Google Doc of meeting notes (for Cloud notes) and a Doc or Slides file to pick.
- Consent costs one of the 100 unverified-user slots per new Google account that connects (3 used today).

**Admin steps are yours.** I did not set the cookie, change flags, or touch Vercel env.

## Limited Use review risks (restricted scopes)

The privacy policy already carries the verbatim Limited Use sentence (`GOOGLE_LIMITED_USE`, enforced by `smoke-legal-pages`) and the per-scope table. Check these before CASA:

- **AI providers.** Gmail text is sent to Gemini, OpenAI or Anthropic on the user's key or Orbit's key. Google allows transfers needed to provide the user-facing feature and forbids use for training generalized models. Confirm each provider's API terms (no training on API data) and keep that stated in the privacy page.
- **Human access.** The policy says a person at Orbit reads Google data only with consent. Keep that true in admin tooling.
- **Storage.** "Message bodies are never stored" must stay true in the Email insights and recruiter scan code paths. CASA will test it.
- **Revocation and deletion.** Disconnect deletes tokens; Settings has delete by category. Keep both working for Google data.

## CASA (restricted scopes: gmail.readonly, drive.readonly)

Required annually for an app that stores or transmits restricted-scope data through a server. Google emails the assessment tier and the authorized assessor labs after restricted scopes are declared. Expect a self-scan plus lab verification, then a Letter of Validation tied to the app. It takes weeks, not days, and it is the long pole. Fees are set by the labs, so get quotes before committing.

## Order of operations

1. Record and upload the new video.
2. **You:** in Data Access add the five missing scopes, paste the justification and the YouTube link, Save, submit for verification.
3. Reply on the Trust and Safety email thread, quoting the two findings and pointing at the new video.
4. **You:** answer Google's CASA email and pick a lab.
5. Meanwhile, finish the AI-provider check above.
6. After approval, flip the `comingSoon` surfaces on in production.

Adding scopes, saving and submitting in the console are outward-facing steps for the account owner. This document changes nothing there.

## Draft reply to Trust and Safety (send on the existing thread, after the new video is up)

> Hi, thanks for the review. Both App functionality findings are addressed:
>
> 1. **OAuth consent flow.** The new video starts from a fresh Google connection and shows the consent screen with the client ID (`368910954513-87cnquv95u5b370fqdbp1gpu1ojecibf.apps.googleusercontent.com`) in the address bar, including the unverified-app screen and every requested scope. It also shows the second consent window the Google Picker opens.
> 2. **App functionality.** The video then shows each requested scope doing its job in the live app at https://myorbitnetwork.com: Google Contacts import, calendar sync, adding a meeting to the calendar (with Undo), sending an email, Gmail-based recruiter scan, event confirmations and Email insights, the Drive Picker, and Drive-based notes.
>
> I have also updated the declared scopes under Data Access to match what the app requests, with a justification for each. Video: <YouTube link>. Please let me know if anything else is needed.
>
> Jason Pereira, Orbit

Replace `<YouTube link>` before sending. Send it yourself from the address on the thread; do not send before the scopes are saved in Data Access.
