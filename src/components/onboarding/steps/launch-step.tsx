"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { startInAppTour } from "@/actions/tour";
import { OrbitLogo } from "@/components/orbit-logo";
import { Button } from "@/components/ui/button";
import { Stagger, StaggerItem, StepHeading } from "@/components/onboarding/onboarding-ui";
import { friendlyError } from "@/lib/errors";

/**
 * The last stage step on the tour path. It runs the handoff on arrival — one server action
 * that stamps the gate flag, opens the tour and plants the example people — then sends the
 * person to the dashboard, where the coach rail picks them up. A failed seed is not a
 * failed tour: the retry and the "anyway" button both exist so nobody is stranded here.
 */
export function LaunchStep() {
  const [state, setState] = useState<{ phase: "working" | "failed"; error?: string }>({
    phase: "working",
  });
  const attempt = useRef(0);

  // The retry button's own handler: it may flip state synchronously before starting again.
  const launch = () => {
    setState({ phase: "working" });
    run();
  };

  // Only the async callbacks below touch state, which is what keeps the mount effect from
  // calling setState synchronously during render.
  const run = () => {
    const mine = ++attempt.current;
    startInAppTour()
      .then((res) => {
        if (mine !== attempt.current) return;
        // A full load that replaces this entry: the action revalidates (its response can
        // snap a client push back here), and Back from the dashboard should not restore a
        // cached stage mid-tour. The server sends a stale /onboarding on to the dashboard.
        window.location.replace(res.redirectTo);
      })
      .catch((err) => {
        if (mine !== attempt.current) return;
        setState({
          phase: "failed",
          error: friendlyError(err, "Couldn’t set the stage — the tour still works with an empty orbit"),
        });
      });
  };

  // Runs once on arrival. The action is idempotent, so a React strict-mode double mount
  // costs a second no-op write, not a second tour.
  useEffect(() => {
    run();
  }, []);

  return (
    <Stagger className="mx-auto flex max-w-lg flex-col items-center text-center">
      <StaggerItem className="relative mb-7 flex size-28 items-center justify-center">
        <span aria-hidden className="absolute inset-0 rounded-full border border-primary/20" />
        <span
          aria-hidden
          className="absolute inset-0 animate-[interest-orbit_6s_linear_infinite] rounded-full"
        >
          <span className="absolute -top-1 left-1/2 size-2 -translate-x-1/2 rounded-full bg-primary" />
        </span>
        <OrbitLogo size="xl" />
      </StaggerItem>
      <StepHeading eyebrow="Almost there" title="Setting the stage" className="text-center">
        Orbit is adding six example people so every page has something to show. They’re clearly
        marked and disappear when the tour ends.
      </StepHeading>
      {state.phase === "failed" && (
        <StaggerItem className="mt-6 space-y-3">
          <p className="text-sm text-warning" role="status">
            {state.error}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button type="button" onClick={launch}>
              Try again
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => window.location.replace("/dashboard")}
            >
              Start the tour anyway
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          </div>
        </StaggerItem>
      )}
      {state.phase === "working" && (
        <StaggerItem className="mt-6">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Opening your dashboard…
          </p>
        </StaggerItem>
      )}
    </Stagger>
  );
}
