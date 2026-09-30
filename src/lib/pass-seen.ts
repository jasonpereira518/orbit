/**
 * What this device last showed a visitor on their pass, so a return visit can say what
 * changed ("2 friends joined since your last visit"). It lives only in the visitor's own
 * browser and is never sent anywhere.
 *
 * One record, for the last pass shown here: a device almost always belongs to one person,
 * and a second pass simply replaces the first. Storage can be missing, full or blocked
 * (private windows, cleared site data), so every access is guarded and a failed read means
 * "nothing to compare with" — the page just shows no news.
 *
 * No React, no aliases: safe to import from anywhere, including smokes.
 */
import type { PassStanding } from "./interest-list";

const KEY = "waitlist-pass-seen";

type Stored = PassStanding & { token: string };

function isStanding(v: unknown): v is Stored {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.token === "string" &&
    Number.isInteger(o.referrals) &&
    Number.isInteger(o.position) &&
    (o.referrals as number) >= 0 &&
    (o.position as number) >= 1
  );
}

/** The browser's storage; reading the property itself throws where storage is blocked. */
function local(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** The standing last shown for `token` on this device, or null. */
export function readSeen(token: string, storage?: Storage): PassStanding | null {
  try {
    const raw = (storage ?? local())?.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStanding(parsed) || parsed.token !== token) return null;
    return { referrals: parsed.referrals, position: parsed.position };
  } catch {
    return null;
  }
}

/** Records what the pass is showing now. Best effort. */
export function writeSeen(token: string, standing: PassStanding, storage?: Storage) {
  try {
    (storage ?? local())?.setItem(KEY, JSON.stringify({ token, ...standing }));
  } catch {
    // Blocked or full: the next visit just has nothing to compare with.
  }
}
