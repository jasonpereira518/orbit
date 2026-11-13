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
/** `reprompted`: Orbit already asked once for the verb after a bare "yes" (sends and deletes). */
export type ConfirmWindow = { verb: ConfirmVerb; opensAt: number | null; expiresAt: number | null; reprompted?: boolean };
export type Judgement = "confirm" | "cancel" | "reprompt" | "other" | "early" | "closed";

const PHRASES: Record<ConfirmVerb, string[]> = {
  // "sent it": how speech-to-text often hears a quick "send it".
  send: ["send it", "send", "send that", "send the email", "send the message", "send it off", "send it out", "sent it"],
  delete: ["delete it", "delete", "delete that", "remove it"],
  confirm: ["confirm", "do it", "go ahead", "save it", "sounds good", "please do"],
};
/** A bare yes: enough for a small change, not for a send or a delete. */
const LEADS = ["yes", "yeah", "yep", "yup", "ok", "okay", "sure", "alright", "go ahead and", "you can"];
const BARE_YES = ["yes", "yeah", "yep", "yup", "ok", "okay", "sure", "alright", "correct", "right"];
/** Any of these anywhere wins: "do not send it", "no wait", "hold on" never send. */
const STOP_WORDS = /\b(no|nope|not|dont|never|cancel|stop|wait|nevermind|actually)\b|\bnever mind\b|\bhold on\b|\bhang on\b/;
const UNDO = ["undo", "undo that", "undo it", "unsend", "unsend it", "take it back", "cancel", "cancel that", "cancel it", "stop", "stop it", "stop that", "no", "wait", "dont", "dont send", "dont send it"];
const GOODBYE = ["bye", "goodbye", "bye bye", "good bye", "see you", "see ya", "talk later", "talk to you later", "goodnight", "good night", "thats all", "thats all for now", "im done", "all done", "hang up", "end the call", "end call", "stop listening"];
/** Sounds and politeness that carry no meaning here, wherever they fall. */
const FILLERS = new Set(["um", "umm", "uh", "uhh", "er", "erm", "hmm", "mm", "oh", "so", "like", "just", "well", "hey", "please", "thanks", "now", "cosmo"]);

/** "cosmos", "kosmo", "cosimo": how Cosmo's name tends to be heard. */
export function normalizeName(text: string): string {
  return text.replace(/\b(cosmos|kosmo|kosmos|cosimo|cosmoe)\b/g, "cosmo");
}

/** Lower-case words only, Cosmo's name fixed, fillers and "thank you" gone. */
export function norm(text: string): string {
  const words = normalizeName(
    text
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z ]+/g, " ")
      .replace(/\bthank you\b/g, " ")
      .replace(/\bfor me\b/g, " "),
  )
    .split(/\s+/)
    .filter((w) => w && !FILLERS.has(w));
  return words.join(" ");
}

/** Whether anything was said beyond sounds and fillers ("uh", "hmm"): background noise isn't talk. */
export function hasWords(text: string): boolean {
  return norm(text).length > 0;
}

/** The utterance with its lead-in yes/okay words removed: "yeah go ahead and send it" → "send it". */
function withoutLeads(said: string): string {
  let rest = said;
  for (let changed = true; changed; ) {
    changed = false;
    for (const lead of LEADS)
      if (rest === lead || rest.startsWith(`${lead} `)) {
        rest = rest.slice(lead.length).trim();
        changed = true;
      }
  }
  return rest;
}

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
  if (!said) return "other";
  if (STOP_WORDS.test(said)) return "cancel";
  const phrases = PHRASES[window.verb];
  const rest = withoutLeads(said);
  if (phrases.includes(rest)) return "confirm";
  // A yes in any form: "yes", "okay", "go ahead", "do it", "sounds good".
  if (BARE_YES.includes(said) || rest === "" || PHRASES.confirm.includes(rest)) {
    if (window.verb === "confirm") return "confirm";
    // A send or a delete needs its verb: ask once, then let the card wait for a click.
    return window.reprompted ? "other" : "reprompt";
  }
  return "other";
}

/** What Orbit says after a bare "yes" to a send or delete. */
export function repromptLine(verb: ConfirmVerb): string {
  return verb === "send" ? 'To send it, say "send it", or tap Send.' : 'To delete it, say "delete it", or tap the button.';
}

/** "Undo" (or stop, cancel, wait) while a sent email can still be stopped. */
export function isUndo(text: string): boolean {
  return UNDO.includes(norm(text));
}

/** The person is ending the call ("bye", "that's all", "hang up"). Whole utterance only. */
export function isGoodbye(text: string): boolean {
  return GOODBYE.includes(norm(text));
}
