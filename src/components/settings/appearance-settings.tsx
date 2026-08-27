"use client";

import { useSyncExternalStore, useTransition } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { saveThemePreference } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import type { ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";

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
    ? (theme as ThemePreference | undefined) || initialTheme || "system"
    : initialTheme || "system";

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
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Appearance</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose light, dark, or match your system. Saved to your account and
          syncs across devices.
        </p>
      </div>
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
    </section>
  );
}
