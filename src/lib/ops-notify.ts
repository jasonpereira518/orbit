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
  const url = process.env.SLACK_OPS_WEBHOOK_URL?.trim();
  if (!url) throw new Error("SLACK_OPS_WEBHOOK_URL is not set");
  const text = formatDelivery(d);
  await post(url, text, fetchImpl);
  const critical = process.env.SLACK_OPS_CRITICAL_WEBHOOK_URL?.trim();
  if (critical && d.condition.severity === "critical" && d.kind !== "recover") {
    await post(critical, text, fetchImpl);
  }
}

/** A plain message (used by the admin "send test alert" button). */
export async function notifySlack(text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = process.env.SLACK_OPS_WEBHOOK_URL?.trim();
  if (!url) throw new Error("SLACK_OPS_WEBHOOK_URL is not set");
  await post(url, text, fetchImpl);
}
