import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PlanActivationPreview } from "@/components/celebration/plan-activation-preview";
import { RenderStamp } from "@/components/layout/render-stamp";

export const dynamic = "force-dynamic";

export default async function PlanActivationPreviewPage() {
  const host = (await headers()).get("host")?.toLowerCase() ?? "";
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);

  if (process.env.NODE_ENV !== "development" || !localHost) notFound();

  return (
    <>
      <RenderStamp />
      <PlanActivationPreview />
    </>
  );
}
