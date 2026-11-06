"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { COMPOSE_EVENT, type ComposeRequest } from "@/lib/compose-events";
import { COMPOSE_SURFACE_KEY } from "@/lib/surfaces";

const ComposeDialog = dynamic(() => import("@/components/email/compose-dialog").then((m) => m.ComposeDialog), {
  ssr: false,
});

/**
 * Mounted once in the app shell. Loads the composer only when something asks for it, and
 * never while Compose is hidden for this viewer (including while it is coming-soon).
 */
export function ComposeHost({ userId, hidden }: { userId: string; hidden: ReadonlySet<string> }) {
  const [request, setRequest] = useState<ComposeRequest | null>(null);
  const [open, setOpen] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const onCompose = (e: Event) => {
      setRequest((e as CustomEvent<ComposeRequest>).detail);
      setNonce((n) => n + 1);
      setOpen(true);
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, []);

  if (hidden.has(COMPOSE_SURFACE_KEY) || !request) return null;
  // Keyed per open, so each request starts from its own draft rather than the last one's state.
  return <ComposeDialog key={nonce} request={request} userId={userId} open={open} onOpenChange={setOpen} />;
}
