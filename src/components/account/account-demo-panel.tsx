/**
 * What an account screen shows with no Clerk keys configured — which is every local
 * `next dev`. A server component on purpose: it must be renderable above the `clerkOn`
 * gate, where no Clerk hook may run.
 */
export function AccountDemoPanel({ what }: { what: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-6">
      <p className="text-sm text-muted-foreground">
        {what} lives in Clerk, and this is a local demo account with no Clerk keys — so
        there’s nothing here to change. Add Clerk keys to your environment to manage it.
      </p>
    </div>
  );
}
