import { PlanetArt } from "@/components/interest/planet-art";
import type { ReferralTierId } from "@/lib/interest-list";
import type { WelcomePlanet } from "@/lib/welcome-planets";

/**
 * One planet per tier, escalating: a small dull Mercury for the waitlist itself, up through
 * Earth, Jupiter and ringed Saturn, to the sun for founding member. Same art the pass and the
 * landing hero use (`PlanetArt`, `public/landing/planets/`) — this is not a signup's planet,
 * so it never touches `WelcomePlanet`'s join-order meaning. `size` is the tracker card's; the
 * unlock celebration draws the same art larger.
 */
export const TIER_ART: Record<ReferralTierId, { planet: WelcomePlanet | "sun"; size: number }> = {
  joined: { planet: "mercury", size: 20 },
  "move-up": { planet: "earth", size: 26 },
  "priority-beta": { planet: "jupiter", size: 34 },
  "early-access": { planet: "saturn", size: 44 },
  // The prize. The sun image carries its rays as padding, so its box runs larger than a
  // planet's for the disc to read bigger than ringed Saturn's; it glows even while locked.
  founding: { planet: "sun", size: 88 },
};

/** A tier's art at any size: the sun as its own image, every other tier through `PlanetArt`. */
export function TierArt({ tierId, size }: { tierId: ReferralTierId; size: number }) {
  const { planet } = TIER_ART[tierId];
  if (planet !== "sun") return <PlanetArt planet={planet} size={size} />;
  return (
    <picture>
      <source type="image/avif" srcSet="/landing/planets/sun.avif" />
      <source type="image/webp" srcSet="/landing/planets/sun.webp" />
      <img
        src="/landing/planets/sun.png"
        alt=""
        width={size}
        height={size}
        draggable={false}
        style={{ width: size, height: size, objectFit: "contain", filter: "drop-shadow(0 0 24px rgba(242,193,78,0.8))" }}
      />
    </picture>
  );
}
