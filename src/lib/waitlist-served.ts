import { headers } from "next/headers";
import { getWaitlistPageUrl } from "@/lib/app-url";
import { isLocalhost } from "@/lib/demo-account";
import { WAITLIST_MIRROR_HEADER, isWaitlistHostHeader } from "@/lib/waitlist-host";

export type WaitlistServed = {
  /** Where the page lives on this request's host: `/`, `/waitlist` or `/interest`. */
  page: string;
  privacy: string;
  /** The absolute page URL share links are built on. */
  pageUrl: string;
};

/**
 * Where the waitlist is being served for THIS request, so its links stay on the address
 * the visitor is using:
 *
 *   - its own domain (`WAITLIST_HOST`): `/` and `/privacy`;
 *   - the local mirror on `next dev` (`/waitlist`, see `localMirrorTarget`): `/waitlist`
 *     and `/waitlist/privacy`, with share links on this localhost origin so they can be
 *     followed in the same browser;
 *   - anywhere else: `/interest` and `/interest/privacy`.
 *
 * The mirror header is trusted only on `next dev`, where the proxy is what set it. Outside
 * a request — the page smoke renders the pages directly — there is no host, which reads as
 * the app's.
 */
export async function waitlistServed(): Promise<WaitlistServed> {
  const app: WaitlistServed = { page: "/interest", privacy: "/interest/privacy", pageUrl: getWaitlistPageUrl() };
  let list: Headers;
  try {
    list = await headers();
  } catch {
    return app;
  }
  const host = list.get("host");
  if (isWaitlistHostHeader(host)) return { page: "/", privacy: "/privacy", pageUrl: getWaitlistPageUrl() };
  if (isLocalhost() && list.get(WAITLIST_MIRROR_HEADER) === "1" && host) {
    const proto = list.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
    return { page: "/waitlist", privacy: "/waitlist/privacy", pageUrl: `${proto}://${host}/waitlist` };
  }
  return app;
}
