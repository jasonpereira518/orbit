import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { fetchDashboard } from "@/actions/reminders";
import { ConstellationPreviewCanvas } from "@/components/dashboard/constellation-preview-canvas";
import { buildPreviewSky } from "@/lib/graph/preview-sky";
import { STAGE_GROUND } from "@/lib/graph/stage-layers";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type GraphPreviewPayload = Awaited<
  ReturnType<typeof fetchDashboard>
>["data"]["graphPreview"];

export function DashboardGraphPreview({
  graphPreview,
}: {
  graphPreview: GraphPreviewPayload;
}) {
  // Laid out here, on the server: the browser receives dot positions, not contact records.
  const sky = buildPreviewSky(graphPreview.contacts, graphPreview.summary.userName);
  return (
    <Card className="flex flex-col border-border/70 shadow-none">
      <CardHeader>
        <CardTitle as="h2" className="text-base">Constellation preview</CardTitle>
        <p className="text-sm text-muted-foreground">
          Your network at a glance — each constellation is a company or school
        </p>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden p-0 px-4 pb-2">
        {/*
          Not a link: the sky moves under a drag, and a drag that ended over a link would open it.
          A tap still opens the chart, and the footer link is the keyboard's way there.
          300px is a floor, not a size: beside Network depth the card is stretched to that
          card's height, and the sky grows into it instead of leaving a band of empty card.

          The sky is pinned to the stage with `absolute inset-0` rather than sized `h-full`.
          On a phone the card is not stretched, so the stage's height is only its min-height —
          which a percentage height cannot resolve against — and the canvas fell back to its
          intrinsic 150px, drawing the whole sky into the top half of the box.
        */}
        <div
          className={cn(
            "relative min-h-[300px] flex-1 overflow-hidden rounded-2xl border border-white/10",
            STAGE_GROUND
          )}
        >
          <div className="absolute inset-0">
            {sky.count > 0 ? (
              <ConstellationPreviewCanvas
                sky={sky}
                href="/graph"
                label={`Your constellation: ${sky.count.toLocaleString()} ${
                  sky.count === 1 ? "person" : "people"
                }. Drag to move around, pinch to zoom, tap to open the full chart.`}
              />
            ) : (
              <Link
                href="/graph"
                className="flex h-full items-center justify-center text-sm text-white/50"
              >
                Your sky is empty
              </Link>
            )}
          </div>
        </div>
      </CardContent>
      <CardFooter className="border-t border-border/60 pt-4">
        <Link
          href="/graph"
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "gap-1.5"
          )}
        >
          Open full constellation
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </CardFooter>
    </Card>
  );
}
