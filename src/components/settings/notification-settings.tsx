"use client";

import { useEffect, useState } from "react";
import { useGuardedTransition } from "@/lib/single-flight";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { playDing, setDingMuted, useDingMuted } from "@/lib/ding";
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

export function NotificationSettings({
  initialAccountEnabled,
}: {
  /** The account's recorded preference; null if it has never been set. */
  initialAccountEnabled: boolean | null;
}) {
  const [permission, setPermission] =
    useState<NotificationPermissionState>("default");
  const [enabled, setEnabled] = useState(Boolean(initialAccountEnabled));
  const [pending, start] = useGuardedTransition();

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
            kind: "test",
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

  // One status line where the description was: what's on, and what (if anything) to do.
  const status = unsupported
    ? "This browser can’t show notifications."
    : !enabled
      ? "Alerts when follow-ups are due · Off"
      : permission === "granted"
        ? "Alerts when follow-ups are due · On for this device"
        : permission === "denied"
          ? "On, but this browser blocks them · allow them in its site settings"
          : "On for your account · allow this browser to show them";

  function sendTest() {
    start(async () => {
      const res = await sendTestDesktopNotification();
      setPermission(res.permission === "unsupported" ? "unsupported" : res.permission);
      // Every result passes `keep: false`: a test is not news, and the notification
      // center's Missed list is no place for it.
      if (res.ok) {
        toast.success("Test notification sent", {
          description:
            "If nothing pops up, check Notification Center — and System Settings → Notifications for this browser (Focus / alert style)",
          duration: 8000,
          keep: false,
        });
      } else if (res.permission === "denied") {
        toast.error("Notifications are blocked — allow them in your browser’s settings", { keep: false });
      } else if (res.permission === "unsupported") {
        toast.error("This browser doesn’t support notifications", { keep: false });
      } else {
        toast.message("Allow notifications when prompted, then try again", { keep: false });
      }
    });
  }

  return (
    <>
      <SettingsRow
        id="settings-notifications"
        title="Desktop notifications"
        description={<span role="status">{status}</span>}
        action={
          <>
            {!enabled || needsBrowserPermission ? (
              <Button type="button" size="sm" disabled={pending || unsupported} onClick={turnOn}>
                {needsBrowserPermission ? "Allow in this browser" : "Turn on"}
              </Button>
            ) : null}
            {enabled ? (
              <>
                <Button type="button" size="sm" variant="ghost" disabled={pending || unsupported} onClick={sendTest}>
                  Send test
                </Button>
                <Button
                  type="button"
                  size="sm"
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
          </>
        }
      />
      <CompletionSoundRow />
    </>
  );
}

/** The ding when a notification is checked off. Per device; on unless muted. */
function CompletionSoundRow() {
  const muted = useDingMuted();

  return (
    <SettingsRow
      title="Completion sound"
      description={
        <>
          A soft ding when you check off a notification · this browser ·{" "}
          <span role="status">{muted ? "Muted" : "On"}</span>
        </>
      }
      action={
        <>
          {!muted && (
            <Button type="button" size="sm" variant="ghost" onClick={() => playDing()}>
              Play
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              const next = !muted;
              setDingMuted(next);
              if (!next) playDing();
            }}
          >
            {muted ? "Unmute" : "Mute"}
          </Button>
        </>
      }
    />
  );
}
