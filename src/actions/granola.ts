"use server";

import { randomUUID } from "crypto";
import { cookies, headers } from "next/headers";
import { requireSyncUser } from "@/lib/plan-guards";
import { deleteConnectorConnection, getConnectorConnection } from "@/lib/connectors/connections";
import { startGranolaAuthorization } from "@/lib/connectors/granola";

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

export async function getGranolaConnection() {
  const userId = await requireSyncUser();
  return getConnectorConnection(userId, "granola");
}

export async function disconnectGranola(): Promise<void> {
  const userId = await requireSyncUser();
  await deleteConnectorConnection(userId, "granola");
}
