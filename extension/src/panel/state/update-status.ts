/**
 * Is this build older than the server it is talking to?
 *
 * `/me` has always returned the server's `contractVersion` "so a stale install
 * can self-diagnose" — and nothing ever read it. Extension updates roll out on
 * Chrome's schedule, not ours, so for a few hours after every contract change
 * some users run an old panel against a new server. The server keeps old
 * shapes working; this is only about telling the user a better build exists.
 */
import { EXTENSION_CONTRACT_VERSION } from "@contract";
import type { UpdateCheck } from "@/lib/browser";

export function isOutdated(
  serverContractVersion: number | null | undefined,
  builtWith: number = EXTENSION_CONTRACT_VERSION
): boolean {
  // An unknown server version is not evidence of anything.
  if (typeof serverContractVersion !== "number") return false;
  return serverContractVersion > builtWith;
}

/**
 * What to tell the user after asking Chrome for the update.
 *
 * `update_available` is the only outcome where acting helps: Chrome has
 * downloaded the new build and applies it on reload. Everything else means
 * "Chrome will get there on its own" — it checks every few hours — except an
 * unpacked build, which has no store to update from.
 */
export function updateOutcomeCopy(outcome: UpdateCheck): {
  reload: boolean;
  message: string;
} {
  switch (outcome) {
    case "update_available":
      return { reload: true, message: "Updating Orbit…" };
    case "unsupported":
      return {
        reload: false,
        message:
          "This is an unpacked build — rebuild it and reload it from chrome://extensions.",
      };
    case "throttled":
    case "no_update":
      return {
        reload: false,
        message: "Chrome will install the update within a few hours.",
      };
  }
}
