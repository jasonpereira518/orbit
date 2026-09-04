"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Database,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import {
  emptyAccountAction,
  rebuildSuggestionsAction,
  reembedContactsAction,
  rerunImportsAction,
  resetToShowcaseAction,
} from "@/actions/testing";

/**
 * One row per tool: what it does, what it costs you, and the button.
 *
 * Destructive rows take a typed confirmation rather than a plain "are you sure". The two
 * reset buttons sit next to three harmless ones, and the failure this guards against is a
 * tester reaching for "Rebuild suggestions" and hitting "Empty everything" — the same
 * reasoning as `ConfirmActionDialog`'s typed confirmation in the admin console.
 */
function Tool({
  icon: Icon,
  title,
  description,
  cta,
  confirm,
  run,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  cta: string;
  /** When set, must be typed verbatim before the button enables. */
  confirm?: string;
  run: () => Promise<string>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [typed, setTyped] = useState("");
  const armed = !confirm || typed.trim().toLowerCase() === confirm.toLowerCase();

  function go() {
    startTransition(async () => {
      try {
        const message = await run();
        toast.success(message);
        setTyped("");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "That did not work.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 border-b border-border/60 py-4 last:border-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:pl-6">
        {confirm && (
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={`Type ${confirm}`}
            aria-label={`Type ${confirm} to confirm`}
            className="h-8 w-36"
          />
        )}
        <Button
          size="sm"
          variant={confirm ? "destructive" : "outline"}
          disabled={pending || !armed}
          onClick={go}
        >
          {pending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
          {cta}
        </Button>
      </div>
    </div>
  );
}

export function TestingConsole() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Data</CardTitle>
        </CardHeader>
        <CardContent className="py-0">
          <Tool
            icon={Database}
            title="Reset to the showcase network"
            description="Wipes your data and loads ~25 people with logged interactions, repeated companies, tags and a spread of overdue and upcoming follow-ups. Your settings, API keys and plan are kept."
            cta="Reset and reseed"
            confirm="reset"
            run={async () => {
              const r = await resetToShowcaseAction();
              return `Loaded ${r.contacts} contacts, ${r.interactions} interactions and ${r.reminders} reminders.`;
            }}
          />
          <Tool
            icon={Trash2}
            title="Empty everything"
            description="The first-run state: no contacts, interactions, imports, chat threads or goals. Settings, API keys and plan are kept."
            cta="Empty account"
            confirm="empty"
            run={async () => {
              await emptyAccountAction();
              return "Account emptied.";
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Background jobs</CardTitle>
        </CardHeader>
        <CardContent className="py-0">
          <Tool
            icon={RefreshCw}
            title="Re-embed my contacts"
            description="Marks every contact stale and rebuilds their embeddings, so semantic search and chat retrieval reflect the current data. Runs to a time budget — press again if it reports any remaining."
            cta="Re-embed"
            run={async () => {
              const r = await reembedContactsAction();
              return r.remaining > 0
                ? `Embedded ${r.embedded}. ${r.remaining} still to go — run it again.`
                : `Embedded ${r.embedded}. Nothing left to do.`;
            }}
          />
          <Tool
            icon={Sparkles}
            title="Rebuild suggestions and follow-ups"
            description="Regenerates the dashboard's outreach queue and the drafted follow-ups, instead of waiting for the periodic refresh."
            cta="Rebuild"
            run={async () => {
              await rebuildSuggestionsAction();
              return "Suggestions and follow-ups rebuilt.";
            }}
          />
          <Tool
            icon={Upload}
            title="Re-run my imports"
            description="Re-arms and resumes every unfinished import that has a server-side runner. Completed jobs are left alone, and file uploads still have to be re-uploaded."
            cta="Re-run"
            run={async () => {
              const r = await rerunImportsAction();
              return r.rerun === 0
                ? "No unfinished imports to re-run."
                : `Re-ran ${r.rerun} import${r.rerun === 1 ? "" : "s"}.`;
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
