"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { BellPlus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dismissOpenThreadAction, remindOpenThread } from "@/actions/relationships";
import { owedLabel } from "@/components/contacts/contact-next-steps";
import type { DigestThread } from "@/lib/relationship-engine/digest-copy";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import { toast } from "@/lib/toast";

export function OpenThreadsList({ threads, busyKey, onRemind, onDismiss }: {
  threads: DigestThread[];
  busyKey: string | null;
  onRemind?: (key: string) => void;
  onDismiss?: (key: string) => void;
}) {
  if (!threads.length) return null;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Open threads ({threads.length})</summary>
      <ul className="mt-2 space-y-2">
        {threads.map((t) => (
          <li key={t.key} className="rounded-md border p-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">{t.text}</span>
              {owedLabel(t.owedBy) ? <Badge variant="outline" className="text-[10px]">{owedLabel(t.owedBy)}</Badge> : null}
            </div>
            <p className="text-xs italic text-muted-foreground">
              “{t.excerpt}” · {format(new Date(`${t.sinceIso.slice(0, 10)}T12:00:00`), "MMM d")}
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              {t.canRemind && onRemind ? (
                <Button size="sm" variant="outline" disabled={busyKey === t.key} onClick={() => onRemind(t.key)}>
                  <BellPlus className="size-3.5" aria-hidden /> Remind me
                </Button>
              ) : null}
              {onDismiss ? (
                <Button size="sm" variant="ghost" disabled={busyKey === t.key} onClick={() => onDismiss(t.key)}>
                  <X className="size-3.5" aria-hidden /> Dismiss
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ContactOpenThreads({ contactId, threads }: { contactId: string; threads: DigestThread[] }) {
  const router = useRouter();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [, start] = useTransition();
  const act = (key: string, run: () => Promise<{ ok: true } | { error: string }>, ok: string) =>
    start(async () => {
      setBusyKey(key);
      try {
        const res = await run();
        if ("error" in res) {
          toast.error(res.error);
          return;
        }
        setHidden((h) => new Set(h).add(key));
        toast.success(ok);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      } finally {
        setBusyKey(null);
      }
    });
  return (
    <OpenThreadsList
      threads={threads.filter((t) => !hidden.has(t.key))}
      busyKey={busyKey}
      onRemind={(key) => act(key, () => remindOpenThread(contactId, key), "Reminder added")}
      onDismiss={(key) => act(key, () => dismissOpenThreadAction(contactId, key), "Thread dismissed")}
    />
  );
}
