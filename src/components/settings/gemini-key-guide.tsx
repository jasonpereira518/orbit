"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * Verified via WebFetch/WebSearch (2026-09-02): aistudio.google.com gates every path
 * behind a Google sign-in redirect, so the exact post-login route can't be confirmed
 * without an authenticated session. This is the URL the task brief specifies as the
 * fallback for that case.
 */
export const GEMINI_KEY_URL = "https://aistudio.google.com/apikey";

type GuideStep = {
  body: string;
  imageSrc?: string;
};

const STEPS: GuideStep[] = [
  {
    body: "Open Google AI Studio and sign in with any Google account.",
    imageSrc: "/guides/gemini/key-1.png",
  },
  {
    body: "Click Create API key. Pick any project — the default is fine.",
    imageSrc: "/guides/gemini/key-2.png",
  },
  {
    body: "Copy the key and paste it into Orbit. It stays encrypted and only your account uses it.",
    imageSrc: "/guides/gemini/key-3.png",
  },
];

function GuideImage({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  // The step's own text is the instruction; the screenshot only illustrates it. If one
  // fails to load, showing nothing is better than a box telling the user Orbit is
  // unfinished — which is what "Screenshot coming soon" read as.
  if (!src || failed) return null;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- static guide screenshots in public/
    <img
      src={src}
      alt={alt}
      className="mt-2 w-full rounded-lg border border-border/60 bg-muted/30 object-cover object-top"
      onError={() => setFailed(true)}
    />
  );
}

export function GeminiKeyGuide() {
  const [open, setOpen] = useState(false);

  return (
    <div className="shrink-0">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        Show me how
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[min(90vh,40rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Get a free Gemini API key</DialogTitle>
            <DialogDescription>
              Takes about a minute — no credit card required.
            </DialogDescription>
          </DialogHeader>

          <ol className="space-y-5">
            {STEPS.map((step, index) => (
              <li key={step.body} className="flex gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">{step.body}</p>
                  <GuideImage src={step.imageSrc} alt={`Step ${index + 1}`} />
                </div>
              </li>
            ))}
          </ol>

          <DialogFooter className="sm:justify-between">
            <a
              href={GEMINI_KEY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              Open Google AI Studio
              <ExternalLink className="size-3.5" />
            </a>
            <DialogClose render={<Button variant="outline" size="sm" />}>
              Got it
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
