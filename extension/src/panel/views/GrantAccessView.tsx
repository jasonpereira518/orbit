/**
 * The one screen the side panel forced on us.
 *
 * A popup rides `activeTab` — the click that opens it is the grant. A panel
 * opened from the toolbar gets no such grant, so before it can read anything
 * the user has to say yes once per site.
 *
 * The copy treats that as the product working rather than as an obstacle,
 * because it is: Orbit genuinely cannot see a page it hasn't been let into, and
 * that's worth more to the user than one saved click. The permission is
 * revocable from here too — an on-switch you can't find the off-switch for is
 * how extensions lose trust.
 */
import { useEffect, useState } from "react";
import { Check, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, Meta, MicroLabel } from "../components/ui";
import {
  KNOWN_ORIGINS,
  KNOWN_SITES,
  grantedOrigins,
  requestSites,
  revokeSites,
} from "@/lib/permissions";

export function GrantAccessView({
  pendingOrigin,
  onGranted,
}: {
  pendingOrigin: string | null;
  onGranted: () => void;
}) {
  const [granted, setGranted] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = () => void grantedOrigins().then(setGranted);
  useEffect(refresh, []);

  // Must run synchronously inside the click: awaiting first loses the gesture
  // and Chrome rejects the request.
  const ask = (origins: string[]) => {
    setBusy(true);
    void requestSites(origins).then((ok) => {
      setBusy(false);
      refresh();
      if (ok) onGranted();
    });
  };

  // Match the concrete origin we saw ("https://www.linkedin.com/*") against
  // the declared pattern ("https://*.linkedin.com/*") on registrable domain,
  // not string containment — the two never match literally.
  const site = (() => {
    if (!pendingOrigin) return null;
    const host = pendingOrigin
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^\*\./, "");
    return (
      KNOWN_SITES.find((candidate) => {
        const domain = candidate.origin
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, "")
          .replace(/^\*\./, "");
        return host === domain || host.endsWith(`.${domain}`);
      }) ?? null
    );
  })();

  return (
    <div className="scroll-area flex-1 px-3 py-4">
      <ShieldCheck size={18} className="mb-2 text-[var(--muted-foreground)]" />
      <p className="text-[14px] font-medium leading-snug">
        {site ? `Let Orbit read ${site.label}` : "Let Orbit read your profiles"}
      </p>
      <Meta className="mt-1.5 max-w-[38ch]">
        Orbit only reads the page you&apos;re looking at, only while the panel
        is open, and never sends the page text anywhere except your own Orbit
        account.
      </Meta>

      <div className="mt-3 space-y-2">
        {site ? (
          <Button size="lg" disabled={busy} onClick={() => ask([site.origin])}>
            Allow {site.label}
          </Button>
        ) : (
          <Button size="lg" disabled={busy} onClick={() => ask(KNOWN_ORIGINS)}>
            Allow LinkedIn, X and Gmail
          </Button>
        )}
        {site ? (
          <button
            onClick={() => ask(KNOWN_ORIGINS)}
            disabled={busy}
            className="block w-full text-center text-[12px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:underline disabled:pointer-events-none disabled:opacity-50"
          >
            Allow every site Orbit reads
          </button>
        ) : null}
      </div>

      <div className="mt-5">
        <MicroLabel className="mb-1.5">Sites</MicroLabel>
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
    </div>
  );
}
