"use client";

import { useEffect } from "react";
import { captureTimezone } from "@/actions/settings";

/**
 * Renders nothing. Reports the browser's IANA zone once per mount so the daily
 * follow-up pass can aim at 07:00 local.
 *
 * A client component with no DOM rather than a settings field: asking someone to pick
 * their own timezone from a list is a worse experience than reading it, and the value
 * is only ever used to schedule a background job.
 */
export function TimezoneCapture({ current }: { current: string | null }) {
  useEffect(() => {
    let zone: string | undefined;
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!zone || zone === current) return;
    captureTimezone(zone).catch(() => {});
  }, [current]);

  return null;
}
