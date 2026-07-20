"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { dismissSuggestion } from "@/actions/reminders";
import { Button } from "@/components/ui/button";

export function SuggestionActions({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <Button
      size="icon"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await dismissSuggestion(id);
          toast.success("Dismissed");
          router.refresh();
        })
      }
    >
      <X className="h-4 w-4" />
    </Button>
  );
}
