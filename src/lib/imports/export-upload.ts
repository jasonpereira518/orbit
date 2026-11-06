/**
 * Sizes and the browser-side gzip for keeping a LinkedIn export. No dependencies, so the
 * client runner and the server store agree on the same caps.
 */

/**
 * Largest single gzipped file, base64, the browser may send. One append has to fit one file.
 * ponytail: a messages.csv past ~20 MB raw gzips over this and is reported "too big to
 * keep" — store it in chunks if that ever happens.
 */
export const MAX_EXPORT_FILE_GZ_CHARS = 3_000_000;

/** Base64 per append, under the ~4.5 MB Server Action body with room for the JSON around it. */
export const MAX_EXPORT_APPEND_CHARS = 3_500_000;

/** Gzip text with the platform's own `CompressionStream`, as base64. Works in Node 18+ too. */
export async function gzipBase64(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  // Chunked: String.fromCharCode(...bytes) on a whole file overflows the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
