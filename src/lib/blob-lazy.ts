import type { del as blobDel, get as blobGet, head as blobHead, list as blobList, put as blobPut } from "@vercel/blob";

/**
 * `put` and `del` from `@vercel/blob`, loading the SDK on first use.
 *
 * The SDK brings undici with it (~2 MB), and the five modules that store or delete objects
 * sit under most server routes — user data, avatars, capture photos, feedback, event
 * covers — so a static import put it on nearly every cold start, including routes that never
 * touch Blob. Both SDK functions are already async, so callers see the same promises.
 */
export async function put(...args: Parameters<typeof blobPut>): ReturnType<typeof blobPut> {
  const blob = await import("@vercel/blob");
  return blob.put(...args);
}

export async function del(...args: Parameters<typeof blobDel>): ReturnType<typeof blobDel> {
  const blob = await import("@vercel/blob");
  return blob.del(...args);
}

export async function head(...args: Parameters<typeof blobHead>): ReturnType<typeof blobHead> {
  const blob = await import("@vercel/blob");
  return blob.head(...args);
}

export async function get(...args: Parameters<typeof blobGet>): ReturnType<typeof blobGet> {
  const blob = await import("@vercel/blob");
  return blob.get(...args);
}

export async function list(...args: Parameters<typeof blobList>): ReturnType<typeof blobList> {
  const blob = await import("@vercel/blob");
  return blob.list(...args);
}
