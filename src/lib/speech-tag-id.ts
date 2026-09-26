/**
 * The opaque per-account id that rides on Deepgram's usage records for dictation and voice
 * notes, and the lookup that turns one back into an account.
 *
 * WHY THIS EXISTS. Every request Orbit's Deepgram key pays for carries a tag, because an
 * untagged request is spend the nightly reconciliation job (`/api/ops/speech-usage`) cannot
 * see at all. A meeting is tagged with its own session uuid, which belongs to one recording
 * and says nothing about who made it. Short-form had no such id — a dictation session lives
 * and dies inside one browser tab — so it was tagged with the raw Clerk user id, which put a
 * stable account identifier into a third party's records: Deepgram's zero-retention flag
 * covers audio and transcripts, not the usage records, so that id would have linked every
 * dictation an account ever made, permanently, in a system Orbit does not control.
 *
 * A STORED RANDOM VALUE, NOT AN HMAC of the user id. The job has to resolve a tag for
 * accounts that recorded nothing in `speech_usage` — that gap is the whole point of the
 * reconciliation — so it cannot work backwards from usage rows, and an HMAC would leave it
 * hashing every account to find the one that matches. A stored value is one indexed hit on
 * `user_settings_speech_tag_uidx`.
 *
 * Minted lazily on the first tagged request rather than backfilled: an account that never
 * dictates never needs one, and a null column reads exactly like an account that predates it.
 */
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { isSpeechTagId } from "@/lib/deepgram-params";
import { ensureUserSettings } from "@/lib/user-settings";

/** 16 random bytes, base64url — 22 characters, the length `isSpeechTagId` insists on. */
export function mintSpeechTagId(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * This account's tag id, minting one the first time it is asked for.
 *
 * Returns null rather than throwing when there is nothing to mint against (no settings row
 * that could be created, say): a request that cannot be tagged still transcribes, it is
 * merely invisible to reconciliation, and failing a person's dictation to protect a nightly
 * report would be the wrong trade.
 *
 * Race-safe without a transaction. The claim is one conditional UPDATE — `WHERE user_id = ?
 * AND speech_tag_id IS NULL` — so two tabs arriving together cannot both write: the loser
 * updates no rows and reads back the winner's value. Without the condition, the second write
 * would overwrite the first and the two tabs would tag the same account two ways.
 */
export async function speechTagIdFor(userId: string): Promise<string | null> {
  const db = await getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { speechTagId: true },
  });
  if (existing?.speechTagId) return existing.speechTagId;
  // No row at all is an account whose settings have not been bootstrapped yet (a background
  // path that never went through `bootstrapAuthenticatedUser`). Create it, so the claim below
  // has something to update.
  if (!existing) await ensureUserSettings(userId);

  const [claimed] = await db
    .update(userSettings)
    .set({ speechTagId: mintSpeechTagId() })
    .where(and(eq(userSettings.userId, userId), isNull(userSettings.speechTagId)))
    .returning();
  if (claimed?.speechTagId) return claimed.speechTagId;

  const settled = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { speechTagId: true },
  });
  return settled?.speechTagId ?? null;
}

/**
 * The account a `shortform:` tag belongs to, or null if no account claims it.
 *
 * Null is an ordinary outcome, not an error: an account that deleted its data drops this
 * column and mints a new value, so a tag from before that delete resolves to nobody — which
 * is precisely what the delete was for.
 *
 * The shape is re-checked here even though the parser already did, because this value came
 * back from Deepgram and reaches a WHERE clause: the same posture as `isUuid` in
 * `speech-usage-tag.ts`.
 */
export async function userIdForSpeechTagId(speechTagId: string): Promise<string | null> {
  if (!isSpeechTagId(speechTagId)) return null;
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.speechTagId, speechTagId),
    columns: { userId: true },
  });
  return row?.userId ?? null;
}
