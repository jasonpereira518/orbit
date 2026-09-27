import { ConstellationPreviewCanvas } from "@/components/dashboard/constellation-preview-canvas";
import { buildPreviewSky } from "@/lib/graph/preview-sky";
import { buildSyntheticGraphPayload } from "@/lib/graph/synthetic-network";
import { STAGE_GROUND } from "@/lib/graph/stage-layers";

/**
 * The dashboard's constellation preview on a synthetic 150-contact network (the dashboard's cap),
 * for measuring against `/bench/preview-old`. Bench-only: compiled only with ORBIT_BENCH=1.
 */
export default function PreviewBenchPage() {
  const payload = buildSyntheticGraphPayload(150);
  const sky = buildPreviewSky(payload.contacts, "You");
  return (
    <main className="mx-auto max-w-xl p-6">
      <div className={`h-[300px] overflow-hidden rounded-2xl border border-white/10 ${STAGE_GROUND}`}>
        <ConstellationPreviewCanvas sky={sky} href="/graph" label="Constellation preview" />
      </div>
    </main>
  );
}
