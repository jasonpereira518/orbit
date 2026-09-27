/**
 * Twilio's "Attempt to send to unsubscribed recipient". The person replied STOP; Twilio's
 * opt-out handling now blocks every message from this sender to them, and Orbit has no
 * inbound webhook of its own — this rejection is how Orbit learns it.
 */
export const TWILIO_OPTED_OUT = 21610;

export const SMS_OPTED_OUT_MESSAGE = "That number replied STOP, so Orbit can’t text it again";

export function isTwilioOptOut(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === TWILIO_OPTED_OUT
  );
}
