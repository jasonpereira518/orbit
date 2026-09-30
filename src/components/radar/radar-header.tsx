/**
 * Static Radar header, rendered by BOTH page.tsx and loading.tsx so client navigation shows
 * identical pixels before and after data arrives. Must not fetch.
 */
export function RadarHeader() {
  return (
    <div className="reveal-mount">
      <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">Radar</h1>
      <p className="mt-1 text-muted-foreground">
        Who to reach out to this week, and why. Orbit checks your network every night.
      </p>
    </div>
  );
}
