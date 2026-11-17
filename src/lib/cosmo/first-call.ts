/** Whether this browser has started a Cosmo call before: the first one asks first. */
export const FIRST_CALL_KEY = "orbit:cosmo-first-call";

export function hasStartedCall(storage: Pick<Storage, "getItem">): boolean {
  try {
    return storage.getItem(FIRST_CALL_KEY) === "1";
  } catch {
    return false; // Private mode: ask every time.
  }
}

export function markCallStarted(storage: Pick<Storage, "setItem">): void {
  try {
    storage.setItem(FIRST_CALL_KEY, "1");
  } catch {
    /* Private mode: it asks again next time. */
  }
}
