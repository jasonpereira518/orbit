"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  setRadarAutopilot,
  setRadarCaptureLinkedin,
  setRadarDigest,
  setRadarPaused,
  type RadarActionResult,
} from "@/actions/radar";
import { friendlyError } from "@/lib/errors";
import type { RadarSettingsView } from "@/lib/radar/page-data";
import { KIND_LABELS, RECOMMENDATION_KINDS, type RecommendationKind } from "@/lib/radar/types";
import { toast } from "@/lib/toast";

/** What autopilot would do for each kind, in the words a person decides on. */
const AUTOPILOT_HINTS: Record<RecommendationKind, string> = {
  prep: "Sets a reminder the day before the meeting",
  heads_up: "Sets a follow-up three days out",
  follow_up: "Sets a follow-up three days out",
  opportunity: "Sets a follow-up three days out",
  reach_out: "Sets a follow-up three days out",
  reconnect: "Sets a follow-up three days out",
};

function Toggle({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer gap-3 rounded-lg p-2 transition-colors hover:bg-muted/60">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
        // Base UI renders a button, which a wrapping `<label>` does not name.
        aria-label={label}
        className="mt-0.5"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

/**
 * Radar's settings, in one sheet: pause, autopilot per kind, the Monday email, and whether the
 * extension may save LinkedIn posts. Each change is saved on its own and says so.
 */
export function RadarSettingsSheet({ settings }: { settings: RadarSettingsView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [state, setState] = useState(settings);

  const save = (apply: (s: RadarSettingsView) => RadarSettingsView, run: () => Promise<RadarActionResult>) =>
    start(async () => {
      const before = state;
      setState(apply(state));
      try {
        const result = await run();
        if (!result.ok) {
          setState(before);
          toast.error(result.message);
          return;
        }
        if (result.message) toast.success(result.message);
        router.refresh();
      } catch (err) {
        setState(before);
        toast.error(friendlyError(err, "Couldn’t save that — try again?"));
      }
    });

  return (
    <>
      <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => setOpen(true)}>
        <Settings2 className="size-3.5" aria-hidden />
        Settings
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Radar settings</SheetTitle>
            <SheetDescription>Saved as you change them. Radar never sends anything on its own.</SheetDescription>
          </SheetHeader>
          <div className="space-y-6 px-4 pb-6">
            <section className="space-y-1" aria-labelledby="radar-settings-run">
              <h3 id="radar-settings-run" className="px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Nightly check
              </h3>
              <Toggle
                id="radar-paused"
                label="Pause Radar"
                hint="No overnight updates and no AI use until you resume"
                checked={state.paused}
                disabled={pending}
                onChange={(on) => save((s) => ({ ...s, paused: on }), () => setRadarPaused(on))}
              />
            </section>

            <section className="space-y-1" aria-labelledby="radar-settings-autopilot">
              <h3 id="radar-settings-autopilot" className="px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Autopilot
              </h3>
              <p className="px-2 text-xs text-muted-foreground">
                For the kinds you pick, Radar puts the follow-up on your calendar for up to five of Today’s cards a night.
                Each one shows under “Autopilot did this” with Undo.
              </p>
              {RECOMMENDATION_KINDS.map((kind) => (
                <Toggle
                  key={kind}
                  id={`radar-autopilot-${kind}`}
                  label={KIND_LABELS[kind]}
                  hint={AUTOPILOT_HINTS[kind]}
                  checked={state.autopilot[kind] === true}
                  disabled={pending}
                  onChange={(on) =>
                    save((s) => ({ ...s, autopilot: { ...s.autopilot, [kind]: on } }), () => setRadarAutopilot(kind, on))
                  }
                />
              ))}
            </section>

            <section className="space-y-1" aria-labelledby="radar-settings-email">
              <h3 id="radar-settings-email" className="px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Email and extension
              </h3>
              <Toggle
                id="radar-digest"
                label="Monday email"
                hint="Your week’s top people and drafts, early Monday in your time zone"
                checked={state.digestEnabled}
                disabled={pending}
                onChange={(on) => save((s) => ({ ...s, digestEnabled: on }), () => setRadarDigest(on))}
              />
              <Toggle
                id="radar-capture-linkedin"
                label="Save LinkedIn posts from the extension"
                hint="Lets the extension keep a post by someone in your network as a Radar signal"
                checked={state.captureLinkedinActivity}
                disabled={pending}
                onChange={(on) =>
                  save((s) => ({ ...s, captureLinkedinActivity: on }), () => setRadarCaptureLinkedin(on))
                }
              />
            </section>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
