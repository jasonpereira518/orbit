/**
 * Turning each importer's preview rows into the one shape the review list renders.
 *
 * These three mappings used to live inline in the three cards, which was fine while a card was
 * the only thing that reviewed a file. The queue reviews all of them on one screen, so an
 * inline copy would have become a fourth — and the subtitle rules here are not arbitrary:
 * each one is the thing that tells two same-named people apart in that particular source.
 */
import type { ReviewPerson } from "@/components/imports/import-people-review";

type ConnectionRow = {
  id: string;
  fullName: string;
  position?: string;
  company?: string;
  isRepeat: boolean;
  duplicate?: { reason: string } | null;
};

export function connectionToReviewPerson(p: ConnectionRow): ReviewPerson {
  return {
    id: p.id,
    name: p.fullName,
    subtitle: [p.position, p.company].filter(Boolean).join(" · "),
    isRepeat: p.isRepeat,
    repeatReason: p.duplicate?.reason,
  };
}

type MessageRow = {
  id: string;
  displayName: string;
  title: string;
  linkedinUrl?: string | null;
  willCreate?: boolean;
  messageCount: number;
  sentByYou: number | null;
  receivedFromThem: number | null;
  sampleContent?: string;
  isRepeat: boolean;
  match?: { fullName?: string; reason?: string } | null;
};

export function messageThreadToReviewPerson(p: MessageRow): ReviewPerson {
  return {
    id: p.id,
    name: p.displayName,
    subtitle: p.isRepeat
      ? `Matched: ${p.match?.fullName || p.title}`
      : p.linkedinUrl
        ? p.linkedinUrl
        : p.willCreate
          ? "Will create new contact"
          : p.title,
    // The sent/received split is the tell for an inverted owner guess: if Orbit decided the
    // wrong person owns this export, every thread reads backwards, and here is where that is
    // cheap to notice rather than after the rows are written. Absent when direction could not
    // be established at all.
    meta: `${
      p.sentByYou !== null && p.receivedFromThem !== null
        ? `${p.sentByYou} sent · ${p.receivedFromThem} received`
        : `${p.messageCount} message${p.messageCount === 1 ? "" : "s"}`
    }${p.sampleContent ? ` · ${p.sampleContent}` : ""}`,
    isRepeat: p.isRepeat,
    repeatReason: p.match?.reason || "Already in your network",
  };
}

type ContactsFileRowPerson = {
  id: string;
  fullName: string;
  title?: string;
  company?: string;
  email?: string;
  phone?: string;
  isRepeat: boolean;
  duplicate?: { reason: string } | null;
};

export function contactsFileToReviewPerson(
  p: ContactsFileRowPerson,
): ReviewPerson {
  return {
    id: p.id,
    name: p.fullName,
    // Most address-book entries have no job at all, so the email (or, failing that, the
    // number) is what tells two same-named people apart in the list.
    subtitle:
      [p.title, p.company].filter(Boolean).join(" · ") || p.email || p.phone,
    isRepeat: p.isRepeat,
    repeatReason: p.duplicate?.reason,
  };
}
