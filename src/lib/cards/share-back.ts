/**
 * A visitor sending their details back through someone's card, minus the request. The server
 * action reads the IP and hands it in, so a smoke can drive this with a fake one.
 *
 * The input is a stranger's, so it never goes through `resolveOrCreateContact`: on an
 * identifier match that overwrites and merges the owner's real contacts. `resolveUntrusted`
 * matches on email/phone only and then writes nothing; a new person is created without
 * claiming their LinkedIn slug; lookalikes become review suggestions, never merges. Only
 * fixed server text reaches the owner's timeline — the visitor's message stays on the
 * `card_shares` row.
 */
import { and, asc, count, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { cardShares, contacts, type CardShareStatus } from "@/db/schema";
import { auditUntrustedWrite, cleanAgentContactFields, cleanSingleLine, safeHttpUrl } from "@/lib/ai-security";
import { isBotRequest, recordBotBlocked } from "@/lib/bot-check";
import { loadPublicCard } from "@/lib/cards/card-store";
import { liveEventFor } from "@/lib/cards/live-event";
import { shareBackSchema } from "@/lib/cards/share-back-schema";
import { findIdentityOwners } from "@/lib/contact-identity";
import { recordDuplicateSuggestions } from "@/lib/contact-merge";
import { MIN_FILL_MS } from "@/lib/contact-message";
import { nameMatchesFor } from "@/lib/contact-resolve";
import {
  contactHeadroomForUser,
  createContactForUser,
  logNoteInteractionForUser,
  type ContactInput,
} from "@/lib/contact-writes";
import { identityKeysFor } from "@/lib/duplicates";
import { isPaywallError } from "@/lib/entitlements";
import { recordMetAtEvent } from "@/lib/events/store";
import { sanitizeAgentText } from "@/lib/mcp/sanitize";
import { RATE_LIMITS, consumeBucket, consumeIpBucket, isRateLimitedError } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";

export type ShareBackInput = {
  slug: string;
  nonce: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  linkedinUrl?: string;
  message?: string;
  website?: string;
  elapsedMs: number;
};

export type ShareBackResult = { ok: true } | { ok: false; message: string; fieldErrors?: Record<string, string> };

/** Contacts one card may create in 24 hours; past it arrivals are held for the owner. */
const DAILY_CARD_CONTACTS = 300;

const SHARED_TEXT = "Shared their details via your card";

export async function shareBackCore(input: ShareBackInput, ctx: { ip: string }): Promise<ShareBackResult> {
  const parsed = shareBackSchema.safeParse(input);
  if (!parsed.success) {
    // A filled honeypot is a bot: plausible success, nothing written.
    if (parsed.error.issues.some((i) => i.path[0] === "website")) return { ok: true };
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "");
      if (field && !fieldErrors[field]) fieldErrors[field] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }
  const data = parsed.data;

  if (data.elapsedMs < MIN_FILL_MS) return { ok: true };
  if (await isBotRequest()) {
    await recordBotBlocked();
    return { ok: true };
  }

  const card = await loadPublicCard(data.slug);
  if (!card) return { ok: false, message: "This card isn't available." };

  const email = cleanSingleLine(data.email, 320) ?? undefined;
  const phone = cleanSingleLine(data.phone, 50) ?? undefined;
  if (identityKeysFor({ email, phone }).length === 0) {
    return {
      ok: false,
      message: "Please fix the highlighted fields.",
      fieldErrors: { email: "Add an email or phone so they can reach you." },
    };
  }

  try {
    await consumeIpBucket("cardShare", ctx.ip, RATE_LIMITS.cardShare);
    await consumeBucket("cardShareCard", card.cardId, RATE_LIMITS.cardShareCard);
  } catch (err) {
    if (isRateLimitedError(err)) return { ok: true };
    throw err;
  }

  const { fields } = cleanAgentContactFields({
    fullName: data.name,
    company: data.company,
    title: data.title,
    linkedinUrl: data.linkedinUrl,
  });
  const fullName = cleanSingleLine(fields.fullName, 120);
  if (!fullName) return { ok: false, message: "Please fix the highlighted fields.", fieldErrors: { name: "Add your name." } };
  const message = data.message ? sanitizeAgentText(data.message).trim().slice(0, 500) || null : null;
  const linkedinUrl = safeHttpUrl(fields.linkedinUrl) ?? undefined;

  const db = await getDb();
  // The share row first, keyed by the form's nonce: a replayed submit stops here.
  const [share] = await db
    .insert(cardShares)
    .values({
      userId: card.ownerId,
      cardId: card.cardId,
      nonce: data.nonce,
      name: fullName,
      email: email ?? null,
      phone: phone ?? null,
      company: fields.company ?? null,
      title: fields.title ?? null,
      linkedinUrl: linkedinUrl ?? null,
      message,
      status: "added" satisfies CardShareStatus, // provisional until resolved below
    })
    .onConflictDoNothing({ target: [cardShares.cardId, cardShares.nonce] })
    .returning();
  if (!share) return { ok: true };

  auditUntrustedWrite(card.ownerId, "card.share", "message", message);
  auditUntrustedWrite(card.ownerId, "card.share", "fields", [fullName, fields.company, fields.title].filter(Boolean).join("\n"));

  const event = await liveEventFor(card.ownerId);
  let resolved: { contactId: string | null; status: CardShareStatus } = { contactId: null, status: "held" };
  try {
    resolved = await resolveUntrusted(card.ownerId, {
      fullName,
      email,
      phone,
      company: fields.company,
      title: fields.title,
      linkedinUrl,
    });
  } catch (err) {
    // The details are already saved on the share row; held keeps them in front of the owner.
    reportError(err, { where: "card.shareBack.resolve" });
  }
  await db
    .update(cardShares)
    .set({ status: resolved.status, contactId: resolved.contactId, eventId: event?.id ?? null })
    .where(eq(cardShares.id, share.id));

  if (resolved.contactId) {
    try {
      await logNoteInteractionForUser(
        card.ownerId,
        {
          contactId: resolved.contactId,
          rawNotes: event ? `${SHARED_TEXT} at ${event.title}` : SHARED_TEXT,
          interactionType: event ? "event" : "note",
          source: "card",
          externalId: `card:${share.id}`,
        },
        // Fixed text, so nothing worth a brief refresh or an embedding on the owner's budget.
        { skipSummary: true, skipEmbedding: true, skipRevalidate: true }
      );
      if (event) await recordMetAtEvent(card.ownerId, event.id, [resolved.contactId], { source: "card", byName: false });
    } catch (err) {
      reportError(err, { where: "card.shareBack.log" });
    }
  }
  return { ok: true };
}

/**
 * The owner's contact for an untrusted arrival. Matches on email/phone only; a match is
 * returned untouched. Otherwise creates one (or holds it, at a cap) without claiming the
 * LinkedIn slug and without merging anything.
 */
export async function resolveUntrusted(
  userId: string,
  input: ContactInput
): Promise<{ contactId: string | null; status: CardShareStatus }> {
  const db = await getDb();
  const owners = await findIdentityOwners(userId, identityKeysFor({ email: input.email, phone: input.phone }));
  if (owners.length) {
    const [oldest] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), inArray(contacts.id, [...new Set(owners.map((o) => o.contactId))])))
      .orderBy(asc(contacts.createdAt), asc(contacts.id))
      .limit(1);
    if (oldest) return { contactId: oldest.id, status: "matched" };
  }

  const [{ added }] = await db
    .select({ added: count() })
    .from(cardShares)
    .where(
      and(
        eq(cardShares.userId, userId),
        eq(cardShares.status, "added"),
        isNotNull(cardShares.contactId),
        gt(cardShares.createdAt, sql`now() - interval '24 hours'`)
      )
    );
  if (added >= DAILY_CARD_CONTACTS || (await contactHeadroomForUser(userId)) === 0) {
    return { contactId: null, status: "held" };
  }

  const { linkedinUrl, ...rest } = input;
  let contactId: string;
  try {
    // Without linkedinUrl: createContactForUser claims every identity key it can see, and a
    // stranger's pasted URL must not capture the real person's future imports.
    const created = await createContactForUser(
      userId,
      { ...rest, source: "card" },
      { settleClaims: false, skipSummary: true, skipEmbedding: true, skipRevalidate: true }
    );
    contactId = created.id;
  } catch (err) {
    // Lost the cap to a concurrent create.
    if (isPaywallError(err)) return { contactId: null, status: "held" };
    throw err;
  }
  if (linkedinUrl) {
    await db
      .update(contacts)
      .set({ linkedinUrl })
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
  }

  const lookalikes = await nameMatchesFor(userId, contactId, rest);
  await recordDuplicateSuggestions(
    userId,
    lookalikes.map((m) => ({ contactIdA: contactId, contactIdB: m.contact.id, reason: m.reason, confidence: m.confidence }))
  );
  return { contactId, status: "added" };
}
