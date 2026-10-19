import { NotFoundFrame } from "@/components/error-fallback";

export default function NotFound() {
  return (
    <NotFoundFrame
      title="Page not found"
      description="That route doesn’t exist — or the link may be out of date."
      // One way out, to `/`, and deliberately not "Go to dashboard": the root not-found
      // is rendered into EVERY page's payload as its boundary fallback, the waitlist's
      // included, so an app path named here ships in the waitlist's HTML. From `/` a
      // signed-in user is one click from the app (in stealth mode, `/` IS the way in).
      // See lib/waitlist-host.ts.
      home={{ href: "/", label: "Back to home" }}
    />
  );
}
