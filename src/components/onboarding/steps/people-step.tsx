"use client";

import { Sparkles, Upload, UserPlus, type LucideIcon } from "lucide-react";
import {
  BackButton,
  Stagger,
  StaggerItem,
  StepHeading,
} from "@/components/onboarding/onboarding-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CARD_HOVER } from "@/lib/interaction";
import { cn } from "@/lib/utils";

export type PeoplePath = "capture" | "manual" | "import";

const PATHS: Array<{ id: PeoplePath; icon: LucideIcon; title: string; body: string; recommended?: boolean }> = [
  {
    id: "capture",
    icon: Sparkles,
    title: "Capture from notes",
    recommended: true,
    body: "Paste notes about people you’ve met. Orbit works out who they are and what to follow up on.",
  },
  {
    id: "manual",
    icon: UserPlus,
    title: "Add someone by hand",
    body: "A name, where they work, and how you know them.",
  },
  {
    id: "import",
    icon: Upload,
    title: "Upload your LinkedIn export",
    body: "Already have LinkedIn’s ZIP? Bring in every connection at once.",
  },
];

export function PeopleStep({
  onChoose,
  onLater,
  onBack,
}: {
  onChoose: (path: PeoplePath) => void;
  onLater: () => void;
  onBack: () => void;
}) {
  return (
    <Stagger className="mx-auto max-w-3xl space-y-8">
      <div className="space-y-4">
        <StaggerItem>
          <BackButton onClick={onBack} />
        </StaggerItem>
        <StepHeading eyebrow="Your people" title="Add your first people">
          Start with whatever you have on hand. Adding more later is just as easy.
        </StepHeading>
      </div>

      <Stagger as="ul" className="grid gap-3 sm:grid-cols-3">
        {PATHS.map((path) => {
          const Icon = path.icon;
          return (
            <StaggerItem as="li" key={path.id}>
              <button
                type="button"
                onClick={() => onChoose(path.id)}
                className={cn(
                  "group flex h-full w-full flex-col items-start gap-3 rounded-xl border border-border-subtle bg-card p-5 text-left",
                  CARD_HOVER,
                  "active:translate-y-px focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                )}
              >
                <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                  <Icon className="size-5" aria-hidden />
                </span>
                <span>
                  <span className="block font-medium text-ink">
                    {path.title}
                    {path.recommended && (
                      <Badge tone="accent" size="sm" className="ml-2 align-middle">
                        Recommended
                      </Badge>
                    )}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">{path.body}</span>
                </span>
              </button>
            </StaggerItem>
          );
        })}
      </Stagger>

      <StaggerItem className="text-center">
        <Button type="button" variant="outline" onClick={onLater}>
          I’ll add people later
        </Button>
      </StaggerItem>
    </Stagger>
  );
}
