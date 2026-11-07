import { cache } from "react";
import { getAdminHealth } from "@/lib/admin-health";
import { getCronHealth, getOpsStatus, getWebhookHealth } from "@/lib/admin-system";

/**
 * The reads both the Ops shell (banner + tab badges) and a tab's own panels need, memoized
 * per request with React `cache` so a tab that shows one of them pays for it once.
 *
 * Each degrades independently, so the page still renders if one instrumentation table is
 * missing — except `getAdminHealth`, whose failure is a real outage worth the error page.
 */
export const loadHealth = cache(() => getAdminHealth());
export const loadOps = cache(() => getOpsStatus().catch(() => null));
export const loadCron = cache(() => getCronHealth("imports.process-stalled").catch(() => null));
export const loadWebhooks = cache(() => getWebhookHealth().catch(() => null));
