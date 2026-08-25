"use client";

import { useCallback, useState, type ReactNode } from "react";
import { HeroPin } from "@/components/landing/hero-pin";
import { LandingHeader } from "@/components/landing/landing-header";
import { usePastHeroPin } from "@/components/landing/use-past-hero-pin";

export function LandingPageShell({
  clerkOn,
  demoMode = false,
  signedIn = false,
  heroCopy,
  claim,
  children,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
  signedIn?: boolean;
  heroCopy: ReactNode;
  claim: ReactNode;
  children: ReactNode;
}) {
  const [heroPinEl, setHeroPinEl] = useState<HTMLElement | null>(null);
  const pastHero = usePastHeroPin(heroPinEl);
  const authProps = { clerkOn, demoMode, signedIn };

  const setHeroPinNode = useCallback((node: HTMLElement | null) => {
    setHeroPinEl(node);
  }, []);

  return (
    <>
      <LandingHeader pastHero={pastHero} {...authProps} />
      <HeroPin ref={setHeroPinNode} heroCopy={heroCopy} claim={claim} />
      {children}
    </>
  );
}
