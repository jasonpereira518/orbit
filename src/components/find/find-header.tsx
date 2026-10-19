/**
 * Static Find people header, rendered by BOTH page.tsx and loading.tsx so client navigation
 * shows identical pixels before and after data arrives. Must not fetch.
 */
export function FindHeader() {
  return (
    <div className="reveal-mount">
      <h1 className="font-heading text-3xl text-ink">Find people</h1>
      <p className="mt-1 text-muted-foreground">
        Research someone outside your network from the public web, then save them to Orbit.
      </p>
    </div>
  );
}
