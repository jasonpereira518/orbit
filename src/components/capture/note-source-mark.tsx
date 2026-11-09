"use client";

import { Cloud, HardDrive, Mic } from "lucide-react";
import { GranolaMark } from "@/components/settings/provider-marks";
import { BrandLogo } from "@/components/ui/brand-logo";
import { cn } from "@/lib/utils";

/** Where a capture's or meeting's notes were taken: the brand on its card. */
export type NoteSource = "granola" | "orbit" | "drive" | "onedrive" | "audio";

export const NOTE_SOURCE_LABEL: Record<NoteSource, string> = {
  granola: "Granola",
  orbit: "Orbit",
  drive: "Google Drive",
  onedrive: "OneDrive",
  audio: "Audio recording",
};

/** Decorative: every caller names the source in text or a tooltip beside it. */
export function NoteSourceMark({ source, className }: { source: NoteSource; className?: string }) {
  const size = cn("size-5", className);
  switch (source) {
    case "granola":
      return <GranolaMark className={size} />;
    case "orbit":
      // eslint-disable-next-line @next/next/no-img-element -- a static app icon; next/image buys nothing here.
      return <img src="/orbit-logo.png" alt="" aria-hidden className={cn(size, "rounded-full")} />;
    case "drive":
      return <BrandLogo domain="drive.google.com" name="" className={size} fallback={<HardDrive className={size} aria-hidden />} />;
    case "onedrive":
      return <BrandLogo domain="onedrive.live.com" name="" className={size} fallback={<Cloud className={size} aria-hidden />} />;
    case "audio":
      return <Mic className={size} aria-hidden />;
  }
}
