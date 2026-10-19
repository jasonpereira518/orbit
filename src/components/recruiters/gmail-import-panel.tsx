"use client";

import { TOAST_COPY } from "@/lib/toast-copy";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { type GmailConnectionStatus, type GmailScanStatus } from "@/actions/gmail";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { IntegrationBadge, type IntegrationStatus } from "@/components/integrations/integration-logo";
import {
  SESSION_EXPIRED_LINE,
  calendarOffLine,
  calendarPauseLine,
} from "@/lib/connection-status";
import { friendlyError } from "@/lib/errors";
import { DisconnectAccountDialog } from "@/components/settings/disconnect-account-dialog";
import { useGoogleConnection } from "@/components/settings/use-provider-connection";
import { useRecruiterScan } from "@/components/settings/use-recruiter-scan";

/** The connection's health as the badge says it. */
function statusFor(connection: GmailConnectionStatus): IntegrationStatus {
  if (connection.status === "needs_reauth") return "needs-reconnect";
  if (connection.connected) return "connected";
  return "not-connected";
}

export function GmailImportPanel({
  connection,
  initialScan,
  returnTo,
}: {
  connection: GmailConnectionStatus;
  initialScan: GmailScanStatus | null;
  /** Where Google sends the user back to. Omitted, the callback defaults to /recruiters. */
  returnTo?: string;
}) {
  const [pending, startTransition] = useTransition();
  const conn = useGoogleConnection({ returnTo: returnTo ?? "", enabled: false, label: "Gmail" });
  // One handler for the header link and the button: both start the same mail consent.
  const connect = () => conn.connect(["recruiter_scan"]);
  const busy = conn.busy || pending;
  const {
    scan,
    running,
    phaseLabel,
    percent: pct,
    start: runStart,
    cancel: runCancel,
    reset: resetScan,
  } = useRecruiterScan("google", initialScan);

  if (!connection.configured) {
    return (
      <div className="space-y-2 rounded-xl border border-dashed border-border-subtle bg-card px-5 py-4 text-sm text-muted-foreground">
        {/* Setup instructions are for whoever runs the app, not the person reading the
            page — the env-var line is compiled out of production bundles. */}
        <p>
          Gmail isn’t connected yet, so recruiter threads can’t be imported from your
          inbox. You can still add recruiters by hand.
        </p>
        {process.env.NODE_ENV === "development" ? (
          <p className="text-xs text-muted-foreground/70">
            Dev only — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and
            GOOGLE_REDIRECT_URI
            {connection.redirectUri ? ` (redirect: ${connection.redirectUri})` : ""}
            .
          </p>
        ) : null}
      </div>
    );
  }

  const canScan = connection.connected && connection.canRead;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <IntegrationBadge
            provider="gmail"
            status={statusFor(connection)}
            detail={connection.connected && connection.emailAddress ? `as ${connection.emailAddress}` : undefined}
          />
          <p className="max-w-prose text-sm text-muted-foreground">
            {connection.status === "needs_reauth"
              ? `${SESSION_EXPIRED_LINE} to scan your inbox again.`
              : canScan
                ? "Orbit searches your whole mailbox for recruiter threads and writes a private summary of each one."
                : connection.connected
                  ? "Connected without permission to read mail. Allow mail access to scan for recruiters."
                  : "Search your whole mailbox for recruiters, the companies they hired for, and a summary of every conversation."}
          </p>
          {connection.status === "disarmed" ? (
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-warning">
              <span>{calendarPauseLine(connection.syncError)}</span>
              <Button variant="link" size="sm" className="h-auto px-0" disabled={busy} onClick={connect}>
                Reconnect
              </Button>
            </p>
          ) : connection.status === "paused" ? (
            // The person switched meetings off themselves: not a fault, so no warning colour
            // and no Reconnect — a consent screen would not turn them back on.
            <p className="text-sm text-muted-foreground">{calendarOffLine()}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {!canScan ? (
            <Button disabled={busy} onClick={connect}>
              {busy
                ? "Connecting…"
                : connection.status === "needs_reauth"
                  ? "Reconnect"
                  : connection.connected
                    ? "Allow mail access"
                    : "Connect Gmail"}
            </Button>
          ) : (
            <>
              <Button
                disabled={busy || running}
                onClick={() => startTransition(() => runStart())}
              >
                {running ? "Scanning…" : "Scan inbox"}
              </Button>
              <DisconnectAccountDialog
                provider="gmail"
                disabled={busy || running}
                onConfirm={(opts) => {
                  conn.disconnect(opts).then(() => {
                    resetScan();
                  });
                }}
              />
            </>
          )}
        </div>
      </CardHeader>

      {running && scan && (
        <CardContent>
          <div className="space-y-2 rounded-lg border border-border-subtle bg-surface-inset p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2 text-foreground" role="status">
                <Loader2 className="size-4 text-muted-foreground motion-safe:animate-spin" aria-hidden />
                {phaseLabel}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => startTransition(() => runCancel())}
              >
                Cancel
              </Button>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={
                  pct == null
                    ? "h-full w-1/3 rounded-full bg-primary/60 motion-safe:animate-pulse"
                    : "h-full rounded-full bg-primary transition-[width] duration-slow"
                }
                style={pct == null ? undefined : { width: `${pct}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Runs on the server — you can close this tab and come back.
              {scan.recruitersFound > 0
                ? ` ${scan.recruitersFound} found so far.`
                : ""}
            </p>
          </div>
        </CardContent>
      )}

      {!running && scan?.status === "completed" && (
        <CardContent>
          <p className="rounded-lg border border-border-subtle bg-surface-inset p-4 text-sm text-muted-foreground">
            Last scan read {scan.messagesScanned.toLocaleString()} messages and
            found{" "}
            <span className="font-medium text-foreground">
              {scan.recruitersFound} recruiter
              {scan.recruitersFound === 1 ? "" : "s"}
            </span>
            . Summaries are private to you.
          </p>
        </CardContent>
      )}

      {!running && scan?.status === "failed" && (
        <CardContent>
          <p role="alert" className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
            {friendlyError(
              scan.errorMessage ? new Error(scan.errorMessage) : null,
              TOAST_COPY.scanFailed
            )}
          </p>
        </CardContent>
      )}
    </Card>
  );
}
