import { NextResponse } from "next/server";
import { isBotUserAgent } from "@/lib/analytics-bots";
import { clientIpFrom } from "@/lib/client-ip";
import {
  BEACON_EVENT_KINDS,
  SHARE_CHANNELS,
  SHARE_TOKEN_MAX,
  type BeaconEventKind,
  type ShareChannel,
} from "@/lib/interest-list";
import { recordInterestEvent } from "@/lib/interest-list-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The waitlist's share-funnel beacon: `{ kind, token, channel? }` from the page — an
 * invite link opened (`ref_arrival`), a share control used (`share_click`). POST because
 * `navigator.sendBeacon` can send nothing else, and a share that opens another app may
 * unload the page before a `fetch` lands.
 *
 * ALWAYS 204, like `/api/track`: a visitor never sees a consequence of this failing, and
 * the client never retries. Bots are dropped here rather than counted — link previewers
 * fetch every pasted URL, but they do not run the page's JavaScript, and a crawler that
 * does usually says so in its user agent.
 *
 * Public (`PUBLIC_ROUTES`) and allowed on the waitlist host (`WAITLIST_ALLOWED_PATHS`).
 */
const OK = () => new NextResponse(null, { status: 204 });

/**
 * Per-instance abuse guard, same shape and reasoning as `/api/track`'s: a Postgres bucket
 * per check would double the writes it polices, and the threat is one caller in a loop.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const recentByIp = new Map<string, number[]>();

function overRateLimit(key: string, now: number) {
  const recent = (recentByIp.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  const over = recent.length >= RATE_MAX;
  if (!over) recent.push(now);
  recentByIp.set(key, recent);
  if (recentByIp.size > 1000) {
    for (const [k, times] of recentByIp) {
      if (times.every((at) => now - at >= RATE_WINDOW_MS)) recentByIp.delete(k);
    }
  }
  return over;
}

const isKind = (v: unknown): v is BeaconEventKind =>
  typeof v === "string" && (BEACON_EVENT_KINDS as readonly string[]).includes(v);
const isChannel = (v: unknown): v is ShareChannel =>
  typeof v === "string" && (SHARE_CHANNELS as readonly string[]).includes(v);

export async function POST(request: Request) {
  try {
    if (isBotUserAgent(request.headers.get("user-agent"))) return OK();
    if (overRateLimit(clientIpFrom(request.headers), Date.now())) return OK();

    // sendBeacon posts a Blob, so the body arrives as text either way.
    const body = (await request
      .text()
      .then((t) => JSON.parse(t) as unknown)
      .catch(() => null)) as { kind?: unknown; token?: unknown; channel?: unknown } | null;
    if (!body || !isKind(body.kind)) return OK();
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token || token.length > SHARE_TOKEN_MAX) return OK();
    if (body.kind === "share_click" && !isChannel(body.channel)) return OK();

    await recordInterestEvent({
      kind: body.kind,
      channel: body.kind === "share_click" ? (body.channel as ShareChannel) : null,
      shareToken: token,
    });
  } catch (err) {
    console.error("[interest-list] event beacon failed", err);
  }
  return OK();
}
