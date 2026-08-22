import { put } from "@vercel/blob";
import { linkedinSlug } from "@/lib/duplicates";
import { isDurableAvatarUrl, isUnusableAvatarUrl } from "@/lib/contact-avatar-url";

export {
  isDurableAvatarUrl,
  isUnusableAvatarUrl,
  resolveContactPhotoUrl,
} from "@/lib/contact-avatar-url";

/** Max raw download we'll attempt before giving up. */
const MAX_DOWNLOAD_BYTES = 5_000_000;
/** Target max for the sharp-decode fallback path (raw bytes, unresized). */
const MAX_PERSIST_BYTES = 220_000;
/** Max encoded bytes we'll inline when Blob storage isn't configured. */
const MAX_INLINE_BYTES = 120_000;

/** How many LinkedIn photos to resolve per backfill tick. */
export const AVATAR_BACKFILL_BATCH_SIZE = 5;

/**
 * Thrown when the photo store itself fails, as opposed to a contact simply
 * having no findable photo. Callers stop the whole run on this — retrying
 * every contact against a broken store just burns quota and shows no progress.
 */
export class AvatarStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AvatarStorageError";
  }
}

/** True when Vercel Blob has credentials to talk to a store. */
export function hasBlobStorage(): boolean {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN?.trim() ||
      (process.env.VERCEL_OIDC_TOKEN?.trim() && process.env.BLOB_STORE_ID?.trim())
  );
}

let warnedMissingBlob = false;

function warnMissingBlobOnce() {
  if (warnedMissingBlob) return;
  warnedMissingBlob = true;
  console.warn(
    "[avatars] BLOB_READ_WRITE_TOKEN is not set - storing photos inline instead. " +
      "Provision a Vercel Blob store to keep them out of Postgres."
  );
}

/** Thrown when Microlink quota is exhausted. */
export class MicrolinkRateLimitError extends Error {
  readonly resetAt: number;

  constructor(resetAt: number) {
    super("LinkedIn photo lookup rate limit hit");
    this.name = "MicrolinkRateLimitError";
    this.resetAt = resetAt;
  }
}

/** Process-local Microlink cooldown (ms since epoch). */
let microlinkCooldownUntil = 0;

export function getMicrolinkCooldownUntil(): number {
  return microlinkCooldownUntil;
}

export function isMicrolinkRateLimited(now = Date.now()): boolean {
  return now < microlinkCooldownUntil;
}

function noteMicrolinkRateLimit(resetAtMs: number) {
  const until = Math.max(resetAtMs, Date.now() + 60_000);
  if (until > microlinkCooldownUntil) {
    microlinkCooldownUntil = until;
  }
}

function parseRateLimitReset(res: Response): number {
  const resetHeader = res.headers.get("x-rate-limit-reset");
  if (resetHeader) {
    const asNum = Number(resetHeader);
    if (Number.isFinite(asNum) && asNum > 0) {
      // Microlink uses UTC epoch seconds.
      return asNum > 1e12 ? asNum : asNum * 1000;
    }
  }
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Date.now() + seconds * 1000;
    }
  }
  return Date.now() + 60_000;
}

function noteMicrolinkHeaders(res: Response) {
  const remaining = Number(res.headers.get("x-rate-limit-remaining"));
  if (Number.isFinite(remaining) && remaining <= 0) {
    noteMicrolinkRateLimit(parseRateLimitReset(res));
  }
}

/** Parse a `data:image/...;base64,...` URL into bytes. */
export function parseImageDataUrl(
  dataUrl: string
): { buf: Buffer; contentType: string } | null {
  if (!dataUrl.startsWith("data:image/")) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const meta = dataUrl.slice(5, comma);
  const contentType = meta.split(";")[0] || "image/jpeg";
  const b64 = dataUrl.slice(comma + 1);
  if (!b64) return null;
  return { buf: Buffer.from(b64, "base64"), contentType };
}

/**
 * Resolve a LinkedIn profile photo and return a durable Blob URL.
 * Tries Microlink (OG image) first, then Unavatar as a fallback.
 * Throws {@link MicrolinkRateLimitError} only when Microlink is limited
 * and the Unavatar fallback also fails (so callers can surface quota).
 */
export async function fetchLinkedInPhotoUrl(
  contactId: string,
  linkedinUrl: string
): Promise<string | null> {
  const slug = linkedinSlug(linkedinUrl);
  if (!slug) return null;

  const normalized = linkedinUrl.includes("linkedin.com/in/")
    ? linkedinUrl.trim()
    : `https://www.linkedin.com/in/${slug}`;

  let microlinkLimited = false;

  if (!isMicrolinkRateLimited()) {
    try {
      const imageUrl = await resolveLinkedInOgImage(normalized);
      if (imageUrl) {
        const photoUrl = await downloadAndPersistAvatar(contactId, imageUrl);
        if (photoUrl) return photoUrl;
      }
    } catch (err) {
      // A broken photo store fails the same way for Unavatar — don't retry it.
      if (err instanceof AvatarStorageError) throw err;
      if (err instanceof MicrolinkRateLimitError) {
        microlinkLimited = true;
      }
      // Fall through to Unavatar.
    }
  } else {
    microlinkLimited = true;
  }

  // Unavatar resolves public LinkedIn avatars without spending Microlink quota.
  const unavatarUrl = `https://unavatar.io/linkedin/${encodeURIComponent(slug)}?fallback=false`;
  const fromUnavatar = await downloadAndPersistAvatar(contactId, unavatarUrl);
  if (fromUnavatar) return fromUnavatar;

  if (microlinkLimited) {
    throw new MicrolinkRateLimitError(getMicrolinkCooldownUntil());
  }
  return null;
}

/**
 * Download an external image and store it durably, or null when the image
 * can't be fetched or decoded. Throws {@link AvatarStorageError} when the
 * photo store itself is broken.
 */
export async function downloadAndPersistAvatar(
  contactId: string,
  imageUrl: string
): Promise<string | null> {
  if (isDurableAvatarUrl(imageUrl)) return imageUrl;
  if (isUnusableAvatarUrl(imageUrl)) return null;

  const downloaded = await downloadImageBytes(imageUrl);
  if (!downloaded) return null;
  return persistAvatar(contactId, downloaded.buf, downloaded.contentType);
}

export async function downloadImageBytes(
  imageUrl: string
): Promise<{ buf: Buffer; contentType: string } | null> {
  const fromDataUrl = parseImageDataUrl(imageUrl);
  if (fromDataUrl) return fromDataUrl;
  if (isUnusableAvatarUrl(imageUrl)) return null;

  try {
    const res = await fetch(imageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: "https://www.linkedin.com/",
      },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!res.ok) return null;

    const contentType = (res.headers.get("content-type") || "image/jpeg")
      .split(";")[0]
      .trim();
    if (!contentType.startsWith("image/")) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_DOWNLOAD_BYTES) return null;
    return { buf, contentType };
  } catch {
    return null;
  }
}

/**
 * Resize/compress to a small square JPEG.
 * LinkedIn CDN photos are often >180KB — we used to drop those entirely.
 */
async function encodeAvatar(
  buf: Buffer,
  contentType: string
): Promise<{ buf: Buffer; contentType: string } | null> {
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(buf)
      .rotate()
      .resize(256, 256, { fit: "cover", withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    if (out.byteLength === 0) return null;
    return { buf: out, contentType: "image/jpeg" };
  } catch {
    // Fall back to raw bytes when sharp can't decode (rare formats).
    if (
      !contentType.startsWith("image/") ||
      buf.byteLength === 0 ||
      buf.byteLength > MAX_PERSIST_BYTES
    ) {
      return null;
    }
    return { buf, contentType };
  }
}

/**
 * Store a photo durably and return the URL to keep on the contact.
 *
 * Blob storage is the preferred home, at a stable per-contact path so
 * re-fetches overwrite instead of orphaning. When no Blob store is configured
 * we inline the (already tiny) JPEG as a data URL — still durable as far as
 * the rest of the app is concerned, and served via `/api/avatars/[contactId]`.
 * A Blob store that *is* configured but rejects the upload is a real failure
 * and throws, so callers stop instead of silently reporting "no photo".
 */
async function persistAvatar(
  contactId: string,
  buf: Buffer,
  contentType: string
): Promise<string | null> {
  const encoded = await encodeAvatar(buf, contentType);
  if (!encoded) return null;

  if (!hasBlobStorage()) {
    warnMissingBlobOnce();
    if (encoded.buf.byteLength > MAX_INLINE_BYTES) return null;
    return `data:${encoded.contentType};base64,${encoded.buf.toString("base64")}`;
  }

  try {
    const blob = await put(`avatars/${contactId}.jpg`, encoded.buf, {
      access: "public",
      contentType: encoded.contentType,
      addRandomSuffix: false,
    });
    return blob.url;
  } catch (err) {
    throw new AvatarStorageError(
      `Couldn't save the photo to Blob storage: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err }
    );
  }
}

async function resolveLinkedInOgImage(
  linkedinUrl: string
): Promise<string | null> {
  if (isMicrolinkRateLimited()) {
    throw new MicrolinkRateLimitError(getMicrolinkCooldownUntil());
  }

  try {
    const endpoint = new URL("https://api.microlink.io/");
    endpoint.searchParams.set("url", linkedinUrl);
    endpoint.searchParams.set("palette", "false");

    const headers: Record<string, string> = { Accept: "application/json" };
    const apiKey = process.env.MICROLINK_API_KEY?.trim();
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    const res = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });

    noteMicrolinkHeaders(res);

    if (res.status === 429) {
      const resetAt = parseRateLimitReset(res);
      noteMicrolinkRateLimit(resetAt);
      throw new MicrolinkRateLimitError(resetAt);
    }
    if (!res.ok) return null;

    const json = (await res.json()) as {
      status?: string;
      code?: string | number;
      message?: string;
      data?: {
        image?: { url?: string } | string | null;
        logo?: { url?: string } | string | null;
      };
    };

    if (
      json.status === "fail" &&
      /rate.?limit|quota|too many/i.test(String(json.message ?? json.code ?? ""))
    ) {
      const resetAt = parseRateLimitReset(res);
      noteMicrolinkRateLimit(resetAt);
      throw new MicrolinkRateLimitError(resetAt);
    }

    if (json.status !== "success") return null;

    const candidates = [json.data?.image, json.data?.logo];
    for (const image of candidates) {
      const url = typeof image === "string" ? image : image?.url;
      if (!url?.startsWith("http")) continue;
      if (url.includes("static.licdn.com/aero")) continue;
      return url;
    }
    return null;
  } catch (err) {
    if (err instanceof MicrolinkRateLimitError) throw err;
    return null;
  }
}
