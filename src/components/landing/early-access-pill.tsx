"use client";

import Link from "next/link";
import { useEffect } from "react";
import { hasSeenAnyPass, PASS_SEEN_KEY } from "@/lib/pass-seen";

/**
 * Marks <html> before first paint when this device has already joined, so the pill can be
 * hidden by CSS instead of mounted by an effect.
 * Kept tiny and dependency-free: it runs during HTML parsing, ahead of every script.
 */
const MARK_IF_JOINED = `try{if(localStorage.getItem(${JSON.stringify(PASS_SEEN_KEY)}))document.documentElement.setAttribute("data-pass-seen","")}catch(e){}`;

/**
 * Bottom-left nudge to the /interest waitlist; hidden on a device that already joined.
 *
 * Rendered in the server HTML. It used to render nothing until an effect had read
 * localStorage after hydration, and as the last large element to appear it WAS the
 * landing page's LCP: 6.4 s on Lighthouse's mobile profile, almost all of it render delay.
 */
export function EarlyAccessPill() {
  // A client-side navigation to "/" does not execute the inline script; mark here instead.
  useEffect(() => {
    if (hasSeenAnyPass()) document.documentElement.setAttribute("data-pass-seen", "");
  }, []);

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: MARK_IF_JOINED }} />
      <Link
        href="/interest"
        className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))] z-40 rounded-full border border-landing-accent bg-[#05070f] px-4 py-2 text-sm font-medium text-[#e8f3f1] transition-colors hover:bg-landing-accent hover:text-[#05070f] focus-visible:bg-landing-accent focus-visible:text-[#05070f] [[data-pass-seen]_&]:hidden"
      >
        Join the waitlist <span aria-hidden="true">→</span>
      </Link>
    </>
  );
}
