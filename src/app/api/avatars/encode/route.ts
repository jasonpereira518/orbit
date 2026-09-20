import { isInternalRequest } from "@/lib/internal-auth";
import { AVATAR_ENCODE_MAX_INPUT_BYTES, encodeAvatarJpeg } from "@/lib/avatar-encode";

/**
 * Internal photo encoder: raw image bytes in, a 256px JPEG out.
 *
 * This is the only function that carries `sharp` (see `next.config.ts`), so every other
 * route that stores a contact photo calls it over HTTP instead of bundling libvips. Not
 * user-facing: fail-closed shared secret, same gate as the other internal routes.
 *
 * 422 means "these bytes are not a decodable image" — the caller falls back to the raw
 * bytes, as it always has. Anything else non-2xx is a fault in the encoder itself.
 */
export async function POST(request: Request) {
  if (!isInternalRequest(request)) return new Response(null, { status: 401 });

  const declared = Number(request.headers.get("content-length"));
  if (declared > AVATAR_ENCODE_MAX_INPUT_BYTES) return new Response(null, { status: 413 });

  const input = Buffer.from(await request.arrayBuffer());
  if (input.byteLength === 0) return new Response(null, { status: 422 });
  if (input.byteLength > AVATAR_ENCODE_MAX_INPUT_BYTES) return new Response(null, { status: 413 });

  try {
    const jpeg = await encodeAvatarJpeg(input);
    return new Response(new Uint8Array(jpeg), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
    });
  } catch {
    return new Response(null, { status: 422 });
  }
}
