"use client";

import { useState, useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, ExternalLink } from "lucide-react";
import { markLinkedInExportRequested } from "@/actions/linkedin-export";
import { LINKEDIN_SHOTS, LinkedInScreenshot } from "@/components/imports/linkedin-screenshot";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  BackButton,
  Stagger,
  StaggerItem,
  StepHeading,
} from "@/components/onboarding/onboarding-ui";
import {
  LINKEDIN_ARCHIVE_EMAIL_SUBJECT,
  LINKEDIN_ARCHIVE_LINK_HOURS,
  LINKEDIN_DATA_URL,
} from "@/lib/linkedin-export";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Step 2, on purpose: the LinkedIn archive is the one part of setup that cannot be hurried,
 * so it starts before anything else and the rest of onboarding happens while it cooks.
 *
 * Opening LinkedIn's page does not count as requesting. The button turns into "I've
 * requested it" once the page has been opened, and only that stamps
 * `linkedin_export_requested_at` — which is what lets tomorrow's reminder say "you asked
 * LinkedIn yesterday" without guessing.
 */
export function LinkedInStep({
  alreadyRequested,
  onRequested,
  onContinue,
  onHaveExport,
  onBack,
}: {
  alreadyRequested: boolean;
  onRequested: () => void;
  onContinue: () => void;
  onHaveExport: () => void;
  onBack: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "opened" | "requested">(
    alreadyRequested ? "requested" : "idle",
  );
  const [pending, start] = useTransition();

  const confirmRequested = () => {
    start(async () => {
      try {
        await markLinkedInExportRequested();
        onRequested();
      } catch {
        // The stamp only changes the reminder's wording, so a failed save must never
        // trap someone on this step. Move on either way.
      }
      onContinue();
    });
  };

  return (
    <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-14">
      <Stagger className="space-y-7">
        <StaggerItem>
          <BackButton onClick={onBack} disabled={pending} />
        </StaggerItem>

        <StepHeading eyebrow="Start this first" title="Start your LinkedIn export">
          LinkedIn takes up to a day to package your connections and messages. Start it now, and
          keep setting up while it works.
        </StepHeading>

        <Stagger as="ol" className="space-y-4">
          <StaggerItem as="li" className="flex gap-3">
            <NumberChip n={1} />
            <p className="pt-0.5 text-sm text-foreground">
              On LinkedIn&apos;s page, choose{" "}
              <span className="font-medium text-ink">Download larger data archive</span>, then{" "}
              <span className="font-medium text-ink">Request archive</span>.
            </p>
          </StaggerItem>
          <StaggerItem as="li" className="flex gap-3">
            <NumberChip n={2} />
            <p className="pt-0.5 text-sm text-foreground">
              Within a day LinkedIn emails you{" "}
              <span className="font-medium text-ink">“{LINKEDIN_ARCHIVE_EMAIL_SUBJECT}”</span>{" "}
              {`The link lasts ${LINKEDIN_ARCHIVE_LINK_HOURS} hours, so we’ll remind you to look for it.`}
            </p>
          </StaggerItem>
        </Stagger>

        <StaggerItem>
          <div className="relative min-h-28">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={phase}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, transition: { duration: DUR.slow, ease: EASE_HOUSE } }}
                exit={{ opacity: 0, transition: { duration: DUR.fast } }}
                className="space-y-3"
              >
                {phase === "idle" && (
                  <>
                    <a
                      href={LINKEDIN_DATA_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setPhase("opened")}
                      className={cn(buttonVariants({ size: "lg" }), "h-11 px-5 text-[15px]")}
                    >
                      Open LinkedIn&apos;s export page
                      <ExternalLink className="size-4" aria-hidden />
                    </a>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      <button
                        type="button"
                        onClick={onHaveExport}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        I already have my export
                      </button>
                      <button
                        type="button"
                        onClick={onContinue}
                        className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      >
                        I don&apos;t use LinkedIn
                      </button>
                    </div>
                  </>
                )}

                {phase === "opened" && (
                  <>
                    <p className="text-sm text-muted-foreground" role="status">
                      LinkedIn opened in a new tab. Come back here once you&apos;ve clicked Request
                      archive.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="lg"
                        className="h-11 px-5 text-[15px]"
                        disabled={pending}
                        onClick={confirmRequested}
                      >
                        <Check className="size-4" aria-hidden />
                        {pending ? "Saving…" : "I’ve requested it"}
                      </Button>
                      <a
                        href={LINKEDIN_DATA_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11 px-4")}
                      >
                        Open it again
                        <ExternalLink className="size-4" aria-hidden />
                      </a>
                      <Button
                        type="button"
                        variant="ghost"
                        size="lg"
                        className="h-11 text-muted-foreground"
                        disabled={pending}
                        onClick={onContinue}
                      >
                        I&apos;ll do it later
                      </Button>
                    </div>
                  </>
                )}

                {phase === "requested" && (
                  <>
                    <p
                      className="flex items-center gap-2 text-sm font-medium text-ink"
                      role="status"
                    >
                      <span className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Check className="size-3" strokeWidth={3} aria-hidden />
                      </span>
                      Requested. We&apos;ll remind you when it should be ready.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="lg"
                        className="h-11 px-5 text-[15px]"
                        onClick={onContinue}
                      >
                        Continue
                        <ArrowRight className="size-4" aria-hidden />
                      </Button>
                      <button
                        type="button"
                        onClick={onHaveExport}
                        className="px-2 text-sm text-primary underline-offset-4 hover:underline"
                      >
                        It already arrived
                      </button>
                    </div>
                  </>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </StaggerItem>
      </Stagger>

      <Stagger className="space-y-5">
        <StaggerItem className="space-y-2">
          <ShotCaption n={1}>Request the archive</ShotCaption>
          <LinkedInScreenshot shot={LINKEDIN_SHOTS.request} priority />
        </StaggerItem>
        <StaggerItem className="space-y-2">
          <ShotCaption n={2}>Watch your inbox for this</ShotCaption>
          <LinkedInScreenshot shot={LINKEDIN_SHOTS.email} priority />
        </StaggerItem>
      </Stagger>
    </div>
  );
}

function NumberChip({ n }: { n: number }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
      {n}
    </span>
  );
}

function ShotCaption({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
      <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[11px] text-foreground">
        {n}
      </span>
      {children}
    </p>
  );
}
