"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Refresh server-rendered data when the user returns to this browser tab. */
export function useRefreshOnVisible() {
  const router = useRouter();

  useEffect(() => {
    let lastRefresh = 0;
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      // visibilitychange + focus often fire together; coalesce into one refresh.
      const now = Date.now();
      if (now - lastRefresh < 500) return;
      lastRefresh = now;
      router.refresh();
    }

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [router]);
}
