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
// 2026-10-19: retention windows for sent-email text, meeting transcripts, feedback screenshots,
// delivery reports, webhook payloads and usage counters; Sentry and Vercel log retention; what
// account deletion now also removes (credit balance, the matching waitlist entry) and keeps
// (the Stripe customer marked deleted, the account's security log). Also product measurement:
// the product events Orbit records, the one-tap questions, the retention of operational logs,
// the waitlist entry's lifetime and the tab id saved with it, and naming Vercel BotID and the
// Slack feedback excerpt, all of which were true and unsaid.
export const TERMS_VERSION = "2026-10-19";
export const LEGAL_LAST_UPDATED = "October 19, 2026";

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
    use: "Recruiter scan: finds recruiting conversations and summarizes each with your AI key or Orbit's included AI. Confirmation emails: reads mail from Luma, Partiful, Eventbrite, Meetup and Posh to find events you registered for. Replying in a thread: when you compose an email to a contact, finds your latest message with them so you can reply in that conversation, reading only its Message-ID, subject, date and thread. Sending: checks your Sent folder so a retried send is never delivered twice. Message bodies are never stored.",
    askedWhen: "Connect Gmail on Recruiters, or turn on Confirmation emails on Events",
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
    use: "Reads your primary calendar from two days back to two weeks ahead and keeps that window in Orbit, updating it as your calendar changes and deleting meetings that leave it. Adds meetings with people in your network to their timelines, and uses upcoming meetings for prep and follow-up reminders, recording suggestions, meeting prep, recording summaries and answers in Chat and in assistants you connect.",
    askedWhen: "Connect Google Calendar on Events",
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
