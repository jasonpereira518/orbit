import { linkedinSlug } from "@/lib/duplicates";
import { isUnusableAvatarUrl } from "@/lib/contact-avatar-url";

export {
  isUnusableAvatarUrl,
  resolveContactPhotoUrl,
} from "@/lib/contact-avatar-url";

/** Max raw download we'll attempt before giving up. */
const MAX_DOWNLOAD_BYTES = 5_000_000;
/** Target max for persisted data-URL thumbnails (after resize). */
const MAX_PERSIST_BYTES = 220_000;

/** How many LinkedIn photos to resolve per backfill tick. */
export const AVATAR_BACKFILL_BATCH_SIZE = 5;

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
 * Resolve a LinkedIn profile photo and return a durable data URL.
 * Uses Microlink meta (LinkedIn OG image), then downloads the bytes.
 * Throws {@link MicrolinkRateLimitError} when the free quota is exhausted.
 */
export async function fetchLinkedInPhotoDataUrl(
  linkedinUrl: string
): Promise<string | null> {
  const slug = linkedinSlug(linkedinUrl);
  if (!slug) return null;

  const normalized = linkedinUrl.includes("linkedin.com/in/")
    ? linkedinUrl.trim()
    : `https://www.linkedin.com/in/${slug}`;

  const imageUrl = await resolveLinkedInOgImage(normalized);
  if (!imageUrl) return null;
  return downloadImageAsDataUrl(imageUrl);
}

/** Download an external image and return a compact data URL, or null on failure. */
export async function downloadImageAsDataUrl(
  imageUrl: string
): Promise<string | null> {
  if (imageUrl.startsWith("data:image/")) return imageUrl;
  if (isUnusableAvatarUrl(imageUrl)) return null;

  const downloaded = await downloadImageBytes(imageUrl);
  if (!downloaded) return null;
  return encodeAvatarDataUrl(downloaded.buf, downloaded.contentType);
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
 * Resize/compress to a durable avatar data URL.
 * LinkedIn CDN photos are often >180KB — we used to drop those entirely.
 */
export async function encodeAvatarDataUrl(
  buf: Buffer,
  contentType: string
): Promise<string | null> {
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(buf)
      .rotate()
      .resize(256, 256, { fit: "cover", withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    if (out.byteLength === 0) return null;
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    // Fall back to raw bytes when sharp can't decode (rare formats).
    if (
      contentType.startsWith("image/") &&
      buf.byteLength > 0 &&
      buf.byteLength <= MAX_PERSIST_BYTES
    ) {
      return `data:${contentType};base64,${buf.toString("base64")}`;
    }
    return null;
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
