/**
 * When Cosmo speaks up (src/lib/cosmo/nudge.ts): which one thing the idle orb shows, what it
 * opens a call with, and when it may break into a live call: never while anyone is speaking or a
 * confirmation is open, at least a minute apart, at most three a call, once per page, and never
 * after the person said to stop. Pure: no pulse, no audio.
 */
import { checker } from "./smoke/check";
import { allNudges, isResumeInterrupting, isStopInterrupting, mayInterject, nudgeInput, pickNudge, type NudgeInput } from "../src/lib/cosmo/nudge";

const t = checker();
const now = Date.parse("2026-11-13T15:00:00Z");
const empty: NudgeInput = { nextMeeting: null, unloggedMeeting: null, dueCount: 0, radarNew: 0 };
const meeting = { eventId: "e1", title: "Coffee", startIso: "2026-11-13T15:12:00Z", people: ["Ada Lovelace"] };

t.check("nothing to say: no nudge", pickNudge(empty, now, new Set()) === null);
const soon = pickNudge({ ...empty, nextMeeting: meeting, dueCount: 3, radarNew: 2 }, now, new Set());
t.check("a meeting soon beats everything else", soon?.kind === "meeting" && soon.chip.includes("Ada") && soon.chip.includes("12"), JSON.stringify(soon));
t.check("its opener offers prep, in Cosmo's voice", Boolean(soon?.opener.startsWith("Hi, I’m Cosmo") && soon.opener.includes("prep")), soon?.opener ?? "");
t.check("a meeting soon may interrupt", Boolean(soon?.interject));
const due = pickNudge({ ...empty, nextMeeting: meeting, dueCount: 3 }, now, new Set([soon!.id]));
t.check("dismissed: the next one shows", due?.kind === "due" && due.chip === "3 things due", JSON.stringify(due));
t.check("things due never interrupt a call", !due?.interject);
t.check("one thing due is singular", pickNudge({ ...empty, dueCount: 1 }, now, new Set())?.chip === "1 thing due");
const debrief = pickNudge({ ...empty, unloggedMeeting: { eventId: "e2", title: "Sync", people: [] } }, now, new Set());
t.check("a meeting with no note asks how it went, by title when nobody is known", debrief?.kind === "debrief" && debrief.chip.includes("Sync"), JSON.stringify(debrief));
t.check("radar is the quietest", pickNudge({ ...empty, radarNew: 4 }, now, new Set())?.chip === "4 new on Radar");
const hostile = pickNudge({ ...empty, nextMeeting: { ...meeting, people: ["Ada\u0007 <b>Lovelace</b> ".repeat(20)] } }, now, new Set());
t.check("names are cleaned and capped before they are spoken", Boolean(hostile && !hostile.chip.includes("\u0007") && hostile.chip.length <= 80), hostile?.chip ?? "");

// The opener a call starts with is rebuilt on the server from its own pulse; the browser only
// names which nudge it showed, and an id the server doesn't have opens with the plain greeting.
const pulse = { nextMeeting: meeting, unloggedMeeting: null, radarNew: 0, panel: { dueCount: 2 } };
const fromServer = allNudges(nudgeInput(pulse), now);
t.check("the server finds the nudge the chip showed", fromServer.find((n) => n.id === "due")?.opener.includes("2 things due") === true);
t.check("an id it doesn't have is nothing", fromServer.find((n) => n.id === "meeting:forged") === undefined);

const calm = { off: false, mode: "listening" as const, confirmOpen: false, userSpeaking: false, now, lastAt: 0, count: 0, page: "/contacts", lastPage: null };
t.check("a quiet moment: may interject", mayInterject(calm));
t.check("not while Cosmo speaks", !mayInterject({ ...calm, mode: "speaking" }));
t.check("not while the person speaks", !mayInterject({ ...calm, userSpeaking: true }));
t.check("not with a confirmation open", !mayInterject({ ...calm, confirmOpen: true }));
t.check("not within a minute of the last", !mayInterject({ ...calm, lastAt: now - 30_000 }));
t.check("at most three a call", !mayInterject({ ...calm, count: 3 }));
t.check("once per page", !mayInterject({ ...calm, lastPage: "/contacts" }));
t.check("never once told to stop", !mayInterject({ ...calm, off: true }));
t.check("'stop interrupting' is heard", isStopInterrupting("Please stop interrupting me") && isStopInterrupting("don't interrupt"));
t.check("'no more interruptions' is heard", isStopInterrupting("No more interruptions, please"));
t.check("'be quiet' or 'shut up' only stops this sentence", !isStopInterrupting("be quiet") && !isStopInterrupting("shut up") && !isStopInterrupting("stop talking"));
t.check("and so is the way back", isResumeInterrupting("you can interrupt me again") && !isStopInterrupting("interrupt me again"));

t.done("cosmo nudge smoke tests");
