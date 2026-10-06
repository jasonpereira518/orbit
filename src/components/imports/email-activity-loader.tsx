"use client";

import { useEffect, useState } from "react";
import {
  getEmailActivityStatus,
  type EmailActivityStatus,
} from "@/actions/email-activity";
import { EmailActivityPanel } from "@/components/imports/email-activity-panel";

/**
 * Fetches the connection state on mount, matching how the other connection panels on this
 * tab load. Renders nothing until it knows: a panel that flashes "connect Google first" at
 * somebody who already has is worse than a beat of nothing.
 */
export function EmailActivityPanelLoader() {
  const [status, setStatus] = useState<EmailActivityStatus | null>(null);

  useEffect(() => {
    let live = true;
    getEmailActivityStatus()
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch(() => {
        // Leave it unrendered; this panel is additive and must not break the imports tab.
      });
    return () => {
      live = false;
    };
  }, []);

  if (!status) return null;
  return <EmailActivityPanel status={status} />;
}
