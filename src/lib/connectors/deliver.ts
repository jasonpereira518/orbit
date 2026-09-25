/**
 * Where an outbox item meets a provider's API.
 *
 * Empty on purpose: P0 builds the queue, and the first real writer (Apple Reminders, via the
 * Shortcut, then Microsoft To Do) arrives in P2. `retryable: false` is what actually keeps an
 * item that nothing can deliver out of a seven-attempt, ~2.3-day retry loop — a plain
 * `ok: false` would still burn the whole ladder before going `dead`, since the connector being
 * unbuilt is not something a later attempt could fix.
 */
import type { ConnectorManifest } from "@/lib/connectors/registry";
import type { DeliverResult, OutboxItem } from "@/lib/connectors/outbox";

export async function deliverOutboxItem(
  manifest: ConnectorManifest,
  _item: OutboxItem
): Promise<DeliverResult> {
  return { ok: false, error: `${manifest.label} cannot receive writes yet`, retryable: false };
}
