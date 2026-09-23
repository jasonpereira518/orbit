
/**
 * The permanent denylist, as code rather than prose.
 *
 * `src/lib/admin-user-detail.ts` has always carried this list in its header comment. That
 * made it greppable but not enforceable: nothing stopped a future query from selecting
 * `chat_messages.content` except somebody remembering the comment existed.
 *
 * That mattered more once the inspector started reading contact and interaction content
 * freely. "Which columns are off-limits" is no longer a short set a reader holds in their
 * head while writing a query, so the machine checks it.
 *
 * Three classes live here, for three different reasons:
 *
 *   Credentials. Encrypted API keys, OAuth tokens, webhook signing secrets and the calendar
 *   feed token are live bearer secrets. The admin console reads their *presence* as a
 *   boolean and nothing else; `decryptOrNull()` is never called from any admin module,
 *   including into a log line. `scripts/smoke-admin-redaction.ts` fails when a new
 *   `*_encrypted` column is added to the schema without being listed here.
 *
 *   Chat transcripts. `chat_messages.content` is the most private store in the app — an
 *   unstructured record of what the user asked about their own network, in their own
 *   words. Unlike a contact note it has no operational use: no support question is
 *   answered by reading it.
 *
 *   Raw capture material. The verbatim text of a capture (`note_batches.source_text`), a
 *   meeting's transcript, and the photos a capture was read from. The privacy policy tells
 *   users the console never shows them; the structured result (contacts, interactions) is
 *   what support reads.
 */
export const NEVER_REVEALABLE: readonly string[] = [
  "chat_messages.content",
  // Free text the user wrote about how they write — a chat note and style notes are the same
  // kind of thing as a chat message, so the console never shows them either.
  "chat_threads.context_note",
  "user_settings.writing_instructions",
  "user_settings.gemini_api_key_encrypted",
  "user_settings.openai_api_key_encrypted",
  "user_settings.anthropic_api_key_encrypted",
  "user_settings.typesafe_api_key_encrypted",
  "user_settings.apollo_api_key_encrypted",
  "user_settings.resend_api_key_encrypted",
  "user_settings.twilio_account_sid_encrypted",
  "user_settings.twilio_auth_token_encrypted",
  "user_settings.calendar_feed_token",
  "user_settings.inbound_log_token",
  "gmail_connections.access_token_encrypted",
  "gmail_connections.refresh_token_encrypted",
  "outlook_connections.access_token_encrypted",
  "outlook_connections.refresh_token_encrypted",
  "apple_connections.app_password_encrypted",
  "event_provider_connections.api_key_encrypted",
  "event_provider_connections.access_token_encrypted",
  "event_provider_connections.refresh_token_encrypted",
  "connector_connections.api_key_encrypted",
  "connector_connections.access_token_encrypted",
  "connector_connections.refresh_token_encrypted",
  "webhook_endpoints.secret_encrypted",
  "note_batches.source_text",
  "meeting_transcript_segments.text",
  "capture_photos.inline_data",
  "capture_photos.blob_url",
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
 * Called by every admin query that reaches beyond a bare summary.
 *
 * This used to guard the reveal-grant branch; that gate is gone, and the assertion stayed,
 * because it was never really enforcing the gate. It enforces the list above — the columns
 * no admin surface may select at all — and with no grant left to sit behind, it is now the
 * only thing standing between a well-meaning "just add the token so we can debug it" and a
 * console that renders a foreign user's credentials.
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
