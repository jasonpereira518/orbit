"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import {
  cancelGmailRecruiterScan,
  disconnectGmail,
  getGmailScanStatus,
  startGmailOAuth,
  startGmailRecruiterScan,
  type GmailConnectionStatus,
  type GmailScanStatus,
} from "@/actions/gmail";
import {
  finishBackgroundJob,
  startBackgroundJob,
  updateBackgroundJob,
} from "@/lib/background-jobs";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

const POLL_INTERVAL_MS = 2000;

function isTerminal(status: string) {
  return ["completed", "failed", "cancelled"].includes(status);
}

/**
 * Describes where the job actually is. Discovery has no meaningful denominator — the
 * mailbox size is unknown until the sweep ends — so it reports messages seen and the
 * progress bar stays indeterminate until classification starts.
 */
function phaseLabel(scan: GmailScanStatus) {
  if (isTerminal(scan.status)) return null;
  if (!scan.discoveryComplete) {
    return scan.messagesScanned > 0
      ? `Searching your mailbox — ${scan.messagesScanned.toLocaleString()} messages so far`
      : "Searching your mailbox…";
  }
  return `Reading ${scan.processed}/${scan.totalSenders ?? 0} conversations`;
}

export function GmailImportPanel({
  connection,
  initialScan,
}: {
  connection: GmailConnectionStatus;
  initialScan: GmailScanStatus | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [scan, setScan] = useState<GmailScanStatus | null>(initialScan);
  const jobIdRef = useRef<string | null>(null);

  const running = scan != null && !isTerminal(scan.status);

  /**
   * Mirror server state into the shared job store so the global progress bar and its
   * completion toast work exactly as they do for LinkedIn imports. The job is owned by
   * the server, so this is presentation only — closing the tab does not stop the scan.
   */
  const mirror = useCallback((next: GmailScanStatus) => {
    const total = next.discoveryComplete ? (next.totalSenders ?? 0) : 0;
    const done = next.discoveryComplete ? next.processed : 0;

    if (!jobIdRef.current && !isTerminal(next.status)) {
      jobIdRef.current = startBackgroundJob({
        id: `gmail-scan-${next.importId}`,
        kind: "gmail-recruiter-scan",
        label: "Scanning Gmail for recruiters",
        startedAt: Date.now(),
        done,
        total,
      });
    } else if (jobIdRef.current && !isTerminal(next.status)) {
      updateBackgroundJob(jobIdRef.current, { done, total });
    } else if (jobIdRef.current && isTerminal(next.status)) {
      finishBackgroundJob(
        jobIdRef.current,
        next.status === "completed"
          ? {
              status: "completed",
              resultMessage: `${next.recruitersFound} recruiter${
                next.recruitersFound === 1 ? "" : "s"
              } found`,
            }
          : {
              status: next.status === "cancelled" ? "cancelled" : "failed",
              error: next.errorMessage || undefined,
            }
      );
      jobIdRef.current = null;
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmail = params.get("gmail");
    if (!gmail) return;
    if (gmail === "connected") {
      toast.success("Gmail connected");
      router.refresh();
    } else if (gmail === "error") {
      toast.error(params.get("reason") || "Gmail connection failed");
    }
    params.delete("gmail");
    params.delete("reason");
    const next = params.toString();
    window.history.replaceState(null, "", `/recruiters${next ? `?${next}` : ""}`);
  }, [router]);

  useEffect(() => {
    if (!running || !scan) return;
    let cancelled = false;

    const timer = setInterval(async () => {
      try {
        const next = await getGmailScanStatus(scan.importId);
        if (cancelled || !next) return;
        setScan(next);
        mirror(next);
        if (isTerminal(next.status)) {
          if (next.status === "completed") {
            toast.success(
              next.recruitersFound > 0
                ? `Found ${next.recruitersFound} recruiter${next.recruitersFound === 1 ? "" : "s"}`
                : "No recruiters found in your mailbox"
            );
          } else if (next.status === "failed") {
            toast.error(next.errorMessage || "Scan failed");
          }
          router.refresh();
        }
      } catch {
        // Transient — the next tick retries.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running, scan, mirror, router]);

  if (!connection.configured) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 bg-card/50 px-5 py-4 text-sm text-muted-foreground">
        Connect Gmail to import recruiters from your inbox. Set{" "}
        <code className="text-xs">GOOGLE_CLIENT_ID</code>,{" "}
        <code className="text-xs">GOOGLE_CLIENT_SECRET</code>, and{" "}
        <code className="text-xs">GOOGLE_REDIRECT_URI</code> in the environment
        {connection.redirectUri ? (
          <>
            {" "}
            (redirect: <code className="text-xs">{connection.redirectUri}</code>)
          </>
        ) : null}
        .
      </div>
    );
  }

  const pct =
    scan && scan.discoveryComplete && scan.totalSenders
      ? Math.min(100, Math.round((scan.processed / scan.totalSenders) * 100))
      : null;

  return (
    <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-[family-name:var(--font-display)] text-lg text-primary">
            Gmail
          </h2>
          <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
            {connection.connected
              ? `Connected as ${connection.emailAddress}. Orbit searches your whole mailbox for recruiter threads and writes a private summary of each one.`
              : "Search your whole mailbox for recruiters, the companies they hired for, and a summary of every conversation."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!connection.connected ? (
            <Button
              disabled={pending}
              onClick={() =>
                start(async () => {
                  try {
                    const { url } = await startGmailOAuth();
                    window.location.href = url;
                  } catch (err) {
                    toast.error(
                      err instanceof Error ? err.message : "OAuth failed"
                    );
                  }
                })
              }
            >
              Connect Gmail
            </Button>
          ) : (
            <>
              <Button
                disabled={pending || running}
                onClick={() =>
                  start(async () => {
                    try {
                      const { importId } = await startGmailRecruiterScan();
                      const next = await getGmailScanStatus(importId);
                      if (next) {
                        setScan(next);
                        mirror(next);
                      }
                      toast.success("Scan started — this can take a few minutes");
                    } catch (err) {
                      toast.error(
                        err instanceof Error ? err.message : "Could not start scan"
                      );
                    }
                  })
                }
              >
                {running ? "Scanning…" : scan ? "Scan again" : "Scan mailbox"}
              </Button>
              <Button
                variant="outline"
                disabled={pending || running}
                onClick={() =>
                  start(async () => {
                    await disconnectGmail();
                    setScan(null);
                    toast.success("Gmail disconnected");
                    router.refresh();
                  })
                }
              >
                Disconnect
              </Button>
            </>
          )}
        </div>
      </div>

      {running && scan && (
        <div className="space-y-2 rounded-xl bg-muted/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2 text-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              {phaseLabel(scan)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                start(async () => {
                  await cancelGmailRecruiterScan(scan.importId);
                  toast.success("Scan cancelled");
                  const next = await getGmailScanStatus(scan.importId);
                  if (next) {
                    setScan(next);
                    mirror(next);
                  }
                })
              }
            >
              Cancel
            </Button>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
            <div
              className={
                pct == null
                  ? "h-full w-1/3 animate-pulse rounded-full bg-primary/60"
                  : "h-full rounded-full bg-primary transition-[width] duration-500"
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
      )}

      {!running && scan?.status === "completed" && (
        <p className="rounded-xl bg-muted/40 p-4 text-sm text-muted-foreground">
          Last scan read {scan.messagesScanned.toLocaleString()} messages and
          found{" "}
          <span className="font-medium text-foreground">
            {scan.recruitersFound} recruiter
            {scan.recruitersFound === 1 ? "" : "s"}
          </span>
          . Summaries are private to you.
        </p>
      )}

      {!running && scan?.status === "failed" && (
        <p className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive">
          {scan.errorMessage || "The last scan failed."}
        </p>
      )}
    </div>
  );
}
