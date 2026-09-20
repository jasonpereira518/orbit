/**
 * Where an outbox item meets a provider's API.
 *
 * Empty on purpose: P0 builds the queue, and the first real writer (Apple Reminders, via the
 * Shortcut, then Microsoft To Do) arrives in P2. Returning a non-retryable failure rather
 * than throwing keeps an item that nothing can deliver out of a seven-attempt retry loop.
 */
import type { ConnectorManifest } from "@/lib/connectors/registry";
import type { DeliverResult, OutboxItem } from "@/lib/connectors/outbox";

export async function deliverOutboxItem(
  manifest: ConnectorManifest,
  _item: OutboxItem
): Promise<DeliverResult> {
  return { ok: false, error: `${manifest.label} cannot receive writes yet` };
}
