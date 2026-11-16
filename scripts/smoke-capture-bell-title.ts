/**
 * The bell's capture row never says "0 people ready to review".
 *
 * Run: npx tsx scripts/run-smoke.ts --only smoke-capture-bell-title
 */
import { captureBellTitle } from "../src/lib/capture/job-staleness";
import { checker } from "./smoke/check";

const t = checker();
t.check("0 items says finish saving", captureBellTitle(0) === "Finish saving your meeting");
t.check("1 item is singular", captureBellTitle(1) === "1 person ready to review");
t.check("3 items is plural", captureBellTitle(3) === "3 people ready to review");
t.done("capture-bell-title");
