/**
 * Things the user did in the app during a call (confirmed a card, dismissed one), told to the
 * agent silently. Deepgram has no silent channel we trust yet (`injectAgentMessage` SPEAKS its
 * text), so these ride on the next tool result instead. Client-safe.
 */
export function withAppEvents(result: string, events: readonly string[]): string {
  if (events.length === 0) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const prior = Array.isArray(record.app_events) ? record.app_events : [];
    return JSON.stringify({ ...record, app_events: [...prior, ...events] });
  }
  return JSON.stringify({ result, app_events: [...events] });
}
