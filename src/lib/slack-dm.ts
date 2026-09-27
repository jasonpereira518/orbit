/**
 * Slack DMs to a single person, via a real bot token — not the incoming webhooks in
 * `ops-notify.ts`, which can only post into one fixed channel and can never address a
 * specific user. Hand-rolled `fetch` calls rather than `@slack/web-api`: the surface needed
 * is two endpoints, and every other Slack touchpoint in this repo is already a raw POST.
 *
 * No `next/server` import, so this is reachable from tsx scripts and from
 * `src/lib/request-errors.ts` (which must stay Edge-bundle-safe).
 */

const SLACK_API = "https://slack.com/api";

/** Memoized per warm instance. `conversations.open` is idempotent, so a cold start is cheap. */
let cachedDmChannelId: string | null = null;

type SlackApiResponse = { ok: boolean; error?: string; channel?: { id: string } };

async function callSlackApi(
  method: string,
  token: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<SlackApiResponse> {
  const res = await fetchImpl(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Slack API ${method} answered ${res.status}`);
  const json = (await res.json()) as SlackApiResponse;
  if (!json.ok) throw new Error(`Slack API ${method} failed: ${json.error ?? "unknown error"}`);
  return json;
}

async function openDmChannel(token: string, userId: string, fetchImpl: typeof fetch): Promise<string> {
  if (cachedDmChannelId) return cachedDmChannelId;
  const json = await callSlackApi("conversations.open", token, { users: userId }, fetchImpl);
  const channelId = json.channel?.id;
  if (!channelId) throw new Error("Slack API conversations.open returned no channel id");
  cachedDmChannelId = channelId;
  return channelId;
}

/**
 * DM the one person `SLACK_ALERT_USER_ID` names, using `SLACK_BOT_TOKEN`.
 *
 * No-ops silently when either is unset — the same "feature is quietly off" contract as
 * `SLACK_OPS_WEBHOOK_URL` in `ops-notify.ts` — so call sites can fire this unconditionally.
 * Throws on an actual Slack API failure so a caller that wants to know (the admin test
 * button) can surface it, while fire-and-forget callers just `.catch(() => {})`.
 */
export async function sendSlackDM(text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  const userId = process.env.SLACK_ALERT_USER_ID?.trim();
  if (!token || !userId) return;

  const channelId = await openDmChannel(token, userId, fetchImpl);
  await callSlackApi("chat.postMessage", token, { channel: channelId, text }, fetchImpl);
}
