"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { addGoal, deleteGoal, listGoals } from "@/actions/goals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import type { UserGoal } from "@/db/schema";

export function GoalsSettings({ initialGoals }: { initialGoals: UserGoal[] }) {
  const router = useRouter();
  const [goals, setGoals] = useState(initialGoals);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-primary">Goals</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Active goals improve closeness scoring and surface aligned contacts on
          your dashboard.
        </p>
      </div>

      {goals.length === 0 ? (
        <p className="text-sm text-muted-foreground">No goals yet.</p>
      ) : (
        <ul className="space-y-2">
          {goals.map((g) => (
            <li
              key={g.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2"
            >
              <span className="text-sm">{g.text}</span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    try {
                      await deleteGoal(g.id);
                      setGoals((prev) => prev.filter((x) => x.id !== g.id));
                      toast.success("Goal removed");
                      router.refresh();
                    } catch (err) {
                      toast.error(
                        err instanceof Error ? err.message : "Could not delete goal"
                      );
                    }
                  })
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
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
              const row = await addGoal(trimmed);
              setGoals((prev) => [row, ...prev]);
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
          placeholder="e.g. Raise seed round, hire engineers…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={200}
          disabled={pending}
          className="flex-1"
        />
        <Button type="submit" disabled={pending || !text.trim()}>
          Add goal
        </Button>
      </form>
    </section>
  );
}

export type GoalsSettingsProps = {
  initialGoals: Awaited<ReturnType<typeof listGoals>>;
};
