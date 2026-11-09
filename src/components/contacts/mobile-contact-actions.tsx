"use client";

import { useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { NotebookPen, Send } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { FollowUpDraftSheetLazy } from "@/components/follow-up/follow-up-draft-sheet-lazy";
import { cn } from "@/lib/utils";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function MobileContactActions({ contactId, name }: { contactId: string; name: string }) {
  const [draftOpen, setDraftOpen] = useState(false);
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  if (!mounted) return null;
  // The profile's reveal transform must not become the fixed bar's containing block.
  return createPortal(
    <>
      <div role="group" aria-label={`Quick actions for ${name}`} className="fixed inset-x-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-30 grid grid-cols-2 gap-3 rounded-2xl border border-border/70 bg-card/95 p-2 shadow-sm backdrop-blur md:hidden">
        <Link href={`/capture?contactId=${contactId}`} className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}><NotebookPen aria-hidden className="size-4" />Log interaction</Link>
        <Button className="min-h-11" onClick={() => setDraftOpen(true)}><Send aria-hidden className="size-4" />Follow up</Button>
      </div>
      {draftOpen && <FollowUpDraftSheetLazy open={draftOpen} onOpenChange={setDraftOpen} contactId={contactId} contactName={name} />}
    </>,
    document.body,
  );
}
