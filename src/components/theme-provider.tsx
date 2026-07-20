"use client";

import * as React from "react";
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

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
