"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "@/lib/toast";

/**
 * Keeps `/admin/feedback` current: listens to `/api/admin/feedback/stream` and, when a report
 * or a reply arrives, refreshes the page (the list, the counts and the nav badge together)
 * and says what came in. Connected only while the tab is visible; coming back reconnects, and
 * a refresh then catches up on anything that landed meanwhile.
 */
export function FeedbackInboxLive() {
  const router = useRouter();

  useEffect(() => {
    let source: EventSource | null = null;
    let wasHidden = false;
    const connect = () => {
      if (source || document.visibilityState !== "visible") return;
      source = new EventSource("/api/admin/feedback/stream");
      source.addEventListener("inbox", (event) => {
        let newReports = 0;
        let newReplies = 0;
        try {
          ({ newReports, newReplies } = JSON.parse((event as MessageEvent<string>).data));
        } catch {
          // Still refresh: something changed even if the frame didn't say what.
        }
        router.refresh();
        if (newReports > 0) {
          toast.message(newReports === 1 ? "New feedback just came in" : `${newReports} new pieces of feedback`);
        } else if (newReplies > 0) {
          toast.message(newReplies === 1 ? "New reply in a conversation" : `${newReplies} new replies`);
        }
      });
    };
    const disconnect = () => {
      source?.close();
      source = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Anything that arrived while the tab was away is not in the stream's new baseline.
        if (wasHidden) router.refresh();
        wasHidden = false;
        connect();
      } else {
        wasHidden = true;
        disconnect();
      }
    };
    connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router]);

  return null;
}
