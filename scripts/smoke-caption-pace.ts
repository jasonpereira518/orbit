/**
 * Cosmo's captions keep pace with the voice (src/lib/voice/caption-pace.ts): words appear as the
 * audio plays, never ahead of it, all of them once the line has finished, and only the tail
 * shows so the newest words are always on screen. Pure: no DOM, no audio.
 */
import { checker } from "./smoke/check";
import { captionTail, captionWordCount } from "../src/lib/voice/caption-pace";

const t = checker();
const text = "Coffee with Ada is at three tomorrow at the usual place near her office";
const words = text.split(" ").length; // 14

t.check("nothing before the audio starts", captionWordCount(text, { played: 0, queued: 0, complete: false }) === 0);
t.check(
  "halfway through the full audio, about half the words",
  captionWordCount(text, { played: 2, queued: 4, complete: true }) === Math.ceil(words / 2),
);
t.check(
  "never ahead while audio is still arriving: paced at speaking rate, not by the bytes so far",
  captionWordCount(text, { played: 1, queued: 1.2, complete: false }) <= 3,
);
t.check("everything once it has finished playing", captionWordCount(text, { played: 4, queued: 4, complete: true }) === words);
t.check("never more words than there are", captionWordCount(text, { played: 99, queued: 4, complete: false }) === words);
t.check("empty text shows nothing", captionWordCount("  ", { played: 3, queued: 4, complete: true }) === 0);

t.check("the revealed words, when short", captionTail(text, 3) === "Coffee with Ada");
t.check("only the tail of a long line, marked as cut", captionTail(text, 14, 5) === "… usual place near her office");
t.check("none revealed, nothing shown", captionTail(text, 0) === "");

t.done("caption pace smoke tests");
