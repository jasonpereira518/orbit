"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

export type LogDetailEvent = {
  eventType: string;
  message: string;
  severity: string;
  source: string;
  occurredAt: string;
  success: number | null;
  userId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  correlationId: string | null;
  durationMs: number | null;
  metadata: Record<string, string | number | boolean | null>;
};

export function LogDetails({ event }: { event: LogDetailEvent }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (key: KeyboardEvent) => key.key === "Escape" && setOpen(false);
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Details
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close log details"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-foreground/10"
          />
          <aside
            aria-label="Log event details"
            className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l border-border/70 bg-background p-5 shadow-[-12px_0_40px_-28px_rgba(26,28,26,0.45)]"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-mono text-sm font-medium">{event.eventType}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{new Date(event.occurredAt).toLocaleString()}</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                <X className="size-4" aria-hidden />
                <span className="sr-only">Close</span>
              </button>
            </div>
            <p className="mt-5 text-sm leading-6">{event.message}</p>
            <dl className="mt-6 divide-y divide-border/50 border-y border-border/50 text-sm">
              {[
                ["Severity", event.severity],
                ["Source", event.source],
                ["Success", event.success == null ? "unknown" : event.success ? "yes" : "no"],
                ["Account", event.userId ?? "—"],
                ["Resource", event.resourceType ? `${event.resourceType}${event.resourceId ? ` · ${event.resourceId}` : ""}` : "—"],
                ["Correlation", event.correlationId ?? "—"],
                ["Duration", event.durationMs == null ? "—" : `${event.durationMs} ms`],
              ].map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-4 py-2">
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
                  <dd className="max-w-[65%] break-all text-right font-mono text-xs">{value}</dd>
                </div>
              ))}
            </dl>
            <h3 className="mt-6 text-xs font-medium uppercase tracking-wide text-muted-foreground">Safe metadata</h3>
            {Object.keys(event.metadata).length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No metadata recorded.</p>
            ) : (
              <dl className="mt-2 rounded-xl bg-muted/70 p-3 text-xs">
                {Object.entries(event.metadata).map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-4 py-1">
                    <dt className="font-mono text-muted-foreground">{key}</dt>
                    <dd className="break-all text-right font-mono">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </aside>
        </>
      )}
    </>
  );
}
