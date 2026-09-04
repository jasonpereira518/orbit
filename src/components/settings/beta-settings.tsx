import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { BETA_SURFACE_KEYS, getSurface } from "@/lib/surfaces";

/**
 * What being a testing account actually gets you.
 *
 * A server component, and rendered only when `settings.beta` is visible — that surface is
 * itself marked `beta`, so the card announcing beta is gated by the same mechanism it
 * describes and nobody who is not a tester ever sees it. Read-only for now: turning testing
 * off is an operator action, so there is no self-serve switch to offer.
 */
export function BetaSettings() {
  const surfaces = [...BETA_SURFACE_KEYS]
    .map((key) => getSurface(key))
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <section className="space-y-4 rounded-2xl border border-accent/40 bg-card p-6">
      <div>
        <div className="flex items-center gap-2">
          <FlaskConical className="size-4 text-accent-foreground" />
          <h2 className="text-lg font-medium text-ink">Beta testing</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Your account is set up for testing Orbit. That is why nothing here is paywalled —
          it is separate from any real plan you hold, and turning testing off restores
          whatever you were on before.
        </p>
      </div>

      <div>
        <p className="text-sm font-medium text-ink">What you have</p>
        <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
          <li>
            <span className="text-foreground">Every paid feature</span> — outreach,
            recruiters, mailbox and calendar sync, the extension, and no contact limit.
          </li>
          {surfaces.map((surface) => (
            <li key={surface.key}>
              <span className="text-foreground">
                {surface.href ? (
                  <Link href={surface.href} className="hover:text-primary">
                    {surface.label}
                  </Link>
                ) : (
                  surface.label
                )}
              </span>{" "}
              — {surface.description}
            </li>
          ))}
          <li>
            <span className="text-foreground">Retrieval diagnostics in chat</span> — what
            was pulled in to answer a question, which search arms matched, and what the
            model was asked to rank.
          </li>
        </ul>
      </div>

      <div>
        <p className="text-sm font-medium text-ink">What to expect</p>
        <p className="mt-1 text-sm text-muted-foreground">
          These tools act on real data and are not all reversible — the testing console can
          wipe and reseed your network. Nothing here is early access to unreleased features;
          when something breaks, the diagnostics are the fastest thing to send along with it.
        </p>
      </div>
    </section>
  );
}
