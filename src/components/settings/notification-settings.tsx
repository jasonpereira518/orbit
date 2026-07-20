"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
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

export function NotificationSettings() {
  const [permission, setPermission] =
    useState<NotificationPermissionState>("default");
  const [enabled, setEnabled] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    setPermission(getNotificationSupport());
    setEnabled(isDesktopNotificationsPreferred());
  }, []);

  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-primary">
          Browser & desktop notifications
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Get alerts on this device when follow-ups are due. Allow notifications
          in your browser — and in System Settings if banners don&apos;t appear.
        </p>
      </div>

      <p className="text-sm text-muted-foreground">
        Status:{" "}
        <span className="font-medium text-foreground">
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
        <span className="font-medium text-foreground">
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
                toast.success("Desktop notifications enabled");
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
                toast.error("Notifications blocked in browser settings");
              } else {
                toast.message("Permission still pending");
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
                toast.success("Test notification sent", {
                  description:
                    "If nothing pops up, check Notification Center — and System Settings → Notifications for this browser (Focus / alert style).",
                  duration: 8000,
                });
              } else if (res.permission === "denied") {
                toast.error("Notifications blocked in browser settings");
              } else if (res.permission === "unsupported") {
                toast.error("Notifications not supported in this browser");
              } else {
                toast.message(
                  "Allow notifications when prompted, then try again"
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
