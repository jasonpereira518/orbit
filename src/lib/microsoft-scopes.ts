/**
 * Which Microsoft Graph scopes each Orbit feature asks for, and how to read a stored grant.
 *
 * DB-free and client-safe on purpose, like `google-scopes.ts` (audit B5): the OAuth start
 * action, the callback, the panels that choose between "Connect" and "Allow", the OAuth-error
 * copy and the privacy policy all read from here, so the policy cannot describe a scope the
 * code does not request. Before this module the single Outlook grant asked for Contacts,
 * Calendars and Mail whichever button was pressed.
 *
 * ## Scope names are not stable on the way back
 *
 * Microsoft's token endpoint does not echo scopes in the form they were requested. A Graph
 * scope can come back as a short name (`Calendars.Read`), as a full URI
 * (`https://graph.microsoft.com/Calendars.Read`), and in inconsistent case (`calendars.read`),
 * and this differs between personal and work/school accounts. Every comparison here goes
 * through `normalizeScope`, so a real grant can never read as "no calendar scope" — which
 * would silently disarm calendar sync (`sync-scheduler.ts` disarms on a missing scope).
 */
const GRAPH_PREFIX = "https://graph.microsoft.com/";

export const MICROSOFT_SCOPES = {
  openid: "openid",
  profile: "profile",
  email: "email",
  offlineAccess: "offline_access",
  userRead: `${GRAPH_PREFIX}User.Read`,
  contacts: `${GRAPH_PREFIX}Contacts.Read`,
  calendar: `${GRAPH_PREFIX}Calendars.Read`,
  mail: `${GRAPH_PREFIX}Mail.Read`,
} as const;

export type MicrosoftScope = (typeof MICROSOFT_SCOPES)[keyof typeof MICROSOFT_SCOPES];

export const MICROSOFT_PURPOSES = ["contacts", "calendar", "recruiter_scan"] as const;
export type MicrosoftPurpose = (typeof MICROSOFT_PURPOSES)[number];

const IDENTITY_SCOPES: readonly MicrosoftScope[] = [
  MICROSOFT_SCOPES.openid,
  MICROSOFT_SCOPES.profile,
  MICROSOFT_SCOPES.email,
  MICROSOFT_SCOPES.offlineAccess,
  MICROSOFT_SCOPES.userRead,
];

const PURPOSE_SCOPE: Record<MicrosoftPurpose, MicrosoftScope> = {
  contacts: MICROSOFT_SCOPES.contacts,
  calendar: MICROSOFT_SCOPES.calendar,
  recruiter_scan: MICROSOFT_SCOPES.mail,
};

export function isMicrosoftPurpose(value: unknown): value is MicrosoftPurpose {
  return typeof value === "string" && (MICROSOFT_PURPOSES as readonly string[]).includes(value);
}

export function requiredScopeFor(purpose: MicrosoftPurpose): MicrosoftScope {
  return PURPOSE_SCOPE[purpose];
}

/** Microsoft returns granted scopes space-separated; so does `outlook_connections.scopes`. */
export function parseScopes(scopes: string | null | undefined): string[] {
  return (scopes ?? "").split(/\s+/).filter(Boolean);
}

/**
 * One scope in its comparison form: the Graph prefix stripped, lower-cased. `openid` and
 * `https://graph.microsoft.com/Calendars.Read` and `CALENDARS.READ` all land on one key.
 */
export function normalizeScope(scope: string): string {
  const lower = scope.trim().toLowerCase();
  return lower.startsWith(GRAPH_PREFIX.toLowerCase()) ? lower.slice(GRAPH_PREFIX.length) : lower;
}

/**
 * Exact token match after normalizing both sides — never a substring test, which would accept
 * a look-alike (`Calendars.ReadWrite` for `Calendars.Read`).
 */
export function hasScope(scopes: string | null | undefined, scope: string): boolean {
  const wanted = normalizeScope(scope);
  return parseScopes(scopes).some((s) => normalizeScope(s) === wanted);
}

export function hasContactsScope(scopes: string | null | undefined): boolean {
  return hasScope(scopes, MICROSOFT_SCOPES.contacts);
}

export function hasCalendarScope(scopes: string | null | undefined): boolean {
  return hasScope(scopes, MICROSOFT_SCOPES.calendar);
}

export function hasMailScope(scopes: string | null | undefined): boolean {
  return hasScope(scopes, MICROSOFT_SCOPES.mail);
}

export function grantCovers(purpose: MicrosoftPurpose, scopes: string | null | undefined): boolean {
  return hasScope(scopes, PURPOSE_SCOPE[purpose]);
}

/** What one Connect asks for. Microsoft has no mail-free equivalent of `event_mail`. */
export const MICROSOFT_CONNECT_PURPOSES: readonly MicrosoftPurpose[] = ["contacts", "calendar"];

/**
 * The scopes one consent screen should ask for. Microsoft has no `include_granted_scopes`, so
 * every Orbit scope the account already granted is re-requested alongside the new ones —
 * otherwise consenting to one feature drops the others.
 */
export function microsoftScopesFor(
  purposes: readonly MicrosoftPurpose[],
  alreadyGranted?: string | null
): MicrosoftScope[] {
  const wanted = new Set<MicrosoftScope>([...IDENTITY_SCOPES, ...purposes.map((p) => PURPOSE_SCOPE[p])]);
  for (const purpose of MICROSOFT_PURPOSES) {
    if (hasScope(alreadyGranted, PURPOSE_SCOPE[purpose])) wanted.add(PURPOSE_SCOPE[purpose]);
  }
  return [...wanted];
}

export function missingMicrosoftPurposes(
  purposes: readonly MicrosoftPurpose[],
  scopes: string | null | undefined
): MicrosoftPurpose[] {
  return purposes.filter((purpose) => !grantCovers(purpose, scopes));
}

/**
 * How the purpose list rides in the OAuth state and comes back on the URL. `.`, not `+`, for
 * the reason `serializeGooglePurposes` gives: the redirect carries the state form-urlencoded,
 * where a literal `+` decodes to a SPACE, and a provider that echoes the decoded value would
 * break the cookie comparison in `consumeOutlookOAuthState` on every two-purpose Connect.
 */
export function serializeMicrosoftPurposes(purposes: readonly MicrosoftPurpose[]): string {
  return purposes.join(".");
}

/**
 * Tolerates a single purpose — a consent screen opened before the list shipped says just
 * `contacts` — and the `+` this used to join with, for a screen opened before that changed.
 */
export function parseMicrosoftPurposes(raw: string | null | undefined): MicrosoftPurpose[] {
  return (raw ?? "").split(/[.+]/).filter(isMicrosoftPurpose);
}

/**
 * What to store after a token response: everything granted before plus everything Microsoft
 * says it granted now, one entry per scope whichever form it arrived in (the first form seen
 * is kept). Never a hardcoded list — `""` when Microsoft reported nothing, so an absent
 * `scope` can never be recorded as every scope granted.
 */
export function unionScopes(
  existing: string | null | undefined,
  granted: string | null | undefined
): string {
  const seen = new Map<string, string>();
  for (const scope of [...parseScopes(existing), ...parseScopes(granted)]) {
    const key = normalizeScope(scope);
    if (!seen.has(key)) seen.set(key, scope);
  }
  return [...seen.values()].join(" ");
}

/** Shown when consent finished but the scope the feature needs was not among what was granted. */
export function missingScopeMessage(purpose: MicrosoftPurpose | null | undefined): string {
  switch (purpose) {
    case "contacts":
      return "Microsoft didn’t grant contacts access — reconnect and allow it";
    case "calendar":
      return "Microsoft didn’t grant calendar access — reconnect and allow it";
    default:
      return "Microsoft didn’t grant mail access — reconnect and allow it";
  }
}
