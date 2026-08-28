import type {
  ContactSearchResponse,
  ExtensionResponse,
  FollowUpRequest,
  FollowUpResponse,
  LogInteractionRequest,
  LogInteractionResponse,
  MeResponse,
  PageContext,
  ParseResponse,
  ResolveResponse,
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

async function request<T>(
  path: string,
  init: RequestInit,
  getToken: TokenGetter,
  signal?: AbortSignal
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");

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
    me: (signal?: AbortSignal) =>
      request<MeResponse>("/me", { method: "GET" }, getToken, signal),

    resolve: (page: PageContext, signal?: AbortSignal) =>
      post<ResolveResponse>("/resolve", { page }, signal),

    parseProfile: (page: PageContext, signal?: AbortSignal) =>
      post<ParseResponse>("/parse", { page }, signal),

    starters: (body: StartersRequest, signal?: AbortSignal) =>
      post<StartersResponse>("/starters", body, signal),

    saveContact: (body: SaveContactRequest, signal?: AbortSignal) =>
      post<SaveContactResponse>("/contacts", body, signal),

    logInteraction: (body: LogInteractionRequest, signal?: AbortSignal) =>
      post<LogInteractionResponse>("/interactions", body, signal),

    followUp: (body: FollowUpRequest, signal?: AbortSignal) =>
      post<FollowUpResponse>("/follow-ups", body, signal),

    searchContacts: (q: string, signal?: AbortSignal) =>
      request<ContactSearchResponse>(
        `/contacts?q=${encodeURIComponent(q)}`,
        { method: "GET" },
        getToken,
        signal
      ),
  };
}

export type OrbitApi = ReturnType<typeof createApi>;
