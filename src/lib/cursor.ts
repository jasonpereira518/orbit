/**
 * Keyset-cursor codecs.
 *
 * The app has several cursor FORMATS and they are deliberately not unified: cursors are held
 * by external callers (the public v1 API) and by open browser tabs, so each format must keep
 * decoding and encoding byte-for-byte. These helpers only remove the copy-pasted code; the
 * wire formats are pinned by literal strings in `cursor.test.ts`.
 *
 *   iso|id, base64url   app/api/v1/contacts (PUBLIC API)
 *   pgtext|id, plain    capture-history, meetings-list
 *   base64url(JSON)     reminders-page-query, contacts-page-cursor
 */

export type CursorEncoding = "plain" | "base64url";

/** `<iso-or-pg-text>|<id>`, optionally base64url-wrapped. */
export function encodeIsoIdCursor(iso: string, id: string, encoding: CursorEncoding): string {
  const raw = `${iso}|${id}`;
  return encoding === "base64url" ? Buffer.from(raw).toString("base64url") : raw;
}

/**
 * Splits an `iso|id` cursor into its halves; validating them is the caller's job.
 *
 * The two encodings split differently because the two legacy decoders did: `plain` splits on
 * the LAST bar (Postgres timestamp text never contains one, an id might), `base64url` takes
 * the first two `|`-separated fields. Keep it that way: it decides what a malformed cursor
 * decodes to.
 */
export function decodeIsoIdCursor(
  cursor: string | null | undefined,
  encoding: CursorEncoding
): { iso: string; id: string } | null {
  if (!cursor) return null;
  if (encoding === "plain") {
    const bar = cursor.lastIndexOf("|");
    if (bar <= 0) return null;
    return { iso: cursor.slice(0, bar), id: cursor.slice(bar + 1) };
  }
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!id) return null;
    return { iso, id };
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f-]{36}$/i;
const PG_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;

/**
 * A plain `pgtext|uuid` cursor, accepted only if both halves look right. Both are cast inside
 * the query, so junk would throw there; refusing it here hands back the first page instead.
 * The timestamp stays Postgres's own text: a JS Date would round microseconds.
 */
export function decodePgTimestampIdCursor(
  cursor: string | null | undefined
): { at: string; id: string } | null {
  const parts = decodeIsoIdCursor(cursor, "plain");
  if (!parts) return null;
  if (!UUID_RE.test(parts.id)) return null;
  if (!PG_TIMESTAMP_RE.test(parts.iso)) return null;
  return { at: parts.iso, id: parts.id };
}

/** `base64url(JSON.stringify(value))`. */
export function encodeJsonCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * The parsed JSON of a base64url cursor, or null when empty or unparseable. The shape check
 * (which sort, which ordering) belongs to the caller.
 */
export function decodeJsonCursor(raw: string | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
