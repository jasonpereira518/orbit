import type { Metadata } from "next";
import Link from "next/link";
import { OrbitLogo } from "@/components/orbit-logo";

export const metadata: Metadata = {
  title: "Terms of Service — Orbit",
  description: "Terms governing use of Orbit, a personal networking tracker.",
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-6 py-5 md:px-8">
        <Link href="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-80">
          <OrbitLogo size="sm" />
          <span className="font-[family-name:var(--font-display)] text-xl tracking-tight text-primary">
            Orbit
          </span>
        </Link>
        <Link
          href="/sign-in"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Sign in
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl px-6 pb-16 md:px-8">
        <article className="space-y-6">
          <header className="space-y-3">
            <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-tight text-primary sm:text-5xl">
              Terms of Service
            </h1>
            <p className="text-base leading-relaxed text-muted-foreground">
              Orbit is an early-stage, solo-built product. Formal terms of
              service are being finalized. By using Orbit today, you agree to
              use it in good faith and understand it is under active
              development. Questions can be directed to the contact page.
            </p>
          </header>
        </article>

        <p className="mt-12 text-sm text-muted-foreground">
          <Link href="/" className="text-primary underline-offset-4 hover:underline">
            Back to home
          </Link>
        </p>
      </main>
    </div>
  );
}
