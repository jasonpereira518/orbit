"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "@/lib/toast";
import { generateDueFollowUpsAction } from "@/actions/reminders";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";

export function GenerateFollowUpsButton({
  limit = 8,
  label = "Generate more",
}: {
  limit?: number;
  label?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      className="gap-1.5"
      onClick={() =>
        start(async () => {
          try {
            const res = await generateDueFollowUpsAction(limit);
            if (res.created === 0) {
              toast.message("No new follow-ups to generate", {
                description:
                  "Everyone eligible already has a follow-up coming up",
              });
            } else {
              toast.success(
                `Added ${res.created} due follow-up${res.created === 1 ? "" : "s"}`
              );
            }
            router.refresh();
          } catch (err) {
            toast.error(
              friendlyError(err, "Couldn’t generate follow-ups — try again?")
            );
          }
        })
      }
    >
      <Sparkles className="h-3.5 w-3.5" />
      {pending ? "Generating…" : label}
    </Button>
  );
}
