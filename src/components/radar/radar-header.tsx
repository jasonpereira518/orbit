import { PageHeader } from "@/components/layout/page-header";

/**
 * Static Radar header, rendered by BOTH page.tsx and loading.tsx so client navigation shows
 * identical pixels before and after data arrives. Must not fetch.
 */
export function RadarHeader() {
  return (
    <PageHeader
      title="Radar"
      subtitle="Who to reach out to this week, and why. Orbit checks your network every night."
    />
  );
}
