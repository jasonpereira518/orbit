"use client";

import { useSyncExternalStore, useTransition } from "react";
import { Monitor, Moon, Pause, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { saveThemePreference } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/settings/settings-section";
import type { ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { setAppReduceMotion } from "@/lib/motion-preference";
import { useAppReducesMotion } from "@/lib/use-prefers-reduced-motion";

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
    <>
    <SettingsRow
      id="settings-appearance"
      title="Theme"
      description="Light, dark, or match your system. Saved to your account, so it follows you across devices."
    >
      <div className="flex flex-wrap gap-2">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <Button
            key={value}
            type="button"
            variant={active === value ? "default" : "outline"}
            size="sm"
            disabled={pending}
            className={cn(
              "gap-1.5",
              active === value && "bg-primary text-primary-foreground hover:bg-primary/90"
            )}
            onClick={() => select(value)}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </Button>
        ))}
      </div>
    </SettingsRow>
    <ReduceMotionSetting />
    </>
  );
}

/**
 * Orbit's own Reduce motion, for calm without changing the whole computer: it stops the
 * looping and decorative animation everywhere in Orbit on this device (lib/motion-preference).
 * The system setting still applies on its own when this is off.
 */
function ReduceMotionSetting() {
  const on = useAppReducesMotion();
  const options = [
    { value: false, label: "Match system", icon: Monitor },
    { value: true, label: "Reduce", icon: Pause },
  ] as const;

  return (
    <SettingsRow
      id="settings-motion"
      title="Motion"
      description="Reduce stops Orbit's animations on this device: the moving starfields, loops and slides. Match system follows your device's reduced-motion setting."
    >
      <div role="radiogroup" aria-label="Motion" className="flex flex-wrap gap-2">
        {options.map(({ value, label, icon: Icon }) => (
          <Button
            key={label}
            type="button"
            role="radio"
            aria-checked={on === value}
            variant={on === value ? "default" : "outline"}
            size="sm"
            className={cn(
              "gap-1.5",
              on === value && "bg-primary text-primary-foreground hover:bg-primary/90"
            )}
            onClick={() => setAppReduceMotion(value)}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </Button>
        ))}
      </div>
    </SettingsRow>
  );
}
