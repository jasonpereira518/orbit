import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono, Outfit } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/components/auth-provider";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const outfit = Outfit({
  variable: "--font-sans",
  subsets: ["latin"],
});

/**
 * The operator console's face. Scoped to `/admin` by `.admin-theme` in globals.css — the
 * product keeps Outfit, which is warm and geometric and right for it, and wrong for a
 * dense table of figures.
 */
const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

/**
 * ALSO A BUG FIX. `--font-mono` in globals.css has always read `var(--font-geist-mono)`,
 * and nothing anywhere defined that variable — so the declaration was invalid and every
 * `font-mono` in the codebase silently inherited Outfit instead. Every user ID, every
 * verbatim error block and every feature key has been rendering in a proportional sans,
 * which is precisely what monospace was specified to avoid.
 */
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  // Fraunces has a genuine italic cut, and the pricing headline uses it. Without
  // declaring it here the browser would slant the upright instead, which on a display
  // serif at 56px reads as a mistake. The italic file is only fetched by pages that
  // actually set font-style: italic.
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Orbit — Personal Networking Tracker",
  description:
    "Remember, organize, and act on every meaningful relationship in your network.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/orbit-logo.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/apple-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${outfit.variable} ${fraunces.variable} ${geist.variable} ${geistMono.variable} h-full`}
    >
      <body className="h-full min-h-full font-sans antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AuthProvider>
            {children}
            <Toaster />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
