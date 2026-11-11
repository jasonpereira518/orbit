"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Radar } from "lucide-react";
import { turnOnRadar } from "@/actions/radar";
import { ActivationHeroCanvas } from "@/components/radar/activation/activation-canvas";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { prefersReducedMotion } from "@/lib/motion-preference";
import { MIN_REAL_FACES, placeNodes, type SceneFace } from "@/lib/radar/activation-scene";
import { toast } from "@/lib/toast";

const loadStage = () => import("@/components/radar/activation/activation-stage");
const ActivationStage = dynamic(() => loadStage().then((m) => m.ActivationStage), { ssr: false });

type Phase = "off" | "playing" | "landing";

/**
 * Radar is off by default. This is what the page shows until it is turned on: your network,
 * dim, around you, and one button. Pressing it plays the full-screen scene (the short cut if
 * Radar was on before) while `turnOnRadar` saves the switch and starts the first plan.
 * Reduced motion skips the scene: the page just swaps to "Building your first plan".
 */
export function RadarActivation({ faces, everOn }: { faces: SceneFace[]; everOn: boolean }) {
  const router = useRouter();
  const nodes = useMemo(() => placeNodes(faces), [faces]);
  const heroRef = useRef<HTMLDivElement | null>(null);
  const action = useRef<ReturnType<typeof turnOnRadar> | null>(null);
  const [phase, setPhase] = useState<Phase>("off");
  const [heroRect, setHeroRect] = useState<DOMRect | null>(null);

  // Fetch the stage's code while the person reads the page, so the press starts it at once.
  useEffect(() => {
    void loadStage();
  }, []);

  const settle = async () => {
    try {
      const result = await action.current;
      if (!result?.ok) throw new Error(result?.message);
      setPhase("landing");
      router.refresh();
    } catch (err) {
      action.current = null;
      setPhase("off");
      toast.error(friendlyError(err, "Couldn’t turn on Radar just now — try again?"));
    }
  };

  const turnOn = () => {
    if (action.current) return;
    action.current = turnOnRadar();
    if (prefersReducedMotion()) {
      void settle();
      return;
    }
    setHeroRect(heroRef.current?.getBoundingClientRect() ?? null);
    setPhase("playing");
  };

  // Landed: re-read the page until it renders as on. One refresh can land before the server
  // has the new state ready (or, in dev, before the Radar view has compiled).
  useEffect(() => {
    if (phase !== "landing") return;
    let n = 0;
    const id = window.setInterval(() => {
      router.refresh();
      if (++n >= 20) window.clearInterval(id);
    }, 2_000);
    return () => window.clearInterval(id);
  }, [phase, router]);

  const small = faces.length < MIN_REAL_FACES;

  return (
    <section aria-labelledby="radar-activation-title" className="overflow-hidden rounded-2xl border border-border/70">
      <div ref={heroRef} className="relative h-[22rem] sm:h-[26rem]">
        <ActivationHeroCanvas nodes={nodes} hidden={phase === "landing"} />
        {phase === "landing" && (
          <p role="status" className="absolute inset-0 flex items-center justify-center font-heading text-lg text-muted-foreground">
            Building your first plan…
          </p>
        )}
      </div>
      <div className="space-y-3 px-6 py-6 text-center">
        <h2 id="radar-activation-title" className="font-heading text-xl text-ink">
          Radar watches your network so you don’t have to
        </h2>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          Turn it on and Radar reads your notes, checks who’s moved, and builds a short plan each week of who to reach
          out to and why.
          {small && " Radar gets sharper as you add people."}
        </p>
        <Button
          type="button"
          size="lg"
          onClick={turnOn}
          disabled={phase !== "off"}
          className="bg-[#c4a35a] text-[#0B1220] hover:bg-[#c4a35a]/90 active:scale-[0.97]"
        >
          <Radar className="size-4" aria-hidden />
          Turn on Radar
        </Button>
      </div>
      {phase === "playing" && (
        <ActivationStage nodes={nodes} short={everOn} hero={heroRect} onDone={() => void settle()} />
      )}
    </section>
  );
}
