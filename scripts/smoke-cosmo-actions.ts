/**
 * Cosmo driving the screen (src/lib/cosmo/actions.ts): it may press and fill only Orbit's own
 * registered controls, only for the action each is marked with, never Save/Send/Delete/Accept,
 * at most 30 of each a call, and nothing once a lookup looked like an injection. Pure.
 */
import { checker } from "./smoke/check";
import { actionsCatalog, cleanTyped, MAX_ACTIONS_PER_CALL, MAX_TYPED_CHARS, planAction } from "../src/lib/cosmo/actions";
import { TOUR_ANCHORS, TOUR_ANCHOR_ACTIONS, type TourAnchorId } from "../src/lib/tour/tour-anchors";

const t = checker();
const none = { click: 0, type: 0 };
const onReminders = { page: "reminders" as const, targets: ["reminders.new"] as TourAnchorId[] };
const withForm = { page: "reminders" as const, targets: ["reminders.new", "reminders.title", "reminders.save"] as TourAnchorId[] };

const open = planAction("click", "reminders.new", onReminders, none, false);
t.check("click a button on screen: one step, no detour", "steps" in open && open.steps.length === 1 && open.steps[0].kind === "target");
const away = planAction("click", "reminders.new", { page: "contacts", targets: [] }, none, false);
t.check("from another page it walks the menu first", "steps" in away && away.steps[0].kind === "nav" && away.steps[1].kind === "target");
t.check("type into a field once the form is open", "steps" in planAction("type", "reminders.title", withForm, none, false));
t.check("a field inside a closed form says to open it first", "error" in planAction("type", "reminders.title", onReminders, none, false));
const save = planAction("click", "reminders.save", withForm, none, false);
t.check("never presses Save: it points instead", "error" in save && save.error.includes("point_at"), JSON.stringify(save));
t.check("never presses Send", "error" in planAction("click", "compose.send", { page: null, targets: ["compose.send"] }, none, false));
t.check("nothing to press on a view", "error" in planAction("click", "graph.stage", { page: "constellation", targets: ["graph.stage"] }, none, false));
t.check("click a field: told to type_into", (() => { const r = planAction("click", "reminders.title", withForm, none, false); return "error" in r && r.error.includes("type_into"); })());
t.check("type into a button: told to click", (() => { const r = planAction("type", "reminders.new", onReminders, none, false); return "error" in r && r.error.includes("click"); })());
t.check("unknown ids and selectors are refused", "error" in planAction("click", "button.danger", onReminders, none, false) && "error" in planAction("click", "[data-tour=x]", onReminders, none, false));
t.check("the cap holds", "error" in planAction("click", "reminders.new", onReminders, { click: MAX_ACTIONS_PER_CALL, type: 0 }, false));
t.check("a tainted call can't click or type", "error" in planAction("click", "reminders.new", onReminders, none, true));
t.check("every Save/Send/Delete-like control is confirm-only", (["capture.keep", "reminders.row-done", "reminders.save", "compose.send"] as TourAnchorId[]).every((id) => TOUR_ANCHOR_ACTIONS[id] === "confirm"));
t.check("every registered control says what Cosmo may do with it", Object.keys(TOUR_ANCHORS).every((id) => Boolean(TOUR_ANCHOR_ACTIONS[id as TourAnchorId])));
const catalog = actionsCatalog();
t.check("the prompt's lists hold no confirm-only control", !catalog.click.includes("reminders.save") && !catalog.click.includes("compose.send") && catalog.type.includes("reminders.title"));
const typed = cleanTyped("Call Ada\u0007 Friday");
t.check("typed text loses control characters", "text" in typed && typed.text === "Call Ada Friday");
t.check("empty or overlong text is refused", "error" in cleanTyped("  ") && "error" in cleanTyped("x".repeat(MAX_TYPED_CHARS + 1)) && "error" in cleanTyped(42));
t.done("cosmo actions smoke tests");
