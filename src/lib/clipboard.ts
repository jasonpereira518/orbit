/**
 * Write text to the clipboard and report whether it landed.
 *
 * `navigator.clipboard.writeText` rejects when the page isn't focused, the context isn't
 * secure, or (Safari) the call isn't close enough to a user gesture. Callers that fire a
 * "Copied" toast without awaiting it tell the user something false, so this resolves to
 * `false` instead of throwing and the caller picks the message.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
