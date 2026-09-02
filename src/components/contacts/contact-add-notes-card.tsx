"use client";

import { useState } from "react";
import { ChevronDown, NotebookPen } from "lucide-react";
import { BulkNotesPanel } from "@/components/chat/bulk-notes-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function ContactAddNotesCard({ contactId, contactName, hasApiKey }: { contactId: string; contactName: string; hasApiKey: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="cursor-pointer" onClick={() => setOpen((o) => !o)}>
        <CardTitle className="flex items-center gap-2 text-base">
          <NotebookPen className="size-4" /> Add notes
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2"
            aria-expanded={open}
            aria-label={open ? "Collapse add notes" : "Expand add notes"}
          >
            <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
          </Button>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">
            Paste what you talked about with {contactName}. Dates, action items, and anyone they mentioned are picked up automatically.
          </p>
          <BulkNotesPanel compact lockedParticipantId={contactId} lockedParticipantName={contactName} entryPoint="profile" hasApiKey={hasApiKey} />
        </CardContent>
      )}
    </Card>
  );
}
