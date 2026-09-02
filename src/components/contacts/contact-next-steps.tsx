"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "@/lib/toast";
import { setActionItemStatus } from "@/actions/action-items";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type OpenActionItem = {
  id: string;
  text: string;
  interactionId: string;
  interactionDate: string;
  reminderId: string | null;
};

export function ContactNextSteps({ items }: { items: OpenActionItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());

  const visible = items.filter((item) => !hiddenIds.has(item.id));

  function checkItem(id: string) {
    setHiddenIds((prev) => new Set(prev).add(id));
    start(async () => {
      try {
        await setActionItemStatus(id, "done");
        router.refresh();
      } catch (err) {
        setHiddenIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        toast.error(
          err instanceof Error ? err.message : "Could not update action item"
        );
      }
    });
  }

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader>
        <CardTitle>Next steps</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing open — everything from your notes is done.
          </p>
        ) : (
          visible.map((item) => (
            <label
              key={item.id}
              className="group flex items-start gap-3 rounded-xl border border-border/60 p-3"
            >
              <Checkbox
                className="mt-0.5"
                disabled={pending}
                checked={false}
                onCheckedChange={() => checkItem(item.id)}
                aria-label={`Mark "${item.text}" done`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">{item.text}</p>
                <div className="mt-1 flex items-center gap-2">
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(item.interactionDate), "MMM d")}
                  </p>
                  {item.reminderId ? (
                    <Badge variant="outline" className="text-[10px]">
                      reminder set
                    </Badge>
                  ) : null}
                </div>
              </div>
            </label>
          ))
        )}
      </CardContent>
    </Card>
  );
}
