"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pause, Play } from "lucide-react";
import { setManagedAiPausedAction } from "@/actions/admin";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import type { ManagedAiSwitchState } from "@/lib/managed-ai-switch";
import { friendlyError } from "@/lib/errors";
import { MANAGED_AI_POOLS, poolWindowStart } from "@/lib/managed-ai-policy";
import type { AiProvider } from "@/lib/ai-providers";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
const POOL_LABELS: Partial<Record<AiProvider, string>> = { anthropic: "Anthropic", openai: "OpenAI" };

/**
 * Included AI on every plan: on or paused. Turning it ON is confirmed, because from that
 * moment Orbit pays the model bills for every account without a key of its own; pausing is
 * not, because pausing is the safe direction.
 */
export function ManagedAiSwitch({ state }: { state: ManagedAiSwitchState }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const pools = (Object.keys(MANAGED_AI_POOLS) as AiProvider[]).map((provider) => {
    const pool = MANAGED_AI_POOLS[provider]!;
    const spent = state.poolSpentMicros[provider] ?? 0;
    return { provider, pool, spent, out: spent >= pool.capMicros };
  });
  const poolSpent = pools.every((p) => p.out);
  const running = !state.paused && !state.envOff && state.keysConfigured && !poolSpent;

  const pause = () =>
    start(async () => {
      try {
        await setManagedAiPausedAction({ paused: true, reason: "Paused from the Money page" });
        toast.success("Included AI is paused");
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t pause included AI — try again?"));
      }
    });

  const blocker = state.envOff
    ? "ORBIT_MANAGED_AI=off is set in this environment, which overrides this switch."
    : !state.keysConfigured
      ? "No provider key is configured for Orbit, so included AI cannot run until one is."
      : poolSpent
        ? "Every provider pool is spent. A monthly pool refills on its reset day; a prepaid one needs a top-up and a higher capMicros in MANAGED_AI_POOLS."
        : null;

  const track = (
    <span
      aria-hidden
      className={cn(
        "inline-block size-4.5 rounded-full bg-background shadow transition-transform duration-fast",
        !state.paused ? "translate-x-[1.35rem]" : "translate-x-0.5"
      )}
    />
  );
  const switchClass = cn(
    "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-fast disabled:opacity-60",
    !state.paused ? "border-primary/40 bg-primary" : "border-border bg-muted"
  );

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm">
          {running ? (
            <Play className="size-3.5 text-primary" aria-hidden />
          ) : (
            <Pause className="size-3.5 text-muted-foreground" aria-hidden />
          )}
          {running ? "Included AI is on for every plan" : state.paused ? "Included AI is paused" : "Included AI is switched on but can’t run"}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {running
            ? "Every plan spends its monthly credits on Orbit’s keys unless the account prefers its own."
            : state.paused && !state.explicit
              ? "Never switched on here, so it is paused by default on production."
              : "Accounts use their own key if they have one; otherwise AI features wait."}{" "}
          Changes reach every server within about thirty seconds.
        </p>
        {pools.map(({ provider, pool, spent }) => (
          <p key={provider} className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {POOL_LABELS[provider] ?? provider} pool: {usd(spent)} of{" "}
            {usd(pool.capMicros)} since {poolWindowStart(pool, new Date()).toISOString().slice(0, 10)}
            {pool.monthlyResetDay ? ` · refills on day ${pool.monthlyResetDay}` : " · no refill"}
          </p>
        ))}
        {blocker && <p className="mt-1 text-xs text-destructive">{blocker}</p>}
      </div>
      {state.paused ? (
        <ConfirmActionDialog
          trigger={
            <button type="button" role="switch" aria-checked={false} aria-label="Included AI" className={switchClass}>
              {track}
            </button>
          }
          title="Turn on included AI?"
          description="Every account without its own key starts spending its monthly credits on Orbit’s provider keys, and Orbit pays those model bills (up to the shared pool). Make sure the Terms and Privacy Policy describing included AI are live first."
          confirmLabel="Turn it on"
          onConfirm={(reason) => setManagedAiPausedAction({ paused: false, reason })}
        />
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked
          aria-label="Included AI"
          disabled={pending}
          onClick={pause}
          className={switchClass}
        >
          {track}
        </button>
      )}
    </div>
  );
}
