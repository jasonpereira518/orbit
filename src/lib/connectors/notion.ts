/**
 * Notion over its REST API: an OAuth public integration that reads only the pages and
 * databases the person shared on Notion's own consent screen. Orbit never writes to Notion.
 *
 * Tokens live on the person's `connector_connections` row (see `oauth.ts` for the grant).
 * Pure helpers take an injectable `fetchImpl` so the smoke can run without a network.
 */
import { refreshAccessToken, OAuthTokenError } from "@/lib/connectors/oauth";
import {
  loadConnectorConnection,
  markConnectorNeedsReauth,
  markConnectorSyncResult,
  storeConnectorTokens,
} from "@/lib/connectors/connections";
import { finalizeIngest, openIngestContext } from "@/lib/ingest/events";
import { ingestPeople, type PersonRecord } from "@/lib/ingest/people";
import type { ConnectorSyncCursor, NotionCursor, NotionPersonField } from "@/db/schema";

export const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2026-03-11";
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
/** Longest a single 429 is waited out inside one call; past that the caller retries later. */
const MAX_RETRY_AFTER_MS = 10_000;

/** The grant is gone (revoked, expired refresh, page access removed): only reconnecting helps. */
export class NotionReauthError extends Error {
  constructor(message = "Reconnect Notion") {
    super(message);
    this.name = "NotionReauthError";
  }
}

export class NotionApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

/** One authenticated Notion call. A 429 is waited out once (Retry-After, capped). */
export async function notionRequest<T>(
  accessToken: string,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(`${NOTION_API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "notion-version": NOTION_VERSION,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429 && attempt === 0) {
      const seconds = Number(res.headers.get("retry-after") ?? "1");
      await sleep(Math.min(MAX_RETRY_AFTER_MS, (Number.isFinite(seconds) ? seconds : 1) * 1000));
      continue;
    }
    if (res.status === 401) throw new NotionReauthError();
    const json = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new NotionApiError(json.message ?? `Notion returned ${res.status}`, res.status);
    return json;
  }
}

/** Workspace details from the token response, kept on the cursor for the settings page. */
export function notionWorkspace(raw: Record<string, unknown>): NotionCursor {
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    workspaceId: str(raw.workspace_id),
    workspaceName: str(raw.workspace_name),
    workspaceIcon: str(raw.workspace_icon),
  };
}

/** A usable access token for this connection, refreshing (and storing the rotated pair) when due. */
async function freshAccessToken(connectionId: string): Promise<string> {
  const conn = await loadConnectorConnection(connectionId);
  if (!conn?.accessToken) throw new NotionReauthError();
  const due = conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
  if (!due) return conn.accessToken;
  if (!conn.refreshToken) throw new NotionReauthError();
  try {
    const t = await refreshAccessToken("notion", conn.refreshToken);
    // Notion rotates the refresh token on every refresh; the old one is now dead.
    await storeConnectorTokens(connectionId, {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      tokenExpiresAt: t.expiresAt,
    });
    return t.accessToken;
  } catch (err) {
    if (err instanceof OAuthTokenError && err.needsReauth) throw new NotionReauthError(err.message);
    throw err;
  }
}

/** `notionRequest` for a stored connection. A dead grant flags the row for reconnect. */
export async function notionCall<T>(
  connectionId: string,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {}
): Promise<T> {
  try {
    return await notionRequest<T>(await freshAccessToken(connectionId), path, init);
  } catch (err) {
    if (err instanceof NotionReauthError) await markConnectorNeedsReauth(connectionId, err.message);
    throw err;
  }
}

/** Best effort: tell Notion to drop the grant. Disconnect deletes the row either way. */
export async function revokeNotionToken(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const id = process.env.NOTION_CLIENT_ID;
  const secret = process.env.NOTION_CLIENT_SECRET;
  if (!id || !secret) return;
  await fetchImpl(`${NOTION_API}/oauth/revoke`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "content-type": "application/json",
      "notion-version": NOTION_VERSION,
    },
    body: JSON.stringify({ token: accessToken }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

// ── Pages → capture text ────────────────────────────────────────────────────────────────

type RichText = { plain_text?: string }[];
export type NotionBlock = { id: string; type: string; has_children?: boolean } & Record<string, unknown>;
type NotionList<T> = { results: T[]; next_cursor: string | null; has_more: boolean };
type NotionPageObject = {
  id: string;
  url?: string;
  last_edited_time: string;
  icon?: { type: string; emoji?: string } | null;
  properties?: Record<string, { type: string; title?: RichText }>;
};

export type NotionPickable = { id: string; title: string; icon: string | null; editedAt: string };

const plain = (rt: unknown) => (Array.isArray(rt) ? (rt as RichText).map((t) => t.plain_text ?? "").join("") : "");

/** A page's title: whichever property is the title column (database rows name it anything). */
export function pageTitle(page: Pick<NotionPageObject, "properties">): string {
  const title = Object.values(page.properties ?? {}).find((p) => p.type === "title");
  return plain(title?.title).trim() || "Untitled";
}

/** One block as one line of plain text, or null for blocks with no words (dividers, images). */
export function blockLine(block: NotionBlock, depth = 0): string | null {
  const body = block[block.type] as { rich_text?: RichText; checked?: boolean; cells?: RichText[] } | undefined;
  if (!body) return null;
  const indent = "  ".repeat(depth);
  const text = plain(body.rich_text).trim();
  switch (block.type) {
    case "heading_1":
      return text && `${indent}# ${text}`;
    case "heading_2":
      return text && `${indent}## ${text}`;
    case "heading_3":
      return text && `${indent}### ${text}`;
    case "bulleted_list_item":
    case "toggle":
      return text && `${indent}- ${text}`;
    case "numbered_list_item":
      return text && `${indent}1. ${text}`;
    case "to_do":
      return text && `${indent}- [${body.checked ? "x" : " "}] ${text}`;
    case "quote":
      return text && `${indent}> ${text}`;
    case "table_row":
      return `${indent}| ${(body.cells ?? []).map((c) => plain(c).trim()).join(" | ")} |`;
    case "paragraph":
    case "callout":
    case "code":
      return text ? `${indent}${text}` : null;
    default:
      return null;
  }
}

/** Child pages and databases are their own documents; everything else nests under its parent. */
const OWN_DOCUMENT = new Set(["child_page", "child_database", "synced_block", "link_to_page"]);
const MAX_DEPTH = 3;

/** Every block under `blockId`, depth-first, as capture text — capped at capture's input ceiling. */
export async function blocksText(
  list: (blockId: string, cursor: string | null) => Promise<NotionList<NotionBlock>>,
  blockId: string,
  maxChars: number
): Promise<string> {
  const lines: string[] = [];
  let size = 0;
  const walk = async (id: string, depth: number): Promise<void> => {
    let cursor: string | null = null;
    do {
      const page = await list(id, cursor);
      for (const block of page.results) {
        if (size >= maxChars) return;
        const line = blockLine(block, depth);
        if (line) {
          lines.push(line);
          size += line.length + 1;
        }
        if (block.has_children && depth < MAX_DEPTH && !OWN_DOCUMENT.has(block.type)) await walk(block.id, depth + 1);
      }
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor && size < maxChars);
  };
  await walk(blockId, 0);
  return lines.join("\n").slice(0, maxChars);
}

/** A page as capture text: its title, then its blocks. */
export async function notionPageText(connectionId: string, pageId: string, maxChars: number) {
  const page = await notionCall<NotionPageObject>(connectionId, `/pages/${pageId}`);
  const title = pageTitle(page);
  const body = await blocksText(
    (id, cursor) =>
      notionCall<NotionList<NotionBlock>>(
        connectionId,
        `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`
      ),
    pageId,
    maxChars
  );
  return { title, text: `# ${title}\n\n${body}`.slice(0, maxChars) };
}

/** Pages the person shared with Orbit, most recently edited first. */
export async function searchNotionPages(
  connectionId: string,
  query: string,
  cursor: string | null
): Promise<{ pages: NotionPickable[]; nextCursor: string | null }> {
  const res = await notionCall<NotionList<NotionPageObject>>(connectionId, "/search", {
    method: "POST",
    body: {
      ...(query ? { query } : {}),
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 25,
      ...(cursor ? { start_cursor: cursor } : {}),
    },
  });
  return {
    pages: res.results.map((p) => ({
      id: p.id,
      title: pageTitle(p),
      icon: p.icon?.type === "emoji" ? (p.icon.emoji ?? null) : null,
      editedAt: p.last_edited_time,
    })),
    nextCursor: res.has_more ? res.next_cursor : null,
  };
}

// ── A people database → contacts ────────────────────────────────────────────────────────

export type NotionDataSource = { id: string; title: string };
export type NotionColumn = { id: string; name: string; type: string };
export type NotionMapping = Partial<Record<NotionPersonField, string>>;

/** The people databases (data sources, since API 2025-09-03) the person shared with Orbit. */
export async function listNotionDataSources(connectionId: string): Promise<NotionDataSource[]> {
  const res = await notionCall<NotionList<{ id: string; title?: RichText; name?: string }>>(connectionId, "/search", {
    method: "POST",
    body: { filter: { property: "object", value: "data_source" }, page_size: 50 },
  });
  return res.results.map((d) => ({ id: d.id, title: plain(d.title).trim() || d.name || "Untitled database" }));
}

export async function notionColumns(connectionId: string, dataSourceId: string): Promise<NotionColumn[]> {
  const res = await notionCall<{ properties?: Record<string, { id: string; name?: string; type: string }> }>(
    connectionId,
    `/data_sources/${dataSourceId}`
  );
  return Object.entries(res.properties ?? {}).map(([name, p]) => ({ id: p.id, name: p.name ?? name, type: p.type }));
}

/** Text-ish columns a field can read from. Title is the name column and nothing else. */
const TEXT_TYPES = new Set(["rich_text", "select", "multi_select", "url", "email", "phone_number"]);
const NAME_HINTS: [NotionPersonField, RegExp][] = [
  ["linkedinUrl", /linked\s*in/i],
  ["company", /company|organi[sz]ation|employer|org\b|firm/i],
  ["title", /title|role|position|job/i],
  ["location", /location|city|based|country|where/i],
  ["notes", /notes?|about|context|how we met|bio/i],
  ["email", /e-?mail/i],
  ["phone", /phone|mobile|cell/i],
];

/** A first guess at which column fills which field; the person can change any of them. */
export function guessMapping(columns: NotionColumn[]): NotionMapping {
  const mapping: NotionMapping = {};
  const taken = new Set<string>();
  const take = (field: NotionPersonField, col: NotionColumn | undefined) => {
    if (col && !mapping[field] && !taken.has(col.id)) {
      mapping[field] = col.id;
      taken.add(col.id);
    }
  };
  take("fullName", columns.find((c) => c.type === "title"));
  take("email", columns.find((c) => c.type === "email"));
  take("phone", columns.find((c) => c.type === "phone_number"));
  for (const [field, hint] of NAME_HINTS) {
    take(field, columns.find((c) => TEXT_TYPES.has(c.type) && !taken.has(c.id) && hint.test(c.name)));
  }
  return mapping;
}

type PropertyValue = { id: string; type: string } & Record<string, unknown>;

/** A property's value as one line of text. */
function propertyText(p: PropertyValue | undefined): string {
  if (!p) return "";
  const v = p[p.type];
  switch (p.type) {
    case "title":
    case "rich_text":
      return plain(v).trim();
    case "select":
    case "status":
      return ((v as { name?: string } | null)?.name ?? "").trim();
    case "multi_select":
      return ((v as { name?: string }[] | null) ?? []).map((o) => o.name ?? "").filter(Boolean).join(", ");
    case "url":
    case "email":
    case "phone_number":
      return typeof v === "string" ? v.trim() : "";
    default:
      return "";
  }
}

/** One database row as a `PersonRecord`, read by property id. Null when it has no name. */
export function rowToPerson(row: { properties?: Record<string, PropertyValue> }, mapping: NotionMapping): PersonRecord | null {
  const byId = new Map(Object.values(row.properties ?? {}).map((p) => [p.id, p]));
  const read = (field: NotionPersonField) => {
    const id = mapping[field];
    const text = id ? propertyText(byId.get(id)) : "";
    return text || null;
  };
  const fullName = read("fullName");
  if (!fullName) return null;
  const linkedin = read("linkedinUrl");
  return {
    fullName,
    email: read("email"),
    phone: read("phone"),
    linkedinUrl: linkedin && /linkedin\.com\//i.test(linkedin) ? linkedin : null,
    company: read("company"),
    title: read("title"),
    location: read("location"),
    notes: read("notes"),
  };
}

/** Stop starting new pages after this, then come straight back (`nextSyncAt: now`). */
const PASS_BUDGET_MS = 90_000;

/**
 * The manifest's `sync`: rows of the chosen people database edited since the watermark,
 * through the one ingest writer, which only fills blanks and never overwrites what the person
 * typed in Orbit. Notion's edit times are minute-precise, so the watermark is inclusive and a
 * re-read row is a no-op.
 */
export async function syncNotionPeople(connectionId: string): Promise<void> {
  const conn = await loadConnectorConnection(connectionId);
  if (!conn) return;
  const notion = conn.cursor?.notion;
  if (!notion?.dataSourceId || !notion.mapping?.fullName) {
    await markConnectorSyncResult(conn.id, { ok: true, cursor: conn.cursor });
    return;
  }
  const started = Date.now();
  const cursor: ConnectorSyncCursor = { ...conn.cursor };
  try {
    const ctx = await openIngestContext(conn.userId, { source: "notion", createsContacts: true });
    let start: string | null = null;
    let more = false;
    let firstRead = !conn.cursor?.syncedThrough;
    do {
      const page: NotionList<{ last_edited_time: string; properties?: Record<string, PropertyValue> }> = await notionCall(
        conn.id,
        `/data_sources/${notion.dataSourceId}/query`,
        {
          method: "POST",
          body: {
            page_size: 100,
            sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
            ...(conn.cursor?.syncedThrough
              ? { filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: conn.cursor.syncedThrough } } }
              : {}),
            ...(start ? { start_cursor: start } : {}),
          },
        }
      );
      const people = page.results.map((r) => rowToPerson(r, notion.mapping!)).filter((p): p is PersonRecord => p !== null);
      if (people.length) await ingestPeople(ctx, people);
      const last = page.results.at(-1)?.last_edited_time;
      if (last) cursor.syncedThrough = last;
      start = page.has_more ? page.next_cursor : null;
      if (start && Date.now() - started > PASS_BUDGET_MS) {
        more = true;
        firstRead = false;
        break;
      }
    } while (start);
    await finalizeIngest(ctx, { recalibrate: firstRead });
    await markConnectorSyncResult(conn.id, { ok: true, cursor, ...(more ? { nextSyncAt: new Date() } : {}) });
  } catch (err) {
    // `notionCall` has already flagged a dead grant; anything else the scheduler backs off.
    if (err instanceof NotionReauthError) return;
    throw err;
  }
}
