import type {
  EventRosterResponse,
  ExtensionResponse,
  FollowUpRequest,
  FollowUpResponse,
  LogInteractionRequest,
  LogInteractionResponse,
  MeResponse,
  PageContext,
  ParseResponse,
  ResolveResponse,
  SaveActivityRequest,
  SaveActivityResponse,
  SaveContactRequest,
  SaveContactResponse,
  StartersRequest,
  StartersResponse,
} from "@contract";
import { API_BASE, DEV_SECRET } from "./env";

export class ApiError extends Error {
  code: string;
  retryAfterSeconds?: number;
  candidates?: unknown;
  status: number;

  constructor(
    status: number,
    code: string,
    message: string,
    extra?: { retryAfterSeconds?: number; candidates?: unknown }
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = extra?.retryAfterSeconds;
    this.candidates = extra?.candidates;
  }
}

export type TokenGetter = () => Promise<string | null>;

/**
 * Which build is talking, so the server can tell installs and versions apart
 * (`extension_usage.version`, `extension_installed`). The manifest's own version, three plain
 * numbers; null where there is no extension runtime (the design preview in a normal tab), in
 * which case the header is simply not sent.
 */
export function extensionVersion(): string | null {
  try {
    const version = chrome.runtime.getManifest().version;
    return /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Set by the service worker on install and cleared once the server has seen it. The first
 * `/me` after install carries `X-Orbit-Install: 1`, which is how the server learns this
 * account installed the extension; every later `/me` is just a session probe.
 */
export const INSTALL_PENDING_KEY = "orbitInstallPending";

async function installPending(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(INSTALL_PENDING_KEY);
    return stored[INSTALL_PENDING_KEY] === true;
  } catch {
    return false;
  }
}

async function clearInstallPending(): Promise<void> {
  try {
    await chrome.storage.local.remove(INSTALL_PENDING_KEY);
  } catch {
    // The marker stays and the next /me sends it again; the server counts an account once.
  }
}

async function request<T>(
  path: string,
  init: RequestInit,
  getToken: TokenGetter,
  signal?: AbortSignal
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const version = extensionVersion();
  if (version) headers.set("x-orbit-extension-version", version);

  const token = await getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  else if (DEV_SECRET) headers.set("x-orbit-dev-secret", DEV_SECRET);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers, signal });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError(0, "offline", "Orbit is unreachable.");
  }

  let payload: ExtensionResponse<T>;
  try {
    payload = (await res.json()) as ExtensionResponse<T>;
  } catch {
    throw new ApiError(res.status, "server_error", "Orbit sent an unreadable response.");
  }

  if (!payload.ok) {
    throw new ApiError(res.status, payload.error.code, payload.error.message, {
      retryAfterSeconds: payload.error.retryAfterSeconds,
      candidates: payload.error.candidates,
    });
  }
  return payload.data;
}

export function createApi(getToken: TokenGetter) {
  const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }, getToken, signal);

  return {
    me: async (signal?: AbortSignal) => {
      const install = await installPending();
      const me = await request<MeResponse>(
        "/me",
        { method: "GET", headers: install ? { "x-orbit-install": "1" } : undefined },
        getToken,
        signal
      );
      // Only after the server answered: a failed or signed-out probe must not eat the marker.
      if (install) void clearInstallPending();
      return me;
    },

    resolve: (page: PageContext, signal?: AbortSignal) =>
      post<ResolveResponse>("/resolve", { page }, signal),

    parseProfile: (page: PageContext, signal?: AbortSignal) =>
      post<ParseResponse>("/parse", { page }, signal),

    saveEventRoster: (page: PageContext, signal?: AbortSignal) =>
      post<EventRosterResponse>("/event-roster", { page }, signal),

    starters: (body: StartersRequest, signal?: AbortSignal) =>
      post<StartersResponse>("/starters", body, signal),

    saveContact: (body: SaveContactRequest, signal?: AbortSignal) =>
      post<SaveContactResponse>("/contacts", body, signal),

    logInteraction: (body: LogInteractionRequest, signal?: AbortSignal) =>
      post<LogInteractionResponse>("/interactions", body, signal),

    followUp: (body: FollowUpRequest, signal?: AbortSignal) =>
      post<FollowUpResponse>("/follow-ups", body, signal),

    saveActivity: (body: SaveActivityRequest, signal?: AbortSignal) =>
      post<SaveActivityResponse>("/signals", body, signal),

    // GET /contacts?q= exists server-side but has no client here yet: it is
    // the seam for a future "link this page to an existing contact" flow.
  };
}

export type OrbitApi = ReturnType<typeof createApi>;
