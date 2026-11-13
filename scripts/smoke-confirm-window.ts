/**
 * Spoken confirmation (src/lib/voice/confirm-window.ts): Cosmo reads a change back from Orbit's
 * own template; only a short whole phrase said AFTER the read-back finished counts, a send or a
 * delete needs its own verb, anything else closes the window, and it closes after 30 seconds.
 * Pure: no audio, no DOM.
 */
import { checker } from "./smoke/check";
import { CONFIRM_WINDOW_MS, confirmVerb, isUndo, judgeUtterance, readBack } from "../src/lib/voice/confirm-window";

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
t.check("a bare 'yes' does not send an email", judgeUtterance(send, "yes", 1500) === "other");
t.check("'send it to everyone' is not the phrase", judgeUtterance(send, "send it to everyone", 1500) === "other");
t.check("a bare 'yes' does not delete", judgeUtterance(del, "yes", 1500) === "other");
t.check("'delete it' deletes", judgeUtterance(del, "delete it", 1500) === "confirm");
t.check("'yes' confirms a plain change", judgeUtterance(change, "Yeah.", 1500) === "confirm");
t.check("'cancel' cancels", judgeUtterance(send, "Cancel.", 1500) === "cancel");
t.check("'no, don't send it' cancels", judgeUtterance(send, "No, don't send it", 1500) === "cancel");
t.check("anything else closes the window", judgeUtterance(send, "who else works at Stripe", 1500) === "other");
t.check("after 30 seconds it has closed", judgeUtterance(send, "send it", 1000 + CONFIRM_WINDOW_MS + 1) === "closed");

t.check("'undo' undoes", isUndo("Undo!") && isUndo("undo that") && isUndo("don't send it"));
t.check("other words don't", !isUndo("undo is a word") && !isUndo("send it"));

t.done("confirm window smoke tests");
