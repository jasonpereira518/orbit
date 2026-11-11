"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
const VoicePanel = dynamic(
  () => import("./voice-panel").then((m) => m.VoicePanel),
  { ssr: false },
);
export function OrbitVoiceEntry() {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    async function check() {
      try {
        const res = await fetch("/api/voice", { cache: "no-store" });
        const state = await res.json();
        if (alive) {
          setEnabled(res.ok && state.enabled === true);
          if (!res.ok || !state.enabled) setOpen(false);
        }
      } catch {
        if (alive) {
          setEnabled(false);
          setOpen(false);
        }
      }
    }
    void check();
    const timer = setInterval(() => void check(), 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  if (!enabled) return null;
  return (
    <div className="shrink-0">
      <Button
        variant="outline"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Mic className="size-4" aria-hidden />
        {open ? "Close Orbit Voice" : "Talk to Orbit"}
      </Button>
      {open && <VoicePanel />}
    </div>
  );
}
