import { checker } from "./smoke/check";
import { shouldRestoreScroll } from "../src/lib/scroll-restore";

const t = checker();
t.check("back/forward to /contacts restores", shouldRestoreScroll("/contacts", true));
t.check("link click to /contacts starts at top", !shouldRestoreScroll("/contacts", false));
t.check("back/forward elsewhere starts at top", !shouldRestoreScroll("/reminders", true));
t.check("contact detail never restores", !shouldRestoreScroll("/contacts/abc", true));
t.done("scroll-restore smoke tests");
