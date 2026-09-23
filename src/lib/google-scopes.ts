/**
 * Which Google OAuth scopes each Orbit feature asks for, and how to read a stored grant.
 *
 * DB-free and client-safe on purpose: the OAuth start action, the callback, the panels that
 * choose between "Connect" and "Scan", the OAuth-error copy and the privacy policy's scope
 * table all read from here, so the policy cannot describe a scope the code does not request.
 *
 * Before this module the single Google grant asked for all six scopes whichever button was
 * pressed (audit B5). Each entry point now asks for its own scope plus the two identity
 * scopes, with `include_granted_scopes=true` so earlier grants carry forward.
 */
export const GOOGLE_SCOPES = {
  openid: "openid",
  email: "https://www.googleapis.com/auth/userinfo.email",
  contacts: "https://www.googleapis.com/auth/contacts.readonly",
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  // Only files the person picks in the Google Picker. Non-sensitive; the restricted
  // drive.readonly would need a CASA assessment, which is why whole-Drive search is later.
  drive: "https://www.googleapis.com/auth/drive.file",
} as const;

export type GoogleScope = (typeof GOOGLE_SCOPES)[keyof typeof GOOGLE_SCOPES];

export const GOOGLE_PURPOSES = ["contacts", "recruiter_scan", "send", "calendar", "event_mail", "drive"] as const;
export type GooglePurpose = (typeof GOOGLE_PURPOSES)[number];

const IDENTITY_SCOPES: readonly GoogleScope[] = [GOOGLE_SCOPES.openid, GOOGLE_SCOPES.email];

const PURPOSE_SCOPE: Record<GooglePurpose, GoogleScope> = {
  contacts: GOOGLE_SCOPES.contacts,
  recruiter_scan: GOOGLE_SCOPES.gmailRead,
  send: GOOGLE_SCOPES.gmailSend,
  calendar: GOOGLE_SCOPES.calendar,
  event_mail: GOOGLE_SCOPES.gmailRead,
  drive: GOOGLE_SCOPES.drive,
};

export function isGooglePurpose(value: unknown): value is GooglePurpose {
  return typeof value === "string" && (GOOGLE_PURPOSES as readonly string[]).includes(value);
}

export function requiredScopeFor(purpose: GooglePurpose): GoogleScope {
  return PURPOSE_SCOPE[purpose];
}

export function googleScopesFor(purpose: GooglePurpose): GoogleScope[] {
  return [...IDENTITY_SCOPES, PURPOSE_SCOPE[purpose]];
}

/** Google returns granted scopes space-separated; so does `gmail_connections.scopes`. */
export function parseScopes(scopes: string | null | undefined): string[] {
  return (scopes ?? "").split(/\s+/).filter(Boolean);
}

/** Exact token match. The old `includes()` substring test would accept a look-alike. */
export function hasScope(scopes: string | null | undefined, scope: string): boolean {
  return parseScopes(scopes).includes(scope);
}

export function hasGmailReadScope(scopes: string | null | undefined): boolean {
  return hasScope(scopes, GOOGLE_SCOPES.gmailRead);
}

export function grantCovers(purpose: GooglePurpose, scopes: string | null | undefined): boolean {
  return hasScope(scopes, PURPOSE_SCOPE[purpose]);
}

/**
 * What to store after a token response: everything granted before plus everything Google
 * says it granted now. Never a hardcoded list — `""` when Google reported nothing, so an
 * absent `scope` can no longer be recorded as every scope granted.
 */
export function unionScopes(
  existing: string | null | undefined,
  granted: string | null | undefined
): string {
  return [...new Set([...parseScopes(existing), ...parseScopes(granted)])].join(" ");
}

/** Shown when Google's granular consent let the person untick the scope the feature needs. */
export function missingScopeMessage(purpose: GooglePurpose | null | undefined): string {
  switch (purpose) {
    case "contacts":
      return "Google didn’t grant contacts access — reconnect and allow it";
    case "calendar":
      return "Google didn’t grant calendar access — reconnect and allow it";
    case "send":
      return "Google didn’t grant permission to send — reconnect and allow it";
    case "drive":
      return "Google didn’t grant Drive access — reconnect and allow it";
    default:
      return "Google didn’t grant mail access — reconnect and allow it";
  }
}
