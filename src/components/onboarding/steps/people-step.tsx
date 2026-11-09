"use client";

import { Sparkles, Upload, UserPlus, type LucideIcon } from "lucide-react";
import {
  CARD,
  ChoiceRow,
  RecommendedTag,
  Stagger,
  StaggerItem,
  StepFooter,
  StepLayout,
} from "@/components/onboarding/onboarding-ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PeoplePath = "capture" | "manual" | "import";

const PATHS: Array<{
  id: PeoplePath;
  icon: LucideIcon;
  tone?: "gold";
  title: string;
  body: string;
  recommended?: boolean;
}> = [
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
    tone: "gold",
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
    <StepLayout
      onBack={onBack}
      eyebrow="Your people"
      title="Add your first people"
      description="Start with whatever you have on hand. Adding more later is just as easy."
      footer={
        <StepFooter
          left={
            <Button type="button" variant="ghost" className="h-10 text-muted-foreground" onClick={onLater}>
              I’ll add people later
            </Button>
          }
        />
      }
    >
      <Stagger as="ul" className="space-y-2.5">
        {PATHS.map((path) => (
          <StaggerItem as="li" key={path.id}>
            <button
              type="button"
              onClick={() => onChoose(path.id)}
              className={cn(
                CARD,
                "flex w-full p-4 text-left",
                "transition-[border-color,box-shadow,transform] duration-200 active:scale-[0.99]",
                "hover:border-primary/40 hover:shadow-md focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                path.recommended && "border-primary",
              )}
            >
              <ChoiceRow
                icon={path.icon}
                tone={path.tone}
                title={path.title}
                tag={path.recommended ? <RecommendedTag /> : undefined}
              >
                {path.body}
              </ChoiceRow>
            </button>
          </StaggerItem>
        ))}
      </Stagger>
    </StepLayout>
  );
}
