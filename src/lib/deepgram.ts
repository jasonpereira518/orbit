/**
 * Deepgram — Orbit's own speech-to-text key.
 *
 * THIS IS THE ONLY FILE THAT READS `DEEPGRAM_API_KEY` (or `DEEPGRAM_PROJECT_ID`, needed only
 * by `fetchDeepgramUsage`) — enforced by the source guard in `scripts/smoke-ai-access.ts`. The
 * browser never sees the key: live transcription runs on 30-second grant tokens minted here
 * (`mintStreamToken`), which are good for opening one connection and nothing else.
 *
 * Deliberately NOT part of `ai-access.ts`. That gate arbitrates LLM provider keys, where the
 * rule is bring-your-own and Orbit's managed keys are Lifetime-only and currently switched
 * off. Deepgram is a hosted service Orbit pays for on every plan, like hosted Apollo
 * enrichment: entitlement plus quota, checked by the caller, recorded in `speech_usage`.
 */
import { listenParams } from "@/lib/deepgram-params";
import { UserFacingError } from "@/lib/errors";

const GRANT_URL = "https://api.deepgram.com/v1/auth/grant";
const LISTEN_URL = "https://api.deepgram.com/v1/listen";
const PROJECTS_URL = "https://api.deepgram.com/v1/projects";
const DEFAULT_TTL_SECONDS = 30;
const FILE_TIMEOUT_MS = 90_000;
const USAGE_TIMEOUT_MS = 15_000;
/** Documented range is [1, 1000]; the max keeps a day's worth of meetings to one or two pages. */
const USAGE_PAGE_LIMIT = 1000;
/** Belt-and-suspenders against an API that never stops saying "one more page". */
const USAGE_MAX_PAGES = 50;

function apiKey(): string | null {
  return process.env.DEEPGRAM_API_KEY?.trim() || null;
}

function projectId(): string | null {
  return process.env.DEEPGRAM_PROJECT_ID?.trim() || null;
}

export function deepgramConfigured(): boolean {
  return Boolean(apiKey());
}

/** The kill switch: `ORBIT_DEEPGRAM=off` reverts every surface to the Whisper/Gemini chain. */
export function deepgramEnabled(): boolean {
  if (process.env.ORBIT_DEEPGRAM?.trim().toLowerCase() === "off") return false;
  return deepgramConfigured();
}

function requireKey(): string {
  const key = apiKey();
  if (!key) throw new UserFacingError("Transcription isn’t configured on this deployment");
  return key;
}

export async function mintStreamToken(
  opts: { ttlSeconds?: number } = {},
): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch(GRANT_URL, {
    method: "POST",
    headers: { Authorization: `Token ${requireKey()}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl_seconds: opts.ttlSeconds ?? DEFAULT_TTL_SECONDS }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Deepgram grant failed: ${res.status}`);
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Deepgram grant returned no token");
  return { accessToken: body.access_token, expiresIn: body.expires_in ?? DEFAULT_TTL_SECONDS };
}

export type DeepgramFileResult = { text: string; seconds: number; requestId: string | null };

export async function transcribeFile(
  audio: { bytes: Uint8Array; mimeType: string },
  opts: { keyterms?: readonly string[] } = {},
): Promise<DeepgramFileResult> {
  const params = listenParams({ live: false, keyterms: opts.keyterms });
  const res = await fetch(`${LISTEN_URL}?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Token ${requireKey()}`, "content-type": audio.mimeType || "audio/wav" },
    body: audio.bytes as unknown as BodyInit,
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Deepgram transcription failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    metadata?: { duration?: number; request_id?: string };
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };
  return {
    text: body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "",
    seconds: Math.ceil(body.metadata?.duration ?? 0),
    requestId: body.metadata?.request_id ?? null,
  };
}

type DeepgramRequestsPage = {
  requests?: Array<{
    response?: {
      details?: {
        duration?: number;
        /** Whatever `tag` was on the request's querystring — `listenParams` puts ours there. */
        tags?: string[];
      };
    };
  }>;
};

export type DeepgramUsageTotal = { tag: string | null; seconds: number };

export type DeepgramUsageResult = {
  totals: DeepgramUsageTotal[];
  /** How many pages were actually read before the loop stopped (a short page, or the cap). */
  pagesRead: number;
  /** Raw count of individual request rows Deepgram returned, before grouping by tag. */
  requestsSeen: number;
};

/**
 * Sums Deepgram-reported audio seconds per `tag` for requests in `[since, until)`, by paging
 * Deepgram's own record of what it billed — `GET /v1/projects/{project_id}/requests`
 * (https://developers.deepgram.com/reference/get-all-requests). This is the reconciliation
 * source of truth: `speech_usage` is what the browser told us it used, and a tampered client
 * could under-report that number to ride Orbit's key for free, so the nightly job compares it
 * against what Deepgram itself says it processed.
 *
 * Per-request fields relied on (from the documented response shape): `response.details.duration`
 * (seconds of audio for that one request) and `response.details.tags` (echoes the `tag` query
 * param `listenParams` sets to `meeting:<sessionId>`). Paged with `limit`/`page`; the response
 * carries no total count, so paging stops on a short page rather than a known page count.
 *
 * `pagesRead`/`requestsSeen` ride alongside the totals so the caller can tell "Deepgram truly
 * had nothing this window" apart from "the page index was wrong and every page came back
 * empty" — the two look identical from `totals` alone (both are `[]`), and the docs do not
 * pin down whether `page` is 0- or 1-based, so a caller that only reads `totals` cannot rule
 * out the latter silently checking nothing. The nightly route logs when `requestsSeen === 0`.
 *
 * Requires `DEEPGRAM_PROJECT_ID` (the project the key lives under — Deepgram's usage endpoints
 * are scoped to a project, unlike `mintStreamToken`/`transcribeFile`, which need only the key).
 * Throws on any failure — missing config, a non-OK response, a malformed body — so the caller
 * (the nightly reconciliation route) can log it and return safely rather than this function
 * pretending "no usage" when it actually could not check.
 */
export async function fetchDeepgramUsage(opts: { since: Date; until: Date }): Promise<DeepgramUsageResult> {
  const key = requireKey();
  const project = projectId();
  if (!project) throw new Error("DEEPGRAM_PROJECT_ID is not set");

  const totals = new Map<string | null, number>();
  let pagesRead = 0;
  let requestsSeen = 0;
  for (let page = 0; page < USAGE_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      start: opts.since.toISOString(),
      end: opts.until.toISOString(),
      limit: String(USAGE_PAGE_LIMIT),
      page: String(page),
    });
    const res = await fetch(`${PROJECTS_URL}/${project}/requests?${params.toString()}`, {
      headers: { Authorization: `Token ${key}` },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Deepgram usage request failed: ${res.status}`);
    }
    const body = (await res.json()) as DeepgramRequestsPage;
    const requests = body.requests ?? [];
    pagesRead += 1;
    requestsSeen += requests.length;
    for (const r of requests) {
      const details = r.response?.details;
      const seconds = details?.duration ?? 0;
      const tags = details?.tags ?? [];
      // One request can in principle carry several tags; only the meeting tag identifies a
      // session, so prefer it and otherwise fall back to whatever tag is first.
      const tag = tags.find((t) => t.startsWith("meeting:")) ?? tags[0] ?? null;
      totals.set(tag, (totals.get(tag) ?? 0) + seconds);
    }
    if (requests.length < USAGE_PAGE_LIMIT) break;
  }
  return {
    totals: [...totals.entries()].map(([tag, seconds]) => ({ tag, seconds })),
    pagesRead,
    requestsSeen,
  };
}
