/**
 * Static events header, rendered by BOTH page.tsx and loading.tsx so client navigation shows
 * identical pixels before and after data arrives. Must not fetch.
 */
export function EventsHeader() {
  return (
    <div className="reveal-mount">
      <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">Events</h1>
      <p className="mt-1 text-muted-foreground">
        Conferences, meetups and parties you went to — and the people you met there.
      </p>
    </div>
  );
}
