"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, Contact, Sparkles, Upload, UserPlus } from "lucide-react";
import { completeWizard, saveWizardStep } from "@/actions/onboarding-wizard";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WizardAddManual } from "@/components/onboarding/wizard/wizard-add-manual";
import { WizardCapture } from "@/components/onboarding/wizard/wizard-capture";
import { WizardConnectGoogle } from "@/components/onboarding/wizard/wizard-connect-google";
import { WizardImport } from "@/components/onboarding/wizard/wizard-import";
import { WizardLinkedInLater } from "@/components/onboarding/wizard/wizard-linkedin-later";
import { WizardReview, type WizardResult } from "@/components/onboarding/wizard/wizard-review";
import { WizardTriage } from "@/components/onboarding/wizard/wizard-triage";
import { WizardAiKey } from "@/components/onboarding/wizard/wizard-ai-key";

export type WizardStep =
  | "intro"
  | "add-people"
  | "connect-google"
  | "manual"
  | "capture"
  | "import"
  | "linkedin-later"
  | "triage"
  | "ai-key"
  | "review";

const PATHS = [
  {
    id: "connect-google" as const,
    icon: Contact,
    title: "Import Google Contacts",
    description: "Two clicks. Orbit only reads your contacts, never your email.",
  },
  {
    id: "capture" as const,
    icon: Sparkles,
    title: "Capture from notes",
    description:
      "Paste meeting notes — Orbit pulls out the people. Needs a free AI key; we'll walk you through it.",
  },
  {
    id: "linkedin-later" as const,
    icon: Upload,
    title: "LinkedIn (start it now, takes a day)",
    description:
      "LinkedIn takes about a day to build your export. Kick it off now and Orbit reminds you when it lands.",
  },
  {
    id: "manual" as const,
    icon: UserPlus,
    title: "Add someone manually",
    description: "Enter a name, company, and how you know them.",
  },
];

const STEP_TITLES: Record<WizardStep, string> = {
  intro: "Let's set up your orbit",
  "add-people": "How do you want to add your first people?",
  "connect-google": "Import your Google contacts",
  manual: "Add someone manually",
  capture: "Capture from notes",
  import: "Import LinkedIn connections",
  "linkedin-later": "Start your LinkedIn export",
  triage: "Rate a few people",
  "ai-key": "Turn on AI (optional)",
  review: "You're set up",
};

function isValidStep(step: string | null | undefined): step is WizardStep {
  return step != null && Object.hasOwn(STEP_TITLES, step);
}

export function SetupWizard({
  initialStepId = null,
  hasApiKey = true,
  googleConfigured,
  contactLimit,
  linkedInRequested = false,
}: {
  initialStepId?: string | null;
  hasApiKey?: boolean;
  googleConfigured: boolean;
  contactLimit: number | null;
  /** True once the export has already been requested, so the step is not offered again. */
  linkedInRequested?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [step, setStep] = useState<WizardStep>(
    isValidStep(initialStepId) ? initialStepId : "intro"
  );
  const [results, setResults] = useState<WizardResult[]>([]);
  // Initialized once from the server-provided prop and never re-read during the
  // session — set true the moment a key is verified, on either the Capture path
  // (inline panel) or the dedicated ai-key step (wizard panel).
  const [aiOn, setAiOn] = useState(hasApiKey);
  // The LinkedIn export is the one thing here that cannot be hurried: LinkedIn takes
  // about a day to build it, so a request made during setup is a usable import tomorrow
  // and a request made whenever someone eventually notices the fourth option is a week
  // of nothing. Every path therefore passes through the request step once, before
  // triage, instead of it being a door most people never open — one click skips it, and
  // anyone who already requested it (or came in via the LinkedIn path) never sees it.
  const [linkedInHandled, setLinkedInHandled] = useState(linkedInRequested);
  const paths = googleConfigured
    ? PATHS
    : PATHS.filter((path) => path.id !== "connect-google");

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

  // Deliberately a plain function rather than a useCallback: it must close over the
  // current `linkedInHandled` every render, and each child callback below is recreated
  // per render anyway.
  function goAfterPeople() {
    goTo(linkedInHandled ? "triage" : "linkedin-later");
  }

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
            <h1 className="mt-1 font-[family-name:var(--font-display)] text-2xl tracking-tight text-ink sm:text-3xl">
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
                <PathStep paths={paths} onChoose={(id) => goTo(id)} />
              )}

              {step === "connect-google" && (
                <WizardConnectGoogle
                  contactLimit={contactLimit}
                  onImported={(count) => {
                    addResult({ kind: "google", count });
                    goAfterPeople();
                  }}
                  onSkip={() => goTo("add-people")}
                />
              )}

              {step === "manual" && (
                <div className="space-y-4">
                  <BackRow onBack={() => goTo("add-people")} />
                  <WizardAddManual
                    onCreated={() => {
                      addResult({ kind: "manual" });
                      goAfterPeople();
                    }}
                  />
                </div>
              )}

              {step === "capture" && (
                <div className="space-y-4">
                  <BackRow onBack={() => goTo("add-people")} />
                  <WizardCapture
                    hasApiKey={hasApiKey}
                    onKeyVerified={() => setAiOn(true)}
                    onSaved={(count) => {
                      addResult({ kind: "capture", count });
                      goAfterPeople();
                    }}
                  />
                </div>
              )}

              {step === "import" && (
                <div className="space-y-4">
                  <BackRow onBack={() => goTo("add-people")} />
                  <WizardImport
                    onContinue={() => {
                      setLinkedInHandled(true);
                      addResult({ kind: "import" });
                      goTo("triage");
                    }}
                  />
                </div>
              )}

              {step === "linkedin-later" && (
                <div className="space-y-4">
                  <BackRow onBack={() => goTo("add-people")} />
                  <WizardLinkedInLater
                    onContinue={(result) => {
                      setLinkedInHandled(true);
                      if (result) addResult(result);
                      goTo("triage");
                    }}
                    onImportNow={(result) => {
                      setLinkedInHandled(true);
                      if (result) addResult(result);
                      goTo("import");
                    }}
                  />
                </div>
              )}

              {step === "triage" && (
                <WizardTriage
                  onDone={() => goTo(aiOn ? "review" : "ai-key")}
                />
              )}

              {step === "ai-key" && (
                <WizardAiKey
                  onVerified={() => {
                    setAiOn(true);
                    addResult({ kind: "ai-key" });
                    goTo("review");
                  }}
                  onSkip={() => goTo("review")}
                />
              )}

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
        Two minutes. Start with the people already in your Google Contacts,
        paste notes from a coffee chat, or add one name. LinkedIn takes a
        day — kick it off now and Orbit will nudge you.
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
  paths,
  onChoose,
}: {
  paths: typeof PATHS;
  onChoose: (
    id: "connect-google" | "manual" | "capture" | "linkedin-later"
  ) => void;
}) {
  return (
    <ul className="space-y-3">
      {paths.map((path) => {
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
                <span className="block font-medium text-ink">
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
