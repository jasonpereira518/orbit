import { redirect } from "next/navigation";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { RenderStamp } from "@/components/layout/render-stamp";

export const metadata = { title: "Find people — Outreach" };

export default async function FindPage() {
  const gate = await pageVisibilityGate("page.find");
  if (gate) {
    return (
      <>
        <RenderStamp />
        {gate}
      </>
    );
  }

  // Find people is now unified under Outreach. Redirect to the unified discovery tab.
  redirect("/outreach?tab=discover");
}
