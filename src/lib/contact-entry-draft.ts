/** Unsaved manual entry stays in this tab, scoped to the account and entry context. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function contactEntryDraftKey(userId: string, context = "new") {
  return `orbit:contact-entry:v1:${encodeURIComponent(userId)}:${encodeURIComponent(context)}`;
}

export function readContactEntryDraft<T extends Record<string, string | number | boolean>>(
  storage: Pick<Storage, "getItem" | "removeItem">,
  key: string,
  defaults: T,
  now = Date.now(),
): T | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.savedAt !== "number" || now - parsed.savedAt > MAX_AGE_MS || parsed.savedAt > now || !parsed.form || typeof parsed.form !== "object") {
      storage.removeItem(key);
      return null;
    }
    const restored = { ...defaults };
    for (const field of Object.keys(defaults) as Array<keyof T>) {
      if (typeof parsed.form[field] === typeof defaults[field]) restored[field] = parsed.form[field];
    }
    return restored;
  } catch {
    // Disabled storage or malformed drafts must never prevent manual entry.
    return null;
  }
}

export function saveContactEntryDraft(storage: Pick<Storage, "setItem" | "removeItem">, key: string, form: Record<string, string | number | boolean>) {
  try {
    const hasInput = Object.values(form).some((value) => typeof value === "string" && value.trim());
    if (hasInput) storage.setItem(key, JSON.stringify({ form, savedAt: Date.now() }));
    else storage.removeItem(key);
  } catch { /* A full/disabled store must not block saving the contact. */ }
}
