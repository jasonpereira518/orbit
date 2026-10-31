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
} from "@/lib/connectors/connections";
import {
  granolaActivity,
  listGranolaFolders,
  startGranolaAuthorization,
  type GranolaActivity,
} from "@/lib/connectors/granola";
import type { GranolaFolder } from "@/lib/connectors/granola-xml";
import { kickSyncPass } from "@/lib/sync-kick";
import { reportError } from "@/lib/report-error";
import { UserFacingError } from "@/lib/errors";

const FLOW_COOKIE = "orbit_granola_oauth";

/** The callback this deployment registers. Localhost and previews derive their own. */
async function callbackUrl(): Promise<string> {
  if (process.env.APP_BASE_URL) return new URL("/api/granola/callback", process.env.APP_BASE_URL).href;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/api/granola/callback`;
}

type GranolaFlow = { state: string; userId: string; codeVerifier: string; clientId: string; redirectUri: string };

export async function startGranolaConnect(): Promise<{ url: string }> {
  const userId = await requireSyncUser();
  const redirectUri = await callbackUrl();
  const state = randomUUID();
  const { url, codeVerifier, clientId } = await startGranolaAuthorization(redirectUri, state);
  // The PKCE verifier never leaves the server side of this browser: httpOnly, single-use.
  (await cookies()).set(
    FLOW_COOKIE,
    JSON.stringify({ state, userId, codeVerifier, clientId, redirectUri } satisfies GranolaFlow),
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
  activity: GranolaActivity;
};

/** Everything the settings page shows, except the folder list (a live Granola call). */
export async function getGranolaPanel(): Promise<GranolaPanel> {
  const userId = await requireSyncUser();
  const connection = await getConnectorConnection(userId, "granola");
  if (!connection) return { connection, folderIds: [], activity: { notes: 0, people: 0, recent: [] } };
  const [full, activity] = await Promise.all([loadConnectorConnection(connection.id), granolaActivity(userId)]);
  return { connection, folderIds: full?.cursor?.folderIds ?? [], activity };
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
