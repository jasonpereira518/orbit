/**
 * Where email attachments live in Blob, and which names are refused — pure, so the composer
 * (client) and the server share one rule. Direct-email P4.
 */
export const ATTACHMENT_PREFIX = "email-attachments";

/**
 * Uploads are private: only the server reads them back (with the store token), at send. The
 * SDK lets the uploading client choose access, so the composer and every server read use this.
 */
export const BLOB_ACCESS = "private" as const;

export function attachmentPrefixFor(userId: string): string {
  return `${ATTACHMENT_PREFIX}/${userId}/`;
}

const BLOCKED = new Set(
  "ade adp apk appx appxbundle bat cab chm cmd com cpl diagcab diagcfg diagpack dll dmg ex ex_ exe hta img ins iso isp jar jnlp js jse lib lnk mde mjs msc msi msix msixbundle msp mst nsh pif ps1 scr sct shb sys vb vbe vbs vhd vxd wsc wsf wsh xll".split(
    " "
  )
);

/** Gmail refuses these outright; refusing them here gives a clear message instead of a bounce. */
export function isBlockedFilename(name: string): boolean {
  if (!name.includes(".")) return false;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return BLOCKED.has(ext);
}

/** A filename safe for a MIME header and a Blob path: no directories, no control characters. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = Array.from(base)
    .filter((ch) => {
      const code = ch.codePointAt(0)!;
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim()
    .slice(0, 120);
  return clean || "attachment";
}
