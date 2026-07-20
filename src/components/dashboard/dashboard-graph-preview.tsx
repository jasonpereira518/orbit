import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { fetchDashboard } from "@/actions/reminders";
import { NetworkGraphLazy } from "@/components/graph/network-graph-lazy";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type GraphPreviewPayload = Awaited<ReturnType<typeof fetchDashboard>>["graphPreview"];

export function DashboardGraphPreview({
  graphPreview,
}: {
  graphPreview: GraphPreviewPayload;
}) {
  return (
    <Card className="flex flex-col border-border/70 shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Constellation preview</CardTitle>
        <p className="text-sm text-muted-foreground">
          Your network at a glance — closer ties sit nearer the center
        </p>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-hidden p-0 px-4 pb-2">
        <NetworkGraphLazy initialData={graphPreview} compact />
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
