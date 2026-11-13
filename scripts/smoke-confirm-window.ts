/**
 * Spoken confirmation (src/lib/voice/confirm-window.ts): Cosmo reads a change back from Orbit's
 * own template; only a short whole phrase said AFTER the read-back finished counts, a send or a
 * delete needs its own verb, anything else closes the window, and it closes after 30 seconds.
 * Pure: no audio, no DOM.
 */
import { checker } from "./smoke/check";
import { CONFIRM_WINDOW_MS, confirmVerb, hasWords, isGoodbye, isUndo, judgeUtterance, readBack, repromptLine } from "../src/lib/voice/confirm-window";

const t = checker();
const send = { verb: "send" as const, opensAt: 1000, expiresAt: 1000 + CONFIRM_WINDOW_MS };
const change = { verb: "confirm" as const, opensAt: 1000, expiresAt: 1000 + CONFIRM_WINDOW_MS };
const del = { verb: "delete" as const, opensAt: 1000, expiresAt: 1000 + CONFIRM_WINDOW_MS };

t.check("an email is a send", confirmVerb({ tool: "draft_email", destructive: false }) === "send");
t.check("a destructive change is a delete", confirmVerb({ tool: "delete_contact", destructive: true }) === "delete");
t.check("anything else is a plain confirm", confirmVerb({ tool: "remove_tags", destructive: false }) === "confirm");
const line = readBack("Email Ada: “Thanks for the intro”", "send");
t.check("the read-back is Orbit's words with the exact phrase to say", line.includes("Email Ada") && line.includes("send it"), line);

t.check("'send it' after the read-back sends", judgeUtterance(send, "Send it.", 1500) === "confirm");
t.check("'yes, send it' sends", judgeUtterance(send, "Yes, send it!", 1500) === "confirm");
t.check("'send it' said over the read-back is ignored", judgeUtterance(send, "send it", 900) === "early");
t.check("before the read-back finished at all, ignored", judgeUtterance({ ...send, opensAt: null, expiresAt: null }, "send it", 900) === "early");
t.check("a bare 'yes' to an email asks once for the verb", judgeUtterance(send, "yes", 1500) === "reprompt");
t.check("a second bare 'yes' doesn't send either", judgeUtterance({ ...send, reprompted: true }, "yes", 1500) === "other");
t.check("'go ahead' to an email asks for the verb too", judgeUtterance(send, "Go ahead.", 1500) === "reprompt");
t.check("the ask names the phrase and the button", repromptLine("send").includes('"send it"') && repromptLine("send").includes("Send"));
t.check("'send it to everyone' is not the phrase", judgeUtterance(send, "send it to everyone", 1500) === "other");
t.check("a bare 'yes' does not delete", judgeUtterance(del, "yes", 1500) === "reprompt");
t.check("'delete it' deletes", judgeUtterance(del, "delete it", 1500) === "confirm");
t.check("'yes' confirms a plain change", judgeUtterance(change, "Yeah.", 1500) === "confirm");
t.check("'cancel' cancels", judgeUtterance(send, "Cancel.", 1500) === "cancel");
t.check("'no, don't send it' cancels", judgeUtterance(send, "No, don't send it", 1500) === "cancel");
t.check("anything else closes the window", judgeUtterance(send, "who else works at Stripe", 1500) === "other");
t.check("after 30 seconds it has closed", judgeUtterance(send, "send it", 1000 + CONFIRM_WINDOW_MS + 1) === "closed");

// What people actually say (Cosmo PR 14).
const said: Array<[string, string, ReturnType<typeof judgeUtterance>]> = [
  ["fillers and politeness", "Uh, yeah, send it please.", "confirm"],
  ["'send it now'", "send it now", "confirm"],
  ["'yeah go ahead and send it'", "yeah go ahead and send it", "confirm"],
  ["'okay, send it, thank you'", "Okay, send it, thank you!", "confirm"],
  ["a speech-to-text slip", "sent it", "confirm"],
  ["Cosmo's name, misheard", "Cosmos, send it.", "confirm"],
  ["'do not send it'", "Do not send it", "cancel"],
  ["'no, don't send that'", "no don't send that", "cancel"],
  ["'wait'", "Wait.", "cancel"],
  ["'hold on'", "hold on a second", "cancel"],
  ["'not yet'", "not yet", "cancel"],
  ["'actually...'", "actually, send it to Grace", "cancel"],
  ["a new recipient", "send it to Bob", "other"],
  ["a change", "change the subject", "other"],
  ["only a sound", "hmm", "other"],
];
for (const [what, text, want] of said) t.check(`${what}: ${want}`, judgeUtterance(send, text, 1500) === want, judgeUtterance(send, text, 1500));
t.check("'sounds good' confirms a plain change", judgeUtterance(change, "Sounds good!", 1500) === "confirm");
t.check("'okay do it' confirms a plain change", judgeUtterance(change, "okay do it", 1500) === "confirm");
t.check("'nope' cancels a plain change", judgeUtterance(change, "nope", 1500) === "cancel");

t.check("goodbyes end the call", ["Bye!", "Goodbye, Cosmo.", "bye cosmos", "That's all, thanks.", "hang up", "OK end the call".replace("OK ", ""), "stop listening"].every(isGoodbye));
t.check("but not things that only sound like it", !isGoodbye("that's it") && !isGoodbye("say bye to Ada for me") && !isGoodbye("I'm good"));
t.check("noise isn't talk", !hasWords("uh") && !hasWords("Hmm...") && hasWords("call Ada"));
t.check("'stop' and 'wait' stop a send too", isUndo("Stop!") && isUndo("wait") && isUndo("cancel that"));

t.check("'undo' undoes", isUndo("Undo!") && isUndo("undo that") && isUndo("don't send it"));
t.check("other words don't", !isUndo("undo is a word") && !isUndo("send it"));

t.done("confirm window smoke tests");
