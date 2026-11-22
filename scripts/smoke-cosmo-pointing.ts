/**
 * How Cosmo plans pointing (src/lib/cosmo/pointing.ts): only registered controls, at most four;
 * a control on another page gets the sidebar link to that page first; a control that needs a
 * record or a tab open says so instead of guessing. Pure: no DOM.
 */
import { checker } from "./smoke/check";
import { ANCHOR_PAGES, planPointing } from "../src/lib/cosmo/pointing";
import { TOUR_ANCHORS } from "../src/lib/tour/tour-anchors";

const t = checker();
const onContacts = { page: "contacts" as const, targets: ["contacts.add" as const] };

t.check("every registered control has a page entry", Object.keys(TOUR_ANCHORS).every((id) => Object.hasOwn(ANCHOR_PAGES, id)));

const here = planPointing(["contacts.add"], onContacts);
t.check("a control on screen: one step, straight at it", "steps" in here && here.steps.length === 1 && here.steps[0].kind === "target", JSON.stringify(here));

const away = planPointing(["reminders.new"], onContacts);
t.check(
  "a control on another page: the sidebar link first, then the control",
  "steps" in away && away.steps.length === 2 && away.steps[0].kind === "nav" && away.steps[1].kind === "target",
  JSON.stringify(away),
);
t.check(
  "the way there is the page's own nav link",
  "steps" in away && away.steps[0].selector.includes('a[href="/reminders"]'),
  "steps" in away ? away.steps[0].selector : "",
);
const tour = planPointing(["reminders.new", "reminders.row-done"], onContacts);
t.check("two controls on the same other page: one trip there", "steps" in tour && tour.steps.filter((s) => s.kind === "nav").length === 1, JSON.stringify(tour));

t.check("an unknown id is refused, never used as a selector", "error" in planPointing(['button[aria-label="Delete"]'], onContacts));
t.check("nothing to point at is refused", "error" in planPointing([], onContacts));
t.check("more than four is refused", "error" in planPointing(["contacts.add", "contacts.add", "contacts.add", "contacts.add", "contacts.add"], onContacts));
const record = planPointing(["compose.email"], onContacts);
t.check("a record page's control asks for the record to be opened", "error" in record && /open/i.test(record.error), JSON.stringify(record));
const visibleRecord = planPointing(["compose.email"], { page: "contact", targets: ["compose.email"] });
t.check("but is fine when it's already on screen", "steps" in visibleRecord && visibleRecord.steps.length === 1);

t.done("cosmo pointing smoke tests");
