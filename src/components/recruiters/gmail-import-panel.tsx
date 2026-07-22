"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  confirmGmailRecruiterImports,
  disconnectGmail,
  scanGmailRecruiters,
  startGmailOAuth,
  type GmailConnectionStatus,
} from "@/actions/gmail";
import type { GmailRecruiterCandidate } from "@/lib/gmail";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

export function GmailImportPanel({
  connection,
}: {
  connection: GmailConnectionStatus;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [candidates, setCandidates] = useState<GmailRecruiterCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmail = params.get("gmail");
    if (gmail === "connected") {
      toast.success("Gmail connected");
      params.delete("gmail");
      params.delete("reason");
      const next = params.toString();
      window.history.replaceState(
        null,
        "",
        `/recruiters${next ? `?${next}` : ""}`
      );
      router.refresh();
    } else if (gmail === "error") {
      toast.error(params.get("reason") || "Gmail connection failed");
      params.delete("gmail");
      params.delete("reason");
      const next = params.toString();
      window.history.replaceState(
        null,
        "",
        `/recruiters${next ? `?${next}` : ""}`
      );
    }
  }, [router]);

  if (!connection.configured) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 bg-card/50 px-5 py-4 text-sm text-muted-foreground">
        Connect Gmail to import recruiters from your inbox. Set{" "}
        <code className="text-xs">GOOGLE_CLIENT_ID</code> and{" "}
        <code className="text-xs">GOOGLE_CLIENT_SECRET</code> in the environment.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border border-border/70 bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-[family-name:var(--font-display)] text-lg text-primary">
            Gmail import
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {connection.connected
              ? `Connected as ${connection.emailAddress}`
              : "Scan your inbox for recruiter outreach (last 90 days)."}
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
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    try {
                      const found = await scanGmailRecruiters();
                      setCandidates(found);
                      setSelected(new Set(found.map((c) => c.key)));
                      setScanned(true);
                      toast.success(
                        found.length
                          ? `Found ${found.length} recruiter${found.length === 1 ? "" : "s"}`
                          : "No recruiter emails found"
                      );
                    } catch (err) {
                      toast.error(
                        err instanceof Error ? err.message : "Scan failed"
                      );
                    }
                  })
                }
              >
                {pending ? "Scanning…" : "Scan inbox"}
              </Button>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    await disconnectGmail();
                    setCandidates([]);
                    setScanned(false);
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

      {scanned && candidates.length > 0 && (
        <div className="space-y-3">
          <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
            {candidates.map((c) => {
              const checked = selected.has(c.key);
              return (
                <li key={c.key} className="flex items-start gap-3 px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checked}
                    onChange={() => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.key)) next.delete(c.key);
                        else next.add(c.key);
                        return next;
                      });
                    }}
                  />
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-medium">{c.fullName}</p>
                    <p className="text-muted-foreground">
                      {c.email}
                      {c.firm ? ` · ${c.firm}` : ""} · {c.messageCount} msg
                      {c.messageCount === 1 ? "" : "s"}
                    </p>
                    {c.evidence && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground/80">
                        {c.evidence}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <Button
            disabled={pending || selected.size === 0}
            onClick={() =>
              start(async () => {
                try {
                  const picked = candidates.filter((c) => selected.has(c.key));
                  const result = await confirmGmailRecruiterImports(picked);
                  toast.success(`Imported ${result.imported} recruiter(s)`);
                  setCandidates([]);
                  setScanned(false);
                  router.refresh();
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Import failed"
                  );
                }
              })
            }
          >
            Import selected ({selected.size})
          </Button>
        </div>
      )}
    </div>
  );
}
