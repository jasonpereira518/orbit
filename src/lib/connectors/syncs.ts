/**
 * The one place a connector's manifest meets its sync function.
 *
 * Server code only — the scheduler and the CRM actions import it — because every sync reaches
 * the database, and `registry.ts` has to stay loadable from a client component. Not marked
 * with `import "server-only"`: that package throws under `tsx`, and the scheduler's smokes
 * load this module.
 */
import type { ClaimedConnectorConnection } from "@/lib/connectors/connections";
import {
  connectorById,
  isSyncable,
  type ConnectorId,
  type ConnectorManifest,
} from "@/lib/connectors/registry";

export type ConnectorSync = (conn: ClaimedConnectorConnection) => Promise<void>;

/** Keyed by connector id. A planned connector listed here is still never synced. */
export const CONNECTOR_SYNCS: Partial<Record<ConnectorId, ConnectorSync>> = {};

/**
 * The manifest for `id` with its sync attached, when it has one and may run it. `syncs` is
 * injectable so a smoke can prove the planned-connector rule without registering a real sync.
 */
export function resolveConnectorWithSync(
  id: string,
  syncs: Partial<Record<string, ConnectorSync>> = CONNECTOR_SYNCS
): ConnectorManifest | null {
  const manifest = connectorById(id);
  if (!manifest) return null;
  const sync = syncs[manifest.id];
  if (!sync) return manifest;
  const withSync: ConnectorManifest = { ...manifest, sync };
  return isSyncable(withSync) ? withSync : manifest;
}
