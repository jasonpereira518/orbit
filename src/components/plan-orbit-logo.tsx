import { OrbitLogo } from "@/components/orbit-logo";
import type { Plan } from "@/lib/plan-limits";

export function PlanOrbitLogo({
  plan,
  hidden = false,
  target = false,
}: {
  plan: Plan;
  hidden?: boolean;
  target?: boolean;
}) {
  return (
    <span
      data-orbit-logo-target={target ? "" : undefined}
      className={`flex shrink-0 items-center justify-center transition-opacity duration-150 ${hidden ? "opacity-0" : "opacity-100"}`}
      aria-hidden={hidden || undefined}
    >
      <OrbitLogo size="md" plan={plan} />
    </span>
  );
}
