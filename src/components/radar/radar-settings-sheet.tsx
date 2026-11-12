"use client";

import { useEffect, useState } from "react";
import { useGuardedTransition } from "@/lib/single-flight";
import { useRouter } from "next/navigation";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  removeRadarPushSubscription,
  saveRadarPushSubscription,
  setRadarAutopilot,
  setRadarCaptureLinkedin,
  setRadarDigest,
  setRadarMomentEmail,
  setRadarPaused,
  type RadarActionResult,
} from "@/actions/radar";
import { SW_PATH } from "@/lib/browser-notifications";
import { friendlyError } from "@/lib/errors";
import type { RadarSettingsView } from "@/lib/radar/page-data";
import { AUTOPILOT_KINDS, KIND_LABELS } from "@/lib/radar/types";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** What autopilot would do for each kind, in the words a person decides on. */
const AUTOPILOT_HINTS: Record<(typeof AUTOPILOT_KINDS)[number], string> = {
  prep: "Sets a reminder the day before the meeting",
  heads_up: "Sets a follow-up three days out",
  follow_up: "Sets a follow-up three days out",
  opportunity: "Sets a follow-up three days out",
  reach_out: "Sets a follow-up three days out",
  reconnect: "Sets a follow-up three days out",
};

/**
 * Radar's own on/off, as a switch rather than a checkbox: it turns the whole feature off.
 * Same markup as the account page's switches (`src/components/settings/account-page.tsx`).
 */
function SwitchRow({
  id,
  label,
  hint,
  on,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  on: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg p-2">
      <span className="min-w-0 flex-1">
        <span id={`${id}-label`} className="block text-sm font-medium text-ink">
          {label}
        </span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={cn(
          "tap-target relative inline-flex h-5 w-9 shrink-0 items-center rounded-full outline-none transition-colors duration-fast ease-house focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
          on ? "bg-primary" : "bg-muted-foreground/30"
        )}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none size-4 rounded-full bg-background shadow-sm transition-transform duration-fast ease-house",
            on ? "translate-x-[1.125rem]" : "translate-x-0.5"
          )}
        />
      </button>
    </div>
  );
}

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

type PushState = "loading" | "unset" | "unsupported" | "denied" | "off" | "on";

const PUSH_HINTS: Record<PushState, string> = {
  loading: "Checking this browser…",
  unset: "Push isn’t set up on this server yet.",
  unsupported: "This browser can’t receive push. On iPhone, add Orbit to your Home Screen first.",
  denied: "Notifications are blocked for Orbit in this browser’s settings.",
  off: "An alert on this device when something on Today won’t keep.",
  on: "On for this device.",
};

/** The VAPID public key as the bytes `pushManager.subscribe` wants. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * "Push on this device": one browser's subscription, made here and saved for the account
 * (`src/lib/push.ts`). Registers the notification worker itself, since the app only registers
 * it in production builds.
 */
function PushRow() {
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() || "";
  const [state, setState] = useState<PushState>("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const read = async (): Promise<PushState> => {
      if (!key) return "unset";
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
      if (Notification.permission === "denied") return "denied";
      const reg = await navigator.serviceWorker.getRegistration("/");
      return (await reg?.pushManager.getSubscription()) ? "on" : "off";
    };
    read()
      .catch((): PushState => "unsupported")
      .then((next) => {
        if (live) setState(next);
      });
    return () => {
      live = false;
    };
  }, [key]);

  const turnOn = async () => {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      await navigator.serviceWorker.register(SW_PATH, { scope: "/" });
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      const result = await saveRadarPushSubscription(sub.toJSON());
      if (!result.ok) {
        await sub.unsubscribe().catch(() => false);
        toast.error(result.message);
        return;
      }
      setState("on");
      if (result.message) toast.success(result.message);
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t turn on push in this browser — try again?"));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await removeRadarPushSubscription(sub.endpoint);
        await sub.unsubscribe().catch(() => false);
      }
      setState("off");
      toast.success("Push off for this device");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t turn that off — try again?"));
    } finally {
      setBusy(false);
    }
  };

  const actionable = state === "on" || state === "off";
  return (
    <div className="flex items-center gap-3 rounded-lg p-2">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">Push on this device</span>
        <span className="block text-xs text-muted-foreground" role="status">
          {PUSH_HINTS[state]}
        </span>
      </span>
      {actionable && (
        <Button type="button" size="sm" variant="outline" className="h-8 shrink-0" disabled={busy} onClick={state === "on" ? turnOff : turnOn}>
          {state === "on" ? "Turn off" : "Turn on"}
        </Button>
      )}
    </div>
  );
}

/**
 * Radar's settings, in one sheet: pause, autopilot per kind, the Monday email, and whether the
 * extension may save LinkedIn posts. Each change is saved on its own and says so.
 */
export function RadarSettingsSheet({ settings }: { settings: RadarSettingsView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useGuardedTransition();
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
                Radar
              </h3>
              <SwitchRow
                id="radar-on"
                label="Radar on"
                hint="Turn off to stop overnight updates and AI use. You can turn it back on from the Radar page."
                on={!state.paused}
                disabled={pending}
                onChange={(on) => save((s) => ({ ...s, paused: !on }), () => setRadarPaused(!on))}
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
              {AUTOPILOT_KINDS.map((kind) => (
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
                How Radar reaches you
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
                id="radar-moment-email"
                label="Same-day email"
                hint="When something on Today won’t keep. At most one a day."
                checked={state.momentEmailEnabled}
                disabled={pending}
                onChange={(on) => save((s) => ({ ...s, momentEmailEnabled: on }), () => setRadarMomentEmail(on))}
              />
              <PushRow />
              <p className="px-2 text-xs text-muted-foreground">At most two alerts a day, and never twice for the same card.</p>
            </section>

            <section className="space-y-1" aria-labelledby="radar-settings-extension">
              <h3 id="radar-settings-extension" className="px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Extension
              </h3>
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
