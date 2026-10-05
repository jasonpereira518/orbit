/**
 * An unsent Compose draft, kept in this browser so closing the dialog doesn't lose it. Never
 * on the server (direct-email spec §5: no server-side drafts in v1). Storage is injected so
 * smoke scripts can pass an in-memory one; every access is guarded, because storage can be
 * full, disabled, or throw in a private window. Same shape as `capture-draft.ts`.
 */
export type ComposeDraft = { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string };

const KEY_PREFIX = "orbit:compose-draft:v1";
export const COMPOSE_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function composeDraftKey(userId: string, contactId: string | null): string {
  return `${KEY_PREFIX}:${userId}:${contactId ?? "general"}`;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function safeRemove(storage: Pick<Storage, "removeItem">, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // Nothing more to do.
  }
}

export function readComposeDraft(
  storage: Pick<Storage, "getItem" | "removeItem">,
  key: string,
  now = Date.now()
): ComposeDraft | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeRemove(storage, key);
    return null;
  }
  const d = (parsed ?? {}) as Partial<ComposeDraft> & { savedAt?: unknown };
  const valid =
    isStrings(d.to) &&
    isStrings(d.cc) &&
    isStrings(d.bcc) &&
    typeof d.subject === "string" &&
    typeof d.body === "string" &&
    typeof d.savedAt === "number";
  if (!valid || now - (d.savedAt as number) > COMPOSE_DRAFT_TTL_MS) {
    safeRemove(storage, key);
    return null;
  }
  return { to: d.to!, cc: d.cc!, bcc: d.bcc!, subject: d.subject!, body: d.body! };
}

export function writeComposeDraft(
  storage: Pick<Storage, "setItem" | "removeItem">,
  key: string,
  draft: ComposeDraft,
  now = Date.now()
): void {
  if (!draft.subject.trim() && !draft.body.trim()) {
    safeRemove(storage, key);
    return;
  }
  try {
    storage.setItem(key, JSON.stringify({ ...draft, savedAt: now }));
  } catch {
    // Full or disabled storage: the draft simply isn't kept.
  }
}

export function clearComposeDraft(storage: Pick<Storage, "removeItem">, key: string): void {
  safeRemove(storage, key);
}
