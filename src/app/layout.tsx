import type { Metadata } from "next";
import { Fraunces, Outfit } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/components/auth-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { WarpProvider } from "@/components/warp/warp-provider";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

const outfit = Outfit({
  variable: "--font-sans",
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
      className={`${outfit.variable} ${fraunces.variable} h-full`}
    >
      <body className="h-full min-h-full font-sans antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <AuthProvider>
            {/* Owns the app <-> /pricing lift-off. Must sit at the ROOT: those
                two live in different route groups, so anything lower unmounts
                mid-flight when the group swaps. */}
            <WarpProvider>{children}</WarpProvider>
            <Toaster />
          </AuthProvider>
        </ThemeProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
