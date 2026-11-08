"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Paintbrush, Palette, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import { setEventThemeColor } from "@/actions/events";

const PRESET_COLORS = [
  { name: "Indigo", hex: "#6366f1" },
  { name: "Violet", hex: "#8b5cf6" },
  { name: "Pink", hex: "#ec4899" },
  { name: "Coral", hex: "#f43f5e" },
  { name: "Amber", hex: "#f59e0b" },
  { name: "Emerald", hex: "#10b981" },
  { name: "Cyan", hex: "#06b6d4" },
  { name: "Blue", hex: "#3b82f6" },
  { name: "Slate", hex: "#64748b" },
];

export function ThemePalettePicker({
  eventId,
  currentColor,
  themeLocked = false,
}: {
  eventId: string;
  currentColor: string;
  themeLocked?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(currentColor.toLowerCase());
  const [customHex, setCustomHex] = useState(currentColor);
  const [pending, start] = useTransition();

  function applyColor(hex: string) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) {
      toast.error("Please enter a valid 6-character hex code (e.g. #6366f1)");
      return;
    }
    const cleanHex = hex.toLowerCase();
    setSelected(cleanHex);
    start(async () => {
      try {
        await setEventThemeColor(eventId, cleanHex, "manual");
        toast.success("Event theme updated & locked");
        setOpen(false);
      } catch {
        toast.error("Couldn’t update theme color");
      }
    });
  }

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="xs"
        onClick={() => setOpen(!open)}
        className="h-7 gap-1.5 rounded-full border-white/20 bg-black/40 px-2.5 text-2xs text-white/90 backdrop-blur-md hover:bg-black/60 hover:text-white"
        aria-label="Change event theme color"
      >
        <span
          className="size-2.5 rounded-full ring-1 ring-white/50"
          style={{ backgroundColor: selected }}
        />
        <Paintbrush className="size-3" />
        {themeLocked ? "Theme Locked" : "Theme Color"}
      </Button>

      {open && (
        <div className="absolute right-0 top-9 z-30 w-64 space-y-3 rounded-2xl border border-border bg-card p-4 shadow-xl backdrop-blur-md">
          <div className="flex items-center justify-between">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold text-ink">
              <Palette className="size-3.5 text-primary" />
              Event Theme Color
            </h4>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          </div>

          <p className="text-3xs text-muted-foreground">
            Sets the ambient glow, badges, and accent highlights for this event.
          </p>

          {/* Color Presets */}
          <div className="grid grid-cols-5 gap-2">
            {PRESET_COLORS.map((preset) => {
              const active = selected === preset.hex.toLowerCase();
              return (
                <button
                  key={preset.hex}
                  type="button"
                  onClick={() => applyColor(preset.hex)}
                  title={preset.name}
                  className={`group relative flex size-9 items-center justify-center rounded-full transition-transform hover:scale-110 ${
                    active ? "ring-2 ring-primary ring-offset-2" : ""
                  }`}
                  style={{ backgroundColor: preset.hex }}
                >
                  {active && <Check className="size-4 text-white drop-shadow" />}
                </button>
              );
            })}
          </div>

          {/* Custom Hex */}
          <div className="flex items-center gap-2 pt-1 border-t border-border/60">
            <Input
              type="text"
              placeholder="#6366f1"
              value={customHex}
              onChange={(e) => setCustomHex(e.target.value)}
              className="h-8 text-xs font-mono"
            />
            <Button
              size="sm"
              onClick={() => applyColor(customHex)}
              disabled={pending}
              className="h-8 text-xs"
            >
              {pending ? <Loader2 className="size-3 animate-spin" /> : "Apply"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
