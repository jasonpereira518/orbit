/**
 * How a Google or Microsoft connection row reads to a person.
 *
 * DB-free and import-free: client cards, the "use server" status actions and the account
 * bell all derive the same three states from the same columns, so they cannot disagree.
 *
 * "disarmed" is the scheduler having given up (`next_sync_at IS NULL` with an error) on a
 * grant that DID include calendar. A contacts-only grant parked for lack of the calendar
 * scope is the user's choice, not a fault, and reads as plain active.
 */
export type ConnectionHealth = "active" | "needs_reauth" | "disarmed";

export function deriveConnectionHealth(row: {
  status: string;
  nextSyncAt: Date | null;
  syncError: string | null;
  calendarScopeGranted: boolean;
}): ConnectionHealth {
  if (row.status !== "active") return "needs_reauth";
  if (row.calendarScopeGranted && row.nextSyncAt === null && row.syncError) return "disarmed";
  return "active";
}

export const SESSION_EXPIRED_LINE = "Session expired — reconnect";
export const CALENDAR_PAUSED_SHORT = "Calendar sync paused";

/** The full line for a card. Never echoes `sync_error`, which can be a provider's raw body. */
export function calendarPauseLine(syncError: string | null): string {
  if (syncError && /not granted|insufficient|scope/i.test(syncError)) {
    return `${CALENDAR_PAUSED_SHORT} — reconnect Google and allow calendar access`;
  }
  return `${CALENDAR_PAUSED_SHORT} — reconnect Google to start it again`;
}

/** One line for the Integrations card and nav, which truncate — so the short forms. */
export function connectionSummary(c: {
  configured: boolean;
  connected: boolean;
  status: ConnectionHealth | null;
}): { state: "on" | "partial" | "off"; detail: string } {
  if (!c.configured) return { state: "off", detail: "Unavailable" };
  if (c.status === "needs_reauth") return { state: "partial", detail: SESSION_EXPIRED_LINE };
  if (c.status === "disarmed") return { state: "partial", detail: CALENDAR_PAUSED_SHORT };
  if (c.connected) return { state: "on", detail: "Connected" };
  return { state: "off", detail: "Not connected" };
}
