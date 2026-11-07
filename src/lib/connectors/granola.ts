/**
 * Granola, through its MCP server: sign in once, then every new meeting note runs through
 * capture's own parse and save with no review step — the same unattended rules as the Drive
 * import (`acceptUnattended`) — so the people in the meeting get the interaction at its real
 * time and their AI notes regenerated. Nothing here renders: there is no Granola view.
 *
 * Why MCP and not Granola's REST API: the REST API takes a pasted key and only exists on
 * Business plans; the MCP server signs in with OAuth on every plan (Free sees 30 days).
 *
 * The OAuth client is registered dynamically per connect (Granola supports RFC 7591 and
 * public PKCE clients), so there is no client id to configure per environment — localhost and
 * preview deployments connect the same way production does. The issued `client_id` is kept on
 * the connection's cursor, because a refresh is refused without the client that obtained it.
 */
import { and, desc, eq, inArray, like, notInArray, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  type OAuthServerInfo,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidClientError, InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getDb } from "@/db";
import { captureJobs, contacts, interactions, noteBatches, type ConnectorSyncCursor } from "@/db/schema";
import {
  loadConnectorConnection,
  markConnectorNeedsReauth,
  markConnectorSyncResult,
  storeConnectorTokens,
} from "@/lib/connectors/connections";
import {
  connectedUserEmail,
  externalParticipants,
  mergeMeetingLists,
  nextCursor,
  noteText,
  parseFolders,
  parseMeetings,
  type GranolaFolder,
  type GranolaMeeting,
} from "@/lib/connectors/granola-xml";
import { NO_PEOPLE_OR_DATES_MESSAGE, runCaptureParse } from "@/lib/capture-parse";
import { acceptUnattended } from "@/lib/drive-import-processor";
import { applyDriveReminderRules } from "@/lib/imports/drive-reminder-rules";
import { saveGranolaDirect } from "@/lib/connectors/granola-save";
import { kickEmbeddingBackfill } from "@/lib/embedding-backfill";
import { hashSourceNote } from "@/lib/suggested-reminder-utils";
import { auditUntrustedWrite } from "@/lib/ai-security";
import { UserFacingError } from "@/lib/errors";

export const GRANOLA_MCP_URL = "https://mcp.granola.ai/mcp";
/** Present on the connection while new notes are extracted automatically. */
export const GRANOLA_AUTO_CAPABILITY = "syncEvents";
/** `mcp` is the resource's own scope; `offline_access` is what earns a refresh token. */
const SCOPE = "mcp offline_access";
/** First sync reaches this far back — also all a Free Granola plan can see. */
const BACKFILL_MS = 30 * 86_400_000;
/**
 * Stop starting notes past this. One note is a parse plus a brief per attendee (~20-60 s),
 * and the scheduler runs four connections at once inside a 4.5-minute pass.
 * ponytail: a 30-day backfill drains a couple of notes per 15-minute pass; a dedicated
 * continuation route if backfills ever need to land faster.
 */
const PASS_BUDGET_MS = 90_000;
const REFRESH_MARGIN_MS = 2 * 60_000;

export class GranolaReauthError extends Error {
  constructor(message = "Granola signed Orbit out — reconnect it from Settings") {
    super(message);
    this.name = "GranolaReauthError";
  }
}

let serverInfo: Promise<OAuthServerInfo> | null = null;
function granolaServer(): Promise<OAuthServerInfo> {
  // Cached per instance; a failed discovery is retried next time rather than cached.
  serverInfo ??= discoverOAuthServerInfo(GRANOLA_MCP_URL).catch((err) => {
    serverInfo = null;
    throw err;
  });
  return serverInfo;
}

const resource = () => new URL(GRANOLA_MCP_URL);
const expiresAt = (t: OAuthTokens) => (t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null);

/** Register a client for this callback URL and build the consent URL. */
export async function startGranolaAuthorization(redirectUri: string, state: string) {
  const info = await granolaServer();
  const metadata = info.authorizationServerMetadata;
  const client = await registerClient(info.authorizationServerUrl, {
    metadata,
    clientMetadata: {
      client_name: "Orbit",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    },
  });
  const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
    metadata,
    clientInformation: client,
    redirectUrl: redirectUri,
    scope: SCOPE,
    state,
    resource: resource(),
  });
  return { url: authorizationUrl.toString(), codeVerifier, clientId: client.client_id };
}

/** Code → tokens, then one live call: proves the grant works and names the Granola account. */
export async function finishGranolaAuthorization(input: {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
}) {
  const info = await granolaServer();
  const tokens = await exchangeAuthorization(info.authorizationServerUrl, {
    metadata: info.authorizationServerMetadata,
    clientInformation: { client_id: input.clientId },
    authorizationCode: input.code,
    codeVerifier: input.codeVerifier,
    redirectUri: input.redirectUri,
    resource: resource(),
  });
  const xml = await withGranola(tokens.access_token, (call) => call("list_meetings", { limit: 1 }));
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    tokenExpiresAt: expiresAt(tokens),
    email: connectedUserEmail(xml),
  };
}

type CallTool = (name: string, args: Record<string, unknown>) => Promise<string>;

async function withGranola<T>(accessToken: string, fn: (call: CallTool) => Promise<T>): Promise<T> {
  const client = new Client({ name: "orbit", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(resource(), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  try {
    await client.connect(transport);
    return await fn(async (name, args) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text?: string }>)
        .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
        .join("\n");
      if (res.isError) throw new Error(`Granola ${name} failed: ${text.slice(0, 300)}`);
      return text;
    });
  } catch (err) {
    if (err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)) throw new GranolaReauthError();
    throw err;
  } finally {
    await client.close().catch(() => {});
  }
}

/** A live access token, refreshed (and stored) when it is about to lapse. */
async function freshAccessToken(conn: NonNullable<Awaited<ReturnType<typeof loadConnectorConnection>>>) {
  if (!conn.accessToken) throw new GranolaReauthError();
  const lapsing = conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
  if (!lapsing) return conn.accessToken;
  if (!conn.refreshToken || !conn.cursor?.clientId) throw new GranolaReauthError();
  const info = await granolaServer();
  try {
    const tokens = await refreshAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientInformation: { client_id: conn.cursor.clientId },
      refreshToken: conn.refreshToken,
      resource: resource(),
    });
    await storeConnectorTokens(conn.id, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: expiresAt(tokens),
    });
    return tokens.access_token;
  } catch (err) {
    if (err instanceof InvalidGrantError || err instanceof InvalidClientError) throw new GranolaReauthError();
    throw err;
  }
}

/**
 * Every note changed since `since`, oldest change first — in the chosen folders when there
 * are any (one listing per folder, merged), otherwise every note the user took part in.
 */
async function listChangedMeetings(
  call: CallTool,
  since: string,
  folderIds: string[],
): Promise<{ meetings: GranolaMeeting[]; email: string | null }> {
  let email: string | null = null;
  const listOne = async (folderId: string | null) => {
    const meetings: GranolaMeeting[] = [];
    let cursor: string | null = null;
    do {
      const xml = await call("list_meetings", {
        updated_after: since,
        ...(folderId ? { folder_id: folderId } : { involvement: { captured_by_me: true, listed_as_participant: true } }),
        ...(cursor ? { cursor } : {}),
      });
      email ??= connectedUserEmail(xml);
      meetings.push(...parseMeetings(xml));
      cursor = nextCursor(xml);
    } while (cursor);
    return meetings;
  };
  const lists: GranolaMeeting[][] = [];
  for (const folderId of folderIds.length ? folderIds : [null]) lists.push(await listOne(folderId));
  const meetings = mergeMeetingLists(lists);
  const changed = (m: GranolaMeeting) => m.updatedAt ?? m.meetingAt;
  meetings.sort((a, b) => Date.parse(changed(a)) - Date.parse(changed(b)));
  return { meetings, email };
}

/** The user's Granola folders, for the picker. Empty on Free Granola, which has no folder tools. */
export async function listGranolaFolders(connectionId: string): Promise<GranolaFolder[]> {
  const conn = await loadConnectorConnection(connectionId);
  if (!conn) return [];
  const token = await freshAccessToken(conn);
  return withGranola(token, async (call) => {
    const folders: GranolaFolder[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = parseFolders(await call("list_meeting_folders", { limit: 100, offset }));
      folders.push(...page.folders);
      offset = page.nextOffset;
    }
    return folders;
  });
}

async function alreadyIngested(userId: string, noteId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ id: interactions.id })
    .from(interactions)
    .where(and(eq(interactions.userId, userId), like(interactions.externalId, `granola:${noteId}:%`)))
    .limit(1);
  return Boolean(row);
}

/**
 * One note → capture's parse → unattended decisions → save → fresh AI notes. Returns the
 * contacts it touched; an empty list means the note named nobody worth keeping.
 */
async function ingestNote(userId: string, meeting: GranolaMeeting, ownEmails: string[], now: Date): Promise<string[]> {
  const attendees = externalParticipants(meeting, ownEmails);
  const text = noteText(meeting, attendees);
  // A shared note is text somebody else wrote, saved with no reviewer: worth an audit row.
  auditUntrustedWrite(userId, "granola.import", "note", text);

  let result;
  try {
    result = await runCaptureParse(
      userId,
      text,
      {
        eventDate: meeting.meetingAt.slice(0, 10),
        seedPeople: attendees.map((p) => ({ name: p.name, email: p.email })),
        interactionType: "meeting",
      },
      { now },
    );
  } catch (err) {
    if (err instanceof UserFacingError && err.message === NO_PEOPLE_OR_DATES_MESSAGE) return [];
    throw err;
  }

  const { keep } = applyDriveReminderRules(result.suggestedReminders, now);
  const out = await saveGranolaDirect(userId, {
    result,
    decisions: acceptUnattended(result.items, keep, now.toISOString(), text),
    text,
    sourceHash: hashSourceNote(text),
    granola: { noteId: meeting.id, meetingAt: meeting.meetingAt },
    now,
  });
  return out?.contactIds ?? [];
}

/** The manifest's `sync`: everything changed since the watermark, within the pass budget. */
export async function syncGranola(connectionId: string): Promise<void> {
  const conn = await loadConnectorConnection(connectionId);
  if (!conn) return;
  const started = Date.now();
  const now = new Date();
  const cursor: ConnectorSyncCursor = {
    ...conn.cursor,
    syncedThrough: conn.cursor?.syncedThrough ?? new Date(started - BACKFILL_MS).toISOString(),
  };

  // Automatic extraction is off: notes come in only when picked from the Notes library.
  // The watermark stays put; turning it back on moves it to "now" (`setGranolaAutoExtract`).
  if (!conn.capabilities.includes(GRANOLA_AUTO_CAPABILITY)) {
    await markConnectorSyncResult(conn.id, { ok: true, cursor: conn.cursor });
    return;
  }

  try {
    const token = await freshAccessToken(conn);
    let touched = 0;
    let more = false;
    await withGranola(token, async (call) => {
      const { meetings, email } = await listChangedMeetings(call, cursor.syncedThrough!, cursor.folderIds ?? []);
      const ownEmails = [email, conn.accountRef].filter((e): e is string => Boolean(e));
      for (const listed of meetings) {
        if (Date.now() - started > PASS_BUDGET_MS) {
          more = true;
          break;
        }
        if (!(await alreadyIngested(conn.userId, listed.id))) {
          // `list_meetings` has no note body; `get_meetings` does.
          const [full] = parseMeetings(await call("get_meetings", { meeting_ids: [listed.id], attachments: "none" }));
          if (full) touched += (await ingestNote(conn.userId, { ...full, updatedAt: listed.updatedAt }, ownEmails, now)).length;
        }
        // Just past this note, so a note that named nobody isn't re-parsed every pass if
        // `updated_after` turns out to be inclusive.
        if (listed.updatedAt) cursor.syncedThrough = new Date(Date.parse(listed.updatedAt) + 1).toISOString();
      }
    });
    if (touched) await kickEmbeddingBackfill(conn.userId).catch(() => {});
    await markConnectorSyncResult(conn.id, { ok: true, cursor, ...(more ? { nextSyncAt: new Date() } : {}) });
  } catch (err) {
    if (err instanceof GranolaReauthError) {
      await markConnectorNeedsReauth(conn.id, err.message);
      return;
    }
    // The scheduler records the failure and backs off. The watermark is not saved: the next
    // pass re-lists from the old one, and `alreadyIngested` skips what did land.
    throw err;
  }
}

export type GranolaActivityPerson = { id: string; name: string; firstName: string | null; photo: string | null };

export type GranolaActivity = {
  notes: number;
  people: number;
  recent: Array<{ noteId: string; title: string; at: Date; url: string; people: GranolaActivityPerson[] }>;
};

/**
 * Notes the page can list. It shows five and expands to the rest, so one read serves both.
 * ponytail: a fixed cap, not paging — plenty for a settings page; page it if anyone outgrows it.
 */
const RECENT_NOTES = 50;

/** What Granola has done so far: totals, and the latest notes with the people each updated. */
export async function granolaActivity(userId: string): Promise<GranolaActivity> {
  const db = await getDb();
  const mine = and(eq(interactions.userId, userId), eq(interactions.source, "granola"));
  const [totals] = await db
    .select({
      notes: sql<number>`count(distinct split_part(${interactions.externalId}, ':', 2))`.mapWith(Number),
      people: sql<number>`count(distinct ${interactions.contactId})`.mapWith(Number),
    })
    .from(interactions)
    .where(mine);
  // A note logs one row per person, so a few notes' worth of rows covers the recent five.
  const rows = await db
    .select({
      externalId: interactions.externalId,
      at: interactions.interactionDate,
      contactId: contacts.id,
      name: contacts.fullName,
      firstName: contacts.firstName,
      photo: contacts.profileImageUrl,
      sourceText: noteBatches.sourceText,
    })
    .from(interactions)
    .innerJoin(contacts, eq(contacts.id, interactions.contactId))
    .leftJoin(noteBatches, eq(noteBatches.id, interactions.noteBatchId))
    .where(mine)
    .orderBy(desc(interactions.interactionDate))
    .limit(RECENT_NOTES * 10);

  const recent: GranolaActivity["recent"] = [];
  for (const row of rows) {
    const noteId = row.externalId?.split(":")[1];
    if (!noteId) continue;
    let note = recent.find((n) => n.noteId === noteId);
    if (!note) {
      if (recent.length === RECENT_NOTES) continue;
      // `noteText` opens with "Meeting: <title>".
      const title = row.sourceText?.match(/^Meeting: (.*)$/m)?.[1]?.trim() || "Granola note";
      note = { noteId, title, at: row.at, url: `https://notes.granola.ai/d/${encodeURIComponent(noteId)}`, people: [] };
      recent.push(note);
    }
    if (!note.people.some((p) => p.id === row.contactId)) {
      note.people.push({ id: row.contactId, name: row.name, firstName: row.firstName, photo: row.photo });
    }
  }
  return { notes: totals?.notes ?? 0, people: totals?.people ?? 0, recent };
}

export type GranolaPickable = { id: string; title: string; meetingAt: string; attendees: string[] };

const PICK_PAGE = 25;

/**
 * One page of the Notes library popup: the last 30 days' notes, newest first, minus any
 * already in Orbit — logged on someone (`granola:<id>:…`), or picked earlier and still
 * reading, waiting for review, or saved. A discarded or failed pick shows again.
 *
 * Every note the user can see, not only the synced folders: this is "what could I pick".
 * A page can come back short, even empty, with a cursor — Load more continues it.
 */
export async function listGranolaPickable(
  connectionId: string,
  cursor: string | null,
): Promise<{ notes: GranolaPickable[]; nextCursor: string | null }> {
  const conn = await loadConnectorConnection(connectionId);
  if (!conn) return { notes: [], nextCursor: null };
  const token = await freshAccessToken(conn);
  const xml = await withGranola(token, (call) =>
    call("list_meetings", {
      time_range: "last_30_days",
      involvement: { captured_by_me: true, listed_as_participant: true },
      limit: PICK_PAGE,
      ...(cursor ? { cursor } : {}),
    }),
  );
  const meetings = parseMeetings(xml);
  const own = [connectedUserEmail(xml), conn.accountRef];
  const taken = await takenGranolaNotes(conn.userId, meetings.map((m) => m.id));
  return {
    notes: meetings
      .filter((m) => !taken.has(m.id))
      .map((m) => ({
        id: m.id,
        title: m.title || "Untitled meeting",
        meetingAt: m.meetingAt,
        attendees: externalParticipants(m, own).map((p) => p.name ?? p.email),
      })),
    nextCursor: nextCursor(xml),
  };
}

/** Of these note ids, the ones already in Orbit or already picked (see `listGranolaPickable`). */
export async function takenGranolaNotes(userId: string, noteIds: string[]): Promise<Set<string>> {
  if (!noteIds.length) return new Set();
  const db = await getDb();
  const noteOf = sql<string>`split_part(${interactions.externalId}, ':', 2)`;
  const [logged, picked] = await Promise.all([
    db
      .selectDistinct({ id: noteOf })
      .from(interactions)
      .where(and(eq(interactions.userId, userId), eq(interactions.source, "granola"), inArray(noteOf, noteIds))),
    db
      .select({ id: sql<string>`${captureJobs.inputHints}->'granola'->>'noteId'` })
      .from(captureJobs)
      .where(
        and(
          eq(captureJobs.userId, userId),
          eq(captureJobs.sourceKind, "granola"),
          notInArray(captureJobs.status, ["discarded", "failed"]),
          inArray(sql`${captureJobs.inputHints}->'granola'->>'noteId'`, noteIds),
        ),
      ),
  ]);
  return new Set([...logged, ...picked].map((r) => r.id));
}

/** One note, whole, plus who "you" are in it — for a pick from the Notes library. */
export async function fetchGranolaNote(
  connectionId: string,
  noteId: string,
): Promise<{ meeting: GranolaMeeting; ownEmails: string[] } | null> {
  const conn = await loadConnectorConnection(connectionId);
  if (!conn) return null;
  const token = await freshAccessToken(conn);
  const xml = await withGranola(token, (call) => call("get_meetings", { meeting_ids: [noteId], attachments: "none" }));
  const [meeting] = parseMeetings(xml);
  if (!meeting || meeting.id !== noteId) return null;
  return { meeting, ownEmails: [connectedUserEmail(xml), conn.accountRef].filter((e): e is string => Boolean(e)) };
}
