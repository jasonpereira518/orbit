"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus, Settings } from "lucide-react";
import { toast } from "@/lib/toast";
import { addGoal } from "@/actions/goals";
import type { UserGoal } from "@/db/schema";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type GoalAlignedContact = {
  id: string;
  fullName: string;
  preferredName?: string | null;
  company?: string | null;
  title?: string | null;
  goalRelevance: number;
};

export function GoalsSummary({
  goals,
  goalAlignedContacts,
}: {
  goals: UserGoal[];
  goalAlignedContacts: GoalAlignedContact[];
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, start] = useTransition();

  const shownGoals = goals.slice(0, 5);

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle className="text-base">Goals</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Surface people aligned with what you&apos;re working toward
          </p>
        </div>
        <Link
          href="/settings"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}
        >
          <Settings className="h-3.5 w-3.5" />
          Manage
        </Link>
      </CardHeader>
      <CardContent className="space-y-5">
        {shownGoals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add goals to surface people who match what you&apos;re working toward.{" "}
            <Link href="/settings" className="text-primary underline-offset-4 hover:underline">
              Set up in settings
            </Link>
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {shownGoals.map((g) => (
              <li
                key={g.id}
                className="rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-sm"
              >
                {g.text}
              </li>
            ))}
            {goals.length > 5 && (
              <li className="px-2 py-1 text-xs text-muted-foreground">
                +{goals.length - 5} more
              </li>
            )}
          </ul>
        )}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = text.trim();
            if (!trimmed) return;
            start(async () => {
              try {
                await addGoal(trimmed);
                setText("");
                toast.success("Goal added");
                router.refresh();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not add goal");
              }
            });
          }}
        >
          <Input
            placeholder="Add a goal…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={200}
            disabled={pending}
            className="flex-1"
          />
          <Button type="submit" size="sm" disabled={pending || !text.trim()} className="gap-1">
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </form>

        {goalAlignedContacts.length > 0 && (
          <div className="space-y-2 border-t border-border/60 pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Goal-aligned contacts
            </p>
            <ul className="space-y-1">
              {goalAlignedContacts.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/contacts/${c.id}`}
                    className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-muted/60"
                  >
                    <span>
                      <span className="font-medium">{c.preferredName || c.fullName}</span>
                      {(c.title || c.company) && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {[c.title, c.company].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {Math.round(c.goalRelevance * 100)}% match
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
