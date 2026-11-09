"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { requireUserForReleasedSurface } from "@/lib/plan-guards";
import { NOTION_SURFACE_KEY } from "@/lib/surfaces";
import { buildAuthorizeUrl } from "@/lib/connectors/oauth";
import {
  armConnectorSync,
  deleteConnectorConnection,
  getConnectorConnection,
  loadConnectorConnection,
} from "@/lib/connectors/connections";
import {
  guessMapping,
  listNotionDataSources,
  NotionReauthError,
  notionColumns,
  notionPageText,
  revokeNotionToken,
  searchNotionPages,
  type NotionColumn,
  type NotionDataSource,
  type NotionMapping,
  type NotionPickable,
} from "@/lib/connectors/notion";
import { kickSyncPass } from "@/lib/sync-kick";
import { createCaptureFromText, startCaptureRuns } from "@/lib/cloud-notes/extract";
import { CAPTURE_INPUT_MAX_CHARS } from "@/lib/capture/limits";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import { asActionResult, UserFacingError, type ActionResult } from "@/lib/errors";
import { safeReturnPath } from "@/lib/safe-return-path";
import { integrationHref } from "@/components/settings/sections";
import type { NotionCursor, NotionPersonField } from "@/db/schema";

const requireNotionUser = () => requireUserForReleasedSurface(NOTION_SURFACE_KEY);

/** The callback this deployment registers with Notion. Localhost and previews derive their own. */
async function callbackUrl(): Promise<string> {
  if (process.env.APP_BASE_URL) return new URL("/api/notion/callback", process.env.APP_BASE_URL).href;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/api/notion/callback`;
}

/**
 * Notion's consent screen, where the person also picks which pages and databases Orbit may
 * read. Reconnecting is how they change that choice. `returnTo`: an in-app path to land on.
 */
export async function startNotionConnect(returnTo?: string | null): Promise<ActionResult<{ url: string }>> {
  const userId = await requireNotionUser();
  return asActionResult(async () => {
    // Said plainly, not as "couldn't reach Notion": the fix is on this server, not at Notion.
    if (!process.env.NOTION_CLIENT_ID || !process.env.NOTION_CLIENT_SECRET) {
      throw new UserFacingError("Notion isn’t set up on this server yet: add NOTION_CLIENT_ID and NOTION_CLIENT_SECRET");
    }
    const url = buildAuthorizeUrl("notion", {
      userId,
      redirectUri: await callbackUrl(),
      scopes: [],
      returnTo: safeReturnPath(returnTo) ?? integrationHref("notion"),
    });
    return { url };
  });
}

export type NotionPanel = {
  connection: Awaited<ReturnType<typeof getConnectorConnection>>;
  workspace: NotionCursor | null;
};

export async function getNotionPanel(): Promise<NotionPanel> {
  const userId = await requireNotionUser();
  const connection = await getConnectorConnection(userId, "notion");
  if (!connection) return { connection, workspace: null };
  const full = await loadConnectorConnection(connection.id);
  return { connection, workspace: full?.cursor?.notion ?? null };
}

/** Revoke at Notion (best effort), then forget the grant. Imported notes and contacts stay. */
export async function disconnectNotion(): Promise<void> {
  const userId = await requireNotionUser();
  const connection = await getConnectorConnection(userId, "notion");
  if (!connection) return;
  const token = (await loadConnectorConnection(connection.id))?.accessToken;
  if (token) await revokeNotionToken(token);
  await deleteConnectorConnection(userId, "notion");
}

export type NotionPickerState = { state: "not_connected" } | { state: "needs_reauth" } | { state: "connected" };

/** What Capture's "From Notion" button needs before it opens anything. */
export async function getNotionPickerState(): Promise<NotionPickerState> {
  const userId = await requireNotionUser();
  const connection = await getConnectorConnection(userId, "notion");
  if (!connection) return { state: "not_connected" };
  return { state: connection.status === "needs_reauth" ? "needs_reauth" : "connected" };
}

const reauthCopy = (err: unknown) =>
  err instanceof NotionReauthError ? new UserFacingError("Notion signed Orbit out — reconnect it") : err;

/** One page of the person's shared Notion pages, newest edit first, optionally searched. */
export async function getNotionPickable(
  query = "",
  cursor: string | null = null,
): Promise<ActionResult<{ pages: NotionPickable[]; nextCursor: string | null }>> {
  const userId = await requireNotionUser();
  return asActionResult(async () => {
    const connection = await getConnectorConnection(userId, "notion");
    if (!connection) throw new UserFacingError("Connect Notion first");
    try {
      return await searchNotionPages(
        connection.id,
        typeof query === "string" ? query.slice(0, 200) : "",
        typeof cursor === "string" && cursor.length <= 2048 ? cursor : null,
      );
    } catch (err) {
      throw reauthCopy(err);
    }
  });
}

const PAGE_ID = /^[0-9a-f-]{32,36}$/i;
const BATCH_ID = /^[\w-]{8,64}$/;

/**
 * One picked page becomes one capture job through the same path as a Drive or OneDrive doc:
 * nothing saves until the person reviews the cards. The text hash is the dedupe, so an
 * unchanged page is "already in Orbit" and an edited one can be captured again.
 */
export async function queueNotionPage(input: {
  pageId: string;
  batchGroupId: string;
}): Promise<ActionResult<{ status: "queued" | "duplicate"; jobId: string }>> {
  const userId = await requireNotionUser();
  return asActionResult(async () => {
    if (!PAGE_ID.test(input?.pageId ?? "")) throw new UserFacingError("Pick a Notion page to extract");
    if (typeof input.batchGroupId !== "string" || !BATCH_ID.test(input.batchGroupId)) {
      throw new UserFacingError("Couldn’t start that — try picking the pages again");
    }
    const connection = await getConnectorConnection(userId, "notion");
    if (!connection) throw new UserFacingError("Connect Notion first");
    await consumeBucket("capture", userId, RATE_LIMITS.capture);
    let page;
    try {
      page = await notionPageText(connection.id, input.pageId, CAPTURE_INPUT_MAX_CHARS);
    } catch (err) {
      throw reauthCopy(err);
    }
    if (page.text.trim().length <= page.title.length + 4) throw new UserFacingError(`“${page.title}” has no text to read`);
    const outcome = await createCaptureFromText(userId, { text: page.text, label: page.title, batchGroupId: input.batchGroupId, provider: "notion" });
    if (outcome.status === "queued") after(() => startCaptureRuns([outcome.jobId]));
    return outcome;
  });
}

async function activeConnection(userId: string) {
  const connection = await getConnectorConnection(userId, "notion");
  if (!connection) throw new UserFacingError("Connect Notion first");
  return connection;
}

/** The databases shared with Orbit, for "Sync a people database". */
export async function getNotionDatabases(): Promise<ActionResult<NotionDataSource[]>> {
  const userId = await requireNotionUser();
  return asActionResult(async () => {
    const connection = await activeConnection(userId);
    try {
      return await listNotionDataSources(connection.id);
    } catch (err) {
      throw reauthCopy(err);
    }
  });
}

/** One database's columns, and a first guess at which fills which contact field. */
export async function getNotionColumns(
  dataSourceId: string,
): Promise<ActionResult<{ columns: NotionColumn[]; guess: NotionMapping }>> {
  const userId = await requireNotionUser();
  return asActionResult(async () => {
    if (!PAGE_ID.test(dataSourceId ?? "")) throw new UserFacingError("Pick a Notion database");
    const connection = await activeConnection(userId);
    try {
      const columns = await notionColumns(connection.id, dataSourceId);
      return { columns, guess: guessMapping(columns) };
    } catch (err) {
      throw reauthCopy(err);
    }
  });
}

const FIELDS: readonly NotionPersonField[] = ["fullName", "email", "phone", "linkedinUrl", "company", "title", "location", "notes"];
/** Notion property ids are short opaque strings; they are only ever compared, never sent anywhere. */
const isColumnId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 64;

/**
 * Sync this database into contacts with this column mapping (null stops syncing). A new
 * choice reads the whole database again; rows already in Orbit only fill blanks.
 */
export async function setNotionDatabase(
  choice: { dataSourceId: string; title: string; mapping: NotionMapping } | null,
): Promise<ActionResult<null>> {
  const userId = await requireNotionUser();
  return asActionResult(async () => {
    const connection = await activeConnection(userId);
    const full = await loadConnectorConnection(connection.id);
    const notion: NotionCursor = full?.cursor?.notion ?? { workspaceId: null, workspaceName: null, workspaceIcon: null };
    if (!choice) {
      await armConnectorSync(userId, "notion", { ...full?.cursor, notion: { ...notion, dataSourceId: null, dataSourceTitle: null, mapping: null } });
      return null;
    }
    if (!PAGE_ID.test(choice.dataSourceId ?? "")) throw new UserFacingError("Pick a Notion database");
    const mapping: NotionMapping = {};
    for (const field of FIELDS) {
      const id = choice.mapping?.[field];
      if (isColumnId(id)) mapping[field] = id;
    }
    if (!mapping.fullName) throw new UserFacingError("Choose the column that holds each person’s name");
    await armConnectorSync(userId, "notion", {
      ...full?.cursor,
      syncedThrough: null,
      notion: { ...notion, dataSourceId: choice.dataSourceId, dataSourceTitle: String(choice.title ?? "").slice(0, 200), mapping },
    });
    after(() => kickSyncPass());
    return null;
  });
}

export async function syncNotionNow(): Promise<void> {
  const userId = await requireNotionUser();
  await armConnectorSync(userId, "notion");
  after(() => kickSyncPass());
}
