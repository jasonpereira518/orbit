/**
 * Checks on what a Server Action receives. Server Functions answer a direct POST, so an id
 * or a status is whatever the caller sent until it passes these. Pure.
 */
import type { LeadStatus } from "@/db/schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export const LEAD_STATUSES: readonly LeadStatus[] = [
  "open",
  "intro_requested",
  "converted",
  "dismissed",
];

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === "string" && (LEAD_STATUSES as readonly string[]).includes(value);
}
