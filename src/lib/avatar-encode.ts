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
 * The stored photo's edge, in pixels. The profile header shows it at 144 CSS px, which is 288
 * device px on a retina screen and 432 on a 3x phone, so the old 256 was upscaled and soft
 * there. 384 stays sharp on retina and is still ~15-25KB, well under the inline cap.
 */
export const AVATAR_PX = 384;

/**
 * Resize/compress to a small square JPEG.
 * LinkedIn CDN photos are often >180KB — we used to drop those entirely.
 *
 * Decoding is strict on purpose (sharp's default `failOn: "warning"`): a photo cut off
 * mid-download throws here instead of decoding to a half-grey picture. Do not loosen it.
 */
export async function encodeAvatarJpeg(buf: Buffer): Promise<Buffer> {
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(buf)
      .rotate()
      .resize(AVATAR_PX, AVATAR_PX, { fit: "cover", withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    if (out.byteLength === 0) throw new Error("sharp produced no output");
    return out;
  } catch (err) {
    throw new Error("The image could not be decoded", { cause: err });
  }
}
