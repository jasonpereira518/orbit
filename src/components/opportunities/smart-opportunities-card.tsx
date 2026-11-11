"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Loader2, RefreshCw, Sparkles, Target, Users, X } from "lucide-react";
import type { SmartOpportunity, SmartOpportunityType } from "@/db/schema";
import { acceptSmartOpportunity, dismissSmartOpportunity, generateSmartOpportunitiesAction } from "@/actions/smart-opportunities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

function opportunityTypeBadge(type: SmartOpportunityType) {
  switch (type) {
    case "introduction":
      return { label: "Mutual Intro", className: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/20" };
    case "collaboration":
      return { label: "Collaboration", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20" };
    case "deal":
      return { label: "Deal / Partner", className: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20" };
    case "knowledge_share":
      return { label: "Knowledge Share", className: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20" };
    case "advisory":
      return { label: "Advisory", className: "bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/20" };
    default:
      return { label: "Opportunity", className: "bg-muted text-muted-foreground" };
  }
}

export function SmartOpportunitiesCard({
  initialOpportunities,
  className,
}: {
  initialOpportunities: SmartOpportunity[];
  className?: string;
}) {
  const router = useRouter();
  const [opportunities, setOpportunities] = useState<SmartOpportunity[]>(initialOpportunities);
  const [isPending, startTransition] = useTransition();
  const [generating, setGenerating] = useState(false);

  async function handleGenerate() {
    setGenerating(true);
    try {
      const res = await generateSmartOpportunitiesAction({ preferAi: true });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.value.count > 0 ? `Synthesized ${res.value.count} new smart opportunities!` : "All cross-network opportunities are up to date.");
      router.refresh();
    } catch {
      toast.error("Couldn’t synthesize opportunities — try again later.");
    } finally {
      setGenerating(false);
    }
  }

  function handleDismiss(id: string) {
    const opp = opportunities.find((o) => o.id === id);
    setOpportunities((prev) => prev.filter((o) => o.id !== id));

    startTransition(async () => {
      try {
        const res = await dismissSmartOpportunity(id);
        if (!res.ok) {
          if (opp) setOpportunities((prev) => [opp, ...prev]);
          toast.error(res.error);
          return;
        }
        toast.success("Opportunity dismissed");
        router.refresh();
      } catch {
        if (opp) setOpportunities((prev) => [opp, ...prev]);
        toast.error("Couldn’t dismiss opportunity");
      }
    });
  }

  function handleAccept(id: string) {
    const opp = opportunities.find((o) => o.id === id);
    setOpportunities((prev) =>
      prev.map((o) => (o.id === id ? { ...o, status: "accepted" as const } : o))
    );

    startTransition(async () => {
      try {
        const res = await acceptSmartOpportunity(id);
        if (!res.ok) {
          if (opp) setOpportunities((prev) => prev.map((o) => (o.id === id ? opp : o)));
          toast.error(res.error);
          return;
        }
        toast.success("Opportunity accepted into your pipeline!");
        router.refresh();
      } catch {
        if (opp) setOpportunities((prev) => prev.map((o) => (o.id === id ? opp : o)));
        toast.error("Couldn’t update opportunity status");
      }
    });
  }

  return (
    <Card className={cn("border-border/70 shadow-none", className)}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-violet-500" />
            <CardTitle as="h2" className="text-base font-semibold">
              Smart Opportunities
            </CardTitle>
          </div>
          <CardDescription className="mt-1 text-xs text-muted-foreground">
            Synergies drawn from notes & ideas across people, linked to your active goals & progress
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={generating || isPending}
          onClick={handleGenerate}
          className="gap-1.5 text-xs"
        >
          {generating ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : (
            <RefreshCw className="size-3.5 text-muted-foreground" />
          )}
          Synthesize Network
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {opportunities.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 p-6 text-center">
            <Users className="mx-auto size-7 text-muted-foreground/60" />
            <p className="mt-2 text-sm font-medium text-foreground">No active smart opportunities</p>
            <p className="mt-1 text-xs text-muted-foreground max-w-md mx-auto">
              As you capture notes from meetings and track your goal progress, Orbit automatically
              connects complementary needs, shared ideas, and intro opportunities across your network.
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={generating}
              onClick={handleGenerate}
              className="mt-4 gap-1.5 text-xs"
            >
              <Sparkles className="size-3.5 text-violet-500" />
              Check for Cross-Network Synergies
            </Button>
          </div>
        ) : (
          <ul className="space-y-3">
            {opportunities.map((opp) => {
              const typeBadge = opportunityTypeBadge(opp.opportunityType);
              const excerpts = Array.isArray(opp.contactExcerpts) ? opp.contactExcerpts : [];

              return (
                <li
                  key={opp.id}
                  className="rounded-xl border border-border/70 bg-card p-4 transition-colors hover:border-border"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className={cn("text-[11px] font-medium", typeBadge.className)}>
                          {typeBadge.label}
                        </Badge>
                        {opp.impactScore === "critical" && (
                          <Badge variant="outline" className="bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/20 text-[10px]">
                            🔥 Critical Impact
                          </Badge>
                        )}
                        {opp.impactScore === "high" && (
                          <Badge variant="outline" className="bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20 text-[10px]">
                            ⭐ High Impact
                          </Badge>
                        )}
                      </div>
                      <h3 className="text-sm font-medium text-foreground">{opp.title}</h3>
                    </div>

                    <div className="flex items-center gap-1">
                      {opp.status !== "accepted" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isPending}
                          onClick={() => handleAccept(opp.id)}
                          className="h-7 gap-1 px-2 text-xs text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
                        >
                          <Check className="size-3.5" />
                          Accept
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isPending}
                        onClick={() => handleDismiss(opp.id)}
                        className="size-7 text-muted-foreground hover:text-foreground"
                        aria-label="Dismiss opportunity"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* Connected Contacts */}
                  {excerpts.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-muted-foreground flex items-center gap-1">
                        <Users className="size-3.5" /> Connecting:
                      </span>
                      {excerpts.map((ex, idx) => (
                        <span key={ex.contactId || idx} className="inline-flex items-center gap-1 font-medium text-foreground">
                          {ex.contactId ? (
                            <Link
                              href={`/contacts/${ex.contactId}`}
                              className="text-primary hover:underline underline-offset-4"
                            >
                              {ex.contactName}
                            </Link>
                          ) : (
                            <span>{ex.contactName}</span>
                          )}
                          {idx < excerpts.length - 1 && <span className="text-muted-foreground">⟷</span>}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Synthesis Rationale */}
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {opp.synthesisRationale}
                  </p>

                  {/* Suggested Next Action */}
                  {opp.suggestedAction && (
                    <div className="mt-3 rounded-lg border border-border/50 bg-muted/30 p-2.5 text-xs">
                      <span className="font-medium text-foreground">Suggested next action: </span>
                      <span className="text-muted-foreground">{opp.suggestedAction}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
