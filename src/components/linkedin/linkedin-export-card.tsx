"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, useTransition } from "react";
import { X } from "lucide-react";
import { toast } from "@/lib/toast";
import { markLinkedInExportRequested } from "@/actions/linkedin-export";
import { Button } from "@/components/ui/button";
import { LinkedInExportInstructions } from "@/components/linkedin/linkedin-export-instructions";
import { LINKEDIN_DATA_URL } from "@/lib/linkedin-export";
import { linkedinCardState } from "@/lib/linkedin-export-card";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

const DISMISS_KEY = "orbit-linkedin-card-dismissed-v1";
const listeners = new Set<() => void>();
function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Start your LinkedIn export, then "should be ready about {date}". Dismissal is per browser. */
export function LinkedInExportCard({ requestedAt: initial, where }: { requestedAt: string | null; where: "dashboard" | "imports" }) {
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => true);
  const [requestedAt, setRequestedAt] = useState(initial);
  const [pending, start] = useTransition();
  const state = linkedinCardState({ imported: false, requestedAt, onboardingDone: true });
  if (dismissed || !state.show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {}
    listeners.forEach((fn) => fn());
  };
  const link = "font-medium text-primary underline-offset-2 hover:underline";

  return (
    <section aria-labelledby="linkedin-card-title" className="relative rounded-xl border border-border/70 p-4">
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="absolute top-3 right-3 text-muted-foreground hover:text-foreground">
        <X className="size-4" />
      </button>
      <h2 id="linkedin-card-title" className="font-heading text-base text-ink">
        Start your LinkedIn export
      </h2>
      {state.mode === "start" ? (
        <div className="mt-3 space-y-4">
          <LinkedInExportInstructions />
          <div className="flex flex-wrap items-center gap-3">
            <a href={LINKEDIN_DATA_URL} target="_blank" rel="noreferrer" className={link}>
              Open LinkedIn’s export page
            </a>
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  try {
                    setRequestedAt((await markLinkedInExportRequested()).requestedAt);
                  } catch (err) {
                    toast.error(friendlyError(err, TOAST_COPY.saveFailed));
                  }
                })
              }
            >
              I’ve requested it
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          Your export should be ready about{" "}
          {new Date(state.readyIso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} —{" "}
          {where === "imports" ? (
            "drop the ZIP below when the email arrives"
          ) : (
            <>
              drop the ZIP on{" "}
              <Link href="/imports" className={link}>
                Imports
              </Link>{" "}
              when the email arrives
            </>
          )}
        </p>
      )}
    </section>
  );
}
