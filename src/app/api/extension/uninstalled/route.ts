import { NextResponse } from "next/server";
import { clientIpFrom, ipBucketKey } from "@/lib/client-ip";
import { consumeBucket } from "@/lib/rate-limit";
import { isExtensionVersion, trackExtensionUninstalled } from "@/lib/extension/telemetry";

export const dynamic = "force-dynamic";

/**
 * Where the browser sends a person the moment they uninstall the extension
 * (`chrome.runtime.setUninstallURL` in `extension/src/background/index.ts`):
 *
 *   GET /api/extension/uninstalled?v=1.1.0
 *
 * UNAUTHENTICATED ON PURPOSE. The extension is gone, and so is its Clerk session, so there is
 * nobody to authenticate; the route is in `PUBLIC_ROUTES` (`/api/extension(.*)`) for that
 * reason. What it accepts is therefore as little as can still be useful: a version that is
 * three plain numbers, nothing else. It records no user, no IP, no User-Agent, no referrer and
 * no other query parameter, and it is rate limited so a loop cannot inflate the churn count.
 *
 * ALWAYS 204 with no body, whatever happened: a missing or malformed version, a limiter that
 * cannot count, a failed insert. The tab the browser opens shows nothing, and the visitor never
 * sees a consequence of this counter failing. (The unload page itself is intentionally blank;
 * a survey would be a product decision, not an analytics one.)
 */
const UNINSTALL_SCOPE: string = "extension.uninstalled";
const UNINSTALL_POLICY = { limit: 10, windowSec: 600 } as const;

const NO_CONTENT = () =>
  new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });

export async function GET(request: Request) {
  try {
    const version = new URL(request.url).searchParams.get("v");
    if (!isExtensionVersion(version)) return NO_CONTENT();

    try {
      await consumeBucket(UNINSTALL_SCOPE, ipBucketKey(clientIpFrom(request.headers)), UNINSTALL_POLICY);
    } catch {
      // Over the limit, or a limiter that cannot count: record nothing.
      return NO_CONTENT();
    }

    trackExtensionUninstalled(version);
  } catch {
    // Telemetry only.
  }
  return NO_CONTENT();
}
