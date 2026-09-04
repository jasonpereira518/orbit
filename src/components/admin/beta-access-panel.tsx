"use client";

import { FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import { setBetaAccessAction } from "@/actions/admin";

/**
 * The testing-account toggle.
 *
 * Goes through `ConfirmActionDialog` rather than being an optimistic switch like the
 * surface toggles, because this is a value grant with no expiry: it hands over every paid
 * feature and the testing tools at once, and nothing downstream will ever correct it. The
 * reason field is what makes `admin_audit_log` a usable record of who is a tester and why.
 *
 * `surfaces` is passed in from the server rather than imported here so this component never
 * reaches `@/lib/surfaces` → `@/components/settings/sections` from a client bundle.
 */
export function BetaAccessPanel({
  targetUserId,
  email,
  enabled,
  surfaces,
}: {
  targetUserId: string;
  email: string | null;
  enabled: boolean;
  surfaces: string[];
}) {
  const who = email ?? targetUserId;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge
          variant={enabled ? "outline" : "secondary"}
          className={
            enabled
              ? "gap-1 border-accent/50 bg-accent/10 font-normal text-accent-foreground"
              : "gap-1 font-normal"
          }
        >
          <FlaskConical className="size-3.5" />
          {enabled ? "Testing account" : "Not a testing account"}
        </Badge>

        <ConfirmActionDialog
          trigger={
            <Button variant={enabled ? "outline" : "default"} size="sm">
              {enabled ? "Revoke beta" : "Make a testing account"}
            </Button>
          }
          title={enabled ? "Revoke testing access" : "Grant testing access"}
          description={
            enabled ? (
              <>
                <strong>{who}</strong> will lose the testing tools and the paid features that
                came with them. Any real comp or subscription on the account is untouched and
                takes effect again immediately.
              </>
            ) : (
              <>
                <strong>{who}</strong> will get every paid feature — with no billing attached
                — plus the testing tools listed below. Their own data is not touched, but the
                testing tools include one that wipes and reseeds it, so grant this only to
                someone who knows that.
              </>
            )
          }
          confirmLabel={enabled ? "Revoke beta" : "Grant beta"}
          onConfirm={async (reason) => {
            await setBetaAccessAction({ targetUserId, enabled: !enabled, reason });
          }}
        />
      </div>

      <div className="text-sm text-muted-foreground">
        <p>
          Beta opens the tools that exist for testing. It is not early access to unreleased
          features — those stay dark for everyone until they ship.
        </p>
        {surfaces.length > 0 && (
          <p className="mt-2">
            Surfaces this grant opens:{" "}
            <span className="text-foreground">{surfaces.join(", ")}</span>
          </p>
        )}
      </div>
    </div>
  );
}
