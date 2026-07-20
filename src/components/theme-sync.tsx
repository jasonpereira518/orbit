"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import type { ThemePreference } from "@/lib/theme";

/** Apply the server-stored theme once per session when the user opens the app. */
export function ThemeSync({ theme }: { theme: ThemePreference | null }) {
  const { setTheme } = useTheme();
  const applied = useRef(false);

  useEffect(() => {
    if (!theme || applied.current) return;
    setTheme(theme);
    applied.current = true;
  }, [theme, setTheme]);

  return null;
}
