import { TZ_COOKIE } from "@/lib/reminder-due-bucket";

/**
 * Keep the `orbit-tz` cookie on this browser's zone, so the server can time what depends on
 * the viewer's day (reminder buckets, Radar's Monday email) without a round trip of its own.
 * Browser only; a no-op when the cookie is already current.
 */
export function syncTimeZoneCookie(): void {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) return;
    const match = document.cookie.match(new RegExp(`(?:^|; )${TZ_COOKIE}=([^;]*)`));
    if (match && decodeURIComponent(match[1] ?? "") === tz) return;
    document.cookie = `${TZ_COOKIE}=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    // A browser without Intl zones, or with cookies blocked: UTC it is.
  }
}
