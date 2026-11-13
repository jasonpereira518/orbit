"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setEmailIntel } from "@/actions/email-intel";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/admin/relative-time";
import { useGoogleConnection } from "@/components/settings/use-provider-connection";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

/**
 * What the Companies tab says before the board has anything to show, and what it says about
 * keeping it current after. One card, one button at most:
 *
 * - no mail access  → "Connect Gmail". Coming back from Google turns Email insights on in the
 *   OAuth callback, so there is nothing to press afterwards.
 * - access, switch off → "Turn on" — for the people who allowed mail access some other way.
 * - on → a line saying when Orbit last looked.
 *
 * The disclosure beside the button is the one Settings shows for the same switch.
 */
const DISCLOSURE =
  "Orbit checks Gmail for job and hiring threads and has your AI provider note the company, role and where things stand. It keeps those notes and one short quote — never the messages themselves.";

export function RecruitingSetup({
  canRead,
  enabled,
  lastSweepAt,
  companies,
}: {
  canRead: boolean;
  enabled: boolean;
  lastSweepAt: string | null;
  companies: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const connection = useGoogleConnection({ returnTo: "/recruiters", enabled: false, label: "Gmail" });

  if (enabled) {
    return (
      <p className="text-sm text-muted-foreground">
        {lastSweepAt ? (
          <>
            Up to date · checked <RelativeTime date={lastSweepAt} format="long" />.{" "}
          </>
        ) : (
          <>Reading your inbox now — companies appear here as they’re found. </>
        )}
        {companies === 0 && lastSweepAt
          ? "Nothing about a job search has turned up yet; new mail lands here on its own. "
          : null}
        It starts with the last two weeks of mail.
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border border-border/70 bg-card p-5">
      <div>
        <h2 className="font-[family-name:var(--font-display)] text-lg text-ink">Let your inbox fill this in</h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Applications, recruiter emails and interviews become a card per company, and Orbit keeps each one current on
          its own.
        </p>
        <p className="mt-2 max-w-prose text-xs text-muted-foreground">{DISCLOSURE}</p>
      </div>
      {canRead ? (
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                const result = await setEmailIntel(true);
                if (!result.ok) {
                  toast.error(result.error);
                  return;
                }
                toast.success("Reading your inbox — companies appear here as they’re found");
                router.refresh();
              } catch (err) {
                toast.error(friendlyError(err, "Couldn’t turn that on — try again?"));
              }
            })
          }
        >
          Turn on
        </Button>
      ) : (
        <Button disabled={connection.busy || pending} onClick={() => connection.connect(["email_intel"])}>
          Connect Gmail
        </Button>
      )}
    </div>
  );
}
