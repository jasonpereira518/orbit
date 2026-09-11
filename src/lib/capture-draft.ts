/**
 * Local persistence for an in-progress capture paste.
 *
 * The notes textarea was plain `useState("")` with nothing behind it, so the text was
 * gone on reload, on switching the Messy/Structured tab, and — worst — on following the
 * app's own instruction. With no AI key the panel shows "Add an AI API key to extract
 * people from notes… add one in Settings, then come back here"; clicking that Settings
 * link discarded whatever had just been pasted. On a phone, after a conference, that is
 * the whole point of the product thrown away by the only path forward it offered.
 *
 * localStorage rather than a server draft: this is a per-device convenience for text the
 * user has not committed yet, it must survive a hard reload with no network, and it must
 * never cost a write to the database on every keystroke.
 *
 * Every accessor is wrapped: private windows, cleared site data and browsers set to block
 * storage all throw on access rather than returning null, and a capture panel that cannot
 * remember a draft must still work perfectly.
 */

const PREFIX = "orbit-capture-draft-v1";

/** Longer than any plausible session, short enough that a stale paste is not resurrected. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Drafts are scoped to the surface that owns them.
 *
 * The panel is mounted in three places — /capture, the chat "Notes" sheet, and the
 * onboarding wizard — and from a contact profile it is additionally locked to one person.
 * A single shared key would resurrect notes about Sarah inside Marcus's profile.
 */
export function captureDraftKey(scope: {
  entryPoint?: string | null;
  lockedParticipantId?: string | null;
}) {
  const surface = scope.entryPoint || "capture";
  const locked = scope.lockedParticipantId || "none";
  return `${PREFIX}:${surface}:${locked}`;
}

type StoredDraft = { text: string; savedAt: number };

export function readCaptureDraft(key: string): string | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    if (typeof parsed?.text !== "string" || !parsed.text.trim()) return null;
    if (
      typeof parsed.savedAt === "number" &&
      Date.now() - parsed.savedAt > MAX_AGE_MS
    ) {
      clearCaptureDraft(key);
      return null;
    }
    return parsed.text;
  } catch {
    return null;
  }
}

export function writeCaptureDraft(key: string, text: string) {
  try {
    if (!text.trim()) {
      window.localStorage.removeItem(key);
      return;
    }
    const payload: StoredDraft = { text, savedAt: Date.now() };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Quota exceeded on a very large paste, or storage blocked outright. The draft is a
    // convenience; losing it must never break the paste the user is in the middle of.
  }
}

export function clearCaptureDraft(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // See above.
  }
}
