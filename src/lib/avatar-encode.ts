/**
 * The one place that loads `sharp`.
 *
 * `sharp` ships ~16MB of native libvips. Bundled into every function that can reach
 * `contact-avatar.ts` it was 75 of them — over a gigabyte per deployment, billed as
 * Vercel Functions Storage. On Vercel, `next.config.ts` strips `sharp` from every function's
 * trace except `/api/avatars/encode`, which includes it back, and `encodeAvatar` reaches
 * that route over HTTP instead (`encodeViaRoute` in `contact-avatar.ts`). Everywhere else —
 * `next dev`, local builds, tsx scripts — this module is called directly, so there is no
 * server to stand up.
 *
 * Do not import `sharp` anywhere else: outside the encoder route it is missing on Vercel.
 */

/** The largest image the encoder accepts. Matches what `downloadImageBytes` will fetch. */
export const AVATAR_ENCODE_MAX_INPUT_BYTES = 5_000_000;

/**
 * Resize/compress to a small square JPEG.
 * LinkedIn CDN photos are often >180KB — we used to drop those entirely.
 */
export async function encodeAvatarJpeg(buf: Buffer): Promise<Buffer> {
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(buf)
      .rotate()
      .resize(256, 256, { fit: "cover", withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    if (out.byteLength === 0) throw new Error("sharp produced no output");
    return out;
  } catch (err) {
    throw new Error("The image could not be decoded", { cause: err });
  }
}
