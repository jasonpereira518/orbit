/**
 * Static leads header, rendered by BOTH page.tsx and loading.tsx so client navigation shows
 * identical pixels before and after data arrives. Must not fetch.
 */
export function LeadsHeader() {
  return (
    <div className="reveal-mount">
      <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">Leads</h1>
      <p className="mt-1 text-muted-foreground">
        Who on your team already knows the people you want to reach.
      </p>
    </div>
  );
}
