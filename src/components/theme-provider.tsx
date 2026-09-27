"use client";

import * as React from "react";
import { useLayoutEffect } from "react";
import { usePathname } from "next/navigation";
import { ThemeProvider as NextThemesProvider } from "next-themes";

// next-themes injects an inline <script> to prevent theme flicker.
// React 19 warns about script tags inside client components; the script still
// runs correctly during SSR, so this is a known false positive.
if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    const text = args
      .map((arg) => (typeof arg === "string" ? arg : ""))
      .join(" ");
    if (text.includes("Encountered a script tag")) return;
    orig.apply(console, args);
  };
}

function isAdminPath(pathname: string | null) {
  return pathname === "/admin" || (pathname?.startsWith("/admin/") ?? false);
}

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  const pathname = usePathname();
  // The operator console is always light. It has to be forced here, on the root provider:
  // a nested next-themes provider is a no-op, and `forcedTheme` never overwrites the stored
  // preference, so leaving /admin restores whatever the operator picked for the product.
  const forcedTheme = isAdminPath(pathname) ? "light" : props.forcedTheme;
  const { storageKey = "theme", defaultTheme = "light" } = props;

  // next-themes applies the class in a passive effect, i.e. after paint, so a client-side
  // navigation between the dark product and /admin painted the new page in the old theme
  // for a frame (measured at 140ms under load). Apply the same resolution before paint.
  useLayoutEffect(() => {
    let theme: string | null | undefined = forcedTheme;
    if (!theme) {
      try {
        theme = localStorage.getItem(storageKey);
      } catch {}
      theme ??= defaultTheme;
    }
    if (theme === "system") {
      theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    if (theme !== "light" && theme !== "dark") return;
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
    root.style.colorScheme = theme;
  }, [forcedTheme, storageKey, defaultTheme]);

  return (
    <NextThemesProvider {...props} forcedTheme={forcedTheme}>
      {children}
    </NextThemesProvider>
  );
}
