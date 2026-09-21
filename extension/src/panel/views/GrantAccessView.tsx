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
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button, Meta } from "../components/ui";
import { SiteAccessList } from "../components/SiteAccess";
import { KNOWN_ORIGINS, KNOWN_SITES, requestSites } from "@/lib/permissions";

export function GrantAccessView({
  pendingOrigin,
  onGranted,
}: {
  pendingOrigin: string | null;
  onGranted: () => void;
}) {
  const [busy, setBusy] = useState(false);

  // Must run synchronously inside the click: awaiting first loses the gesture
  // and Chrome rejects the request.
  const ask = (origins: string[]) => {
    setBusy(true);
    void requestSites(origins).then((ok) => {
      setBusy(false);
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
        <SiteAccessList onGranted={onGranted} />
      </div>
    </div>
  );
}
