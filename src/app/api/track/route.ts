/**
 * The page-view beacon's OLD path, kept for one release.
 *
 * Ad-blocker lists (EasyPrivacy and friends) match generic `/api/track` patterns, so the
 * beacon moved to `/api/p/v` (`src/app/api/p/v/route.ts`), where the handler now lives. A
 * client that loaded the previous bundle still POSTs here until its tab reloads; this
 * forwards to the same handler so those views keep landing. Delete this file, its entries in
 * `PUBLIC_ROUTES` and `WAITLIST_ALLOWED_PATHS`, and the alias assertions in the smokes when
 * the next release has shipped.
 */
export { POST } from "@/app/api/p/v/route";

// Route segment config cannot be re-exported, so it is repeated: same as the real route.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
