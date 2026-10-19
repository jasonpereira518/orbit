import { resolveTimeZone, TZ_COOKIE } from "@/lib/reminder-due-bucket";

/**
 * The viewer's IANA time zone, for server-rendered dates (audit L-17).
 *
 * A server component or action formatting a `Date` with no `timeZone` uses the runtime's
 * zone, which is UTC on Vercel: a 7pm Pacific meeting read as 2am the next day. The browser
 * keeps its zone in the `orbit-tz` cookie (`syncTimeZoneCookie`, mounted app-wide by the
 * presence heartbeat), and this reads it back through `resolveTimeZone`, so an unknown or
 * forged value falls back to UTC rather than reaching `Intl`.
 *
 * Outside a request (a script, a cron, a smoke test) there is no cookie to read: UTC, the
 * same answer as a request without the cookie.
 */
export async function viewerTimeZone(): Promise<string> {
  try {
    const { cookies } = await import("next/headers");
    return resolveTimeZone((await cookies()).get(TZ_COOKIE)?.value);
  } catch {
    return resolveTimeZone(null);
  }
}
