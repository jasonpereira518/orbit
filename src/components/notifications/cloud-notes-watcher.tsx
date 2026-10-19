"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { extractCloudNotes, markCloudNotesNotified, scanCloudNotesOnOpen } from "@/actions/cloud-notes";
import { refreshPulse, useAppPulse } from "@/lib/app-pulse-store";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

const REVIEW_URL = "/capture?mode=cloud&review=1";
/**
 * How often this browser may ASK the server for an on-open scan. The server owns the real
 * rule (a drive unscanned for 60 minutes); this only stops every tab focus posting an action.
 */
const OPEN_CHECK_EVERY_MS = 10 * 60_000;
const OPEN_CHECK_KEY = "orbit:cloud-notes:open-check";
/** After page load, so the check never takes the Server Action lane the page needs first. */
const OPEN_CHECK_DELAY_MS = 5_000;
/** Roughly how long a background drive scan takes before the pulse can show its finds. */
const SCAN_SETTLE_MS = 20_000;

/**
 * Toasts once when the cloud-notes scan finds meeting notes (Extract for one, Review for
 * several), or extracted some on its own. The server stamps each doc as told, so another tab
 * or device never toasts it again; the bell keeps the row until the docs are dealt with.
 */
export function CloudNotesWatcher() {
  const { pulse } = useAppPulse();
  const router = useRouter();
  const seen = useRef(new Set<string>());
  const news = pulse?.panel.cloudNotes;

  // Opening the app (or coming back to the tab) after an hour away scans the drives then,
  // rather than waiting for the next cron pass.
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    function maybeScan() {
      if (document.visibilityState !== "visible") return;
      let last = 0;
      try {
        last = Number(window.localStorage.getItem(OPEN_CHECK_KEY)) || 0;
      } catch {}
      if (Date.now() - last < OPEN_CHECK_EVERY_MS) return;
      try {
        window.localStorage.setItem(OPEN_CHECK_KEY, String(Date.now()));
      } catch {}
      void scanCloudNotesOnOpen()
        .then((res) => {
          if (res.started) settle = setTimeout(() => void refreshPulse(true), SCAN_SETTLE_MS);
        })
        .catch(() => {});
    }
    const first = setTimeout(maybeScan, OPEN_CHECK_DELAY_MS);
    document.addEventListener("visibilitychange", maybeScan);
    return () => {
      clearTimeout(first);
      clearTimeout(settle);
      document.removeEventListener("visibilitychange", maybeScan);
    };
  }, []);

  useEffect(() => {
    if (!news) return;
    const found = news.newFound.filter((f) => !seen.current.has(f.id));
    const extracted = news.newExtracted.filter((f) => !seen.current.has(f.id));
    if (found.length === 0 && extracted.length === 0) return;
    for (const f of [...found, ...extracted]) seen.current.add(f.id);

    if (found.length === 1) {
      const [doc] = found;
      toast.message(`“${doc.name}” looks like meeting notes`, {
        description: "Extract the people and follow-ups from it?",
        duration: 15_000,
        keep: false,
        action: {
          label: "Extract",
          // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the async body catches its own errors; nothing can reject out of it
          onClick: async () => {
            try {
              const res = await extractCloudNotes({
                provider: doc.provider,
                files: [{ id: doc.fileId, name: doc.name }],
                batchGroupId: crypto.randomUUID(),
              });
              if (!res.ok) {
                toast.error(res.error, { keep: false });
                return;
              }
              router.push("/capture");
            } catch (err) {
              toast.error(friendlyError(err, TOAST_COPY.notesReadFailed), { keep: false });
            }
          },
        },
      });
    } else if (found.length > 1) {
      toast.message(`${found.length} docs look like meeting notes`, {
        description: "Review them and extract the ones you want",
        duration: 15_000,
        keep: false,
        action: { label: "Review", onClick: () => router.push(REVIEW_URL) },
      });
    }
    if (extracted.length > 0) {
      toast.success(
        extracted.length === 1
          ? `Extracting “${extracted[0].name}” from your drive`
          : `Extracting ${extracted.length} meeting notes from your drive`,
        {
          description: "You’ll review who’s in them on Capture",
          duration: 15_000,
          keep: false,
          action: { label: "Open", onClick: () => router.push("/capture") },
        },
      );
    }
    void markCloudNotesNotified([...found, ...extracted].map((f) => f.id))
      .then(() => refreshPulse(true))
      .catch(() => {});
  }, [news, router]);

  return null;
}
