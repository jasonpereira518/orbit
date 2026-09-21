/**
 * The per-site switches: which sites Orbit may read without being asked again.
 *
 * Lives in Settings. Reading a page never needs these — the icon click grants
 * the tab — so this is purely "follow me on this site without a click", with
 * the off-switch right beside the on-switch.
 */
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  KNOWN_SITES,
  grantedOrigins,
  requestSites,
  revokeSites,
} from "@/lib/permissions";
import { MicroLabel } from "./ui";

export function useGrantedOrigins() {
  const [granted, setGranted] = useState<string[]>([]);
  const refresh = () => void grantedOrigins().then(setGranted);
  useEffect(refresh, []);
  return { granted, refresh };
}

export function SiteAccessList({
  title = "Sites",
  onGranted,
}: {
  title?: string;
  onGranted?: () => void;
}) {
  const { granted, refresh } = useGrantedOrigins();

  // Synchronous inside the click: awaiting first loses the gesture and Chrome
  // rejects the request.
  const ask = (origins: string[]) => {
    void requestSites(origins).then((ok) => {
      refresh();
      if (ok) onGranted?.();
    });
  };

  return (
    <div>
      <MicroLabel className="mb-1.5">{title}</MicroLabel>
      <ul className="space-y-1">
        {KNOWN_SITES.map((s) => {
          const on = granted.includes(s.origin);
          return (
            <li
              key={s.origin}
              className={cn(
                "flex items-center gap-2 rounded-[var(--radius)] px-2 py-1.5 text-[13px]",
                on && "bg-[var(--accent)]"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "h-[5px] w-[5px] shrink-0 rounded-full",
                  on ? "bg-[var(--primary)]" : "border border-[var(--border)]"
                )}
              />
              <span className="flex-1">{s.label}</span>
              {on ? (
                <button
                  onClick={() => void revokeSites([s.origin]).then(refresh)}
                  className="inline-flex items-center gap-1 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:underline"
                >
                  <Check size={11} />
                  turn off
                </button>
              ) : (
                <button
                  onClick={() => ask([s.origin])}
                  className="text-[11px] text-[var(--primary)] hover:underline"
                >
                  turn on
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
