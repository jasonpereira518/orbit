
/**
 * The permanent denylist, as code rather than prose.
 *
 * `src/lib/admin-user-detail.ts` has always carried this list in its header comment. That
 * made it greppable but not enforceable: nothing stopped a future query from selecting
 * `chat_messages.content` except somebody remembering the comment existed. Now that the
 * console can unmask contact and interaction content under a grant, "which columns are
 * off-limits" stops being a fixed set a reader can hold in their head, and the difference
 * between reveal-able and never-reveal-able has to be checked by the machine.
 *
 * Two classes live here, for two different reasons:
 *
 *   Credentials. Encrypted API keys, the calendar feed token, and OAuth access/refresh
 *   tokens are live bearer secrets. The admin console reads their *presence* as a boolean
 *   and nothing else; `decryptKey()` is never called from any admin module, under any
 *   grant, including into a log line.
 *
 *   Chat transcripts. `chat_messages.content` is the most private store in the app — an
 *   unstructured record of what the user asked about their own network, in their own
 *   words. Unlike a contact note it has no operational use: no support question is
 *   answered by reading it. It is the one field a reveal grant cannot reach.
 */
export const NEVER_REVEALABLE: readonly string[] = [
  "chat_messages.content",
  "user_settings.gemini_api_key_encrypted",
  "user_settings.openai_api_key_encrypted",
  "user_settings.anthropic_api_key_encrypted",
  "user_settings.apollo_api_key_encrypted",
  "user_settings.resend_api_key_encrypted",
  "user_settings.twilio_account_sid_encrypted",
  "user_settings.twilio_auth_token_encrypted",
  "user_settings.calendar_feed_token",
  "gmail_connections.access_token_encrypted",
  "gmail_connections.refresh_token_encrypted",
  "outlook_connections.access_token_encrypted",
  "outlook_connections.refresh_token_encrypted",
];

const DENIED = new Set(NEVER_REVEALABLE);

/** Thrown rather than returned: a denied column is a bug, not a condition to branch on. */
export class RedactionViolationError extends Error {
  constructor(columns: string[]) {
    super(
      `Refusing to select permanently redacted column(s): ${columns.join(", ")}`
    );
    this.name = "RedactionViolationError";
  }
}

/**
 * Called by every query that widens its column list under a grant.
 *
 * Takes fully qualified `table.column` names, because the bare column name is ambiguous
 * exactly where it matters — `content` is fine on `imports`, fatal on `chat_messages`.
 */
export function assertRevealable(columns: readonly string[]): void {
  const violations = columns.filter((c) => DENIED.has(c));
  if (violations.length > 0) throw new RedactionViolationError(violations);
}

/**
 * Deep scan for sentinel values, used by the smoke scripts.
 *
 * `assertRevealable` checks what a query *asked* for; this checks what actually came back,
 * which is the assertion that survives a refactor into raw SQL where there is no column
 * list to inspect.
 */
export function assertNoForbiddenValues(
  value: unknown,
  needles: readonly string[]
): void {
  if (needles.length === 0) return;
  const haystack = JSON.stringify(value ?? null);
  if (!haystack) return;
  const found = needles.filter((n) => n.length > 0 && haystack.includes(n));
  if (found.length > 0) {
    throw new Error(
      `Forbidden value(s) present in admin payload: ${found.join(", ")}`
    );
  }
}
