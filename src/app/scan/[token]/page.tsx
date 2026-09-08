import type { Metadata } from "next";
import { ScanPhoneCapture } from "@/components/imports/scan-phone-capture";
import { findScanHandoff } from "@/lib/scan-handoff";

/**
 * The page a phone lands on after scanning the QR code on a desktop.
 *
 * Public by design and listed in `PUBLIC_ROUTES`: the phone has no Clerk session and the
 * entire point of the handoff is that it never needs one. Authorization is the opaque
 * token in the path, resolved server-side here and re-checked on every upload.
 *
 * Deliberately outside the `(app)` route group — that layout redirects signed-out visitors
 * to /sign-in and mounts the whole app shell, both of which would be wrong here. This is a
 * camera button and nothing else.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Scan notes · Orbit",
  // A handoff link is single-use and short-lived; there is nothing here to index.
  robots: { index: false, follow: false },
};

// The phone should render at device width with the shutter clear of the home indicator.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
};

export default async function ScanHandoffPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const handoff = await findScanHandoff(token);

  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 px-5 py-10"
      style={{ paddingBottom: "calc(2.5rem + env(safe-area-inset-bottom))" }}
    >
      {handoff ? (
        <ScanPhoneCapture token={token} />
      ) : (
        /*
          One calm message for every refusal — expired, already used, unknown, or a
          suspended account. `findScanHandoff` deliberately cannot tell them apart, and a
          raw 404 here would read as "Orbit is broken" rather than "get a fresh code".
        */
        <div className="space-y-2 text-center">
          <h1 className="font-heading text-xl font-medium text-ink">
            This link has expired
          </h1>
          <p className="text-sm text-muted-foreground">
            Scan links last ten minutes and work once. Generate a new QR code on your
            computer and try again.
          </p>
        </div>
      )}
    </main>
  );
}
