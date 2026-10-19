"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, useTransition } from "react";
import { X } from "lucide-react";
import { toast } from "@/lib/toast";
import { markLinkedInExportRequested } from "@/actions/linkedin-export";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IntegrationLogo } from "@/components/integrations/integration-logo";
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
    <Card size="sm" aria-labelledby="linkedin-card-title">
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <IntegrationLogo provider="linkedin" size="sm" title="" />
          <CardTitle as="h2" id="linkedin-card-title">
            Start your LinkedIn export
          </CardTitle>
        </div>
        <CardAction>
          <Button type="button" variant="ghost" size="icon-sm" onClick={dismiss} aria-label="Dismiss" className="-mr-1 -mt-1 text-muted-foreground">
            <X className="size-4" aria-hidden />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
      {state.mode === "start" ? (
        <div className="space-y-4">
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
              {pending ? "Saving…" : "I’ve requested it"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
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
      </CardContent>
    </Card>
  );
}
