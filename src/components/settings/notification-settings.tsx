"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/settings/settings-section";
import {
  DESKTOP_PREFERENCE_EVENT,
  ensureNotificationPermission,
  getNotificationSupport,
  isDesktopNotificationsPreferred,
  registerNotificationServiceWorker,
  sendTestDesktopNotification,
  setDesktopNotificationsPreferred,
  showDesktopNotification,
  syncDesktopNotificationsPreference,
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
// Each calls `toast` directly rather than taking it as a parameter, so
// scripts/smoke-toast-copy.ts — which looks for `toast.*(` — checks this copy too.
const TEST_TOASTS: (() => void)[] = [
  () =>
    toast.success("Test notification sent", {
      description:
        "If nothing pops up, check Notification Center — and System Settings → Notifications for this browser (Focus / alert style)",
      duration: 8000,
      keep: false,
    }),
  () =>
    toast.error("Sample error — nothing actually went wrong", {
      description:
        "Errors stay for ten seconds and hovering pauses them — anything past three lines tucks behind See more, and opening it grows the toast to fit, which is what this long sentence is here to show",
      keep: false,
    }),
  () => toast.warning("Sample warning — two contacts look alike", { keep: false }),
  () =>
    toast.info("Sample notice — calendar sync finished", {
      description: "Info and warning have almost no real call sites yet",
      keep: false,
    }),
  () =>
    toast.message("Sample message with an action", {
      description: "A plain message takes no accent rail and no icon",
      action: { label: "Undo", onClick: () => {} },
      keep: false,
    }),
];

export function NotificationSettings({
  initialAccountEnabled,
}: {
  /** The account's recorded preference; null if it has never been set. */
  initialAccountEnabled: boolean | null;
}) {
  const [permission, setPermission] =
    useState<NotificationPermissionState>("default");
  const [enabled, setEnabled] = useState(Boolean(initialAccountEnabled));
  const [pending, start] = useTransition();
  // Survives re-renders without causing one — nothing renders from it.
  const testToastIndex = useRef(0);

  useEffect(() => {
    // A never-recorded account adopts this device's old local-only choice (and writes it
    // up); a recorded one overwrites a stale local mirror. Either way, show the result.
    syncDesktopNotificationsPreference(initialAccountEnabled);
    setPermission(getNotificationSupport());
    setEnabled(initialAccountEnabled ?? isDesktopNotificationsPreferred());

    // Another tab, or a pulse carrying a change made on another device.
    const onChange = (event: Event) =>
      setEnabled((event as CustomEvent<{ enabled: boolean }>).detail.enabled);
    window.addEventListener(DESKTOP_PREFERENCE_EVENT, onChange);
    return () => window.removeEventListener(DESKTOP_PREFERENCE_EVENT, onChange);
  }, [initialAccountEnabled]);

  const unsupported = permission === "unsupported";
  // On for the account, but this browser has not been asked yet: the one state where the
  // primary action is about the device rather than the account.
  const needsBrowserPermission = enabled && permission === "default";

  function turnOn() {
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
    });
  }

  return (
    <SettingsRow
      id="settings-notifications"
      title="Desktop notifications"
      description="Alerts when follow-ups are due. The on/off choice follows your account; each browser still has to be allowed to show them."
    >
      <p className="text-sm text-muted-foreground" role="status">
        {unsupported ? (
          "This browser can’t show notifications."
        ) : !enabled ? (
          <>
            <span className="font-medium text-ink">Off</span> for your account.
          </>
        ) : permission === "granted" ? (
          <>
            <span className="font-medium text-ink">On</span> — alerts appear on
            this device.
          </>
        ) : permission === "denied" ? (
          <>
            <span className="font-medium text-ink">On</span> for your account,
            but this browser blocks notifications — allow them in its site
            settings.
          </>
        ) : (
          <>
            <span className="font-medium text-ink">On</span> for your account.
            This browser hasn’t been allowed to show them yet.
          </>
        )}
      </p>

      <div className="flex flex-wrap gap-2">
        {!enabled || needsBrowserPermission ? (
          <Button
            type="button"
            disabled={pending || unsupported}
            className="bg-primary text-primary-foreground"
            onClick={turnOn}
          >
            {needsBrowserPermission ? "Allow in this browser" : "Turn on"}
          </Button>
        ) : null}
        {enabled ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={pending || unsupported}
              onClick={() =>
                start(async () => {
                  const res = await sendTestDesktopNotification();
                  setPermission(
                    res.permission === "unsupported"
                      ? "unsupported"
                      : res.permission
                  );
                  if (res.ok) {
                    TEST_TOASTS[testToastIndex.current % TEST_TOASTS.length]();
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
              disabled={pending}
              onClick={() => {
                setDesktopNotificationsPreferred(false);
                setEnabled(false);
                toast.success("Notifications turned off");
              }}
            >
              Turn off
            </Button>
          </>
        ) : null}
      </div>
    </SettingsRow>
  );
}
