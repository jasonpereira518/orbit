import { GOOGLE_SCOPES } from "@/lib/google-scopes";

/**
 * The legal pages' shared facts, DB-free so the marketing pages, onboarding and smoke tests
 * can all import them.
 *
 * TERMS_VERSION is what `user_settings.terms_version` records at acceptance. Change it (and
 * LEGAL_LAST_UPDATED) in the same commit as any material change to /terms or /privacy.
 */
export const TERMS_VERSION = "2026-09-22";
export const LEGAL_LAST_UPDATED = "September 22, 2026";

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
    use: "Lists your Google Contacts so you can pick who to import. Only the people you select are saved: name, company, title, email, phone and photo.",
    askedWhen: "Connect Google on Imports → Google Contacts",
  },
  {
    scope: GOOGLE_SCOPES.gmailRead,
    permission: "Read your email (gmail.readonly)",
    use: "Recruiter scan: finds recruiting conversations and summarizes each with your own AI key. Confirmation emails: reads mail from Luma, Partiful, Eventbrite, Meetup and Posh to find events you registered for. Message bodies are never stored.",
    askedWhen: "Connect Gmail on Recruiters, or turn on Confirmation emails on Events",
  },
  {
    scope: GOOGLE_SCOPES.gmailSend,
    permission: "Send email as you (gmail.send)",
    use: "Sends the recruiter messages you write and press Send on, from your own address, so replies reach your inbox. Orbit never sends a message you did not send.",
    askedWhen: "Allow Gmail to send, in the recruiter composer",
  },
  {
    scope: GOOGLE_SCOPES.calendar,
    permission: "See your calendar events (calendar.readonly)",
    use: "Reads recent and upcoming events on your primary calendar and adds meetings with people in your network to their timelines.",
    askedWhen: "Connect Google Calendar on Events",
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
