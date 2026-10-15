/**
 * Whose data this browser's storage holds. Drafts, meeting notes, queued offline changes and
 * kept notifications live in local/session storage and outlive sign-out — on a shared machine
 * the next person to sign in must not inherit them. When a different account signs in, every
 * key that can hold another person's words is removed before anything reads it.
 *
 * Pure apart from the storages passed in, so it runs in a smoke without a DOM.
 */
const OWNER_KEY = "orbit:owner";

/** Keys (by prefix) that can carry contact names, notes or message text. */
export const PERSONAL_KEY_PREFIXES = [
  "orbit:meeting-notes:",
  "orbit:capture-draft:",
  "orbit:compose-draft:",
  "orbit:offline-queue:",
  "orbit:capture-handoff",
  "orbit:kept-notifications:",
  "orbit:chat-send-resume",
  "orbit:notified-ids",
] as const;

type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** Returns true when it removed a previous account's data. Never throws. */
export function forgetPreviousAccount(userId: string, stores: KeyStore[]): boolean {
  try {
    const owner = stores[0]?.getItem(OWNER_KEY);
    stores[0]?.setItem(OWNER_KEY, userId);
    if (!owner || owner === userId) return false;
    for (const store of stores) {
      const doomed: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key && PERSONAL_KEY_PREFIXES.some((p) => key.startsWith(p))) doomed.push(key);
      }
      for (const key of doomed) store.removeItem(key);
    }
    return true;
  } catch {
    // Storage blocked (private mode, quota): nothing was kept there to leak.
    return false;
  }
}
