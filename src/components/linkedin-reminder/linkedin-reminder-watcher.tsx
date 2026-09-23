"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { claimLinkedInReminder } from "@/actions/linkedin-export";

/** The stage only loads for the one page load that shows it. */
const LinkedInReminderStage = dynamic(
  () =>
    import("@/components/linkedin-reminder/linkedin-reminder-stage").then((m) => ({
      default: m.LinkedInReminderStage,
    })),
  { ssr: false },
);

/**
 * Let the page the user came for paint first. Also keeps the claim — a server action —
 * clear of the mount-time `router.replace` calls other shell watchers make: an action
 * queued during one of those is dropped and never resolves.
 */
const SETTLE_MS = 1200;
/** Re-check cadence while something else (a dialog, the upgrade celebration) holds the screen. */
const RETRY_MS = 2000;

/**
 * Shows the full-screen "Is your LinkedIn export ready?" reminder on the first app page load
 * at least 24 hours after the account's first login — once per account.
 *
 * `due` comes from the app layout (`getLinkedInReminderState`), but it only arms this: the
 * server action is what takes the single showing, atomically, so a second tab or device
 * rendered from the same stale `due` gets `claimed: false` and draws nothing.
 *
 * It never interrupts another takeover. It waits for a visible tab, no warp in flight, no
 * upgrade celebration, and no open modal dialog, re-checking every couple of seconds.
 */
export function LinkedInReminderWatcher({
  due,
  requested,
  email,
}: {
  due: boolean;
  requested: boolean;
  email: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const settledRef = useRef(false);
  const claimingRef = useRef(false);

  const tryClaim = useCallback(() => {
    if (!due || settledRef.current || claimingRef.current) return;
    if (document.visibilityState !== "visible") return;
    const root = document.documentElement;
    if (root.hasAttribute("data-warp") || root.hasAttribute("data-celebration")) return;
    if (document.querySelector('[role="dialog"][aria-modal="true"], [data-slot="dialog-content"]')) return;

    claimingRef.current = true;
    claimLinkedInReminder()
      .then(({ claimed }) => {
        // A resolved claim is a decision either way; only a transport failure retries.
        settledRef.current = true;
        if (claimed) {
          setMounted(true);
          setOpen(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        claimingRef.current = false;
      });
  }, [due]);

  useEffect(() => {
    if (!due) return;
    let interval = 0;
    const timeout = window.setTimeout(() => {
      tryClaim();
      interval = window.setInterval(() => {
        if (settledRef.current) window.clearInterval(interval);
        else tryClaim();
      }, RETRY_MS);
    }, SETTLE_MS);
    const onVisible = () => tryClaim();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [due, tryClaim]);

  // Dev preview: `?preview=linkedin-reminder` draws the stage without claiming, so it can be
  // looked at on any account and replayed. `NODE_ENV` is inlined at build time, so this
  // branch does not exist in production bundles.
  const [preview, setPreview] = useState<null | { requested: boolean }>(null);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const param = new URLSearchParams(window.location.search).get("preview");
    if (param !== "linkedin-reminder" && param !== "linkedin-reminder-unrequested") return;
    const timeout = window.setTimeout(() => {
      setPreview({ requested: param === "linkedin-reminder" });
      setMounted(true);
      setOpen(true);
    }, SETTLE_MS);
    return () => window.clearTimeout(timeout);
  }, []);

  if (!mounted) return null;
  return (
    <LinkedInReminderStage
      open={open}
      requested={preview ? preview.requested : requested}
      email={email}
      onClose={() => setOpen(false)}
    />
  );
}
