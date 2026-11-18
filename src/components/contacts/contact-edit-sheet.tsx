"use client";

import { useState } from "react";
import { Merge, MoreHorizontal, Pencil, Trash2, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { ContactForm } from "@/components/contacts/contact-form";
import { DeleteContactDialog } from "@/components/contacts/delete-contact-dialog";
import { MergeContactDialog } from "@/components/contacts/merge-contact-dialog";
import { lookupBrand } from "@/lib/brand-colors";
import { companyBrandColor } from "@/lib/company-brand";
import type { ContactInput } from "@/actions/contacts";

/** Orbit's deep teal, for a contact with no company (or a black/white brand). */
const FALLBACK_BAND = "#0f3d3e";

/**
 * The band behind the header: the company's brand, deepened toward near-black so white text
 * clears AA on every brand (Amazon's orange included) while it still reads as the brand.
 * Only a brand Orbit knows: `companyBrandColor`'s hashed tint for any other name would
 * repaint the header on every keystroke of a half-typed company.
 *
 * ponytail: one fixed mix for all brands; if some read muddy, clamp per brand the way
 * `companyBrandText` does for text.
 */
function bandColor(company: string) {
  const brand = lookupBrand(company, "company") ? companyBrandColor(company) : null;
  return brand ? `color-mix(in oklab, ${brand} 62%, #0b1416)` : FALLBACK_BAND;
}

export function ContactEditSheet({
  contactId,
  name,
  firstName,
  profileImageUrl,
  initial,
}: {
  contactId: string;
  name: string;
  firstName?: string | null;
  profileImageUrl?: string | null;
  initial: Partial<ContactInput> & { tags?: string[]; tagNames?: string[] };
}) {
  const [open, setOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
        Edit
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" showCloseButton={false} className="w-full gap-0 overflow-y-auto sm:max-w-lg">
          <ContactForm
            contactId={contactId}
            initial={initial}
            pinnedActions
            className="rounded-none border-0 bg-transparent px-4 pt-0 pb-0 shadow-none"
            onSuccess={() => setOpen(false)}
            renderHeader={(live) => {
              const role = [live.title.trim(), live.company.trim()].filter(Boolean).join(" · ");
              return (
                <header
                  className="sticky top-0 z-10 -mx-4 mb-4 flex items-center gap-3 px-4 py-3.5 text-white transition-[background-color] duration-slow"
                  style={{ backgroundColor: bandColor(live.company) }}
                >
                  <ContactAvatar
                    contactId={contactId}
                    firstName={firstName}
                    fullName={live.fullName || name}
                    profileImageUrl={profileImageUrl}
                    size="default"
                    className="size-10 shrink-0 ring-2 ring-white/70"
                  />
                  <div className="min-w-0 flex-1">
                    <SheetTitle className="truncate font-[family-name:var(--font-display)] text-lg text-white">
                      <bdi>{live.fullName.trim() || name}</bdi>
                    </SheetTitle>
                    <SheetDescription className="truncate text-sm text-white/85">
                      {role || "Edit contact"}
                    </SheetDescription>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="More actions"
                          className="text-white hover:bg-white/15 hover:text-white"
                        />
                      }
                    >
                      <MoreHorizontal />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem onClick={() => setMergeOpen(true)}>
                        <Merge aria-hidden />
                        Merge into…
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                        <Trash2 aria-hidden />
                        Delete contact
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <SheetClose
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-white hover:bg-white/15 hover:text-white"
                      />
                    }
                  >
                    <XIcon />
                    <span className="sr-only">Close</span>
                  </SheetClose>
                </header>
              );
            }}
          />
        </SheetContent>
      </Sheet>
      <MergeContactDialog id={contactId} name={name} open={mergeOpen} onOpenChange={setMergeOpen} />
      <DeleteContactDialog id={contactId} name={name} open={deleteOpen} onOpenChange={setDeleteOpen} />
    </>
  );
}
