import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { shareCards, userSettings, type CardFields } from "@/db/schema";
import { isAdminUser } from "@/lib/admin";
import { cardArt, cardSeed, isAccentKey, type AccentKey, type CardArt } from "@/lib/cards/card-art";
import { getAppBaseUrl } from "@/lib/app-url";
import { cleanSingleLine } from "@/lib/ai-security";
import { UserFacingError } from "@/lib/errors";
import { isSurfaceReleased } from "@/lib/surface-visibility";

/** A new card starts with the safe set: no phone until the owner opts in. */
export const DEFAULT_CARD_FIELDS: CardFields = {
  photo: true,
  role: true,
  headline: true,
  linkedin: true,
  email: true,
  phone: false,
  website: false,
  location: false,
};

export type CardDraft = {
  fields: CardFields;
  phone: string | null;
  tagline: string | null;
  /** "Shuffle my stars" bumps it. Left out = keep the saved one. */
  artSalt?: number;
  /** One of `ACCENTS`; null = picked from the seed. Left out = keep the saved one. */
  accent?: AccentKey | null;
};

export type PublicCard = {
  /** share_cards.id, for rate limiting and share-back inserts. */
  cardId: string;
  slug: string;
  ownerId: string;
  firstName: string;
  fullName: string;
  photoUrl: string | null;
  title: string | null;
  company: string | null;
  headline: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  websiteUrl: string | null;
  location: string | null;
  tagline: string | null;
  /** The card's artwork, already resolved: numbers only, no ids, no user text. */
  art: CardArt;
};

const SLUG_RE = /^[A-Za-z0-9_-]{11}$/;

const newSlug = () => randomBytes(8).toString("base64url");

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/** Run `write` with a fresh slug, once more if the slug collided. */
async function withFreshSlug<T>(write: (slug: string) => Promise<T>): Promise<T> {
  try {
    return await write(newSlug());
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return write(newSlug());
  }
}

/** Only http(s) links reach a rendered href. */
const httpUrl = (v: string | null | undefined) => (v && /^https?:\/\//i.test(v) ? v : null);

function cleanDraft(draft: CardDraft) {
  // Both arrive from the client; a stranger value is refused, not stored.
  if (draft.accent != null && !isAccentKey(draft.accent)) throw new UserFacingError("Pick one of the card colours");
  if (draft.artSalt !== undefined && !(Number.isSafeInteger(draft.artSalt) && draft.artSalt >= 0 && draft.artSalt < 2 ** 31)) {
    throw new UserFacingError("Couldn’t shuffle your stars — try again?");
  }
  return {
    fields: { ...DEFAULT_CARD_FIELDS, ...draft.fields },
    phone: cleanSingleLine(draft.phone, 40),
    tagline: cleanSingleLine(draft.tagline, 120),
    // Only what the draft carries, so a save that leaves them out keeps the saved ones.
    ...(draft.artSalt !== undefined && { artSalt: draft.artSalt }),
    ...(draft.accent !== undefined && { accent: draft.accent }),
  };
}

/** The art for a card row; before the card exists, a seed that is the owner's alone. */
const artFor = (cardId: string, d: Pick<CardDraft, "artSalt" | "accent">) =>
  cardArt(cardSeed(cardId, d.artSalt ?? 0), d.accent ?? null);

export async function getCardForOwner(
  userId: string
): Promise<(Required<CardDraft> & { slug: string; pausedAt: Date | null }) | null> {
  const db = await getDb();
  const [row] = await db.select().from(shareCards).where(eq(shareCards.userId, userId)).limit(1);
  if (!row) return null;
  return {
    slug: row.slug,
    fields: { ...DEFAULT_CARD_FIELDS, ...row.fields },
    phone: row.phone,
    tagline: row.tagline,
    artSalt: row.artSalt,
    accent: isAccentKey(row.accent) ? row.accent : null,
    pausedAt: row.pausedAt,
  };
}

export async function saveCard(userId: string, draft: CardDraft): Promise<{ slug: string }> {
  const db = await getDb();
  const values = { ...cleanDraft(draft), updatedAt: new Date() };
  const [row] = await withFreshSlug((slug) =>
    db
      .insert(shareCards)
      .values({ userId, slug, ...values })
      // The slug is kept on update: a saved card never changes its link by itself.
      .onConflictDoUpdate({ target: shareCards.userId, set: values })
      .returning()
  );
  return { slug: row.slug };
}

export async function resetCardSlug(userId: string): Promise<{ slug: string }> {
  const db = await getDb();
  const [row] = await withFreshSlug((slug) =>
    db
      .update(shareCards)
      .set({ slug, updatedAt: new Date() })
      .where(eq(shareCards.userId, userId))
      .returning()
  );
  if (!row) throw new Error("No card to reset");
  return { slug: row.slug };
}

export async function setCardPaused(userId: string, paused: boolean): Promise<void> {
  const db = await getDb();
  await db
    .update(shareCards)
    .set({ pausedAt: paused ? new Date() : null, updatedAt: new Date() })
    .where(eq(shareCards.userId, userId));
}

type Owner = typeof userSettings.$inferSelect;

function build(cardId: string, slug: string, o: Owner, d: CardDraft, art: CardArt): PublicCard | null {
  const f = d.fields;
  const first = o.firstName?.trim() ?? "";
  const full = [first, o.lastName?.trim()].filter(Boolean).join(" ") || o.email?.split("@")[0] || "";
  // A card with no name at all has nothing to show.
  if (!full) return null;
  const career = o.careerProfile;
  return {
    cardId,
    slug,
    ownerId: o.userId,
    firstName: first || full,
    fullName: full,
    photoUrl: f.photo ? httpUrl(o.profileImageUrl) : null,
    title: f.role ? career?.role?.title || null : null,
    company: f.role ? career?.role?.company || null : null,
    headline: f.headline ? career?.profile?.headline || null : null,
    email: f.email ? o.email || null : null,
    phone: f.phone ? d.phone : null,
    linkedinUrl: f.linkedin ? httpUrl(o.socialLinks?.linkedin) : null,
    websiteUrl: f.website ? httpUrl(o.socialLinks?.website) : null,
    location: f.location ? career?.profile?.location || null : null,
    tagline: d.tagline,
    art,
  };
}

async function readOwner(userId: string): Promise<Owner | null> {
  const db = await getDb();
  const [o] = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  return o ?? null;
}

/** What the public page would show for this draft, for the editor's live preview. */
export async function previewCard(userId: string, draft: CardDraft): Promise<PublicCard> {
  const db = await getDb();
  const [owner, [row]] = await Promise.all([
    readOwner(userId),
    db.select({ id: shareCards.id, artSalt: shareCards.artSalt, accent: shareCards.accent }).from(shareCards).where(eq(shareCards.userId, userId)).limit(1),
  ]);
  const clean = cleanDraft(draft);
  // The same art the saved card will wear: its row id, or (before the first save) the owner's id.
  const art = artFor(row?.id ?? `new:${userId}`, {
    artSalt: clean.artSalt ?? row?.artSalt,
    accent: clean.accent !== undefined ? clean.accent : isAccentKey(row?.accent) ? row.accent : null,
  });
  const card = owner && build("preview", "preview", owner, clean, art);
  if (!card) throw new UserFacingError("Add your name in Settings → Profile to preview your card");
  return card;
}

export async function loadPublicCard(slug: string): Promise<PublicCard | null> {
  if (!SLUG_RE.test(slug)) return null;
  const db = await getDb();
  const [row] = await db.select().from(shareCards).where(eq(shareCards.slug, slug)).limit(1);
  if (!row || row.pausedAt) return null;
  const owner = await readOwner(row.userId);
  if (!owner || owner.suspendedAt) return null;
  if (!(await isSurfaceReleased(row.userId, "page.card")) && !isAdminUser(row.userId)) return null;
  const accent = isAccentKey(row.accent) ? row.accent : null;
  return build(
    row.id,
    row.slug,
    owner,
    { fields: { ...DEFAULT_CARD_FIELDS, ...row.fields }, phone: row.phone, tagline: row.tagline },
    artFor(row.id, { artSalt: row.artSalt, accent })
  );
}

export const cardUrl = (slug: string) => `${getAppBaseUrl()}/c/${slug}`;
