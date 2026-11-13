"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setCompanyHidden, setCompanyStage } from "@/actions/recruiting";
import { Button } from "@/components/ui/button";
import { RECRUITER_STAGES, STAGE_LABELS, type RecruiterStage } from "@/lib/recruiter-stages";
import { runToastAction } from "@/lib/toast";

/**
 * The two corrections a card offers: where it stands, and "Not a job". Both are reversible from
 * the toast — a mis-click on a stage select or a hide should cost a second, not a search.
 */
export function CompanyActions({
  companyKey,
  name,
  stage,
}: {
  companyKey: string;
  name: string;
  stage: RecruiterStage;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function move(next: RecruiterStage) {
    if (next === stage) return;
    start(async () => {
      await runToastAction({
        run: () => setCompanyStage(companyKey, next),
        success: `${name} moved to ${STAGE_LABELS[next]}`,
        failure: "Couldn’t move that company",
        refresh: () => router.refresh(),
        undo: () => () => setCompanyStage(companyKey, stage),
        undone: `${name} is back in ${STAGE_LABELS[stage]}`,
      });
    });
  }

  function hide() {
    start(async () => {
      await runToastAction({
        run: () => setCompanyHidden(companyKey, true),
        success: `Hidden — ${name} won’t come back`,
        failure: "Couldn’t hide that company",
        refresh: () => router.refresh(),
        undo: () => () => setCompanyHidden(companyKey, false),
        undone: `${name} is back on the board`,
      });
    });
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <select
        aria-label={`Stage for ${name}`}
        value={stage}
        disabled={pending}
        onChange={(e) => move(e.target.value as RecruiterStage)}
        className="h-8 min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 text-xs text-foreground"
      >
        {RECRUITER_STAGES.map((s) => (
          <option key={s} value={s}>
            {STAGE_LABELS[s]}
          </option>
        ))}
      </select>
      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={hide}>
        Not a job
      </Button>
    </div>
  );
}

/** "Put it back" for a company that was hidden. */
export function PutBackButton({ companyKey, name }: { companyKey: string; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await runToastAction({
            run: () => setCompanyHidden(companyKey, false),
            success: `${name} is back on the board`,
            failure: "Couldn’t put that back",
            refresh: () => router.refresh(),
          });
        })
      }
    >
      Put it back
    </Button>
  );
}
