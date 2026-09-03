/**
 * Write paths behind the extension's save actions.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. The client's `mode` is never trusted. A popup opened twice on a slow
 *    connection will happily send two creates, so the server rescores the page
 *    and refuses a create that collides with an existing contact.
 * 2. Merges union the list fields. `updateContactForUser` replaces them, and a
 *    naive merge would silently wipe years of accumulated key facts the moment
 *    someone hit "save" on a LinkedIn profile.
 */

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  createContactForUser,
  logInteractionForUser,
  updateContactForUser,
  type ContactInput,
} from "@/lib/contact-writes";
import { DUPLICATE_MERGE_CONFIDENCE } from "@/lib/duplicates";
import { PaywallError } from "@/lib/entitlements";
import { rebuildContactEmbedding } from "@/lib/search";
import { generateAndStoreContactBrief } from "@/lib/contact-brief";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import type {
  LogInteractionRequest,
  LogInteractionResponse,
  SaveContactFields,
  SaveContactRequest,
  SaveContactResponse,
} from "./contract";
import { ExtensionRouteError } from "./http";
import { scheduleContactFollowUp } from "./follow-ups";
import { buildSnapshot, matchesForPage, toCandidate } from "./resolve";

/** Defer slow, non-essential work past the response. Routes pass `after`. */
export type Defer = (fn: () => Promise<void>) => void;

const runInline: Defer = (fn) => {
  void fn().catch(() => null);
};

const WRITE_OPTIONS = {
  skipRevalidate: true,
  skipEmbedding: true,
  skipSummary: true,
} as const;

/** Case-insensitive union that keeps the existing entries and their order. */
function unionLists(
  existing: string[] | null | undefined,
  incoming: string[] | undefined
): string[] | undefined {
  if (!incoming?.length) return undefined;
  const out = [...(existing ?? [])];
  const seen = new Set(out.map((v) => v.trim().toLowerCase()));
  for (const value of incoming) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function toContactInput(fields: SaveContactFields, source: string): ContactInput {
  return {
    fullName: fields.fullName,
    firstName: fields.firstName,
    lastName: fields.lastName,
    company: fields.company,
    title: fields.title,
    location: fields.location,
    school: fields.school,
    email: fields.email,
    phone: fields.phone,
    linkedinUrl: fields.linkedinUrl,
    xHandle: fields.xHandle,
    website: fields.website,
    profileImageUrl: fields.photoUrl ?? null,
    relationshipScore: fields.relationshipScore,
    source,
    metContext: fields.metContext,
    howMet: fields.howMet,
    dateMet: fields.dateMet,
    notes: fields.notes,
    aiSummary: fields.aiSummary,
    tagNames: fields.tagNames,
    keyFacts: fields.keyFacts,
    sharedInterests: fields.sharedInterests,
  };
}

function revalidateContactRoutes(contactId: string) {
  revalidatePath("/");
  revalidatePath("/dashboard");
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/graph");
}

export const EXTENSION_SOURCE = "chrome_extension";

export async function saveContactFromExtension(
  userId: string,
  input: SaveContactRequest,
  defer: Defer = runInline
): Promise<SaveContactResponse> {
  const warnings: string[] = [];

  let contactId: string;
  let created: boolean;

  if (input.mode === "merge") {
    const target = input.contactId!;
    const db = await getDb();
    const existing = await db.query.contacts.findFirst({
      where: (c, { and, eq }) => and(eq(c.id, target), eq(c.userId, userId)),
    });
    if (!existing) {
      throw new ExtensionRouteError("not_found", "That contact no longer exists.");
    }

    const patch = toContactInput(input.fields, existing.source ?? EXTENSION_SOURCE);
    // Additive for the list fields — see the file header.
    patch.keyFacts = unionLists(existing.keyFacts, input.fields.keyFacts);
    patch.sharedInterests = unionLists(
      existing.sharedInterests,
      input.fields.sharedInterests
    );
    patch.tagNames = unionLists(undefined, input.fields.tagNames);
    // Don't clobber a curated note with a scraped one.
    if (existing.notes && input.fields.notes) {
      patch.notes = `${existing.notes}\n\n${input.fields.notes}`;
    }

    await updateContactForUser(userId, target, patch, WRITE_OPTIONS);
    contactId = target;
    created = false;
  } else {
    if (!input.force) {
      const { matches } = await matchesForPage(userId, input.page);
      const strong = matches.filter(
        (m) => m.confidence >= DUPLICATE_MERGE_CONFIDENCE
      );
      if (strong.length > 0) {
        throw new ExtensionRouteError(
          "duplicate",
          "You already have this person in your orbit.",
          strong.slice(0, 3).map(toCandidate)
        );
      }
    }

    let contact;
    try {
      contact = await createContactForUser(
        userId,
        toContactInput(input.fields, EXTENSION_SOURCE),
        WRITE_OPTIONS
      );
    } catch (error) {
      // Surface the plan cap as itself rather than a generic server error —
      // the panel shows this message verbatim, and "something went wrong"
      // would send a capped user hunting for a bug that isn't there.
      if (error instanceof PaywallError) {
        throw new ExtensionRouteError("limit_exceeded", error.message);
      }
      throw error;
    }
    contactId = contact.id;
    created = true;
  }

  // Neon HTTP has no cross-statement transactions, so the note and follow-up are
  // separate writes that can fail independently. Report what didn't land rather
  // than pretending the whole thing was atomic.
  if (input.note?.rawNotes?.trim()) {
    try {
      await logInteractionForUser(
        userId,
        {
          contactId,
          rawNotes: input.note.rawNotes,
          interactionType: input.note.interactionType ?? "note",
          source: EXTENSION_SOURCE,
          interactionDate: input.note.interactionDate,
        },
        WRITE_OPTIONS
      );
    } catch {
      warnings.push("The contact was saved, but the note could not be added.");
    }
  }

  if (input.followUp) {
    try {
      await scheduleContactFollowUp(userId, {
        contactId,
        followUp: input.followUp,
      });
    } catch {
      warnings.push(
        "The contact was saved, but the follow-up could not be scheduled."
      );
    }
  }

  const goals = await listActiveGoalTextsForUser(userId);
  const bundle = await buildSnapshot(userId, contactId, goals);
  if (!bundle) {
    throw new ExtensionRouteError("server_error", "Saved, but could not reload.");
  }

  // A manual summary edit must win over the auto-generated one — regenerating
  // right after would silently overwrite what the user just typed.
  const summaryManuallySet = input.fields.aiSummary !== undefined;

  defer(async () => {
    await rebuildContactEmbedding(userId, contactId).catch(() => null);
    if (!summaryManuallySet) {
      await generateAndStoreContactBrief(userId, contactId).catch(() => null);
    }
    revalidateContactRoutes(contactId);
  });

  return { contact: bundle.snapshot, created, warnings };
}

export async function logExtensionInteraction(
  userId: string,
  input: LogInteractionRequest,
  defer: Defer = runInline
): Promise<LogInteractionResponse> {
  const warnings: string[] = [];

  const row = await logInteractionForUser(
    userId,
    {
      contactId: input.contactId,
      rawNotes: input.rawNotes,
      interactionType: input.interactionType ?? "note",
      source: EXTENSION_SOURCE,
      interactionDate: input.interactionDate,
    },
    WRITE_OPTIONS
  );

  let nextFollowUpAt: Date | null = null;
  if (input.followUp) {
    try {
      const result = await scheduleContactFollowUp(userId, {
        contactId: input.contactId,
        followUp: input.followUp,
      });
      nextFollowUpAt = result.nextFollowUpAt;
    } catch {
      warnings.push("Note saved, but the follow-up could not be scheduled.");
    }
  }

  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: (c, { and, eq }) =>
      and(eq(c.id, input.contactId), eq(c.userId, userId)),
    columns: { id: true, lastInteractionAt: true, nextFollowUpAt: true },
  });

  defer(async () => {
    await rebuildContactEmbedding(userId, input.contactId).catch(() => null);
    await generateAndStoreContactBrief(userId, input.contactId).catch(() => null);
    revalidateContactRoutes(input.contactId);
  });

  return {
    interaction: {
      id: row.id,
      interactionDate: row.interactionDate?.toISOString() ?? null,
    },
    contact: {
      id: input.contactId,
      lastInteractionAt: contact?.lastInteractionAt?.toISOString() ?? null,
      nextFollowUpAt:
        (nextFollowUpAt ?? contact?.nextFollowUpAt)?.toISOString() ?? null,
    },
    warnings,
  };
}
