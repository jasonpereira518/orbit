import { AdminPageHeader, AdminPanel } from "@/components/admin/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * One loading screen for every admin route.
 *
 * Each block is drawn with the same chrome the loaded page uses — the real page header,
 * the real section tabs, `AdminPanel`, tiles shaped like `MetricTile` — so the only thing
 * that changes when data arrives is what is inside the boxes. Hand-rolled skeletons had
 * drifted (bare grey slabs, `rounded-2xl` tiles, no tab row), and the page jumped on swap.
 *
 * Heights are Tailwind classes, spelled out at the call site so the compiler sees them.
 */
type PanelBlock = {
  /** Omit for an untitled panel. */
  title?: string;
  /** Body height, e.g. `"h-40"`. Ignored when `body` is given. */
  height?: string;
  body?: React.ReactNode;
};

export type LoadingBlock =
  | { tiles: 3 | 4 | 5 }
  | ({ panel: true } & PanelBlock)
  | { pair: [PanelBlock, PanelBlock] }
  | { toolbar: true }
  /** The small "7d · 30d · 90d" row above a time-windowed page. */
  | { range: true };

const TILE_GRID = {
  3: "grid gap-3 sm:grid-cols-3",
  4: "grid gap-3 sm:grid-cols-2 lg:grid-cols-4",
  5: "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5",
} as const;

/**
 * Each bar sits in a box the height of the `MetricTile` line it stands for (label, value,
 * hint), with the tile's own spacing between them — not margins on the bars, which would
 * collapse into each other and come out shorter than the real tile.
 */
function TileSkeleton() {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-3">
      <div className="flex h-4 items-center">
        <Skeleton className="h-3 w-20" />
      </div>
      <div className="mt-1.5 flex h-8 items-center">
        <Skeleton className="h-7 w-14" />
      </div>
      <div className="mt-0.5 flex h-4 items-center">
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  );
}

function PanelSkeleton({ title, height = "h-32", body }: PanelBlock) {
  return (
    <AdminPanel title={title}>
      {body ?? <Skeleton className={cn("w-full", height)} />}
    </AdminPanel>
  );
}

export function AdminLoading({
  title,
  subtitle = "Loading…",
  above,
  tabs,
  blocks,
}: {
  title: string;
  subtitle?: string;
  /** Rendered before the header, e.g. a back link. */
  above?: React.ReactNode;
  /** The section's real tab row, so it is already in place when data lands. */
  tabs?: React.ReactNode;
  blocks: LoadingBlock[];
}) {
  return (
    <>
      {above}
      <AdminPageHeader title={title} subtitle={subtitle} />
      {tabs}
      <div className="space-y-6" aria-busy="true">
        {blocks.map((block, i) => {
          if ("tiles" in block) {
            return (
              <div key={i} className={TILE_GRID[block.tiles]}>
                {Array.from({ length: block.tiles }).map((_, j) => (
                  <TileSkeleton key={j} />
                ))}
              </div>
            );
          }
          if ("pair" in block) {
            return (
              <div key={i} className="grid gap-6 lg:grid-cols-2">
                <PanelSkeleton {...block.pair[0]} />
                <PanelSkeleton {...block.pair[1]} />
              </div>
            );
          }
          if ("toolbar" in block) {
            return <Skeleton key={i} className="h-8 w-full max-w-xl" />;
          }
          if ("range" in block) {
            return (
              <div key={i} className="flex h-4 items-center">
                <Skeleton className="h-3 w-28" />
              </div>
            );
          }
          return <PanelSkeleton key={i} {...block} />;
        })}
      </div>
    </>
  );
}

/** A back link's footprint, for detail pages. */
export function BackLinkSkeleton() {
  return <Skeleton className="mb-3 h-3 w-24" />;
}
