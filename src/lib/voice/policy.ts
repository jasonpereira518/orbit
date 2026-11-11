/** Client-safe limits and allowlists. Voice never exposes arbitrary MCP or web tools. */
export const VOICE_DURATION_SECONDS = 600;
export const VOICE_MAX_TOOL_CALLS = 60;
export const VOICE_READ_NAMES = new Set([
  "search_contacts",
  "get_contact",
  "who_do_i_know_at",
  "get_timeline",
  "search_notes",
  "search_meetings",
  "get_network_overview",
  "get_goals",
  "due_followups",
  "list_reminders",
  "list_open_commitments",
  "upcoming_meetings",
  "meeting_context",
  "get_dossier",
]);
export const VOICE_WRITE_NAMES = new Set([
  "log_note",
  "create_reminder",
  "schedule_follow_up",
  "update_contact",
  "add_tags",
  "create_contact",
  "complete_action_item",
  "complete_reminder",
  "reschedule_reminder",
  "snooze_reminder",
]);
export function voiceAvailable(
  enabled: boolean | null | undefined,
  configured: boolean,
): boolean {
  return enabled === true && configured;
}
