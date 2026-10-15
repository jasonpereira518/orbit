import type { LinkedInSignalRowPayload } from "@/db/schema";
import type { ContactInput } from "@/lib/contact-writes";
import type { ImportAdapter, InteractionInsert } from "@/lib/import-engine";

/**
 * The per-person notes in a kept LinkedIn export — connection-request messages, the notes the
 * user wrote inside LinkedIn, and recommendations — attached to people already in Orbit.
 *
 * Never creates anyone (`createsContacts: false`, like calendar): a pending invitation or a
 * recommender who is not a connection is not someone the user asked to add. Unlike calendar it
 * keeps the default 0.85 floor, so a bare name never attaches a recommendation to the wrong
 * person — invitations and notes match on the profile URL, recommendations need name + company.
 */
const SOURCE = "linkedin_export";

function dateOf(p: LinkedInSignalRowPayload): Date {
  return p.date ? new Date(p.date) : new Date();
}

/** What the note says, in the user's terms. The quoted text is theirs or their contact's. */
function noteFor(p: LinkedInSignalRowPayload): { type: string; raw: string; summary: string } {
  switch (p.signal) {
    case "invitation_sent":
      return { type: "reach_out", raw: `Your LinkedIn connection request:\n${p.text}`, summary: "You sent a connection request" };
    // `reach_out` reads "you introduced yourself", so their request is a note, not one of those.
    case "invitation_received":
      return { type: "note", raw: `Their LinkedIn connection request:\n${p.text}`, summary: "They sent you a connection request" };
    case "note":
      return { type: "note", raw: p.text, summary: "Your note on LinkedIn" };
    case "recommendation_received":
      return { type: "note", raw: `Recommended you on LinkedIn:\n${p.text}`, summary: "Recommended you on LinkedIn" };
    case "recommendation_given":
      return { type: "note", raw: `You recommended them on LinkedIn:\n${p.text}`, summary: "You recommended them on LinkedIn" };
  }
}

/** A note is something the user wrote down, not an exchange, so it never moves the touch dates. */
function isTouch(p: LinkedInSignalRowPayload): boolean {
  return p.signal !== "note" && Boolean(p.date);
}

export const linkedinSignalsAdapter: ImportAdapter<LinkedInSignalRowPayload> = {
  createsContacts: false,

  identity(p) {
    if (!p.linkedinUrl && !(p.fullName && p.company)) return null;
    return {
      fullName: p.fullName || undefined,
      linkedinUrl: p.linkedinUrl || undefined,
      company: p.company || undefined,
      title: p.title || undefined,
    };
  },

  toCreate(): ContactInput {
    // Unreachable with `createsContacts: false` — see `calendarAdapter.toCreate`.
    throw new Error("a LinkedIn export's notes do not create contacts");
  },

  /** Only the touch dates, widened server-side; nothing else from these files is worth a merge. */
  toMerge(p) {
    if (!isTouch(p)) return {};
    const d = dateOf(p);
    return { firstInteractionAt: d, lastInteractionAt: d };
  },

  interactions(p, contactId, userId): InteractionInsert[] {
    const { type, raw, summary } = noteFor(p);
    return [
      {
        userId,
        contactId,
        interactionType: type,
        interactionDate: dateOf(p),
        source: SOURCE,
        // Keyed by the contact too, so the same row matched to a merged duplicate cannot collide.
        externalId: `li-export:${p.signal}:${p.externalKey}:${contactId}`,
        rawNotes: raw,
        aiSummary: summary,
      },
    ];
  },
};
