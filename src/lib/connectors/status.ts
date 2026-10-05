/**
 * Connector ids that `getIntegrationStatuses` answers for.
 *
 * Split from the action because the action reaches the database through its lookups, and
 * `scripts/smoke-integration-statuses.ts` has to compare this list against the registry
 * without loading a driver. The action asserts it implements exactly these ids, so the two
 * cannot drift.
 */
export const CONNECTOR_STATUS_LOOKUP_IDS = [
  "google",
  "outlook",
  "linkedin",
  "calendar_ics",
  "luma",
  "eventbrite",
  "apollo",
  "zapier",
] as const;

export type ConnectorStatusId = (typeof CONNECTOR_STATUS_LOOKUP_IDS)[number];
