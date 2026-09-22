/**
 * The web app's two questions to the extension, answered by the worker.
 *
 * `externally_connectable` in the manifest already limits who can ask to the
 * Orbit app's own origin; this checks the sender's origin again anyway, so a
 * manifest mistake can't widen it. Neither answer carries anything about the
 * user, and neither message carries anything the extension acts on beyond
 * "check the session again" — no URLs, no payloads, no page access.
 *
 *   orbit/hello            → { ok, version, sites }: installed, which build, and
 *                            which sites it follows without a click
 *   orbit/session-changed  → { ok }: the user signed in on the web app, so a
 *                            panel showing "sign in" should look again
 */
import { SESSION_POKE_KEY } from "./intents";
import { KNOWN_SITES } from "./permissions";

export const HELLO = "orbit/hello";
export const SESSION_CHANGED = "orbit/session-changed";

/** Written by the worker, heard by open panels (browser().onSessionPoke). */
export { SESSION_POKE_KEY };

export type HandshakeDeps = {
  appOrigin: string;
  version: () => string;
  grantedOrigins: () => Promise<string[]>;
  poke: () => Promise<void>;
};

export type HandshakeReply =
  | { ok: true; version: string; sites: string[] }
  | { ok: true }
  | { ok: false };

/** Friendly names of the known sites Orbit may follow — never raw origins. */
export function followedSites(granted: string[]): string[] {
  return KNOWN_SITES.filter((site) => granted.includes(site.origin)).map((site) => site.label);
}

/**
 * null: not for us (wrong origin or unknown message) — the worker then sends
 * no reply at all, which reads to the page exactly like no extension.
 */
export async function handleExternalMessage(
  message: unknown,
  senderOrigin: string | undefined,
  deps: HandshakeDeps
): Promise<HandshakeReply | null> {
  if (!senderOrigin || senderOrigin !== deps.appOrigin) return null;
  const type = (message as { type?: unknown } | null)?.type;
  if (type === HELLO) {
    let sites: string[] = [];
    try {
      sites = followedSites(await deps.grantedOrigins());
    } catch {
      // A version without sites is still an answer.
    }
    return { ok: true, version: deps.version(), sites };
  }
  if (type === SESSION_CHANGED) {
    try {
      await deps.poke();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
  return null;
}
