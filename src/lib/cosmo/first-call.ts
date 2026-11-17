/** Whether this browser has started a Cosmo call before: the first one asks first. */
export const FIRST_CALL_KEY = "orbit:cosmo-first-call";

/** Blocked storage throws on merely reading the `localStorage` global, so it is read in here. */
const browserStorage = (): Storage => localStorage;

export function hasStartedCall(storage: Pick<Storage, "getItem"> = { getItem: (k) => browserStorage().getItem(k) }): boolean {
  try {
    return storage.getItem(FIRST_CALL_KEY) === "1";
  } catch {
    return false; // Private mode or blocked storage: ask every time.
  }
}

export function markCallStarted(storage: Pick<Storage, "setItem"> = { setItem: (k, v) => browserStorage().setItem(k, v) }): void {
  try {
    storage.setItem(FIRST_CALL_KEY, "1");
  } catch {
    /* Private mode or blocked storage: it asks again next time. */
  }
}
