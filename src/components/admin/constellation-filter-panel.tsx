"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Stars } from "lucide-react";
import { setConstellationConfigAction } from "@/actions/admin";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConstellationConfig } from "@/lib/constellation-config";
import {
  MAX_MESSAGE_THRESHOLD,
  MIN_MESSAGE_THRESHOLD,
} from "@/lib/constellation-eligibility";
import { cn } from "@/lib/utils";

/**
 * The operator's control over what the star chart means.
 *
 * The switch is optimistic with a rollback, for the same reason `SurfaceToggles` is: it is
 * the only feedback there is, and a control that sits still for a round trip reads as dead.
 * The thresholds are not — they save on an explicit click, because a number field that wrote
 * on every keystroke would fire a global write (and an audit row) for each digit typed.
 */
export function ConstellationFilterPanel({ config }: { config: ConstellationConfig }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [optimisticEnabled, setOptimisticEnabled] = useState<boolean | null>(null);
  const [inbound, setInbound] = useState(String(config.thresholds.minInbound));
  const [outbound, setOutbound] = useState(String(config.thresholds.minOutbound));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const enabled = optimisticEnabled ?? config.enabled;
  const thresholdsDirty =
    Number(inbound) !== config.thresholds.minInbound ||
    Number(outbound) !== config.thresholds.minOutbound;

  function toggle() {
    const next = !enabled;
    setOptimisticEnabled(next);
    setError(null);
    start(async () => {
      try {
        await setConstellationConfigAction({ enabled: next });
        router.refresh();
      } catch (err) {
        setOptimisticEnabled(null);
        setError(err instanceof Error ? err.message : "Could not save that.");
      }
    });
  }

  function saveThresholds() {
    const minInbound = Number(inbound);
    const minOutbound = Number(outbound);
    if (!Number.isFinite(minInbound) || !Number.isFinite(minOutbound)) return;
    setError(null);
    setSaved(false);
    start(async () => {
      try {
        const next = await setConstellationConfigAction({ minInbound, minOutbound });
        // Echo back what was actually stored — the server clamps, so a 0 or a 900 typed here
        // comes back as something else and the field should say so rather than lie.
        setInbound(String(next.thresholds.minInbound));
        setOutbound(String(next.thresholds.minOutbound));
        setSaved(true);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save that.");
      }
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm">
            <Stars className="size-3.5 text-muted-foreground" aria-hidden />
            Only show people they have engaged with
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The star chart draws only contacts with notes, a logged meeting, a real
            back-and-forth on LinkedIn, or a closeness rating. Everyone else stays in
            Contacts, search and chat — they just aren&apos;t drawn.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Never applies to a network where too little would survive it, so a new account
            or a connections-only import still sees its whole sky.
          </p>
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${enabled ? "Disable" : "Enable"} the constellation filter`}
          disabled={pending}
          onClick={toggle}
          className={cn(
            "flex w-24 shrink-0 items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors duration-fast disabled:opacity-60",
            enabled
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border/70 text-muted-foreground hover:text-foreground"
          )}
        >
          <Sparkles className="size-3" aria-hidden />
          {enabled ? "Filtering" : "Showing all"}
        </button>
      </div>

      <div
        className={cn(
          "space-y-2 border-t border-border/50 pt-4 transition-opacity duration-fast",
          !enabled && "opacity-50"
        )}
      >
        <p className="text-xs text-muted-foreground">
          How much LinkedIn back-and-forth counts as a real conversation. Both sides must
          clear their number, so a one-sided thread never qualifies however long it is.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="constellation-inbound" className="text-xs">
              Messages received
            </Label>
            <Input
              id="constellation-inbound"
              type="number"
              min={MIN_MESSAGE_THRESHOLD}
              max={MAX_MESSAGE_THRESHOLD}
              value={inbound}
              onChange={(e) => {
                setInbound(e.target.value);
                setSaved(false);
              }}
              className="h-8 w-20"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="constellation-outbound" className="text-xs">
              Messages sent
            </Label>
            <Input
              id="constellation-outbound"
              type="number"
              min={MIN_MESSAGE_THRESHOLD}
              max={MAX_MESSAGE_THRESHOLD}
              value={outbound}
              onChange={(e) => {
                setOutbound(e.target.value);
                setSaved(false);
              }}
              className="h-8 w-20"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || !thresholdsDirty}
            onClick={saveThresholds}
          >
            Save thresholds
          </Button>
          {saved && !thresholdsDirty && (
            <span className="pb-1.5 text-xs text-muted-foreground">Saved.</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Threads imported before Orbit recorded who sent each message fall back to a total
          of {config.thresholds.minInbound + config.thresholds.minOutbound}, and switch to
          the two-sided rule once that export is re-uploaded.
        </p>
      </div>
    </div>
  );
}
