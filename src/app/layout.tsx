import type { Metadata, Viewport } from "next";
import { Fraunces, Outfit } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { SkipLink } from "@/components/ui/skip-link";
import { ThemeProvider } from "@/components/theme-provider";
import { WarpProvider } from "@/components/warp/warp-provider";
import { PageviewBeacon } from "@/components/analytics/pageview-beacon";
import { VercelTelemetry } from "@/components/analytics/vercel-telemetry";

const outfit = Outfit({
  variable: "--font-sans",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  style: ["normal"],
});

/**
 * Fraunces has a genuine italic cut, and the pricing and waitlist headlines use it. Without
 * it the browser would slant the upright instead, which on a display serif at 56px reads as
 * a mistake. Declared as its own face with `preload: false`: in the same declaration as the
 * upright, `next/font` preloaded its 45 KB on every page, app pages included, which never
 * set a display-serif italic (LATENCY_PLAN NET-3). theme.css points italic text inside a
 * display-serif element at this family; the browser fetches it only where that happens.
 */
const frauncesItalic = Fraunces({
  variable: "--font-display-italic",
  subsets: ["latin"],
  style: ["italic"],
  preload: false,
});

export const metadata: Metadata = {
  // Every page names itself ("Contacts · Orbit"). Beyond the tab, this is how a screen reader
  // hears a client-side navigation at all: Next's route announcer speaks only when
  // `document.title` changes, so pages sharing one title navigated in silence.
  title: {
    template: "%s · Orbit",
    default: "Orbit — Personal Networking Tracker",
  },
  description:
    "Remember, organize, and act on every meaningful relationship in your network.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/orbit-logo.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/apple-icon.png",
  },
  /**
   * Stop iOS Safari rewriting the server HTML before React hydrates.
   *
   * Its data detectors wrap anything that looks like a phone number (and sometimes an
   * address or email) in a link, so the markup React finds is not the markup it sent.
   * Every page that shows one — a recruiter's contact card, say — failed hydration on
   * an iPhone and had that tree thrown away and re-rendered on the client. Nothing is
   * lost by switching it off: the link Safari added never survived that re-render.
   */
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
};

/**
 * `viewport-fit=cover` is what makes `env(safe-area-inset-*)` non-zero on iOS: without it the
 * bottom nav's and corner controls' safe-area padding resolved to 0 in landscape and in a
 * home-screen web app. No `maximumScale`: pinch-zoom must always work.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
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
      className={`${outfit.variable} ${fraunces.variable} ${frauncesItalic.variable} h-full`}
    >
      <body className="h-full min-h-full font-sans antialiased">
        {/* First in the document, so it is the first Tab on every page. */}
        <SkipLink />
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          {/* No ClerkProvider here: it lives in (clerk)/layout.tsx, so the
              pages in (site) — the landing page, /interest and the docs — ship
              no Clerk JS at all. */}
          {/* Owns the app <-> /pricing lift-off. Must sit at the ROOT: those
              two live in different route groups, so anything lower unmounts
              mid-flight when the group swaps. */}
          <WarpProvider>{children}</WarpProvider>
          <Toaster />
        </ThemeProvider>
        {/* Orbit's own traffic pipeline: page views, sessions and geography, read by
            /admin/analytics. Vercel's Web Analytics counts page views too, and Speed
            Insights measures load performance, but neither can be joined to the users and
            billing tables — so conversion has to be measured here. */}
        <PageviewBeacon />
        {/* Redacted: Vercel sees route patterns, never ids, tokens or admin URLs. */}
        <VercelTelemetry />
      </body>
    </html>
  );
}
