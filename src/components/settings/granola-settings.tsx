"use client";

import { useEffect, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { disconnectGranola, getGranolaConnection, startGranolaConnect } from "@/actions/granola";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection } from "@/components/settings/settings-section";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

type Connection = Awaited<ReturnType<typeof getGranolaConnection>>;

/**
 * Connect Granola and leave it. There is deliberately nothing else here — no note list, no
 * review queue: new notes land on the people in them on the next sync.
 */
export function GranolaSettings() {
  const [conn, setConn] = useState<Connection | undefined>(undefined);
  const [pending, start] = useTransition();
  const result = useSearchParams().get("granola");

  useEffect(() => {
    getGranolaConnection().then(setConn, () => setConn(null));
  }, []);

  const connect = () =>
    start(async () => {
      try {
        const { url } = await startGranolaConnect();
        window.location.assign(url);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t reach Granola — try again?"));
      }
    });

  const disconnect = () =>
    start(async () => {
      await disconnectGranola();
      setConn(null);
    });

  return (
    <SettingsSection
      title="Granola"
      description="New Granola notes update the people you met — the meeting is logged at its real time and their AI notes are refreshed. Nothing to review."
    >
      {conn === undefined ? (
        <Skeleton className="h-9 w-40 rounded-lg" />
      ) : !conn || conn.status === "needs_reauth" ? (
        <div className="space-y-3">
          {conn?.status === "needs_reauth" ? (
            <p className="text-sm text-destructive">Granola signed Orbit out. Reconnect to keep syncing.</p>
          ) : result === "error" ? (
            <p className="text-sm text-destructive">That didn’t connect. Try again.</p>
          ) : (
            <p className="text-sm text-muted-foreground">Works with every Granola plan. Brings in the last 30 days, then each new note.</p>
          )}
          <Button disabled={pending} onClick={connect}>
            {conn ? "Reconnect Granola" : "Connect Granola"}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            Connected{conn.accountRef ? ` as ${conn.accountRef}` : ""}.{" "}
            <span className="text-muted-foreground">
              {conn.lastSyncedAt
                ? `Last checked ${formatDistanceToNow(conn.lastSyncedAt, { addSuffix: true })}.`
                : "First sync is running."}
            </span>
          </p>
          {conn.syncError ? <p className="text-sm text-destructive">{conn.syncError}</p> : null}
          <Button variant="outline" size="sm" disabled={pending} onClick={disconnect}>
            Disconnect
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}
