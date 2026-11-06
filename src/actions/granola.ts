"use server";

import { randomUUID } from "crypto";
import { cookies, headers } from "next/headers";
import { after } from "next/server";
import { requireSyncUser } from "@/lib/plan-guards";
import {
  armConnectorSync,
  deleteConnectorConnection,
  getConnectorConnection,
  loadConnectorConnection,
  setConnectorCapabilities,
} from "@/lib/connectors/connections";
import {
  fetchGranolaNote,
  GRANOLA_AUTO_CAPABILITY,
  GranolaReauthError,
  granolaActivity,
  listGranolaFolders,
  listGranolaPickable,
  startGranolaAuthorization,
  takenGranolaNotes,
  type GranolaActivity,
  type GranolaPickable,
} from "@/lib/connectors/granola";
import { externalParticipants, noteText, type GranolaFolder } from "@/lib/connectors/granola-xml";
import { granolaJobHints } from "@/lib/connectors/granola-save";
import { createCaptureJob } from "@/lib/capture-jobs";
import { runCaptureJobById } from "@/lib/capture-job-runner";
import { auditUntrustedWrite } from "@/lib/ai-security";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import { safeReturnPath } from "@/lib/safe-return-path";
import { kickSyncPass } from "@/lib/sync-kick";
import { reportError } from "@/lib/report-error";
import { asActionResult, UserFacingError, type ActionResult } from "@/lib/errors";

const FLOW_COOKIE = "orbit_granola_oauth";

/** The callback this deployment registers. Localhost and previews derive their own. */
async function callbackUrl(): Promise<string> {
  if (process.env.APP_BASE_URL) return new URL("/api/granola/callback", process.env.APP_BASE_URL).href;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/api/granola/callback`;
}

type GranolaFlow = {
  state: string;
  userId: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  /** Where the callback lands; null is the Granola settings page. */
  returnTo: string | null;
};

/** `returnTo`: an in-app path to come back to (Capture opens its picker); anything else is dropped. */
export async function startGranolaConnect(returnTo?: string | null): Promise<{ url: string }> {
  const userId = await requireSyncUser();
  const redirectUri = await callbackUrl();
  const state = randomUUID();
  const { url, codeVerifier, clientId } = await startGranolaAuthorization(redirectUri, state);
  // The PKCE verifier never leaves the server side of this browser: httpOnly, single-use.
  (await cookies()).set(
    FLOW_COOKIE,
    JSON.stringify({
      state,
      userId,
      codeVerifier,
      clientId,
      redirectUri,
      returnTo: safeReturnPath(returnTo),
    } satisfies GranolaFlow),
    { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 600 },
  );
  return { url };
}

/** Read once and delete. Throws unless `state` is the one this browser started with. */
export async function consumeGranolaFlow(state: string | null): Promise<GranolaFlow> {
  const jar = await cookies();
  const raw = jar.get(FLOW_COOKIE)?.value;
  jar.delete(FLOW_COOKIE);
  const flow = raw ? (JSON.parse(raw) as GranolaFlow) : null;
  if (!state || !flow || flow.state !== state) throw new Error("Invalid OAuth state");
  return flow;
}

export type GranolaPanel = {
  connection: Awaited<ReturnType<typeof getConnectorConnection>>;
  /** The folders being synced; empty means every note. */
  folderIds: string[];
  /** New notes are extracted on their own (see `setGranolaAutoExtract`). */
  autoExtract: boolean;
  activity: GranolaActivity;
};

/** Everything the settings page shows, except the folder list (a live Granola call). */
export async function getGranolaPanel(): Promise<GranolaPanel> {
  const userId = await requireSyncUser();
  const connection = await getConnectorConnection(userId, "granola");
  if (!connection) {
    return { connection, folderIds: [], autoExtract: false, activity: { notes: 0, people: 0, recent: [] } };
  }
  const [full, activity] = await Promise.all([loadConnectorConnection(connection.id), granolaActivity(userId)]);
  return {
    connection,
    folderIds: full?.cursor?.folderIds ?? [],
    autoExtract: connection.capabilities.includes(GRANOLA_AUTO_CAPABILITY),
    activity,
  };
}

/**
 * The user's Granola folders, or null when Granola won't list them — Free plans have no folder
 * tools, and an outage shouldn't break the page; the picker then offers "All notes" only.
 */
export async function getGranolaFolders(): Promise<GranolaFolder[] | null> {
  const userId = await requireSyncUser();
  const connection = await getConnectorConnection(userId, "granola");
  if (!connection || connection.status !== "active") return null;
  try {
    return await listGranolaFolders(connection.id);
  } catch (err) {
    reportError(err, { where: "action.granola.folders", userId, level: "warning" });
    return null;
  }
}

const MAX_FOLDERS = 50;

/**
 * Sync only these folders (empty: every note). The look-back restarts at 30 days so notes in a
 * newly chosen folder aren't skipped for predating the watermark; notes already logged are
 * skipped by the sync itself, so nothing is logged twice.
 */
export async function setGranolaFolders(folderIds: string[]): Promise<void> {
  const userId = await requireSyncUser();
  if (!Array.isArray(folderIds) || folderIds.length > MAX_FOLDERS) {
    throw new UserFacingError(`Pick up to ${MAX_FOLDERS} folders`);
  }
  const ids = [...new Set(folderIds.filter((id) => typeof id === "string" && /^[\w-]{1,100}$/.test(id)))];
  const connection = await getConnectorConnection(userId, "granola");
  if (!connection) throw new UserFacingError("Connect Granola first");
  const full = await loadConnectorConnection(connection.id);
  await armConnectorSync(userId, "granola", { clientId: full?.cursor?.clientId ?? null, folderIds: ids });
  after(() => kickSyncPass());
}

export async function syncGranolaNow(): Promise<void> {
  const userId = await requireSyncUser();
  await armConnectorSync(userId, "granola");
  after(() => kickSyncPass());
}

export async function disconnectGranola(): Promise<void> {
  const userId = await requireSyncUser();
  await deleteConnectorConnection(userId, "granola");
}

/**
 * Automatic extraction on or off: the connection's `syncEvents` capability. Off, notes come in
 * only when picked in the Notes library. Back on, it starts from now — notes from while it was
 * off stay in the picker for choosing by hand, rather than all landing at once.
 */
export async function setGranolaAutoExtract(on: boolean): Promise<void> {
  const userId = await requireSyncUser();
  const connection = await getConnectorConnection(userId, "granola");
  if (!connection) throw new UserFacingError("Connect Granola first");
  if (on) {
    const full = await loadConnectorConnection(connection.id);
    await armConnectorSync(userId, "granola", { ...full?.cursor, syncedThrough: new Date().toISOString() });
  }
  await setConnectorCapabilities(userId, "granola", on ? [GRANOLA_AUTO_CAPABILITY] : []);
}

export type GranolaPickerState =
  | { state: "not_connected" }
  | { state: "needs_reauth" }
  | { state: "connected"; autoExtract: boolean };

/** What the Notes library's Granola button needs before it opens anything. */
export async function getGranolaPickerState(): Promise<GranolaPickerState> {
  const userId = await requireSyncUser();
  const connection = await getConnectorConnection(userId, "granola");
  if (!connection) return { state: "not_connected" };
  if (connection.status === "needs_reauth") return { state: "needs_reauth" };
  return { state: "connected", autoExtract: connection.capabilities.includes(GRANOLA_AUTO_CAPABILITY) };
}

/** One page of notes not yet in Orbit, for the picker. */
export async function getGranolaPickable(
  cursor: string | null = null,
): Promise<ActionResult<{ notes: GranolaPickable[]; nextCursor: string | null }>> {
  const userId = await requireSyncUser();
  return asActionResult(async () => {
    const connection = await getConnectorConnection(userId, "granola");
    if (!connection) throw new UserFacingError("Connect Granola first");
    try {
      return await listGranolaPickable(connection.id, typeof cursor === "string" && cursor.length <= 2048 ? cursor : null);
    } catch (err) {
      if (err instanceof GranolaReauthError) throw new UserFacingError("Granola signed Orbit out — sign in again");
      throw err;
    }
  });
}

const NOTE_ID = /^[\w-]{6,100}$/;
const BATCH_ID = /^[\w-]{8,64}$/;

/**
 * One note picked in the Notes library becomes one capture job. The job's runner saves the
 * people already in Orbit straight away and leaves the new ones for review
 * (`saveConfidentGranolaPeople`); every save of it is logged as Granola's, at the real time.
 */
export async function queueGranolaCapture(input: {
  noteId: string;
  batchGroupId: string;
}): Promise<ActionResult<{ status: "queued" | "duplicate"; jobId: string | null }>> {
  const userId = await requireSyncUser();
  return asActionResult(async () => {
    if (!NOTE_ID.test(input?.noteId ?? "")) throw new UserFacingError("Pick a Granola note to extract");
    if (typeof input.batchGroupId !== "string" || !BATCH_ID.test(input.batchGroupId)) {
      throw new UserFacingError("Couldn’t start that — try picking the notes again");
    }
    const connection = await getConnectorConnection(userId, "granola");
    if (!connection) throw new UserFacingError("Connect Granola first");
    await consumeBucket("capture", userId, RATE_LIMITS.capture);
    // Picked twice (two tabs, a double click) or already logged: not read again.
    if ((await takenGranolaNotes(userId, [input.noteId])).has(input.noteId)) return { status: "duplicate", jobId: null };

    let note;
    try {
      note = await fetchGranolaNote(connection.id, input.noteId);
    } catch (err) {
      if (err instanceof GranolaReauthError) throw new UserFacingError("Granola signed Orbit out — sign in again");
      throw err;
    }
    if (!note) throw new UserFacingError("That note isn’t in Granola any more");
    const { meeting, ownEmails } = note;
    const attendees = externalParticipants(meeting, ownEmails);
    const text = noteText(meeting, attendees);
    // People already in Orbit are saved from this with no review, and a shared note is text
    // somebody else wrote: worth an audit row, like the sync.
    auditUntrustedWrite(userId, "granola.pick", "note", text);

    const row = await createCaptureJob(userId, {
      sourceKind: "granola",
      status: "queued",
      inputText: text,
      inputHints: granolaJobHints({
        eventDate: meeting.meetingAt.slice(0, 10),
        seedPeople: attendees.map((p) => ({ name: p.name, email: p.email })),
        interactionType: "meeting",
        granola: { noteId: meeting.id, meetingAt: meeting.meetingAt },
      }),
      batchGroupId: input.batchGroupId,
      sourceLabel: (meeting.title || "Granola note").slice(0, 200),
    });
    after(() => runCaptureJobById(row.id).catch(() => null));
    return { status: "queued", jobId: row.id };
  });
}
