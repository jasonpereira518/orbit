/**
 * Spoken confirmation for Cosmo's confirm-tier changes (emails, deletes, anything a card asks
 * about). Orbit, not the model, reads the change back from the stored card, then listens for one
 * short phrase. The rules that make a spoken yes safe enough to act on:
 *  - only what the user says AFTER the read-back finished playing counts (no talking over it, no
 *    echo of the read-back itself);
 *  - the whole utterance must be the phrase, not just contain it ("send it to everyone" is not);
 *  - sending and deleting need their own verb ("send it", "delete it"), a bare "yes" won't do;
 *  - anything else closes the window (the card stays, clickable), and so does 30 seconds.
 * Client-safe and pure (scripts/smoke-confirm-window.ts).
 */

export const CONFIRM_WINDOW_MS = 30_000;
export type ConfirmVerb = "send" | "delete" | "confirm";
export type ConfirmWindow = { verb: ConfirmVerb; opensAt: number | null; expiresAt: number | null };
export type Judgement = "confirm" | "cancel" | "other" | "early" | "closed";

const PHRASES: Record<ConfirmVerb, string[]> = {
  send: ["send it", "send", "send that", "send the email", "send it please", "please send it"],
  delete: ["delete it", "delete", "delete that", "delete it please", "please delete it"],
  confirm: ["yes", "yeah", "yep", "sure", "ok", "okay", "confirm", "do it", "go ahead", "save it", "yes please", "please do"],
};
const LEADS = ["yes", "yeah", "yep", "ok", "okay", "sure"];
const CANCEL = ["cancel", "cancel it", "no", "nope", "no thanks", "stop", "dont", "dont send it", "dont do it", "never mind", "nevermind", "no dont", "no dont send it", "no dont do it", "no cancel"];
const UNDO = ["undo", "undo that", "undo it", "unsend", "unsend it", "dont send it", "stop it", "cancel that"];

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** What a card asks for, by the write behind it. */
export function confirmVerb(action: { tool: string; destructive: boolean }): ConfirmVerb {
  if (action.tool === "draft_email") return "send";
  return action.destructive ? "delete" : "confirm";
}

/** Orbit's own words for the change (the card's preview, never the model's), and what to say. */
export function readBack(preview: string, verb: ConfirmVerb): string {
  const say = verb === "send" ? "send it" : verb === "delete" ? "delete it" : "yes";
  return `${preview.replace(/\s*—\s*you review and send it$/, "")}. Say "${say}" to go ahead, or "cancel".`;
}

export function judgeUtterance(window: ConfirmWindow, text: string, startedAt: number): Judgement {
  if (window.opensAt === null || startedAt < window.opensAt) return "early";
  if (window.expiresAt !== null && startedAt > window.expiresAt) return "closed";
  const said = norm(text);
  if (CANCEL.includes(said)) return "cancel";
  const phrases = PHRASES[window.verb];
  if (phrases.includes(said)) return "confirm";
  // "yes, send it" / "okay delete it": a lead-in word, then the exact phrase.
  for (const lead of LEADS) if (said.startsWith(`${lead} `) && phrases.includes(said.slice(lead.length + 1))) return "confirm";
  return "other";
}

/** "Undo" while a sent email can still be stopped. */
export function isUndo(text: string): boolean {
  return UNDO.includes(norm(text));
}
