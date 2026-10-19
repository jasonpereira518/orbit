"use client";

import { useSyncExternalStore, useTransition } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { saveThemePreference } from "@/actions/settings";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingsRow } from "@/components/settings/settings-section";
import type { ThemePreference } from "@/lib/theme";

const OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  icon: typeof Sun;
}> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/** False during SSR and the hydrating render, true afterwards. */
function useHydrated() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

export function AppearanceSettings({
  initialTheme,
}: {
  initialTheme: ThemePreference | null;
}) {
  const { theme, setTheme } = useTheme();
  const [pending, start] = useTransition();
  const hydrated = useHydrated();

  // next-themes reads localStorage, so `theme` is undefined during SSR and
  // resolved on the client. Trusting it before hydration would highlight a
  // different button than the server markup does — a hydration mismatch on the
  // Button className. Stay on the server-known value until hydration finishes.
  const active: ThemePreference = hydrated
    ? (theme as ThemePreference | undefined) || initialTheme || "light"
    : initialTheme || "light";

  function select(next: ThemePreference) {
    setTheme(next);
    start(async () => {
      try {
        await saveThemePreference(next);
      } catch {
        // Local theme still applies
      }
    });
  }

  return (
    <SettingsRow
      id="settings-appearance"
      title="Theme"
      description="Light, dark, or match your system. Saved to your account, so it follows you across devices."
    >
      <SegmentedControl
        ariaLabel="Theme"
        value={active}
        onChange={(next) => {
          if (!pending && next !== active) select(next);
        }}
        items={OPTIONS.map(({ value, label, icon: Icon }) => ({
          key: value,
          label,
          icon: <Icon aria-hidden />,
          disabled: pending,
        }))}
      />
    </SettingsRow>
  );
}
