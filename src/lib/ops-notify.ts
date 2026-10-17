import type { OpsCondition, OpsSeverity } from "@/lib/ops-alerts";
import { getAppBaseUrl } from "@/lib/app-url";

/**
 * Slack delivery for the ops sweep.
 *
 * Two incoming webhooks: everything goes to `SLACK_OPS_WEBHOOK_URL`; critical conditions
 * ALSO go to `SLACK_OPS_CRITICAL_WEBHOOK_URL`, which is the channel with mobile push set
 * to "all messages". That split — not SMS — is how a solo operator gets paged for the
 * things that must not wait, without every warning buzzing a phone.
 *
 * Throws on failure so the sweep can leave the condition un-notified and try again next
 * tick. No `next/server` import: reached from tsx scripts.
 */

export type OpsDeliveryKind = "open" | "remind" | "recover";

export type OpsDelivery = { kind: OpsDeliveryKind; condition: OpsCondition };

const ICON: Record<OpsSeverity, string> = {
  critical: ":rotating_light:",
  warning: ":warning:",
  info: ":information_source:",
};

export function formatDelivery(d: OpsDelivery, baseUrl = getAppBaseUrl()): string {
  const c = d.condition;
  if (d.kind === "recover") {
    return `:white_check_mark: *Recovered: ${c.title}* (\`${c.id}\`)`;
  }
  const prefix = d.kind === "remind" ? "Still open" : "New";
  const where = c.href ? `\n<${baseUrl}${c.href}|Open in Orbit>` : "";
  return `${ICON[c.severity]} *[${c.severity}] ${prefix}: ${c.title}* (\`${c.id}\`)\n${c.detail}${where}`;
}

async function post(url: string, text: string, fetchImpl: typeof fetch) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Slack webhook answered ${res.status}`);
}

export async function deliverToSlack(d: OpsDelivery, fetchImpl: typeof fetch = fetch): Promise<void> {
  const main = process.env.SLACK_OPS_WEBHOOK_URL?.trim();
  const critical = process.env.SLACK_OPS_CRITICAL_WEBHOOK_URL?.trim();
  const toCritical = Boolean(critical) && d.condition.severity === "critical" && d.kind !== "recover";
  if (!main && !toCritical) throw new Error("SLACK_OPS_WEBHOOK_URL is not set");
  const text = formatDelivery(d);

  // Each channel is attempted on its own. A dead main webhook used to stop the critical post
  // from ever being tried (the one that buzzes a phone), and a dead critical webhook threw
  // after the main post had landed, so the sweep re-sent the same message to #orbit-ops every
  // ten minutes. The delivery counts as made when any channel took it; it fails, and is
  // retried next tick, only when every channel it was meant for refused it.
  const attempts: Array<Promise<void>> = [];
  if (toCritical) attempts.push(post(critical!, text, fetchImpl));
  if (main) attempts.push(post(main, text, fetchImpl));
  const results = await Promise.allSettled(attempts);
  if (results.every((r) => r.status === "rejected")) {
    throw (results[0] as PromiseRejectedResult).reason;
  }
}

/** A plain message (used by the admin "send test alert" button). */
export async function notifySlack(text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = process.env.SLACK_OPS_WEBHOOK_URL?.trim();
  if (!url) throw new Error("SLACK_OPS_WEBHOOK_URL is not set");
  await post(url, text, fetchImpl);
}

/**
 * A message about the alerting path itself failing ("the sweep could not run"), posted to
 * the main AND the critical channel. It cannot go through the condition state machine,
 * because that machine is what broke. Never throws: it runs inside a failure handler.
 */
export async function notifyOpsFailure(text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const urls = [process.env.SLACK_OPS_CRITICAL_WEBHOOK_URL, process.env.SLACK_OPS_WEBHOOK_URL]
    .map((u) => u?.trim())
    .filter((u): u is string => Boolean(u));
  await Promise.allSettled(urls.map((u) => post(u, text, fetchImpl)));
}
