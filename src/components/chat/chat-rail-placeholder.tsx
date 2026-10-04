"use client";

import { useSyncExternalStore } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { RAIL_CLOSED_WIDTH, RAIL_OPEN_WIDTH } from "@/components/chat/chat-history-rail";
import { readRailOpen } from "@/lib/chat-rail-pref";

/** The history rail's place while the chat panel loads, at the width the person left it. */
export function ChatRailPlaceholder() {
  // Server and hydration render the open rail (the default); the stored choice takes over
  // straight after, without a hydration mismatch.
  const open = useSyncExternalStore(
    () => () => {},
    readRailOpen,
    () => true
  );
  return (
    <div
      aria-hidden
      className="hidden shrink-0 border-r border-border/60 md:block"
      style={{ width: open ? RAIL_OPEN_WIDTH : RAIL_CLOSED_WIDTH }}
    >
      {open ? (
        <div className="space-y-2 p-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="mt-4 h-4 w-16" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : (
        <div className="flex justify-center p-2">
          <Skeleton className="size-8" />
        </div>
      )}
    </div>
  );
}
