import { checker } from "./smoke/check";
import { consumeTraversal, markTraversal, scrollKeySearch, scrollStorageKey, scrollTargetFits, shouldRestoreScroll } from "../src/lib/scroll-restore";

const t = checker();
t.check("back/forward to /contacts restores", shouldRestoreScroll("/contacts", true));
t.check("link click to /contacts starts at top", !shouldRestoreScroll("/contacts", false));
t.check("back/forward elsewhere starts at top", !shouldRestoreScroll("/reminders", true));
t.check("contact detail never restores", !shouldRestoreScroll("/contacts/abc", true));
t.check("search keyed on /contacts", scrollKeySearch("/contacts", "followUp=due") === "followUp=due");
t.check("search ignored elsewhere", scrollKeySearch("/settings", "google=ok") === "");
t.check(
  "filtered /contacts saves apart from the plain list",
  scrollStorageKey("/contacts", "followUp=due") !== scrollStorageKey("/contacts", ""),
);
t.check("same URL, same key", scrollStorageKey("/contacts", "") === scrollStorageKey("/contacts", ""));
t.check("target past the rendered height doesn't fit yet", !scrollTargetFits(600, 768, 700));
t.check("target fits once the list renders", scrollTargetFits(600, 4600, 700));
t.check("top always fits", scrollTargetFits(0, 0, 700));
t.check("no traversal by default", !consumeTraversal());
markTraversal();
t.check("flag consumed once", consumeTraversal() && !consumeTraversal());
t.done("scroll-restore smoke tests");
