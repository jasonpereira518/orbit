"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type ExportSource = {
  title: string;
  body: string;
  link?: { href: string; label: string };
};

/**
 * One short paragraph per place an address book lives, rather than the LinkedIn guide's
 * screenshot walkthrough: every one of these is two or three clicks in an app the reader
 * already uses, and the whole point of this card is that it is quicker than connecting an
 * account. The menu names are the apps' own, so they can be searched for if an app moves them.
 */
const SOURCES: ExportSource[] = [
  {
    title: "Google Contacts",
    body: "Click Export, choose which contacts, then pick vCard or Google CSV — either works here.",
    link: { href: "https://contacts.google.com", label: "Open Google Contacts" },
  },
  {
    title: "iPhone or iCloud",
    body: "On iCloud.com, open Contacts, select everyone (Ctrl+A or ⌘A), then choose Export vCard from the ⋯ menu. Your iPhone's contacts are only there if Contacts is switched on under iCloud in Settings.",
    link: { href: "https://www.icloud.com/contacts", label: "Open iCloud Contacts" },
  },
  {
    title: "Android or Mac",
    body: "Android: in the Contacts app, open Fix & manage, then Export to file. Mac: in Contacts, select everyone, then File → Export → Export vCard.",
  },
  {
    title: "Outlook",
    body: "Outlook.com: in People, choose Manage contacts → Export contacts. Classic Outlook: File → Open & Export → Import/Export → Export to a file → Comma Separated Values.",
  },
];

export function ContactsExportGuide() {
  const [open, setOpen] = useState(false);

  return (
    <div className="shrink-0">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        How to export
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[min(90vh,40rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Export your contacts</DialogTitle>
            <DialogDescription>
              Save your address book as a vCard (.vcf) or CSV, then upload it here.
            </DialogDescription>
          </DialogHeader>

          <ul className="space-y-4">
            {SOURCES.map((source) => (
              <li key={source.title}>
                <p className="font-medium text-ink">{source.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {source.body}
                </p>
                {source.link ? (
                  <a
                    href={source.link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                  >
                    {source.link.label}
                    <ExternalLink className="size-3.5" />
                  </a>
                ) : null}
              </li>
            ))}
          </ul>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>
              Got it
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
