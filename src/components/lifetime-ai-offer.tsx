"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether this deployment can honour "Orbit Lifetime includes AI" — i.e. it holds at least
 * one managed AI key (`managedKeysConfigured` in `src/lib/ai-access.ts`).
 *
 * Every in-app pitch for Lifetime-as-AI reads this, so the product never offers AI it
 * would then refuse: with no managed key set, a Lifetime buyer is still BYOK, and a notice
 * that sold them Lifetime for its AI would be the confusing error this whole gate exists to
 * prevent. Provided once, by the (app) layout, which reads the server's actual keys.
 */
const LifetimeAiOffer = createContext(false);

export function LifetimeAiOfferProvider({
  value,
  children,
}: {
  value: boolean;
  children: ReactNode;
}) {
  return <LifetimeAiOffer.Provider value={value}>{children}</LifetimeAiOffer.Provider>;
}

export function useLifetimeIncludesAi(): boolean {
  return useContext(LifetimeAiOffer);
}
