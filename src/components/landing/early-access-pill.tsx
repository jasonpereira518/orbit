"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { hasSeenAnyPass } from "@/lib/pass-seen";

/** Bottom-left nudge to the /interest waitlist; hidden on a device that already joined. */
export function EarlyAccessPill() {
  // false until the client storage read: the static HTML renders nothing.
  const [eligible, setEligible] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads client-only storage
    setEligible(!hasSeenAnyPass());
  }, []);

  if (!eligible) return null;

  return (
    <Link
      href="/interest"
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))] z-40 rounded-full border border-landing-accent bg-[#05070f] px-4 py-2 text-sm font-medium text-[#e8f3f1] transition-colors hover:bg-landing-accent hover:text-[#05070f] focus-visible:bg-landing-accent focus-visible:text-[#05070f]"
    >
      Join the waitlist <span aria-hidden="true">→</span>
    </Link>
  );
}
