"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Trash2 } from "lucide-react";
import { runToastAction, toast } from "@/lib/toast";
import { addGoal, deleteGoal, restoreGoal, updateGoalProgress } from "@/actions/goals";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useRef, useState } from "react";
import type { UserGoal } from "@/db/schema";
import { friendlyError } from "@/lib/errors";
import { SettingsSection } from "@/components/settings/settings-section";

export function GoalsSettings({ initialGoals }: { initialGoals: UserGoal[] }) {
  const router = useRouter();
  const [goals, setGoals] = useState(initialGoals);
  const [text, setText] = useState("");
  // Shown under the field, and the field is marked invalid, until the next attempt.
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();

  return (
    <SettingsSection
      title="Goals"
      description="Active goals improve closeness scoring and surface aligned contacts on your dashboard."
    >

      {goals.length === 0 ? (
        <p className="text-sm text-muted-foreground">No goals yet.</p>
      ) : (
        <ul className="space-y-2">
          {goals.map((g) => (
            <GoalRow
              key={g.id}
              goal={g}
              pending={pending}
              onDelete={() =>
                start(() =>
                  runToastAction({
                    run: async () => {
                      const snapshot = await deleteGoal(g.id);
                      setGoals((prev) => prev.filter((x) => x.id !== g.id));
                      return snapshot;
                    },
                    success: "Goal removed",
                    failure: "Couldn’t remove that goal — try again?",
                    refresh: () => router.refresh(),
                    undo: (snapshot) =>
                      snapshot
                        ? async () => {
                            const result = await restoreGoal(snapshot);
                            if (result.restored) {
                              setGoals((prev) =>
                                [...prev.filter((x) => x.id !== g.id), g].sort(
                                  (a, b) =>
                                    new Date(b.createdAt).getTime() -
                                    new Date(a.createdAt).getTime()
                                )
                              );
                            }
                            return result;
                          }
                        : null,
                  }).then(() => undefined)
                )
              }
              onUpdateProgress={async (progress) => {
                const res = await updateGoalProgress(g.id, progress);
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                setGoals((prev) =>
                  prev.map((item) => (item.id === g.id ? { ...item, progress: progress.trim() || null } : item))
                );
                toast.success("Progress updated");
                router.refresh();
              }}
            />
          ))}
        </ul>
      )}

      <form
        className="flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = text.trim();
          if (!trimmed) return;
          setError(null);
          start(async () => {
            try {
              const res = await addGoal(trimmed);
              if (!res.ok) {
                setError(res.error);
                inputRef.current?.focus();
                return;
              }
              setGoals((prev) => [res.value, ...prev]);
              setText("");
              toast.success("Goal added");
              router.refresh();
            } catch (err) {
              const message = friendlyError(err, "Couldn’t add that goal — try again?");
              toast.error(message);
              setError(message);
            }
          });
        }}
      >
        <Field label="New goal" hideLabel error={error} className="min-w-0 flex-1">
          <Input
            ref={inputRef}
            placeholder="e.g. Land a summer 2027 internship in product design"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
            maxLength={200}
            disabled={pending}
          />
        </Field>
        <Button type="submit" disabled={pending || !text.trim()}>
          Add goal
        </Button>
      </form>
    </SettingsSection>
  );
}

function GoalRow({
  goal,
  pending,
  onDelete,
  onUpdateProgress,
}: {
  goal: UserGoal;
  pending: boolean;
  onDelete: () => void;
  onUpdateProgress: (progress: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [progressVal, setProgressVal] = useState(goal.progress || "");
  const [saving, setSaving] = useState(false);

  return (
    <li className="rounded-xl border border-border/60 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{goal.text}</div>
          {goal.progress && !editing && (
            <div className="text-xs text-muted-foreground flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
              <span>Progress: {goal.progress}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-xs h-7 px-2 text-muted-foreground"
            onClick={() => setEditing(!editing)}
          >
            {editing ? "Cancel" : goal.progress ? "Edit progress" : "+ Add progress"}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Remove goal: ${goal.text}`}
            disabled={pending}
            onClick={onDelete}
            className="size-7"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {editing && (
        <form
          className="flex items-center gap-2 pt-1"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            try {
              await onUpdateProgress(progressVal);
              setEditing(false);
            } finally {
              setSaving(false);
            }
          }}
        >
          <Input
            value={progressVal}
            onChange={(e) => setProgressVal(e.target.value)}
            placeholder="Current status or milestone (e.g. Completed Phase 1, seeking design partners)"
            className="h-8 text-xs flex-1"
            maxLength={500}
            disabled={saving}
          />
          <Button type="submit" size="sm" className="h-8 text-xs" disabled={saving}>
            Save
          </Button>
        </form>
      )}
    </li>
  );
}
