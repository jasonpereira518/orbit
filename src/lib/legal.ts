import { GOOGLE_SCOPES } from "@/lib/google-scopes";

/**
 * The legal pages' shared facts, DB-free so the marketing pages, onboarding and smoke tests
 * can all import them.
 *
 * TERMS_VERSION is what `user_settings.terms_version` records at acceptance. Change it (and
 * LEGAL_LAST_UPDATED) in the same commit as any material change to /terms or /privacy.
 * `scripts/smoke-legal-pages.ts` holds a lock over the two page sources and fails when they
 * move and these two do not, so the rule above is enforced rather than merely written down.
 */
// 2026-10-15: the calendar features — the two-week calendar window Orbit keeps, what of a
// meeting reaches the AI provider (Chat, recording summaries, talking points), guest Look up's
// web search, and upcoming meetings for connected assistants.
// 2026-10-16: the browser extension saves the Luma/Partiful guest list you have open, on your
// click; meeting prep shows the event behind an invite; meeting history keeps 500 characters
// of an invite's description (always true, now said).
// 2026-10-19: product measurement — the product events Orbit records, the one-tap questions, the
// retention of operational logs, the waitlist entry's lifetime and the tab id saved with it, and
// naming Vercel BotID and the Slack feedback excerpt, all of which were true and unsaid.
// 2026-11-05: reviewing the people a capture found looks each NEW one up on the web, by
// name with the company, role, place met and city the note gives — never an email or phone.
// 2026-11-06: Email insights, which reads the sender, subject and Gmail's preview of new job and
// hiring-process threads. Bumped a day after the text above so accounts that accepted 2026-11-05
// are asked again.
// 2026-11-06.2 (same day, after Email insights shipped as 2026-11-06): page-load timings, a
// last-touch attribution cookie, the kind of error screen shown, search and notification
// counts (never query text), and Resend delivery/open/click for outreach Orbit sends. A
// suffix, not a new date: needsTermsAcceptance compares strings, and accounts that accepted
// 2026-11-06 must be asked again.
// 2026-11-07: company logos on meeting rows — an organization's name or domain (a domain may
// come from a contact's or guest's work email, never the address) goes to Wikidata and
// Google's favicon service. The favicon lookup for brand colours was already true and unsaid.
// 2026-11-07.2 (same day, after company logos shipped as 2026-11-07): the extension can log the
// LinkedIn connections you tick at one of your events (names, profile links, headlines, on your
// click); and event discovery from confirmation emails is gone, so its description is removed.
// 2026-11-08: shared public work history — a confident web-search work history found from a
// public LinkedIn profile is reused across accounts that have the same profile, like shared photos.
// 2026-11-09: feedback — an AI model on Orbit's account reads each report for the operator
// (summary, kind, urgency, repeats), and the Slack alert now carries the whole report with the
// sender's email, plan and account age instead of a short excerpt.
// 2026-11-10: chat can keep notes you ask it to remember across chats (saved only when you add
// one or confirm a suggestion, listed and removable in the chat's Context panel, sent with every
// chat question), and the text of files you attach to a question is kept with that chat and sent
// to the AI provider, a photo or PDF being read by it first.
// 2026-11-11: TypeSafe on Orbit's own account for every account — Jev decides whether a
// contact's work history needs another web search, reading the stored job history and short
// summaries of the user's notes and messages since the last check (never the notes, an email
// address or a phone number), and may judge an unsure search's public answer to be someone else.
// 2026-11-12.2 (Google verification): the calendar wording now matches the code — Google
// calendars are the ones you tick (primary by default, not primary only), and meetings from 90
// days back to 60 days ahead are matched to your contacts, besides the two-week window kept for
// prep. Both were true and unsaid. A suffix, not a new date: the constellations PR (#636) also
// claims 2026-11-12, and needsTermsAcceptance compares strings, so whichever merges second must
// still ask everyone again.
// 2026-11-12.3 (Radar, revision PR 10): a Radar section — off until turned on; what it reads;
// Connect compares notes about people you have met; the people check widens the work-history
// search to recent posts, talks and news (kept for the account only); the weekly web search
// sends only city and up to five goals and may open public event pages (never lu.ma); people it
// finds stay out of contacts until saved; unsaved finds deleted 30 days after they end; push
// carries no names; Radar's emails go through Resend with their own unsubscribe; dismiss reasons
// shape that account only. Processors: Bluesky and Mastodon removed (Radar PR 1), web push
// services and event websites added, Radar's emails added to Resend. Terms: Radar can be wrong
// and never contacts anyone for you.
// 2026-11-12.4 (Radar PR 11): the extension's "Save post to Radar" and "Scan this page" (a scan
// sends Orbit only the authors' profile links first; only contacts' posts follow and are kept;
// strangers' posts never leave the browser), and the hashtags from your own posts (Shares.csv)
// as something Radar reads and adds to its weekly web search.
// 2026-11-12.5 (admin refresh, PR 2): public Gravatar photos found by email join the shared photo
// set, kept under a one-way hash of the address; uploads named as never shared.
// 2026-11-13 (Cosmo launch): Cosmo, the voice assistant — what a call sends Deepgram (and OpenAI
// through Deepgram's voice agent, or ElevenLabs if calls are switched to it), the screen context
// (page name, record id, Orbit's own button names; never page text), the day's Cosmo chat, small
// changes applied with Undo, spoken "send it", minutes per plan. Terms: Cosmo can be wrong.
// 2026-11-13.2 (contact-info accuracy, PR 8): Email insights also reads the signature of a
// known contact's own message, by rule, into that contact's empty role, company, phone and
// LinkedIn fields; each fill is undoable under "Changed by Orbit". No new mail is read.
// smoke-legal-pages requires TERMS_VERSION to move with any /privacy change.
// 2026-11-13.3 (Cosmo revision): Cosmo can open pages, press Orbit's own buttons and type into
// its fields when asked, never pressing save, send or delete. A suffix (main took .2 first):
// accounts that accepted 2026-11-13.2 must be asked again (needsTermsAcceptance compares strings).
// 2026-11-13.4 (message-format PR 2): matching your writing style. About twenty recent sent
// emails from Gmail or Outlook, cleaned of quotes, signatures and contact details, go to your AI
// provider once to describe how you write; only that description (600 characters) is kept.
// First claimed .3; renumbered when main took .3 (Cosmo revision).
export const TERMS_VERSION = "2026-11-13.4";
export const LEGAL_LAST_UPDATED = "November 13, 2026 (revision 4)";

/**
 * Clerk's `legal_accepted_at` from a user.created payload, as an acceptance to record.
 * Clerk timestamps are unix epochs whose unit varies by field; anything below 1e12 is read
 * as seconds (the same rule as `epochToDate` in user-settings.ts).
 */
export function termsAcceptanceFromClerk(
  legalAcceptedAt: number | null | undefined
): { acceptedAt: Date; version: string } | null {
  if (typeof legalAcceptedAt !== "number" || !Number.isFinite(legalAcceptedAt) || legalAcceptedAt <= 0) {
    return null;
  }
  const ms = legalAcceptedAt < 1e12 ? legalAcceptedAt * 1000 : legalAcceptedAt;
  return { acceptedAt: new Date(ms), version: TERMS_VERSION };
}

/** True when this account has not accepted the current Terms. */
export function needsTermsAcceptance(termsVersion: string | null | undefined): boolean {
  return termsVersion !== TERMS_VERSION;
}

export const GOOGLE_USER_DATA_POLICY_URL =
  "https://developers.google.com/terms/api-services-user-data-policy";

/**
 * Google requires this sentence, verbatim, on the privacy policy of any app using its
 * restricted or sensitive scopes. Split so the page can link the policy name;
 * `scripts/smoke-legal-pages.ts` proves the pieces still join into the exact sentence.
 */
export const GOOGLE_LIMITED_USE_SENTENCE =
  "Orbit's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.";

export const GOOGLE_LIMITED_USE = {
  before: "Orbit's use and transfer to any other app of information received from Google APIs will adhere to the ",
  linkText: "Google API Services User Data Policy",
  after: ", including the Limited Use requirements.",
  href: GOOGLE_USER_DATA_POLICY_URL,
} as const;

/**
 * One row per scope the code can request (src/lib/google-scopes.ts). The privacy page renders
 * this table and Google's verification form reuses it as the per-scope justification.
 */
export const GOOGLE_SCOPE_DISCLOSURES: readonly {
  scope: string;
  permission: string;
  use: string;
  askedWhen: string;
}[] = [
  {
    scope: GOOGLE_SCOPES.openid,
    permission: "Sign-in identity (openid)",
    use: "Confirms which Google account you connected.",
    askedWhen: "Every Google connection",
  },
  {
    scope: GOOGLE_SCOPES.email,
    permission: "Your email address (userinfo.email)",
    use: "Shown on the connection so you can tell which account is connected, and the address mail is sent from when you send from Gmail.",
    askedWhen: "Every Google connection",
  },
  {
    scope: GOOGLE_SCOPES.contacts,
    permission: "See your contacts (contacts.readonly)",
    use: "Lists your Google Contacts so you can pick who to import. Only the people you select are saved: name, company, title, email, phone and photo. A Google photo is saved for your account only and is never shared with other Orbit users.",
    askedWhen: "Connect Google on Imports → Google Contacts",
  },
  {
    scope: GOOGLE_SCOPES.gmailRead,
    permission: "Read your email (gmail.readonly)",
    use: "Recruiter scan: finds recruiting conversations and summarizes each with your AI key or Orbit's included AI. Email insights: reads the sender, subject and Gmail’s short preview of new job and hiring-process threads, and for hiring conversations the text of the latest messages, which it sends to your AI provider to note the company, role, stage, dates and people. The notes can appear on your Radar cards, which can also offer to add people an email names to your contacts when you press Add. Your chat assistant can search the notes too. Replying in a thread: when you compose an email to a contact, finds your latest message with them so you can reply in that conversation, reading only its Message-ID, subject, date and thread. Sending: checks your Sent folder so a retried send is never delivered twice. Message bodies are never stored.",
    askedWhen: "Connect Gmail on Recruiters, or turn on Email insights in Settings",
  },
  {
    scope: GOOGLE_SCOPES.gmailSend,
    permission: "Send email as you (gmail.send)",
    use: "Sends the emails you write and press Send on — from Compose on a contact page, follow-ups, drafts from Chat, recruiter emails, and drafts an assistant prepared that you approved — from your own address, so replies reach your inbox. Each one waits about 10 seconds so you can undo it, or until the time you schedule, and can carry files you attach. Orbit never sends a message you did not send.",
    askedWhen: "Connect Gmail to send, in Compose, Settings → Email, the recruiter composer, or on a draft in Chat",
  },
  {
    scope: GOOGLE_SCOPES.calendar,
    permission: "See your calendar events (calendar.readonly)",
    use: "Reads the calendars you choose (your primary calendar by default). Keeps the meetings from two days back to two weeks ahead in Orbit, updating them as your calendar changes and deleting meetings that leave that window. Looks from 90 days back to 60 days ahead to match meetings to people in your network, add them to those people’s timelines and suggest follow-up reminders. Uses upcoming meetings for prep and follow-up reminders, recording suggestions, meeting prep, recording summaries and answers in Chat and in assistants you connect.",
    askedWhen: "Connect Google Calendar on Events",
  },
  {
    scope: GOOGLE_SCOPES.calendarWrite,
    permission: "Add events to your calendar (calendar.events)",
    use: "Puts the meetings you set up in Chat on your primary calendar, with the title, time and place you gave, and removes one when you press Undo. Nobody is invited and no email is sent. Orbit never changes or deletes an event it did not add.",
    askedWhen: "Add to calendar on a meeting in Chat",
  },
  {
    scope: GOOGLE_SCOPES.drive,
    permission: "See and open only the Google Docs and Slides you pick (drive.file)",
    use: "Lets you pick Google Docs and Slides from the Google Picker to import. Orbit only ever sees files you explicitly select.",
    askedWhen: "Connect Google on Imports → Google Drive",
  },
  {
    scope: GOOGLE_SCOPES.driveRead,
    permission: "See your Google Drive files (drive.readonly)",
    use: "Cloud notes: lists your recent Google Docs so you can pick notes to import from inside Orbit, and reads the title and first lines of recently changed Docs to spot meeting notes. A whole Doc is read only when you extract it, or when you turned on automatic extraction. Orbit never changes or deletes anything in your Drive.",
    askedWhen: "Connect Google Drive on Capture → Drive & OneDrive",
  },
];

/**
 * Whether the app shell should ask this account to accept the current Terms.
 *
 * Only for a real signed-in account (Clerk on, not the shared local demo user), and only
 * while the recorded version is not the current one — which covers both "never recorded"
 * (accounts that predate Clerk's consent checkbox) and "accepted an older version".
 */
export function shouldShowTermsNotice(input: {
  clerkOn: boolean;
  demoMode: boolean;
  termsVersion: string | null | undefined;
}): boolean {
  if (!input.clerkOn || input.demoMode) return false;
  return needsTermsAcceptance(input.termsVersion);
}

export const TERMS_NOTICE_COPY = {
  title: "We’ve updated our Terms and Privacy Policy",
  body: "Please read them. Accepting records that you agree to the version dated " + LEGAL_LAST_UPDATED,
  accept: "Accept",
  retry: "Couldn’t record that — try again",
} as const;
