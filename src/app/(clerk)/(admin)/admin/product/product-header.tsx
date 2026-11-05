import { ProductSectionTabs } from "@/components/admin/admin-tabs";
import { AdminPageHeader } from "@/components/admin/primitives";
import { UnhideAllButton } from "@/components/admin/surface-toggles";
import { getComingSoonKeys, getHiddenSurfaceKeys, getTierRules } from "@/lib/surface-visibility";
import { surfacesOfKind, type SurfaceKind } from "@/lib/surfaces";

/** Which surface kinds each tab toggles, so its badge counts what is hidden there. */
const TAB_KINDS: Record<string, SurfaceKind[]> = {
  "/admin/product": ["page"],
  "/admin/product/dashboard": ["dashboard", "widget", "feature"],
  "/admin/product/settings": ["settings"],
};

/**
 * The header every Product tab shares: what is hidden from everyone, the one-click undo, and
 * the tab row with a hidden count per tab — so a forgotten toggle shows from any tab, not
 * just the one it lives on. Operators are exempt from their own toggles; this summary is
 * how they notice one.
 *
 * Reads its own data: the surface reads are `cache()`d per request on one flag snapshot, so
 * a page that already loaded them pays nothing here.
 */
export async function ProductHeader() {
  const [hidden, comingSoon, tierRules] = await Promise.all([
    getHiddenSurfaceKeys(),
    getComingSoonKeys(),
    getTierRules(),
  ]);

  const pageKeys = new Set(surfacesOfKind("page").map((p) => p.key));
  // A hidden page wins over coming-soon, so it is counted once, as hidden.
  const soonCount = [...comingSoon].filter((k) => pageKeys.has(k) && !hidden.has(k)).length;
  const summary = [
    hidden.size > 0 && `${hidden.size} hidden`,
    soonCount > 0 && `${soonCount} coming soon`,
    tierRules.size > 0 && `${tierRules.size} limited to some plans`,
  ].filter(Boolean);

  const counts = Object.fromEntries(
    Object.entries(TAB_KINDS).map(([href, kinds]) => [
      href,
      kinds.flatMap((k) => surfacesOfKind(k)).filter((s) => hidden.has(s.key)).length,
    ])
  );

  return (
    <>
      <AdminPageHeader
        title="Product"
        subtitle={
          summary.length === 0
            ? "Every surface is live for every user."
            : `${summary.join(" · ")} for all users. You still see hidden surfaces — “See what users see” on the Pages tab shows what they get.`
        }
        action={<UnhideAllButton hiddenKeys={[...hidden]} />}
      />
      <ProductSectionTabs counts={counts} />
    </>
  );
}
