"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, Sparkles, Upload, UserPlus } from "lucide-react";
import { completeWizard, saveWizardStep } from "@/actions/onboarding-wizard";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WizardAddManual } from "@/components/onboarding/wizard/wizard-add-manual";
import { WizardCapture } from "@/components/onboarding/wizard/wizard-capture";
import { WizardImport } from "@/components/onboarding/wizard/wizard-import";
import { WizardReview, type WizardResult } from "@/components/onboarding/wizard/wizard-review";
import { WizardTriage } from "@/components/onboarding/wizard/wizard-triage";

export type WizardStep =
  | "intro"
  | "add-people"
  | "manual"
  | "capture"
  | "import"
  | "triage"
  | "review";

const PATHS = [
  {
    id: "import" as const,
    icon: Upload,
    title: "Import LinkedIn",
    description: "Bring in connections from a Connections.csv export.",
  },
  {
    id: "manual" as const,
    icon: UserPlus,
    title: "Add someone manually",
    description: "Enter a name, company, and how you know them.",
  },
  {
    id: "capture" as const,
    icon: Sparkles,
    title: "Capture from notes",
    description: "Paste meeting notes — AI extracts people and context.",
  },
];

const STEP_TITLES: Record<WizardStep, string> = {
  intro: "Let's set up your orbit",
  "add-people": "How do you want to add your first people?",
  manual: "Add someone manually",
  capture: "Capture from notes",
  import: "Import LinkedIn connections",
  triage: "Rate a few people",
  review: "You're set up",
};

function isValidStep(step: string | null | undefined): step is WizardStep {
  return (
    step === "intro" ||
    step === "add-people" ||
    step === "manual" ||
    step === "capture" ||
    step === "import" ||
    step === "triage" ||
    step === "review"
  );
}

export function SetupWizard({
  initialStepId = null,
  hasApiKey = true,
}: {
  initialStepId?: string | null;
  hasApiKey?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [step, setStep] = useState<WizardStep>(
    isValidStep(initialStepId) ? initialStepId : "intro"
  );
  const [results, setResults] = useState<WizardResult[]>([]);

  const goTo = useCallback((next: WizardStep) => {
    setStep(next);
    // Fire-and-forget, but not silently. The only thing a failed save costs is
    // resuming at the wrong step after a refresh, so blocking a transition the
    // user has already made would be worse than the bug. It is worth a console
    // error though: this call returned `{ok: false}` for the entire `triage`
    // step for as long as that step existed, and nothing anywhere said so.
    void saveWizardStep(next)
      .then((res) => {
        if (!res.ok) {
          console.error(`Wizard step "${next}" was rejected by the server.`);
        }
      })
      .catch((err) => {
        console.error(`Failed to persist wizard step "${next}"`, err);
      });
  }, []);

  const addResult = useCallback((result: WizardResult) => {
    setResults((r) => [...r, result]);
  }, []);

  const finish = useCallback(() => {
    start(async () => {
      const res = await completeWizard();
      router.push(res.redirectTo);
      router.refresh();
    });
  }, [router]);

  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-2xl flex-col justify-center gap-6 py-6">
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-4 sm:px-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Guided setup
            </p>
            <h1 className="mt-1 font-[family-name:var(--font-display)] text-2xl tracking-tight text-primary sm:text-3xl">
              {STEP_TITLES[step]}
            </h1>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            className="text-muted-foreground"
            onClick={finish}
          >
            Exit setup
          </Button>
        </div>

        <div className="p-4 sm:p-6">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              {step === "intro" && (
                <IntroStep onNext={() => goTo("add-people")} />
              )}

              {step === "add-people" && (
                <PathStep onChoose={(id) => goTo(id)} />
              )}

              {step === "manual" && (
                <div className="space-y-4">
                  <BackRow onBack={() => goTo("add-people")} />
                  <WizardAddManual
                    onCreated={() => {
                      addResult({ kind: "manual" });
                      goTo("triage");
                    }}
                  />
                </div>
              )}

              {step === "capture" && (
                <div className="space-y-4">
                  <BackRow onBack={() => goTo("add-people")} />
                  <WizardCapture
                    hasApiKey={hasApiKey}
                    onSaved={(count) => {
                      addResult({ kind: "capture", count });
                      goTo("triage");
                    }}
                  />
                </div>
              )}

              {step === "import" && (
                <div className="space-y-4">
                  <BackRow onBack={() => goTo("add-people")} />
                  <WizardImport
                    onContinue={() => {
                      addResult({ kind: "import" });
                      goTo("triage");
                    }}
                  />
                </div>
              )}

              {step === "triage" && <WizardTriage onDone={() => goTo("review")} />}

              {step === "review" && (
                <WizardReview
                  results={results}
                  onAddMore={() => goTo("add-people")}
                  onFinish={finish}
                  pending={pending}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function IntroStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Two minutes, three ways to start — pick whichever fits what you
        already have on hand: a LinkedIn export, some raw notes, or just a
        name you want to remember.
      </p>
      <Button
        type="button"
        className="bg-primary text-primary-foreground hover:bg-primary/90"
        onClick={onNext}
      >
        Let&apos;s go
      </Button>
    </div>
  );
}

function PathStep({
  onChoose,
}: {
  onChoose: (id: "manual" | "capture" | "import") => void;
}) {
  return (
    <ul className="space-y-3">
      {PATHS.map((path) => {
        const Icon = path.icon;
        return (
          <li key={path.id}>
            <button
              type="button"
              onClick={() => onChoose(path.id)}
              className={cn(
                "group flex w-full items-start gap-4 rounded-2xl border border-border/70 bg-background/70 p-5 text-left transition-colors",
                "hover:border-primary/25 hover:bg-accent"
              )}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
                <Icon className="h-5 w-5" />
              </span>
              <span>
                <span className="block font-medium text-primary">
                  {path.title}
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {path.description}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function BackRow({ onBack }: { onBack: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-muted-foreground"
      onClick={onBack}
    >
      <ChevronLeft className="h-4 w-4" />
      Back
    </Button>
  );
}
