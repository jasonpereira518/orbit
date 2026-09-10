"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  ensureNotificationPermission,
  getNotificationSupport,
  isDesktopNotificationsPreferred,
  registerNotificationServiceWorker,
  sendTestDesktopNotification,
  setDesktopNotificationsPreferred,
  showDesktopNotification,
  type NotificationPermissionState,
} from "@/lib/browser-notifications";

/**
 * What "Send test notification" shows, one per click.
 *
 * The button's real job is testing the OS notification path, and it still does
 * that on every click — this is the toast that reports it, cycled through the
 * variants so the styling of each can actually be seen. Only `error` and
 * `info` otherwise appear in the app often enough to eyeball, and `warning`
 * has no other trigger at all.
 *
 * Every one passes `keep: false`. Without it the error sample would file
 * itself under Missed in the notification center and sit there claiming
 * something broke, and the sample with an action would do the same.
 *
 * The copy says "Sample" on everything except the first, which is the genuine
 * result of the send that just happened.
 */
const TEST_TOASTS: ((t: typeof toast) => void)[] = [
  (t) =>
    t.success("Test notification sent", {
      description:
        "If nothing pops up, check Notification Center — and System Settings → Notifications for this browser (Focus / alert style).",
      duration: 8000,
      keep: false,
    }),
  (t) =>
    t.error("Sample error — nothing actually failed", {
      description:
        "Errors run for ten seconds rather than four, and hovering pauses that. A description longer than three lines is clamped, which is what this sentence is here to demonstrate: the rest of it is cut off with an ellipsis rather than growing the toast.",
      keep: false,
    }),
  (t) => t.warning("Sample warning — two contacts look alike", { keep: false }),
  (t) =>
    t.info("Sample notice — calendar sync finished", {
      description: "Info and warning have almost no real call sites yet.",
      keep: false,
    }),
  (t) =>
    t.message("Sample message with an action", {
      description: "A plain message takes no accent rail and no icon.",
      action: { label: "Undo", onClick: () => {} },
      keep: false,
    }),
];

export function NotificationSettings() {
  const [permission, setPermission] =
    useState<NotificationPermissionState>("default");
  const [enabled, setEnabled] = useState(false);
  const [pending, start] = useTransition();
  // Survives re-renders without causing one — nothing renders from it.
  const testToastIndex = useRef(0);

  useEffect(() => {
    setPermission(getNotificationSupport());
    setEnabled(isDesktopNotificationsPreferred());
  }, []);

  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-ink">
          Browser & desktop notifications
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Get alerts on this device when follow-ups are due. Allow notifications
          in your browser — and in System Settings if banners don&apos;t appear.
        </p>
      </div>

      <p className="text-sm text-muted-foreground">
        Status:{" "}
        <span className="font-medium text-ink">
          {permission === "unsupported"
            ? "Not supported in this browser"
            : permission === "granted"
              ? "Permission granted"
              : permission === "denied"
                ? "Permission blocked — enable in browser settings"
                : "Permission not decided yet"}
        </span>
        {" · "}
        Preference:{" "}
        <span className="font-medium text-ink">
          {enabled ? "On" : "Off"}
        </span>
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={pending || permission === "unsupported"}
          className="bg-primary text-primary-foreground"
          onClick={() =>
            start(async () => {
              setDesktopNotificationsPreferred(true);
              setEnabled(true);
              await registerNotificationServiceWorker();
              const next = await ensureNotificationPermission();
              setPermission(next);
              if (next === "granted") {
                toast.success("Desktop notifications are on");
                await showDesktopNotification(
                  {
                    id: `orbit-welcome-${Date.now()}`,
                    title: "Orbit is ready",
                    body: "You’ll get alerts here when follow-ups are due.",
                    url: "/dashboard",
                  },
                  { force: true }
                );
              } else if (next === "denied") {
                toast.error("Notifications are blocked — allow them in your browser’s settings");
              } else {
                toast.message("Still waiting on permission");
              }
            })
          }
        >
          Enable notifications
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending || permission === "unsupported"}
          onClick={() =>
            start(async () => {
              const res = await sendTestDesktopNotification();
              setPermission(
                res.permission === "unsupported"
                  ? "unsupported"
                  : res.permission
              );
              if (res.ok) {
                TEST_TOASTS[testToastIndex.current % TEST_TOASTS.length](
                  toast
                );
                testToastIndex.current += 1;
              } else if (res.permission === "denied") {
                // Genuine failures report themselves and do not advance the
                // cycle: you need to know the send failed, and every click
                // will keep failing until the permission changes.
                toast.error("Notifications are blocked — allow them in your browser’s settings", {
                  keep: false,
                });
              } else if (res.permission === "unsupported") {
                toast.error("This browser doesn’t support notifications", {
                  keep: false,
                });
              } else {
                toast.message(
                  "Allow notifications when prompted, then try again",
                  { keep: false }
                );
              }
            })
          }
        >
          Send test notification
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending || !enabled}
          onClick={() => {
            setDesktopNotificationsPreferred(false);
            setEnabled(false);
            toast.success("Notifications turned off");
          }}
        >
          Turn off
        </Button>
      </div>
    </section>
  );
}
