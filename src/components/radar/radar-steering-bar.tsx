"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Compass, Plus, Radar, Sparkles, X } from "lucide-react";
import { scanRadarOpportunitiesNow, saveRadarSteering } from "@/actions/radar";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import type { RadarPageData } from "@/lib/radar/page-data";
import type { RadarSteering } from "@/lib/radar/types";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type SteeringContext = RadarPageData["steeringContext"];

export function RadarSteeringBar({
  steering,
  context,
  paused,
}: {
  steering: RadarSteering;
  context: SteeringContext;
  paused: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [topicInput, setTopicInput] = useState("");
  const [orgInput, setOrgInput] = useState("");
  const [pending, start] = useTransition();
  const [scanning, startScan] = useTransition();

  const focusTopics = steering.topics ?? [];
  const customOrgs = steering.targetOrgs ?? [];
  const mergedOrgs = Array.from(new Set([...customOrgs, ...context.targetOrgs])).slice(0, 8);
  const mode = steering.cadenceMode ?? "reactive";

  const commit = (next: Partial<RadarSteering>, successMsg?: string) =>
    start(async () => {
      try {
        const res = await saveRadarSteering({ ...steering, ...next });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        if (successMsg) toast.success(successMsg);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t update Radar focus — try again?"));
      }
    });

  const addTopic = () => {
    const clean = topicInput.trim();
    if (!clean) return;
    if (focusTopics.some((t) => t.toLowerCase() === clean.toLowerCase())) {
      setTopicInput("");
      return;
    }
    setTopicInput("");
    commit({ topics: [...focusTopics, clean].slice(0, 12) }, `Added focus: ${clean}`);
  };

  const removeTopic = (topic: string) => {
    commit({ topics: focusTopics.filter((t) => t !== topic) });
  };

  const addOrg = () => {
    const clean = orgInput.trim();
    if (!clean) return;
    if (customOrgs.some((o) => o.toLowerCase() === clean.toLowerCase())) {
      setOrgInput("");
      return;
    }
    setOrgInput("");
    commit({ targetOrgs: [...customOrgs, clean].slice(0, 15) }, `Watching ${clean}`);
  };

  const removeOrg = (org: string) => {
    commit({ targetOrgs: customOrgs.filter((o) => o !== org) });
  };

  const scanNow = () =>
    startScan(async () => {
      try {
        const res = await scanRadarOpportunitiesNow();
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        if (res.message) toast.success(res.message);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t scan opportunities — try again?"));
      }
    });

  const busy = pending || scanning;

  return (
    <section
      aria-label="Radar steering"
      className="rounded-xl border border-border/60 bg-card/80 px-3 py-2.5 sm:px-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
          <span className="inline-flex items-center gap-1 font-medium text-ink">
            <Compass className="size-3.5 text-primary" aria-hidden />
            Radar focus
          </span>
          {context.city && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{context.city}</span>
          )}
          {context.projects.slice(0, 2).map((p) => (
            <span key={p} className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">
              {p}
            </span>
          ))}
          {context.goals.slice(0, 2).map((g) => (
            <span key={g} className="max-w-[14rem] truncate rounded-full bg-muted px-2 py-0.5 text-ink/80">
              {g}
            </span>
          ))}
          {focusTopics.map((topic) => (
            <span
              key={topic}
              className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-800 dark:text-emerald-200"
            >
              {topic}
              {editing && (
                <button
                  type="button"
                  onClick={() => removeTopic(topic)}
                  disabled={busy}
                  aria-label={`Remove topic ${topic}`}
                  className="hover:text-ink"
                >
                  <X className="size-3" aria-hidden />
                </button>
              )}
            </span>
          ))}
          {mergedOrgs.slice(0, 4).map((org) => {
            const removable = customOrgs.includes(org);
            return (
              <span
                key={org}
                className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-muted-foreground"
              >
                {org}
                {editing && removable && (
                  <button
                    type="button"
                    onClick={() => removeOrg(org)}
                    disabled={busy}
                    aria-label={`Remove organization ${org}`}
                    className="hover:text-ink"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                )}
              </span>
            );
          })}
          {focusTopics.length === 0 &&
            mergedOrgs.length === 0 &&
            context.projects.length === 0 &&
            context.goals.length === 0 && (
              <span className="text-muted-foreground">Add topics or target organizations to steer Radar</span>
            )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {!paused && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2.5 text-xs"
              disabled={busy}
              onClick={scanNow}
            >
              <Sparkles className="size-3" aria-hidden />
              {scanning ? "Scanning…" : "Scan web"}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={editing ? "default" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Done" : "Steer"}
          </Button>
        </div>
      </div>

      {editing && (
        <div className="mt-3 grid gap-3 border-t border-border/50 pt-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="radar-steer-topic" className="block text-xs font-medium text-ink">
              Focus topics (hiring, AI agents, seed fundraising…)
            </label>
            <div className="flex gap-1.5">
              <input
                id="radar-steer-topic"
                type="text"
                value={topicInput}
                onChange={(e) => setTopicInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTopic();
                  }
                }}
                placeholder="Add a focus topic…"
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button type="button" size="sm" variant="outline" className="h-8 gap-1 px-2.5 text-xs" disabled={busy || !topicInput.trim()} onClick={addTopic}>
                <Plus className="size-3" aria-hidden />
                Add
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="radar-steer-org" className="block text-xs font-medium text-ink">
              Watch organizations or funds
            </label>
            <div className="flex gap-1.5">
              <input
                id="radar-steer-org"
                type="text"
                value={orgInput}
                onChange={(e) => setOrgInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addOrg();
                  }
                }}
                placeholder="Add an organization…"
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button type="button" size="sm" variant="outline" className="h-8 gap-1 px-2.5 text-xs" disabled={busy || !orgInput.trim()} onClick={addOrg}>
                <Plus className="size-3" aria-hidden />
                Watch
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Radar className="size-3.5" aria-hidden />
              <span>Cadence:</span>
              <div className="inline-flex rounded-md border border-border/70 p-0.5">
                {(["reactive", "weekly"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={busy}
                    onClick={() => commit({ cadenceMode: m }, m === "reactive" ? "Switched to Reactive mode" : "Switched to Weekly digest mode")}
                    className={cn(
                      "rounded px-2 py-0.5 text-xs font-medium capitalize transition-colors",
                      mode === m ? "bg-muted text-ink" : "text-muted-foreground hover:text-ink"
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
