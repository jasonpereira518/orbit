import Link from "next/link";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { OrbitLogo } from "@/components/orbit-logo";

export function LandingHeader({
  clerkOn,
  demoMode = false,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
}) {
  return (
    <header className="relative z-10 flex items-center justify-between px-6 py-5 md:px-10">
      <Link href="/" className="flex items-center gap-2.5" aria-label="Orbit home">
        <OrbitLogo size="md" priority />
        <span className="font-[family-name:var(--font-display)] text-xl tracking-tight text-[#e8f3f1]">
          Orbit
        </span>
      </Link>
      <LandingAuthControls clerkOn={clerkOn} demoMode={demoMode} variant="header" />
    </header>
  );
}
