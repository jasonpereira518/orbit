/**
 * Where Cosmo rests (src/lib/cosmo/placement.ts): six slots on the two side edges, home unless
 * something is in the way, the least-covered slot nearest home otherwise; a drop snaps to the
 * nearest slot; arrow keys step between slots. Pure: no DOM.
 */
import { checker } from "./smoke/check";
import { chooseSlot, nearestSlot, slotBox, stepSlot, type SlotFrame } from "../src/lib/cosmo/placement";

const t = checker();
const frame: SlotFrame = {
  viewport: { width: 1280, height: 720 },
  insets: { left: 276, right: 20, top: 112, bottom: 20 },
  size: { width: 48, height: 48 },
};

const br = slotBox("bottom-right", frame);
t.check("bottom-right sits in the corner insets", br.left === 1280 - 20 - 48 && br.top === 720 - 20 - 48, JSON.stringify(br));
const ml = slotBox("middle-left", frame);
t.check("left slots start beside the sidebar", ml.left === 276 && ml.top === (720 - 48) / 2, JSON.stringify(ml));
t.check("top slots clear the header controls", slotBox("top-right", frame).top === 112);

t.check("home wins when nothing covers it", chooseSlot("bottom-right", frame, []) === "bottom-right");
const sheet = { left: 900, top: 16, width: 364, height: 688 }; // a right-edge panel
t.check("a right-edge panel moves it to the left side", chooseSlot("bottom-right", frame, [sheet]) === "bottom-left");
const field = { left: 1100, top: 640, width: 170, height: 60 }; // a focused field in the corner
t.check("a field in the corner moves it up the same side", chooseSlot("bottom-right", frame, [field]) === "middle-right");
t.check("an obstacle elsewhere does not move it", chooseSlot("bottom-right", frame, [{ left: 400, top: 200, width: 300, height: 200 }]) === "bottom-right");
const everywhere = [{ left: 0, top: 0, width: 1280, height: 720 }];
t.check("covered everywhere: stays home rather than wandering", chooseSlot("top-left", frame, everywhere) === "top-left");

t.check("a drop near the top left snaps there", nearestSlot({ x: 300, y: 130 }, frame) === "top-left");
t.check("a drop mid-right snaps there", nearestSlot({ x: 1200, y: 380 }, frame) === "middle-right");

t.check("ArrowLeft crosses to the other side", stepSlot("bottom-right", "ArrowLeft") === "bottom-left");
t.check("ArrowUp climbs the same side", stepSlot("bottom-right", "ArrowUp") === "middle-right");
t.check("ArrowUp at the top stays", stepSlot("top-left", "ArrowUp") === "top-left");
t.check("ArrowDown descends", stepSlot("top-right", "ArrowDown") === "middle-right");
t.check("other keys do nothing", stepSlot("middle-left", "Enter") === null);

t.done("cosmo placement smoke tests");
