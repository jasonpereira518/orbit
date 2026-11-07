/**
 * The corner-clearance claim stores: each CSS variable holds the MAX of its live claims and
 * is removed when the last one is released. Lift and shift are independent stores, so an
 * open notifications window never clears a page's lift (or the other way round).
 *
 * No DOM: `document.documentElement.style` is stubbed with a plain map.
 */
import { checker } from "./smoke/check";

const props = new Map<string, string>();
(globalThis as unknown as { document: unknown }).document = {
  documentElement: {
    style: {
      setProperty: (k: string, v: string) => props.set(k, v),
      removeProperty: (k: string) => props.delete(k),
    },
  },
};

async function main() {
  const { claimCornerLift, claimCornerShift } = await import("../src/lib/corner-clearance");
  const { PANEL_CORNER_SHIFT_PX, PANEL_INSET_PX, PANEL_MAX_W_PX } = await import(
    "../src/lib/floating-panel"
  );
  const t = checker();
  const shift = () => props.get("--orbit-corner-shift");
  const lift = () => props.get("--orbit-corner-lift");

  claimCornerShift("notifications", 400);
  t.check("one shift claim sets the variable", shift() === "400px", shift());
  claimCornerShift("feedback", 250);
  t.check("the larger claim wins", shift() === "400px", shift());
  claimCornerShift("notifications", null);
  t.check("releasing the larger falls back to the remaining claim", shift() === "250px", shift());

  claimCornerLift("capture", 120);
  t.check("lift is its own store", lift() === "120px" && shift() === "250px");
  claimCornerShift("feedback", 0);
  t.check("a 0px claim releases and the variable is removed", shift() === undefined);
  t.check("releasing shift leaves lift alone", lift() === "120px");
  claimCornerLift("capture", null);
  t.check("lift is removed with its last claim", lift() === undefined);

  t.check(
    "panel shift = window width + right inset",
    PANEL_CORNER_SHIFT_PX === PANEL_MAX_W_PX + PANEL_INSET_PX,
    String(PANEL_CORNER_SHIFT_PX)
  );

  t.done("corner-clearance smoke tests");
}

void main();
