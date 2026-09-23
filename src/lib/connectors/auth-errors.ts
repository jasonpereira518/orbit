/**
 * The two errors a connector's provider client and `openConnectorAuth` speak. Import-free on
 * purpose: a provider client (`src/lib/crm/hubspot/api.ts`) throws `ConnectorAuthError`, and
 * that client's smoke runs without a database — `token.ts` reaches `@/db`.
 */

/** A provider client throws this when the ACCESS TOKEN was refused (HTTP 401) — and only then. */
export class ConnectorAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorAuthError";
  }
}

/**
 * The connection has been marked `needs_reauth` and disarmed. The row is already resolved, so
 * a sync that catches this returns normally — the scheduler's success backstop is guarded on
 * the row still being `syncing` and leaves it alone.
 */
export class ConnectorNeedsReauthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorNeedsReauthError";
  }
}
